-- ============================================================
--  会议发布与参会确认系统 —— 数据库结构 v2（多用户版）
--  用法：Supabase 控制台 -> SQL Editor -> New query -> 整段粘贴 -> Run
--
--  特性：
--   · 幂等，可重复执行
--   · 可从 v1（单管理员口令版）就地升级，已有会议/名单/回执数据不丢
--   · v2 改用 Supabase Auth 账号体系，不再需要后台口令
--
--  执行完还必须做一步（见第 15 节）：把你的工号设为超级管理员。
-- ============================================================

set search_path = public, extensions;

-- ------------------------------------------------------------
-- 0. 清理 v1 的"单管理员口令"方案
--    （v1 的表可能不存在，全部用 DO 块做存在性判断，避免全新项目报错）
-- ------------------------------------------------------------
do $$
begin
  if to_regclass('public.roster') is not null then
    execute 'drop policy if exists roster_admin_all on public.roster';
  end if;
  if to_regclass('public.meetings') is not null then
    execute 'drop policy if exists meet_admin_all on public.meetings';
  end if;
  if to_regclass('public.responses') is not null then
    execute 'drop policy if exists resp_admin_all on public.responses';
  end if;
  if to_regclass('public.app_config') is not null then
    execute 'drop policy if exists cfg_admin_all on public.app_config';
  end if;
end $$;

drop function if exists public.check_admin(text);
drop function if exists public.req_secret();
drop function if exists public.admin_secret_hash(text);
drop function if exists public.set_admin_secret(text);
drop table   if exists public.app_config;

-- ------------------------------------------------------------
-- 1. 套餐（超级管理员在面板里定价）
-- ------------------------------------------------------------
create table if not exists public.plans (
  id            uuid primary key default gen_random_uuid(),
  name          text    not null,                                        -- 如：月卡
  price_cents   integer not null default 0 check (price_cents >= 0),     -- 价格（分）
  duration_days integer not null default 30 check (duration_days > 0),   -- 有效天数
  description   text    not null default '',
  is_active     boolean not null default true,
  sort_no       integer not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ------------------------------------------------------------
-- 2. 用户档案（与 auth.users 一一对应）
-- ------------------------------------------------------------
create table if not exists public.profiles (
  id              uuid primary key references auth.users(id) on delete cascade,
  emp_no          text not null,
  name            text not null,
  phone           text not null default '',
  email           text not null default '',
  is_super        boolean not null default false,
  locked          boolean not null default false,
  locked_reason   text not null default '',
  balance_cents   integer not null default 0 check (balance_cents >= 0),
  plan_id         uuid references public.plans(id) on delete set null,
  plan_expires_at timestamptz,
  note            text not null default '',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists profiles_emp_no_idx on public.profiles (emp_no);

-- ------------------------------------------------------------
-- 3. 钱包流水（充值、购买套餐、管理员调整都记一笔）
-- ------------------------------------------------------------
create table if not exists public.wallet_logs (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.profiles(id) on delete cascade,
  delta_cents   integer not null,                 -- 正数入账、负数出账
  balance_after integer not null,
  kind          text not null default 'adjust',   -- recharge | plan | adjust
  note          text not null default '',
  created_at    timestamptz not null default now()
);
create index if not exists wallet_logs_user_idx on public.wallet_logs (user_id, created_at desc);

-- ------------------------------------------------------------
-- 4. 充值申请（用户提交 → 超级管理员审批入账）
-- ------------------------------------------------------------
create table if not exists public.recharge_requests (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  amount_cents integer not null check (amount_cents > 0),
  method       text not null default '',   -- 转账/现金/微信 等，供超管核对
  note         text not null default '',
  status       text not null default 'pending',  -- pending | approved | rejected
  review_note  text not null default '',
  reviewed_by  uuid references public.profiles(id),
  reviewed_at  timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists recharge_user_idx on public.recharge_requests (user_id, created_at desc);
create index if not exists recharge_status_idx on public.recharge_requests (status, created_at desc);

-- ------------------------------------------------------------
-- 5. 业务表（v2 定义，自带建表；v1 老库则走后面的 ALTER 升级）
-- ------------------------------------------------------------
create table if not exists public.roster (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid references public.profiles(id) on delete cascade default auth.uid(),
  emp_no      text not null default '',     -- 工号
  dept        text not null default '',     -- 部门
  category    text not null default '',     -- 类别：处长 / 院长 / 办公室主任 / 党总支书记
  name        text not null,                -- 姓名
  phone       text not null default '',
  note        text not null default '',
  sort_no     integer not null default 0,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.meetings (
  id            uuid primary key default gen_random_uuid(),
  owner_id      uuid references public.profiles(id) on delete cascade default auth.uid(),
  title         text not null,
  meet_date     date,
  start_time    text not null default '',
  end_time      text not null default '',
  location      text not null default '',
  convene_dept  text not null default '',
  host          text not null default '',
  contact       text not null default '',
  agenda        text not null default '',
  ask_reason    boolean not null default true,
  ask_note      boolean not null default true,
  deadline      timestamptz,
  invite        jsonb not null default '[]'::jsonb,
  share_token   text not null unique default
                  (md5(random()::text || clock_timestamp()::text)
                   || md5(random()::text || clock_timestamp()::text)),
  status        text not null default 'published',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.responses (
  id           uuid primary key default gen_random_uuid(),
  meeting_id   uuid not null references public.meetings(id) on delete cascade,
  name_key     text not null,
  name_raw     text not null,
  dept         text not null default '',
  category     text not null default '',
  attending    boolean not null,
  reason       text not null default '',
  note         text not null default '',
  on_list      boolean not null default false,
  user_agent   text not null default '',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (meeting_id, name_key)
);

-- 从 v1 老表升级：补齐 v2 新增字段
alter table public.roster   add column if not exists owner_id uuid references public.profiles(id) on delete cascade;
alter table public.roster   add column if not exists emp_no   text not null default '';
alter table public.meetings add column if not exists owner_id uuid references public.profiles(id) on delete cascade;
alter table public.roster   alter column owner_id set default auth.uid();
alter table public.meetings alter column owner_id set default auth.uid();

-- 唯一约束：v1 是「全校 部门+类别+姓名」，v2 改为「同一用户内 部门+类别+姓名」
drop index if exists public.roster_unique_idx;
create unique index if not exists roster_owner_unique_idx
  on public.roster (owner_id, dept, category, name);
create index if not exists roster_owner_sort_idx on public.roster (owner_id, sort_no, dept, name);
create index if not exists meetings_owner_idx on public.meetings (owner_id, meet_date desc);
create index if not exists meetings_date_idx on public.meetings (meet_date desc, created_at desc);
create index if not exists responses_meeting_idx on public.responses (meeting_id, attending);

-- ------------------------------------------------------------
-- 6. 通用工具函数
-- ------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists trg_profiles_touch on public.profiles;
create trigger trg_profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_plans_touch on public.plans;
create trigger trg_plans_touch before update on public.plans
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_roster_touch on public.roster;
create trigger trg_roster_touch before update on public.roster
  for each row execute function public.touch_updated_at();

drop trigger if exists trg_meetings_touch on public.meetings;
create trigger trg_meetings_touch before update on public.meetings
  for each row execute function public.touch_updated_at();

create or replace function public.is_super()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select p.is_super from public.profiles p where p.id = auth.uid()), false);
$$;

create or replace function public.is_active_user()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select not p.locked from public.profiles p where p.id = auth.uid()), false);
$$;

create or replace function public.has_active_plan()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_super()
      or coalesce((select p.plan_expires_at > now() from public.profiles p where p.id = auth.uid()), false);
$$;

-- ------------------------------------------------------------
-- 7. 注册：auth.users 插入时自动建档案
-- ------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_emp   text := btrim(coalesce(new.raw_user_meta_data->>'emp_no', ''));
  v_name  text := btrim(coalesce(new.raw_user_meta_data->>'name', ''));
  v_phone text := btrim(coalesce(new.raw_user_meta_data->>'phone', ''));
begin
  if v_emp = '' then
    raise exception '请填写工号' using errcode = '22023';
  end if;
  if v_name = '' then
    raise exception '请填写姓名' using errcode = '22023';
  end if;
  if exists (select 1 from public.profiles where emp_no = v_emp) then
    raise exception '工号 % 已经被注册，请直接登录或联系管理员', v_emp using errcode = '23505';
  end if;

  insert into public.profiles (id, emp_no, name, phone, email)
  values (new.id, v_emp, v_name, v_phone, coalesce(new.email, ''))
  on conflict (id) do nothing;

  return new;
end $$;

drop trigger if exists trg_on_auth_user_created on auth.users;
create trigger trg_on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 注册前预检工号是否被占用（前端友好提示用）
create or replace function public.is_emp_no_taken(p_emp_no text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where emp_no = btrim(coalesce(p_emp_no, '')));
$$;

-- ------------------------------------------------------------
-- 8. 用户自助操作（普通用户不能直接改 profiles，走这几个函数）
-- ------------------------------------------------------------
create or replace function public.update_my_profile(p_name text, p_phone text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', '请先登录');
  end if;
  if btrim(coalesce(p_name, '')) = '' then
    return jsonb_build_object('ok', false, 'error', '姓名不能为空');
  end if;
  update public.profiles
     set name = btrim(p_name), phone = btrim(coalesce(p_phone, ''))
   where id = v_uid;
  return jsonb_build_object('ok', true);
end $$;

create or replace function public.purchase_plan(p_plan_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid     uuid := auth.uid();
  v_plan    public.plans;
  v_balance integer;
  v_base    timestamptz;
  v_expires timestamptz;
  v_after   integer;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', '请先登录');
  end if;
  if not public.is_active_user() then
    return jsonb_build_object('ok', false, 'error', '账号已被锁定，无法购买');
  end if;

  select * into v_plan from public.plans where id = p_plan_id and is_active = true;
  if not found then
    return jsonb_build_object('ok', false, 'error', '该套餐不存在或已下架');
  end if;

  select balance_cents, greatest(now(), coalesce(plan_expires_at, now()))
    into v_balance, v_base
    from public.profiles where id = v_uid for update;

  if v_balance < v_plan.price_cents then
    return jsonb_build_object('ok', false,
      'error', '余额不足：需要 ' || round(v_plan.price_cents / 100.0, 2) ||
               ' 元，当前余额 ' || round(v_balance / 100.0, 2) || ' 元，请先充值');
  end if;

  v_expires := v_base + (v_plan.duration_days || ' days')::interval;
  v_after   := v_balance - v_plan.price_cents;

  update public.profiles
     set balance_cents = v_after, plan_id = v_plan.id, plan_expires_at = v_expires
   where id = v_uid;

  insert into public.wallet_logs (user_id, delta_cents, balance_after, kind, note)
  values (v_uid, -v_plan.price_cents, v_after, 'plan',
          '购买套餐：' || v_plan.name || '（' || v_plan.duration_days || ' 天）');

  return jsonb_build_object('ok', true, 'balance_cents', v_after,
                            'plan_expires_at', v_expires, 'plan_name', v_plan.name);
end $$;

create or replace function public.request_recharge(p_amount_cents integer, p_method text, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', '请先登录');
  end if;
  if not public.is_active_user() then
    return jsonb_build_object('ok', false, 'error', '账号已被锁定');
  end if;
  if coalesce(p_amount_cents, 0) <= 0 then
    return jsonb_build_object('ok', false, 'error', '充值金额必须大于 0');
  end if;
  if (select count(*) from public.recharge_requests
       where user_id = v_uid and status = 'pending') >= 5 then
    return jsonb_build_object('ok', false, 'error', '你已有 5 条待审批的充值申请，请等待处理');
  end if;

  insert into public.recharge_requests (user_id, amount_cents, method, note)
  values (v_uid, p_amount_cents, btrim(coalesce(p_method, '')), btrim(coalesce(p_note, '')));

  return jsonb_build_object('ok', true);
end $$;

-- ------------------------------------------------------------
-- 9. 超级管理员操作
-- ------------------------------------------------------------
create or replace function public.admin_review_recharge(p_request_id uuid, p_approve boolean, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_req   public.recharge_requests;
  v_after integer;
  v_uid   uuid := auth.uid();
begin
  if not public.is_super() then
    return jsonb_build_object('ok', false, 'error', '只有超级管理员可以审批');
  end if;
  select * into v_req from public.recharge_requests where id = p_request_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', '申请不存在');
  end if;
  if v_req.status <> 'pending' then
    return jsonb_build_object('ok', false, 'error', '该申请已经处理过了');
  end if;

  if p_approve then
    update public.profiles
       set balance_cents = balance_cents + v_req.amount_cents
     where id = v_req.user_id
     returning balance_cents into v_after;
    insert into public.wallet_logs (user_id, delta_cents, balance_after, kind, note)
    values (v_req.user_id, v_req.amount_cents, v_after, 'recharge',
            '充值审批通过' || case when coalesce(p_note, '') <> '' then '：' || p_note else '' end);
  else
    select balance_cents into v_after from public.profiles where id = v_req.user_id;
  end if;

  update public.recharge_requests
     set status = case when p_approve then 'approved' else 'rejected' end,
         review_note = coalesce(p_note, ''),
         reviewed_by = v_uid,
         reviewed_at = now()
   where id = p_request_id;

  return jsonb_build_object('ok', true, 'status', case when p_approve then 'approved' else 'rejected' end);
end $$;

create or replace function public.admin_adjust_balance(p_user_id uuid, p_delta_cents integer, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_after integer;
begin
  if not public.is_super() then
    return jsonb_build_object('ok', false, 'error', '只有超级管理员可以调整余额');
  end if;
  if coalesce(p_delta_cents, 0) = 0 then
    return jsonb_build_object('ok', false, 'error', '调整金额不能为 0');
  end if;

  update public.profiles
     set balance_cents = greatest(0, balance_cents + p_delta_cents)
   where id = p_user_id
   returning balance_cents into v_after;

  if v_after is null then
    return jsonb_build_object('ok', false, 'error', '用户不存在');
  end if;

  insert into public.wallet_logs (user_id, delta_cents, balance_after, kind, note)
  values (p_user_id, p_delta_cents, v_after, 'adjust',
          '管理员调整' || case when coalesce(p_note, '') <> '' then '：' || p_note else '' end);

  return jsonb_build_object('ok', true, 'balance_cents', v_after);
end $$;

create or replace function public.admin_grant_plan(p_user_id uuid, p_plan_id uuid, p_days integer)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_days integer := coalesce(p_days, 0);
  v_base timestamptz;
  v_exp  timestamptz;
begin
  if not public.is_super() then
    return jsonb_build_object('ok', false, 'error', '只有超级管理员可以操作');
  end if;
  if p_plan_id is not null then
    select duration_days into v_days from public.plans where id = p_plan_id;
    v_days := coalesce(v_days, 0);
  end if;
  if v_days <= 0 then
    return jsonb_build_object('ok', false, 'error', '请选择套餐或填写有效天数');
  end if;

  select greatest(now(), coalesce(plan_expires_at, now())) into v_base
    from public.profiles where id = p_user_id;
  v_exp := v_base + (v_days || ' days')::interval;

  update public.profiles
     set plan_id = coalesce(p_plan_id, plan_id), plan_expires_at = v_exp
   where id = p_user_id;

  return jsonb_build_object('ok', true, 'plan_expires_at', v_exp);
end $$;

-- ------------------------------------------------------------
-- 10. 发布会议的套餐校验（数据库层强制，绕不过去）
-- ------------------------------------------------------------
create or replace function public.check_meeting_allowed()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_locked boolean; v_exp timestamptz;
begin
  select locked, plan_expires_at into v_locked, v_exp
    from public.profiles where id = new.owner_id;

  if coalesce(v_locked, false) then
    raise exception '账号已被锁定，无法发布会议' using errcode = '42501';
  end if;
  if not public.is_super() and (v_exp is null or v_exp <= now()) then
    raise exception '套餐未开通或已过期，请先在「我的账户」购买套餐' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists trg_meetings_quota on public.meetings;
create trigger trg_meetings_quota before insert on public.meetings
  for each row execute function public.check_meeting_allowed();

-- ------------------------------------------------------------
-- 11. 行级安全策略（RLS）：按归属隔离，超级管理员放行
-- ------------------------------------------------------------
alter table public.profiles          enable row level security;
alter table public.plans             enable row level security;
alter table public.wallet_logs       enable row level security;
alter table public.recharge_requests enable row level security;
alter table public.roster            enable row level security;
alter table public.meetings          enable row level security;
alter table public.responses         enable row level security;

drop policy if exists profiles_select       on public.profiles;
drop policy if exists profiles_update_super on public.profiles;
drop policy if exists plans_select          on public.plans;
drop policy if exists plans_write           on public.plans;
drop policy if exists wallet_select         on public.wallet_logs;
drop policy if exists recharge_select       on public.recharge_requests;
drop policy if exists recharge_insert       on public.recharge_requests;
drop policy if exists recharge_update_super on public.recharge_requests;
drop policy if exists roster_owner_all      on public.roster;
drop policy if exists meetings_owner_all    on public.meetings;
drop policy if exists responses_owner_all   on public.responses;

-- 档案：能看自己；超管能看全部。写入只允许超管（普通用户走 RPC）。
create policy profiles_select on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_super());
create policy profiles_update_super on public.profiles
  for update to authenticated using (public.is_super()) with check (public.is_super());

-- 套餐：所有登录用户可看（买之前要能看价格）；只有超管能增删改
create policy plans_select on public.plans
  for select to authenticated using (true);
create policy plans_write on public.plans
  for all to authenticated using (public.is_super()) with check (public.is_super());

-- 钱包流水：自己的；超管全部。写入只通过函数（security definer）
create policy wallet_select on public.wallet_logs
  for select to authenticated using (user_id = auth.uid() or public.is_super());

-- 充值申请：自己可提交、可查看；超管可审批
create policy recharge_select on public.recharge_requests
  for select to authenticated using (user_id = auth.uid() or public.is_super());
create policy recharge_insert on public.recharge_requests
  for insert to authenticated with check (user_id = auth.uid() and status = 'pending');
create policy recharge_update_super on public.recharge_requests
  for update to authenticated using (public.is_super()) with check (public.is_super());

-- 名单 / 会议 / 回执：按归属隔离
create policy roster_owner_all on public.roster
  for all to authenticated
  using (owner_id = auth.uid() or public.is_super())
  with check (owner_id = auth.uid() or public.is_super());

create policy meetings_owner_all on public.meetings
  for all to authenticated
  using (owner_id = auth.uid() or public.is_super())
  with check (owner_id = auth.uid() or public.is_super());

create policy responses_owner_all on public.responses
  for all to authenticated
  using (exists (select 1 from public.meetings m
                  where m.id = responses.meeting_id
                    and (m.owner_id = auth.uid() or public.is_super())))
  with check (exists (select 1 from public.meetings m
                  where m.id = responses.meeting_id
                    and (m.owner_id = auth.uid() or public.is_super())));

-- ------------------------------------------------------------
-- 12. 参会人填报（匿名，凭 share_token，不需要登录）
-- ------------------------------------------------------------
create or replace function public.open_meeting(p_token text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  m public.meetings;
  v_closed boolean;
  v_owner_locked boolean := false;
  v_owner_name text := '';
begin
  select * into m from public.meetings where share_token = btrim(coalesce(p_token, ''));
  if not found then
    return jsonb_build_object('ok', false, 'error', '链接无效或会议已撤销');
  end if;

  if m.owner_id is not null then
    select coalesce(p.locked, false), coalesce(p.name, '')
      into v_owner_locked, v_owner_name
      from public.profiles p where p.id = m.owner_id;
  end if;
  if v_owner_locked then
    return jsonb_build_object('ok', false, 'error', '该会议已暂停接收回执，请联系会议联系人');
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
      'invite_count',  jsonb_array_length(m.invite),
      'organizer',     v_owner_name
    ),
    'names', coalesce((
      select jsonb_agg(distinct x->>'name')
      from jsonb_array_elements(m.invite) x
      where coalesce(x->>'name', '') <> ''
    ), '[]'::jsonb)
  );
end $$;

create or replace function public.submit_response(
  p_token     text,
  p_name      text,
  p_attending boolean,
  p_reason    text default '',
  p_note      text default '',
  p_ua        text default ''
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m public.meetings;
  v_key text;
  v_hit jsonb;
  v_row public.responses;
  v_locked boolean := false;
begin
  select * into m from public.meetings where share_token = btrim(coalesce(p_token, ''));
  if not found then
    return jsonb_build_object('ok', false, 'error', '链接无效或会议已撤销');
  end if;

  if m.owner_id is not null then
    select locked into v_locked from public.profiles where id = m.owner_id;
    if coalesce(v_locked, false) then
      return jsonb_build_object('ok', false, 'error', '该会议已暂停接收回执');
    end if;
  end if;

  if m.deadline is not null and now() > m.deadline then
    return jsonb_build_object('ok', false, 'error', '本次填报已截止，如需变更请联系会议联系人');
  end if;

  p_name := btrim(coalesce(p_name, ''));
  if length(p_name) < 2 or length(p_name) > 20 then
    return jsonb_build_object('ok', false, 'error', '请填写本人真实姓名（2-20 字）');
  end if;

  v_key := lower(regexp_replace(p_name, '\s', '', 'g'));

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
-- 13. 授权
-- ------------------------------------------------------------
revoke all on function public.is_super() from public;
revoke all on function public.is_active_user() from public;
revoke all on function public.has_active_plan() from public;
revoke all on function public.handle_new_user() from public;
revoke all on function public.update_my_profile(text, text) from public;
revoke all on function public.purchase_plan(uuid) from public;
revoke all on function public.request_recharge(integer, text, text) from public;
revoke all on function public.admin_review_recharge(uuid, boolean, text) from public;
revoke all on function public.admin_adjust_balance(uuid, integer, text) from public;
revoke all on function public.admin_grant_plan(uuid, uuid, integer) from public;
revoke all on function public.open_meeting(text) from public;
revoke all on function public.submit_response(text, text, boolean, text, text, text) from public;
revoke all on function public.my_response(text, text) from public;

grant execute on function public.is_emp_no_taken(text)          to anon, authenticated;
grant execute on function public.open_meeting(text)             to anon, authenticated;
grant execute on function public.submit_response(text, text, boolean, text, text, text) to anon, authenticated;
grant execute on function public.my_response(text, text)        to anon, authenticated;
grant execute on function public.update_my_profile(text, text)  to authenticated;
grant execute on function public.purchase_plan(uuid)            to authenticated;
grant execute on function public.request_recharge(integer, text, text) to authenticated;
grant execute on function public.admin_review_recharge(uuid, boolean, text) to authenticated;
grant execute on function public.admin_adjust_balance(uuid, integer, text) to authenticated;
grant execute on function public.admin_grant_plan(uuid, uuid, integer)  to authenticated;
grant execute on function public.is_super()        to authenticated;
grant execute on function public.is_active_user()  to authenticated;
grant execute on function public.has_active_plan() to authenticated;

-- ------------------------------------------------------------
-- 14. 默认套餐（仅当套餐表为空时插入，之后在超管面板改价）
-- ------------------------------------------------------------
insert into public.plans (name, price_cents, duration_days, description, is_active, sort_no)
select * from (values
  ('月卡', 9900,  30,  '有效期内发布会议不限场次', true, 1),
  ('季卡', 26800, 90,  '比月卡更划算', true, 2),
  ('年卡', 89900, 365, '一年内不限场次', true, 3)
) as t(name, price_cents, duration_days, description, is_active, sort_no)
where not exists (select 1 from public.plans);

-- ------------------------------------------------------------
-- 15. ★ 必做：指定超级管理员
--     把你的工号填进去执行（只执行这一行，执行完删掉）
-- ------------------------------------------------------------
-- update public.profiles set is_super = true where emp_no = '你的工号';

-- 确认一下（应看到 is_super = t）：
-- select emp_no, name, email, is_super, locked, balance_cents, plan_expires_at
--   from public.profiles order by created_at;

-- ------------------------------------------------------------
-- 16. 可选：把 v1 时期的历史会议/名单归到某个用户名下
--     （v1 数据没有 owner_id，普通用户看不到，只有超管能看到）
-- ------------------------------------------------------------
-- update public.meetings set owner_id = (select id from public.profiles where emp_no = '你的工号')
--  where owner_id is null;
-- update public.roster set owner_id = (select id from public.profiles where emp_no = '你的工号')
--  where owner_id is null;

-- ------------------------------------------------------------
-- 17. 自检
-- ------------------------------------------------------------
-- select tablename, policyname, cmd from pg_policies
--  where schemaname = 'public' order by tablename, policyname;
-- select public.is_emp_no_taken('随便一个工号') as 工号是否已占用;
