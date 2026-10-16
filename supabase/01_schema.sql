-- ============================================================
--  会议发布与参会确认系统 —— Supabase 数据库结构
--  用法：Supabase 控制台 -> SQL Editor -> New query -> 整段粘贴 -> Run
--  本脚本可安全重复执行（幂等）。
-- ============================================================

-- 把常见的 schema 都放进搜索路径，避免因 schema 不同而报
-- "function xxx does not exist"。本脚本只会用到 PostgreSQL 内置函数。
-- （public 和 extensions 在 Supabase 里都一定存在；万一你的项目删过 extensions，
--   把这行改成 set search_path = public; 即可，脚本功能不受影响。）
set search_path = public, extensions;

-- ------------------------------------------------------------
-- 1. 系统配置表（管理员口令哈希等）
-- ------------------------------------------------------------
create table if not exists public.app_config (
  key         text primary key,
  value       text not null,
  updated_at  timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 2. 人员名单表（后台维护的唯一数据源；新建会议时快照进会议里，
--    因此以后改名单不会影响历史会议的参会范围）
-- ------------------------------------------------------------
create table if not exists public.roster (
  id          uuid primary key default gen_random_uuid(),
  dept        text not null default '',    -- 部门
  category    text not null default '',    -- 类别：处长 / 院长 / 办公室主任 / 党总支书记
  name        text not null,               -- 姓名
  phone       text not null default '',    -- 手机号（选填）
  note        text not null default '',    -- 备注（选填）
  sort_no     integer not null default 0,  -- 排序号
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists roster_sort_idx on public.roster (sort_no, dept, name);
-- 去重键包含「类别」：同一个人在同一部门可能兼任两种身份
-- （如某人既是办公室主任又是院长），两条记录都要保留
drop index if exists public.roster_unique_idx;
create unique index if not exists roster_unique_idx on public.roster (dept, category, name);

-- ------------------------------------------------------------
-- 3. 会议表
--    invite = 本场会议的参会人快照：[{name, dept, category, rid}, ...]
--    share_token = 二级网页链接里的随机串，不可猜测
-- ------------------------------------------------------------
create table if not exists public.meetings (
  id            uuid primary key default gen_random_uuid(),
  title         text not null,
  meet_date     date,
  start_time    text not null default '',
  end_time      text not null default '',
  location      text not null default '',
  convene_dept  text not null default '',  -- 主办/召集部门
  host          text not null default '',  -- 主持人
  contact       text not null default '',  -- 联系人及电话
  agenda        text not null default '',  -- 会议议程 / 说明
  ask_reason    boolean not null default true,   -- 二级网页：不参会时收集原因
  ask_note      boolean not null default true,   -- 二级网页：收集备注
  deadline      timestamptz,                     -- 填报截止（留空 = 不限）
  invite        jsonb not null default '[]'::jsonb,
  -- 参会链接里的随机串（32 字节十六进制）。只用内置函数拼出来，不依赖 pgcrypto。
  share_token   text not null unique default
                  (md5(random()::text || clock_timestamp()::text)
                   || md5(random()::text || clock_timestamp()::text)),
  status        text not null default 'published', -- published | archived
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists meetings_date_idx on public.meetings (meet_date desc, created_at desc);

-- ------------------------------------------------------------
-- 4. 回执表（二级网页填报结果；同名重复提交即覆盖更新）
-- ------------------------------------------------------------
create table if not exists public.responses (
  id           uuid primary key default gen_random_uuid(),
  meeting_id   uuid not null references public.meetings(id) on delete cascade,
  name_key     text not null,             -- 姓名归一化键（去空格、转小写）
  name_raw     text not null,             -- 填报人输入的姓名原文
  dept         text not null default '',
  category     text not null default '',
  attending    boolean not null,          -- true=参会 false=不参会
  reason       text not null default '',  -- 请假/不参会原因
  note         text not null default '',  -- 备注
  on_list      boolean not null default false, -- 是否在受邀名单中
  user_agent   text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (meeting_id, name_key)
);
create index if not exists responses_meeting_idx on public.responses (meeting_id, attending);
create index if not exists responses_name_idx on public.responses (name_key);

-- ------------------------------------------------------------
-- 5. 通用触发器：自动维护 updated_at
-- ------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_roster_touch on public.roster;
create trigger trg_roster_touch before update on public.roster
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_meetings_touch on public.meetings;
create trigger trg_meetings_touch before update on public.meetings
  for each row execute function public.touch_updated_at();

-- ------------------------------------------------------------
-- 6. 管理员口令
--    口令只以 sha256(固定盐 + 口令) 的形式存储；明文既不进数据库，也不进网页源码。
--
--    ★ 本节的三个函数是 pgcrypto 的"零依赖实现"，这是刻意的：
--      pgcrypto 的 digest() 在部分 Supabase 项目里会报
--      42883 function digest(text, unknown) does not exist，
--      而函数体出于安全要求固定了 search_path，无法靠改搜索路径解决。
--      这里改用 PostgreSQL 11+ 内置的 pg_catalog.sha256(bytea)，
--      与 encode(digest(x,'sha256'),'hex') 的结果完全一致。
-- ------------------------------------------------------------
create or replace function public.admin_secret_hash(p_secret text)
returns text language sql immutable as $$
  select pg_catalog.encode(
           pg_catalog.sha256(pg_catalog.convert_to('dsh-meeting-salt::' || btrim(coalesce(p_secret, '')), 'UTF8')),
           'hex'
         );
$$;

create or replace function public.set_admin_secret(p_secret text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_secret is null or length(btrim(p_secret)) < 4 then
    raise exception '口令至少 4 位';
  end if;
  insert into public.app_config(key, value, updated_at)
  values ('admin_secret_hash', public.admin_secret_hash(p_secret), now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
end $$;

-- 只有「已设置口令」且「口令正确」才返回 true；
-- 未初始化口令时一律 false，防止空白口令直接拿到全库权限。
-- 若你之前用旧版脚本设过口令（旧版用 pgcrypto 的 digest），
-- 重新执行一次 set_admin_secret('口令') 即可，哈希会按新算法覆盖。
create or replace function public.check_admin(p_secret text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.app_config
     where key = 'admin_secret_hash'
       and value = public.admin_secret_hash(p_secret)
  );
$$;

-- 从当前请求头取管理员口令。
-- 依据：PostgREST 会把请求头放进 request.headers，Supabase 官方支持在 RLS 里读取
-- （参见 supabase-community/pg_headerkit）。这里不用 ::json 直接强转，
-- 而是先用正则判断是不是 JSON 对象，避免某些情况下报错导致整条查询失败。
create or replace function public.req_secret()
returns text language sql stable as $$
  select case
    when coalesce(current_setting('request.headers', true), '') ~ '^\s*\{'
      then coalesce(current_setting('request.headers', true)::json ->> 'x-admin-secret', '')
    else ''
  end;
$$;

-- ------------------------------------------------------------
-- 7. 安全策略（RLS）
--    名单与回执属于内部数据：只有带正确口令的会话可读写。
--    二级网页不直接碰表，只走第 8 节的三个函数。
-- ------------------------------------------------------------
alter table public.app_config enable row level security;
alter table public.roster     enable row level security;
alter table public.meetings   enable row level security;
alter table public.responses  enable row level security;

-- 先清理同名策略，保证可重复执行
drop policy if exists roster_admin_all on public.roster;
drop policy if exists meet_admin_all  on public.meetings;
drop policy if exists resp_admin_all  on public.responses;
drop policy if exists cfg_admin_all   on public.app_config;

-- app_config 故意不建任何策略：任何客户端都读不到、写不了，
-- 只能通过 security definer 函数间接使用。

create policy roster_admin_all on public.roster
  for all to anon, authenticated
  using (public.check_admin(public.req_secret()))
  with check (public.check_admin(public.req_secret()));

create policy meet_admin_all on public.meetings
  for all to anon, authenticated
  using (public.check_admin(public.req_secret()))
  with check (public.check_admin(public.req_secret()));

create policy resp_admin_all on public.responses
  for all to anon, authenticated
  using (public.check_admin(public.req_secret()))
  with check (public.check_admin(public.req_secret()));

-- ------------------------------------------------------------
-- 8. 二级网页（参会人）专用函数 —— 只认 share_token
-- ------------------------------------------------------------

-- 8.1 凭链接读取会议公开信息（不含任何回执数据）
create or replace function public.open_meeting(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  m public.meetings;
  v_closed boolean;
begin
  select * into m from public.meetings where share_token = btrim(coalesce(p_token, ''));
  if not found then
    return jsonb_build_object('ok', false, 'error', '链接无效或会议已撤销');
  end if;

  v_closed := (m.deadline is not null and now() > m.deadline);

  return jsonb_build_object(
    'ok', true,
    'meeting', jsonb_build_object(
      'title',         m.title,
      'meet_date',     m.meet_date,
      'start_time',    m.start_time,
      'end_time',      m.end_time,
      'location',      m.location,
      'convene_dept',  m.convene_dept,
      'host',          m.host,
      'contact',       m.contact,
      'agenda',        m.agenda,
      'ask_reason',    m.ask_reason,
      'ask_note',      m.ask_note,
      'deadline',      m.deadline,
      'closed',        v_closed,
      'invite_count',  jsonb_array_length(m.invite)
    ),
    -- 只下发姓名，供输入框自动补全（防止写错字 / 名单外的人），
    -- 不下发部门、类别，避免整份名单被外泄
    'names', coalesce((
      select jsonb_agg(distinct x->>'name')
      from jsonb_array_elements(m.invite) x
      where coalesce(x->>'name', '') <> ''
    ), '[]'::jsonb)
  );
end $$;

-- 8.2 提交 / 更新回执（同一会议内同名即覆盖，实现「随时可改」）
create or replace function public.submit_response(
  p_token     text,
  p_name      text,
  p_attending boolean,
  p_reason    text default '',
  p_note      text default '',
  p_ua        text default ''
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m     public.meetings;
  v_key text;
  v_hit jsonb;
  v_row public.responses;
begin
  select * into m from public.meetings where share_token = btrim(coalesce(p_token, ''));
  if not found then
    return jsonb_build_object('ok', false, 'error', '链接无效或会议已撤销');
  end if;

  if m.deadline is not null and now() > m.deadline then
    return jsonb_build_object('ok', false, 'error', '本次填报已截止，如需变更请联系会议联系人');
  end if;

  p_name := btrim(coalesce(p_name, ''));
  if length(p_name) < 2 or length(p_name) > 20 then
    return jsonb_build_object('ok', false, 'error', '请填写本人真实姓名（2-20 字）');
  end if;

  v_key := lower(regexp_replace(p_name, '\s', '', 'g'));

  -- 是否在受邀名单中（按姓名匹配；命中则回填部门与类别）
  select x into v_hit
  from jsonb_array_elements(m.invite) x
  where lower(regexp_replace(x->>'name', '\s', '', 'g')) = v_key
  limit 1;

  insert into public.responses as r
    (meeting_id, name_key, name_raw, dept, category, attending, reason, note, on_list, user_agent)
  values
    (m.id, v_key, p_name,
     coalesce(v_hit->>'dept', ''), coalesce(v_hit->>'category', ''),
     coalesce(p_attending, false), btrim(coalesce(p_reason, '')), btrim(coalesce(p_note, '')),
     (v_hit is not null), left(coalesce(p_ua, ''), 300))
  on conflict (meeting_id, name_key) do update set
    name_raw   = excluded.name_raw,
    dept       = case when excluded.dept = '' then r.dept else excluded.dept end,
    category   = case when excluded.category = '' then r.category else excluded.category end,
    attending  = excluded.attending,
    reason     = excluded.reason,
    note       = excluded.note,
    on_list    = excluded.on_list,
    user_agent = excluded.user_agent,
    updated_at = now()
  returning * into v_row;

  return jsonb_build_object(
    'ok', true,
    'attending', v_row.attending,
    'name', v_row.name_raw,
    'on_list', v_row.on_list,
    'updated_at', v_row.updated_at,
    'message', case when v_row.attending then '已记录：您将按时参会' else '已记录：您不参会' end
  );
end $$;

-- 8.3 回看 / 带出本人上次答复（二级网页重开时用）
create or replace function public.my_response(p_token text, p_name text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare m public.meetings; v_row public.responses;
begin
  select * into m from public.meetings where share_token = btrim(coalesce(p_token, ''));
  if not found then
    return jsonb_build_object('ok', false, 'error', '链接无效');
  end if;
  select * into v_row from public.responses
   where meeting_id = m.id
     and name_key = lower(regexp_replace(btrim(coalesce(p_name, '')), '\s', '', 'g'));
  if not found then
    return jsonb_build_object('ok', true, 'found', false);
  end if;
  return jsonb_build_object(
    'ok', true, 'found', true,
    'attending', v_row.attending, 'reason', v_row.reason,
    'note', v_row.note, 'updated_at', v_row.updated_at
  );
end $$;

-- ------------------------------------------------------------
-- 9. 授权：匿名只允许执行第 8 节三个函数，不能直接碰表
-- ------------------------------------------------------------
revoke all on function public.open_meeting(text) from public;
revoke all on function public.submit_response(text, text, boolean, text, text, text) from public;
revoke all on function public.my_response(text, text) from public;
revoke all on function public.set_admin_secret(text) from public;
revoke all on function public.check_admin(text) from public;
revoke all on function public.admin_secret_hash(text) from public;
revoke all on function public.req_secret() from public;

grant execute on function public.open_meeting(text) to anon, authenticated;
grant execute on function public.submit_response(text, text, boolean, text, text, text) to anon, authenticated;
grant execute on function public.my_response(text, text) to anon, authenticated;

-- ------------------------------------------------------------
-- 10. 初始化 / 修改管理员口令
--     把下面这一行的口令换掉，然后单独执行这一行即可。
--     执行完请把这一行删掉或注释掉，别把明文口令留在 SQL 历史里。
-- ------------------------------------------------------------
-- select public.set_admin_secret('改成你的后台口令');

-- ------------------------------------------------------------
-- 11. 自检（可选，但建议做一次）
--     把 '刚才设的口令' 换成你真实口令后执行下面的 select。
--     （这些 select 只在你手动执行时运行，不会泄露给网页端）
-- ------------------------------------------------------------
-- select
--   public.check_admin('刚才设的口令')                        as 口令校验应为t,
--   (select count(*) from public.roster)                      as 名单人数,
--   (select count(*) from public.meetings)                    as 会议数,
--   (select count(*) from public.responses)                   as 回执数;

-- ------------------------------------------------------------
-- 12. 排查用（都是只读查询，手动执行时才运行）
-- (1) 口令哈希用的是 PostgreSQL 内置的 pg_catalog.sha256，与任何扩展无关。
--     执行下面这句，能返回一串 64 位十六进制就说明正常：
-- ------------------------------------------------------------
-- select public.admin_secret_hash('测试口令') as 哈希值应为64位十六进制;

-- (2) 确认四个函数都已建好（应为 4 行）：
-- ------------------------------------------------------------
-- select proname from pg_proc
--  where pronamespace = 'public'::regnamespace
--    and proname in ('admin_secret_hash','set_admin_secret','check_admin','req_secret')
--  order by proname;

-- (3) 确认三张业务表已建好（应为 3 行）：
-- ------------------------------------------------------------
-- select tablename from pg_tables
--  where schemaname = 'public' and tablename in ('roster','meetings','responses')
--  order by tablename;

-- (4) 网页端一直提示口令错误时，确认库里已经存了口令哈希：
-- ------------------------------------------------------------
-- select key, left(value, 12) || '…' as 哈希前几位, updated_at
--   from public.app_config;

-- (5) 万一以后还想知道 pgcrypto 的情况（本脚本已不需要它）：
-- ------------------------------------------------------------
-- select e.extname, n.nspname as 所在schema
--   from pg_extension e join pg_namespace n on n.oid = e.extnamespace;
