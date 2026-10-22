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
-- 关闭函数体校验：脚本里函数之间互相引用时，不要求被调用的函数先定义。
set check_function_bodies = off;

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

-- v2.2：免费版操作配额（会员不受限）
--   quota_remind_used  = 已用「复制催办文本」次数（免费上限 10）
--   quota_promote_used = 已用「名单外人员一键加入名单」次数（免费上限 10）
alter table public.profiles add column if not exists quota_remind_used  integer not null default 0;
alter table public.profiles add column if not exists quota_promote_used integer not null default 0;

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
  emp_no       text not null default '',
  dept         text not null default '',
  category     text not null default '',
  attending    boolean not null,
  reason       text not null default '',
  note         text not null default '',
  on_list      boolean not null default false,
  promoted     boolean not null default false,
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
-- v2.1：回执增加工号，用于同名不同人时精确匹配
alter table public.responses add column if not exists emp_no text not null default '';
-- v2.2：是否已"一键加入名单"
alter table public.responses add column if not exists promoted boolean not null default false;
create index if not exists responses_emp_idx on public.responses (meeting_id, emp_no);

-- ------------------------------------------------------------
-- 5.1 v2.3：会场布局 + 签到
-- ------------------------------------------------------------
alter table public.meetings add column if not exists layout_enabled boolean not null default false;
alter table public.meetings add column if not exists checkin_start timestamptz;
alter table public.meetings add column if not exists checkin_end   timestamptz;

-- 每场会议最多一份布局（整块 JSON，含座位与人员绑定）
create table if not exists public.meeting_layouts (
  meeting_id  uuid primary key references public.meetings(id) on delete cascade,
  mode        text not null default 'grid',          -- grid(排座式) | free(自由布局)
  layout      jsonb not null default '{}'::jsonb,    -- 座位、场景、样式、seatKey->personKey 绑定
  updated_at  timestamptz not null default now()
);

-- 签到记录（与"参会回执"独立：回执=是否愿意来，签到=实际到场）
create table if not exists public.checkins (
  id            uuid primary key default gen_random_uuid(),
  meeting_id    uuid not null references public.meetings(id) on delete cascade,
  person_key    text not null,                      -- e:工号 或 n:姓名
  emp_no        text not null default '',
  name          text not null,
  seat_key      text not null default '',
  scene_name    text not null default '',
  seat_label    text not null default '',
  checked_in_at timestamptz not null default now(),
  source        text not null default 'link',       -- link | manual
  unique (meeting_id, person_key)
);
create index if not exists checkins_meeting_idx on public.checkins (meeting_id, checked_in_at desc);

-- 布局写入同样受"会员"限制；签到开关也一样
create or replace function public.check_layout_allowed()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_owner uuid;
begin
  select owner_id into v_owner from public.meetings where id = new.meeting_id;
  if not public.is_super() and not (v_owner = auth.uid() and public.has_active_plan()) then
    raise exception '会场布局是会员功能，请先购买套餐' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists trg_layout_quota on public.meeting_layouts;
create trigger trg_layout_quota before insert or update on public.meeting_layouts
  for each row execute function public.check_layout_allowed();


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
-- 6.1 免费版操作配额（会员/超管不受限）
--
--   两种配额，免费用户各 10 次：
--     remind  = 复制催办文本
--     promote = 把名单外参会人一键加入名单
--   计数只对"非会员"累加；买了套餐后再降级，计数保留但重新受限。
-- ------------------------------------------------------------
create or replace function public.free_quota_limit()
returns integer language sql immutable as $$ select 10 $$;

create or replace function public.quota_status()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_unlimited boolean;
  v_r integer := 0;
  v_p integer := 0;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', '请先登录');
  end if;
  v_unlimited := public.has_active_plan();
  select quota_remind_used, quota_promote_used into v_r, v_p
    from public.profiles where id = v_uid;

  return jsonb_build_object(
    'ok', true,
    'unlimited', v_unlimited,
    'limit', public.free_quota_limit(),
    'remind',  jsonb_build_object('used', coalesce(v_r, 0),
                 'left', greatest(0, public.free_quota_limit() - coalesce(v_r, 0))),
    'promote', jsonb_build_object('used', coalesce(v_p, 0),
                 'left', greatest(0, public.free_quota_limit() - coalesce(v_p, 0)))
  );
end $$;

-- 消耗一次配额。p_kind = 'remind' | 'promote'
create or replace function public.consume_quota(p_kind text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_kind text := lower(btrim(coalesce(p_kind, '')));
  v_used integer;
  v_lim  integer := public.free_quota_limit();
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', '请先登录');
  end if;

  -- 会员 / 超管：不计数、不限制
  if public.has_active_plan() then
    return jsonb_build_object('ok', true, 'unlimited', true);
  end if;

  if v_kind = 'remind' then
    update public.profiles
       set quota_remind_used = quota_remind_used + 1
     where id = v_uid and quota_remind_used < v_lim
     returning quota_remind_used into v_used;
  elsif v_kind = 'promote' then
    update public.profiles
       set quota_promote_used = quota_promote_used + 1
     where id = v_uid and quota_promote_used < v_lim
     returning quota_promote_used into v_used;
  else
    return jsonb_build_object('ok', false, 'error', '未知的配额类型');
  end if;

  if v_used is null then
    return jsonb_build_object('ok', false, 'exhausted', true,
      'error', case when v_kind = 'remind'
                 then '免费版「复制催办文本」已用完 10 次，购买套餐后可不限次数使用'
                 else '免费版「一键加入名单」已用完 10 次，购买套餐后可不限次数使用' end);
  end if;

  return jsonb_build_object('ok', true, 'unlimited', false,
    'used', v_used, 'left', greatest(0, v_lim - v_used), 'limit', v_lim);
end $$;

-- 把某个"名单外"参会人一步加入自己的名单（原子操作：先校验、再扣配额、再写入）
create or replace function public.promote_response_to_roster(p_response_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid   uuid := auth.uid();
  v_resp  public.responses;
  v_owner uuid;
  v_already boolean;
  v_sort  integer;
  v_q     jsonb;
  v_emp   text;
  v_dept  text;
  v_cat   text;
  v_name  text;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', '请先登录');
  end if;

  -- 只能操作自己会议的参会记录（超管除外）
  select r.* into v_resp
    from public.responses r
    join public.meetings m on m.id = r.meeting_id
   where r.id = p_response_id
     and (m.owner_id = v_uid or public.is_super());
  if not found then
    return jsonb_build_object('ok', false, 'error', '找不到这条参会记录，或它不属于你的会议');
  end if;

  if coalesce(v_resp.on_list, false) then
    return jsonb_build_object('ok', false, 'error', '这个人本来就在受邀名单里，不需要再加入');
  end if;

  v_name := btrim(coalesce(v_resp.name_raw, ''));
  v_emp  := btrim(coalesce(v_resp.emp_no, ''));
  v_dept := btrim(coalesce(v_resp.dept, ''));
  v_cat  := btrim(coalesce(v_resp.category, ''));
  if v_name = '' then
    return jsonb_build_object('ok', false, 'error', '这条记录没有姓名，无法加入名单');
  end if;

  -- 已经在名单里（同工号，或同部门同姓名）→ 直接标记，不扣配额
  select exists (
    select 1 from public.roster
     where owner_id = v_uid
       and (
         (v_emp <> '' and lower(btrim(coalesce(emp_no, ''))) = lower(v_emp))
         or (v_emp = '' and name = v_name and coalesce(dept, '') = v_dept)
       )
  ) into v_already;

  if v_already then
    update public.responses set promoted = true where id = p_response_id;
    return jsonb_build_object('ok', true, 'already', true, 'message', '这个人已经在你的名单里了');
  end if;

  -- 扣配额（会员不计数）
  v_q := public.consume_quota('promote');
  if not coalesce((v_q->>'ok')::boolean, false) then
    return v_q;
  end if;

  select coalesce(max(sort_no), 0) + 1 into v_sort
    from public.roster where owner_id = v_uid;

  insert into public.roster as ro (owner_id, emp_no, dept, category, name, sort_no, active)
  values (v_uid, v_emp, v_dept, v_cat, v_name, v_sort, true)
  on conflict (owner_id, dept, category, name) do update
    set emp_no = case when excluded.emp_no = '' then ro.emp_no else excluded.emp_no end,
        active = true,
        updated_at = now();

  update public.responses set promoted = true where id = p_response_id;

  return jsonb_build_object('ok', true, 'already', false,
    'quota', v_q,
    'added', jsonb_build_object('name', v_name, 'emp_no', v_emp, 'dept', v_dept, 'category', v_cat));
end $$;

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

  -- 新用户不赠送任何套餐：注册后即处于"免费额度"
  -- （需要给某个用户开通体验/赠送，由超级管理员在面板里操作）
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
-- 10. 发布会议的额度校验（数据库层强制，前端绕不过去）
--
--   规则（2026 版）：
--     · 账号被锁定            → 一律不能发布
--     · 超级管理员            → 不受限制
--     · 套餐有效            → 不限场次、不限邀请人数
--     · 免费 / 套餐已过期      → 最多 1 场会议，单场最多 20 人
-- ------------------------------------------------------------
create or replace function public.check_meeting_allowed()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_locked boolean;
  v_exp    timestamptz;
  v_count  integer;
  v_invite integer;
begin
  select locked, plan_expires_at into v_locked, v_exp
    from public.profiles where id = new.owner_id;

  if coalesce(v_locked, false) then
    raise exception '账号已被锁定，无法发布会议' using errcode = '42501';
  end if;

  -- 超级管理员与有效期内的会员：不受限制
  if public.is_super() or (v_exp is not null and v_exp > now()) then
    return new;
  end if;

  -- 免费额度
  select count(*) into v_count from public.meetings where owner_id = new.owner_id;
  if v_count >= 1 then
    raise exception '免费额度已用完：未开通套餐最多发布 1 场会议，请到「我的账户」购买套餐后继续'
      using errcode = '42501';
  end if;

  v_invite := coalesce(jsonb_array_length(new.invite), 0);
  if v_invite > 20 then
    raise exception '免费额度限制：单场最多邀请 20 人（当前 % 人），购买套餐后不限人数', v_invite
      using errcode = '42501';
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
      'layout_enabled', m.layout_enabled,
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

-- v2.1：签名增加 p_emp_no（工号）。旧签名先删掉，避免 PostgREST 出现重载歧义。
drop function if exists public.submit_response(text, text, boolean, text, text, text);
drop function if exists public.my_response(text, text);

create or replace function public.submit_response(
  p_token     text,
  p_name      text,
  p_attending boolean,
  p_reason    text default '',
  p_note      text default '',
  p_ua        text default '',
  p_emp_no    text default ''
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m public.meetings;
  v_key text;
  v_emp text;
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

  v_emp := lower(btrim(coalesce(p_emp_no, '')));
  if length(v_emp) < 1 or length(v_emp) > 30 then
    return jsonb_build_object('ok', false, 'error', '请填写你的工号（用于区分同名人员）');
  end if;

  -- ① 优先按工号匹配受邀名单：同名不同人不会互相覆盖
  select x into v_hit
  from jsonb_array_elements(m.invite) x
  where lower(btrim(coalesce(x->>'emp_no', ''))) = v_emp
  limit 1;

  -- ② 名单里没填工号的老数据，退一步按姓名匹配
  if v_hit is null then
    select x into v_hit
    from jsonb_array_elements(m.invite) x
    where lower(regexp_replace(coalesce(x->>'name', ''), '\s', '', 'g'))
        = lower(regexp_replace(p_name, '\s', '', 'g'))
    limit 1;
  end if;

  -- 去重键：有工号就以工号为准，否则用姓名
  v_key := case when v_emp <> ''
                then v_emp
                else lower(regexp_replace(p_name, '\s', '', 'g')) end;

  insert into public.responses as r
    (meeting_id, name_key, name_raw, emp_no, dept, category, attending, reason, note, on_list, user_agent)
  values
    (m.id, v_key, p_name, v_emp,
     coalesce(v_hit->>'dept', ''), coalesce(v_hit->>'category', ''),
     coalesce(p_attending, false), btrim(coalesce(p_reason, '')), btrim(coalesce(p_note, '')),
     (v_hit is not null), left(coalesce(p_ua, ''), 300))
  on conflict (meeting_id, name_key) do update set
    name_raw   = excluded.name_raw,
    emp_no     = case when excluded.emp_no = '' then r.emp_no else excluded.emp_no end,
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
    'emp_no', v_row.emp_no,
    'on_list', v_row.on_list,
    'updated_at', v_row.updated_at,
    'message', case when v_row.attending then '已记录：您将按时参会' else '已记录：您不参会' end
  );
end $$;

-- 回看/带出本人上次答复：给了工号就按工号找（同名也认得出是谁）
create or replace function public.my_response(p_token text, p_name text, p_emp_no text default '')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  m public.meetings;
  v_row public.responses;
  v_emp text := lower(btrim(coalesce(p_emp_no, '')));
begin
  select * into m from public.meetings where share_token = btrim(coalesce(p_token, ''));
  if not found then
    return jsonb_build_object('ok', false, 'error', '链接无效');
  end if;

  if v_emp <> '' then
    select * into v_row from public.responses
     where meeting_id = m.id
       and (name_key = v_emp or emp_no = v_emp)
     limit 1;
  end if;

  if v_row.id is null then
    select * into v_row from public.responses
     where meeting_id = m.id
       and name_key = lower(regexp_replace(btrim(coalesce(p_name, '')), '\s', '', 'g'))
     limit 1;
  end if;

  if v_row.id is null then
    return jsonb_build_object('ok', true, 'found', false);
  end if;

  return jsonb_build_object(
    'ok', true, 'found', true,
    'attending', v_row.attending, 'reason', v_row.reason,
    'note', v_row.note, 'updated_at', v_row.updated_at, 'emp_no', v_row.emp_no
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
revoke all on function public.submit_response(text, text, boolean, text, text, text, text) from public;
revoke all on function public.my_response(text, text, text) from public;
revoke all on function public.quota_status() from public;
revoke all on function public.consume_quota(text) from public;
revoke all on function public.promote_response_to_roster(uuid) from public;

grant execute on function public.is_emp_no_taken(text)          to anon, authenticated;
grant execute on function public.open_meeting(text)             to anon, authenticated;
grant execute on function public.submit_response(text, text, boolean, text, text, text, text) to anon, authenticated;
grant execute on function public.my_response(text, text, text)  to anon, authenticated;
grant execute on function public.quota_status()                 to authenticated;
grant execute on function public.consume_quota(text)            to authenticated;
grant execute on function public.promote_response_to_roster(uuid) to authenticated;
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
-- 16.1 可选：撤销早期版本自动赠送的「新用户 7 天体验」
--      新版本已不再赠送体验。如果之前注册过的人还带着体验期，执行下面这句清掉：
-- ------------------------------------------------------------
-- update public.profiles
--    set plan_expires_at = null
--  where note = '新用户 7 天体验'
--    and plan_expires_at is not null;

-- ------------------------------------------------------------
-- 17. 自检
-- ------------------------------------------------------------
-- select tablename, policyname, cmd from pg_policies
--  where schemaname = 'public' order by tablename, policyname;
-- select public.is_emp_no_taken('随便一个工号') as 工号是否已占用;

-- ============================================================
-- 18. v2.3 会场布局 + 签到
--     布局写入受会员限制（见 5.1 的 trg_layout_quota）；
--     签到是"匿名可参与"的：凭 share_token，不需要登录。
-- ============================================================

-- 18.1 安全策略
alter table public.meeting_layouts enable row level security;
alter table public.checkins         enable row level security;

drop policy if exists layout_owner_all on public.meeting_layouts;
drop policy if exists checkin_owner_all on public.checkins;

create policy layout_owner_all on public.meeting_layouts
  for all to authenticated
  using (exists (select 1 from public.meetings m
                  where m.id = meeting_layouts.meeting_id
                    and (m.owner_id = auth.uid() or public.is_super())))
  with check (exists (select 1 from public.meetings m
                  where m.id = meeting_layouts.meeting_id
                    and (m.owner_id = auth.uid() or public.is_super())));

create policy checkin_owner_all on public.checkins
  for all to authenticated
  using (exists (select 1 from public.meetings m
                  where m.id = checkins.meeting_id
                    and (m.owner_id = auth.uid() or public.is_super())))
  with check (exists (select 1 from public.meetings m
                  where m.id = checkins.meeting_id
                    and (m.owner_id = auth.uid() or public.is_super())));

-- 18.2 由 token 找到会议（内部用）
create or replace function public.meeting_by_token(p_token text)
returns public.meetings language sql stable security definer set search_path = public as $$
  select * from public.meetings where share_token = btrim(coalesce(p_token, ''));
$$;

-- 18.3 人员键：有工号用工号，否则用姓名
create or replace function public.person_key_of(p_emp_no text, p_name text)
returns text language sql immutable as $$
  select case
    when btrim(coalesce(p_emp_no, '')) <> '' then 'e:' || lower(btrim(p_emp_no))
    else 'n:' || lower(regexp_replace(btrim(coalesce(p_name, '')), '\s', '', 'g'))
  end;
$$;

-- 18.4 从布局里查某人的座位（返回 {seat_key, seat_label, scene_name}）
create or replace function public.seat_of_person(p_layout jsonb, p_person_key text)
returns jsonb language plpgsql immutable as $$
declare
  v_key text;
  v_seat jsonb;
  v_scene text := '';
begin
  if p_layout is null or p_person_key is null then
    return jsonb_build_object('seat_key','', 'seat_label','', 'scene_name','');
  end if;

  select k into v_key
    from jsonb_each_text(coalesce(p_layout->'assign', '{}'::jsonb)) as t(k, v)
   where t.v = p_person_key
   limit 1;

  if v_key is null then
    return jsonb_build_object('seat_key','', 'seat_label','', 'scene_name','');
  end if;

  select s into v_seat
    from jsonb_array_elements(coalesce(p_layout->'seats','[]'::jsonb)) s
   where s->>'key' = v_key
   limit 1;

  if v_seat is not null then
    v_scene := coalesce(v_seat->>'sceneName', '');
    return jsonb_build_object(
      'seat_key',   v_key,
      'seat_label', coalesce(v_seat->>'label', ''),
      'scene_name', v_scene
    );
  end if;

  return jsonb_build_object('seat_key', v_key, 'seat_label','', 'scene_name','');
end $$;

-- 18.4.1 双键查座（放在 seat_of_person 之后，避免"函数不存在"）：名单里没录工号时，参会人自己填的工号也要能对上
create or replace function public.seat_of_person_any(p_layout jsonb, p_emp_no text, p_name text)
returns jsonb language sql immutable as $$
  select case
    when public.seat_of_person(p_layout, 'e:' || lower(btrim(coalesce(p_emp_no, ''))))->>'seat_key' <> ''
      then public.seat_of_person(p_layout, 'e:' || lower(btrim(coalesce(p_emp_no, ''))))
    else public.seat_of_person(p_layout, 'n:' || lower(regexp_replace(btrim(coalesce(p_name, '')), '\s', '', 'g')))
  end;
$$;

-- 18.5 签到是否开放
create or replace function public.checkin_is_open(p_m public.meetings)
returns boolean language sql stable as $$
  select p_m.layout_enabled
     and (p_m.checkin_start is null or now() >= p_m.checkin_start)
     and (p_m.checkin_end   is null or now() <= p_m.checkin_end);
$$;

-- 18.6 参会人查询签到状态 + 自己的座位
create or replace function public.checkin_info(p_token text, p_emp_no text default '', p_name text default '')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  m public.meetings;
  v_pk text;
  v_ci public.checkins;
  v_seat jsonb := jsonb_build_object('seat_key','','seat_label','','scene_name','');
begin
  select * into m from public.meetings where share_token = btrim(coalesce(p_token, ''));
  if not found then
    return jsonb_build_object('ok', false, 'error', '链接无效');
  end if;

  v_pk := public.person_key_of(p_emp_no, p_name);

  select * into v_ci from public.checkins
   where meeting_id = m.id
     and (person_key = v_pk
          or (coalesce(p_emp_no,'') <> '' and person_key = 'e:' || lower(btrim(p_emp_no)))
          or (coalesce(p_name,'') <> '' and name = btrim(p_name)))
   limit 1;

  if v_ci.id is not null then
    return jsonb_build_object('ok', true,
      'layout_enabled', m.layout_enabled,
      'open', false,
      'checked_in', true,
      'checked_in_at', v_ci.checked_in_at,
      'seat', jsonb_build_object('seat_key', v_ci.seat_key,
                                 'seat_label', v_ci.seat_label,
                                 'scene_name', v_ci.scene_name));
  end if;

  -- 没签到过，但布局里已经给他排了座，先告诉他座位在哪
  if m.layout_enabled then
     select public.seat_of_person_any(l.layout, p_emp_no, p_name) into v_seat
     from public.meeting_layouts l where l.meeting_id = m.id;
  end if;

  return jsonb_build_object('ok', true,
    'layout_enabled', m.layout_enabled,
    'open', public.checkin_is_open(m),
    'checked_in', false,
    'start', m.checkin_start,
    'end', m.checkin_end,
    'person_key', v_pk,
    'seat', coalesce(v_seat, jsonb_build_object('seat_key','','seat_label','','scene_name','')));
end $$;

-- 18.7 提交签到
create or replace function public.submit_checkin(p_token text, p_emp_no text, p_name text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m public.meetings;
  v_ci public.checkins;
  v_locked boolean := false;
  v_pk text;
  v_name text := btrim(coalesce(p_name, ''));
  v_seat jsonb := jsonb_build_object('seat_key','','seat_label','','scene_name','');
begin
  select * into m from public.meetings where share_token = btrim(coalesce(p_token, ''));
  if not found then
    return jsonb_build_object('ok', false, 'error', '链接无效或会议已撤销');
  end if;

  if m.owner_id is not null then
    select locked into v_locked from public.profiles where id = m.owner_id;
    if coalesce(v_locked, false) then
      return jsonb_build_object('ok', false, 'error', '该会议已暂停');
    end if;
  end if;

  if not m.layout_enabled then
    return jsonb_build_object('ok', false, 'error', '这场会议没有开启签到');
  end if;
  if not public.checkin_is_open(m) then
    return jsonb_build_object('ok', false,
      'error', case when m.checkin_start is not null and now() < m.checkin_start
                 then '签到还没开始，开放时间：' || to_char(m.checkin_start, 'YYYY-MM-DD HH24:MI')
                 else '签到已截止' end);
  end if;

  if length(v_name) < 2 or length(v_name) > 20 then
    return jsonb_build_object('ok', false, 'error', '请填写本人真实姓名（2-20 字）');
  end if;
  if btrim(coalesce(p_emp_no, '')) = '' then
    return jsonb_build_object('ok', false, 'error', '请填写你的工号');
  end if;

  v_pk := public.person_key_of(p_emp_no, v_name);

   select public.seat_of_person_any(l.layout, p_emp_no, v_name) into v_seat
   from public.meeting_layouts l where l.meeting_id = m.id;

  insert into public.checkins as c
    (meeting_id, person_key, emp_no, name, seat_key, scene_name, seat_label, source)
  values
    (m.id, v_pk, lower(btrim(p_emp_no)), v_name,
     coalesce(v_seat->>'seat_key',''), coalesce(v_seat->>'scene_name',''),
     coalesce(v_seat->>'seat_label',''), 'link')
  on conflict (meeting_id, person_key) do update
    set name = excluded.name,
        emp_no = excluded.emp_no,
        seat_key = case when excluded.seat_key = '' then c.seat_key else excluded.seat_key end,
        scene_name = case when excluded.scene_name = '' then c.scene_name else excluded.scene_name end,
        seat_label = case when excluded.seat_label = '' then c.seat_label else excluded.seat_label end
  returning * into v_ci;

  return jsonb_build_object('ok', true,
    'checked_in_at', v_ci.checked_in_at,
    'name', v_ci.name,
    'seat', jsonb_build_object('seat_key', v_ci.seat_key,
                               'seat_label', v_ci.seat_label,
                               'scene_name', v_ci.scene_name));
end $$;

-- 18.8 参会人查看座位图（只给几何 + 自己那一格，不下发别人姓名）
create or replace function public.seat_map(p_token text, p_emp_no text default '', p_name text default '')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  m public.meetings;
  v_pk text;
  v_layout jsonb;
  v_seat jsonb;
  v_style jsonb;
begin
  select * into m from public.meetings where share_token = btrim(coalesce(p_token, ''));
  if not found then
    return jsonb_build_object('ok', false, 'error', '链接无效');
  end if;
  if not m.layout_enabled then
    return jsonb_build_object('ok', false, 'error', '这场会议没有座位图');
  end if;

  select layout into v_layout from public.meeting_layouts where meeting_id = m.id;
  if v_layout is null then
    return jsonb_build_object('ok', false, 'error', '会议还没有排座位');
  end if;

  v_pk := public.person_key_of(p_emp_no, p_name);
  v_seat := public.seat_of_person_any(v_layout, p_emp_no, p_name);

  return jsonb_build_object(
    'ok', true,
    'mode', coalesce(v_layout->>'mode', 'grid'),
    'style', coalesce(v_layout->'style', '{}'::jsonb),
    'canvas', coalesce(v_layout->'canvas', '{}'::jsonb),
    'seats', coalesce(v_layout->'seats', '[]'::jsonb),      -- 只有几何与标签，没有姓名
    'scenes', coalesce(v_layout->'scenes', '[]'::jsonb),
    'my_seat_key', coalesce(v_seat->>'seat_key',''),
    'my_seat_label', coalesce(v_seat->>'seat_label',''),
    'my_scene_name', coalesce(v_seat->>'scene_name','')
  );
end $$;

-- 18.9 授权
revoke all on function public.meeting_by_token(text) from public;
revoke all on function public.seat_of_person(jsonb, text) from public;
revoke all on function public.checkin_is_open(public.meetings) from public;
revoke all on function public.checkin_info(text, text, text) from public;
revoke all on function public.submit_checkin(text, text, text) from public;
revoke all on function public.seat_map(text, text, text) from public;
grant execute on function public.checkin_info(text, text, text)  to anon, authenticated;
grant execute on function public.submit_checkin(text, text, text) to anon, authenticated;
grant execute on function public.seat_map(text, text, text)      to anon, authenticated;

-- ============================================================
-- 19. v2.5 签到自动分座（按分区优先、随机、加锁防抢座）
-- ============================================================

-- 一个座位只能被一个人签到占用
drop index if exists public.checkins_seat_uniq;
create unique index if not exists checkins_seat_uniq
  on public.checkins (meeting_id, seat_key) where seat_key <> '';

-- 按"单位分区 / 身份分区 / 未分区"依次找一个空座
create or replace function public.pick_auto_seat(
  p_layout jsonb, p_meeting uuid, p_dept text, p_cat text)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_taken text[];
  v_row record;
  v_zones text[] := array[]::text[];
begin
  select coalesce(array_agg(seat_key), array[]::text[]) into v_taken
    from public.checkins
   where meeting_id = p_meeting and seat_key <> '';

  if btrim(coalesce(p_dept,'')) <> '' then
    v_zones := v_zones || ('单位·' || btrim(p_dept));
  end if;
  if btrim(coalesce(p_cat,'')) <> '' then
    v_zones := v_zones || ('身份·' || btrim(p_cat));
  end if;

  -- 1) 本区空座
  if array_length(v_zones, 1) > 0 then
    select s into v_row
      from jsonb_array_elements(coalesce(p_layout->'seats','[]'::jsonb)) s
     where coalesce(p_layout->'zoneMap'->>(s->>'key'), '') = any(v_zones)
       and not ((s->>'key') = any(v_taken))
     order by random() limit 1;
    if v_row.s is not null then
      return jsonb_build_object('seat_key', v_row.s->>'key',
        'seat_label', coalesce(v_row.s->>'label',''),
        'scene_name', coalesce(v_row.s->>'sceneName',''),
        'auto', true, 'matched', 'zone');
    end if;
  end if;

  -- 2) 未分区空座
  select s into v_row
    from jsonb_array_elements(coalesce(p_layout->'seats','[]'::jsonb)) s
   where coalesce(p_layout->'zoneMap'->>(s->>'key'), '') = ''
     and not ((s->>'key') = any(v_taken))
   order by random() limit 1;
  if v_row.s is not null then
    return jsonb_build_object('seat_key', v_row.s->>'key',
      'seat_label', coalesce(v_row.s->>'label',''),
      'scene_name', coalesce(v_row.s->>'sceneName',''),
      'auto', true, 'matched', 'free');
  end if;

  -- 3) 任何一个空座
  select s into v_row
    from jsonb_array_elements(coalesce(p_layout->'seats','[]'::jsonb)) s
   where not ((s->>'key') = any(v_taken))
   order by random() limit 1;
  if v_row.s is not null then
    return jsonb_build_object('seat_key', v_row.s->>'key',
      'seat_label', coalesce(v_row.s->>'label',''),
      'scene_name', coalesce(v_row.s->>'sceneName',''),
      'auto', true, 'matched', 'any');
  end if;

  return jsonb_build_object('seat_key','','seat_label','','scene_name','','auto', false, 'full', true);
end $$;

revoke all on function public.pick_auto_seat(jsonb, uuid, text, text) from public;
grant execute on function public.pick_auto_seat(jsonb, uuid, text, text) to authenticated;

-- 重写 submit_checkin：没固定座位就自动分
create or replace function public.submit_checkin(p_token text, p_emp_no text, p_name text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  m public.meetings;
  v_ci public.checkins;
  v_locked boolean := false;
  v_pk text;
  v_name text := btrim(coalesce(p_name, ''));
  v_layout jsonb;
  v_seat jsonb;
  v_dept text := '';
  v_cat  text := '';
  v_hit  jsonb;
  v_auto boolean := false;
begin
  select * into m from public.meetings where share_token = btrim(coalesce(p_token, ''));
  if not found then
    return jsonb_build_object('ok', false, 'error', '链接无效或会议已撤销');
  end if;

  if m.owner_id is not null then
    select locked into v_locked from public.profiles where id = m.owner_id;
    if coalesce(v_locked, false) then
      return jsonb_build_object('ok', false, 'error', '该会议已暂停');
    end if;
  end if;

  if not m.layout_enabled then
    return jsonb_build_object('ok', false, 'error', '这场会议没有开启签到');
  end if;
  if not public.checkin_is_open(m) then
    return jsonb_build_object('ok', false,
      'error', case when m.checkin_start is not null and now() < m.checkin_start
                 then '签到还没开始，开放时间：' || to_char(m.checkin_start, 'YYYY-MM-DD HH24:MI')
                 else '签到已截止' end);
  end if;

  if length(v_name) < 2 or length(v_name) > 20 then
    return jsonb_build_object('ok', false, 'error', '请填写本人真实姓名（2-20 字）');
  end if;
  if btrim(coalesce(p_emp_no, '')) = '' then
    return jsonb_build_object('ok', false, 'error', '请填写你的工号');
  end if;

  v_pk := public.person_key_of(p_emp_no, v_name);

  -- 锁住布局，避免两个人同时抢到同一个座位
  select layout into v_layout from public.meeting_layouts
   where meeting_id = m.id for update;

  -- 已有固定座位？
  v_seat := public.seat_of_person_any(v_layout, p_emp_no, v_name);

  -- 没排座：按单位/身份分区随机分一个
  if coalesce(v_seat->>'seat_key','') = '' then
    select s into v_hit
      from jsonb_array_elements(coalesce(m.invite,'[]'::jsonb)) s
     where lower(btrim(coalesce(s->>'emp_no',''))) = lower(btrim(p_emp_no))
        or lower(btrim(coalesce(s->>'name',''))) = lower(v_name)
     limit 1;
    if v_hit is not null then
      v_dept := coalesce(v_hit->>'dept','');
      v_cat  := coalesce(v_hit->>'category','');
    end if;

    v_seat := public.pick_auto_seat(v_layout, m.id, v_dept, v_cat);
    if coalesce(v_seat->>'full', false) then
      return jsonb_build_object('ok', true, 'checked_in_at', now(), 'name', v_name,
        'seat', jsonb_build_object('seat_key','','seat_label','','scene_name',''),
        'warning', '现场座位已满，请联系工作人员');
    end if;
    v_auto := true;
  end if;

  insert into public.checkins as c
    (meeting_id, person_key, emp_no, name, seat_key, scene_name, seat_label, source)
  values
    (m.id, v_pk, lower(btrim(p_emp_no)), v_name,
     coalesce(v_seat->>'seat_key',''), coalesce(v_seat->>'scene_name',''),
     coalesce(v_seat->>'seat_label',''), 'link')
  on conflict (meeting_id, person_key) do update
    set name = excluded.name,
        emp_no = excluded.emp_no,
        seat_key = case when excluded.seat_key = '' then c.seat_key else excluded.seat_key end,
        scene_name = case when excluded.scene_name = '' then c.scene_name else excluded.scene_name end,
        seat_label = case when excluded.seat_label = '' then c.seat_label else excluded.seat_label end
  returning * into v_ci;

  return jsonb_build_object('ok', true,
    'checked_in_at', v_ci.checked_in_at,
    'name', v_ci.name,
    'auto_seat', v_auto,
    'seat', jsonb_build_object('seat_key', v_ci.seat_key,
                               'seat_label', v_ci.seat_label,
                               'scene_name', v_ci.scene_name));
end $$;

revoke all on function public.submit_checkin(text, text, text) from public;
grant execute on function public.submit_checkin(text, text, text) to anon, authenticated;

-- ============================================================
-- 20. v2.6 会议室布局模板（可复用）
-- ============================================================
create table if not exists public.layout_templates (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null,
  name       text not null,
  mode       text not null default 'grid',
  layout     jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, name)
);
create index if not exists layout_templates_owner_idx on public.layout_templates (owner_id, created_at desc);

alter table public.layout_templates enable row level security;
drop policy if exists layout_tpl_owner_all on public.layout_templates;
create policy layout_tpl_owner_all on public.layout_templates
  for all to authenticated
  using (owner_id = auth.uid() or public.is_super())
  with check (owner_id = auth.uid() or public.is_super());

-- 保存/覆盖模板（owner 由服务端取当前登录用户，前端不用传 uid）
create or replace function public.save_layout_template(p_name text, p_mode text, p_layout jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_row public.layout_templates;
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', '请先登录');
  end if;
  if btrim(coalesce(p_name, '')) = '' then
    return jsonb_build_object('ok', false, 'error', '模板名不能为空');
  end if;

  insert into public.layout_templates (owner_id, name, mode, layout)
  values (v_uid, btrim(p_name), coalesce(nullif(p_mode, ''), 'grid'), coalesce(p_layout, '{}'::jsonb))
  on conflict (owner_id, name) do update
    set mode = excluded.mode, layout = excluded.layout, updated_at = now()
  returning * into v_row;

  return jsonb_build_object('ok', true, 'id', v_row.id, 'name', v_row.name);
end $$;

revoke all on function public.save_layout_template(text, text, jsonb) from public;
grant execute on function public.save_layout_template(text, text, jsonb) to authenticated;

-- ============================================================
-- 21. v2.7 超管"以普通会员身份预览"
--     开启后：自己的账号按真实套餐算额度（1场/20人/10次/导出）
--     关闭后：恢复超管不限额度
--     注意：只是额度按普通会员算，看别人数据的管理权限不受影响
-- ============================================================
alter table public.profiles add column if not exists preview_member boolean not null default false;

create or replace function public.in_preview()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select p.preview_member from public.profiles p where p.id = auth.uid()), false);
$$;

-- 生效中的"管理员特权"：是超管且没开预览
create or replace function public.is_super_eff()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_super() and not public.in_preview();
$$;

-- 会员资格：管理员（未开预览）或套餐有效
create or replace function public.has_active_plan()
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_super_eff()
      or coalesce((select p.plan_expires_at > now() from public.profiles p where p.id = auth.uid()), false);
$$;

create or replace function public.set_preview_mode(p_on boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    return jsonb_build_object('ok', false, 'error', '请先登录');
  end if;
  if not public.is_super() then
    return jsonb_build_object('ok', false, 'error', '只有超级管理员可以使用身份预览');
  end if;
  update public.profiles set preview_member = coalesce(p_on, false) where id = v_uid;
  return jsonb_build_object('ok', true, 'preview', coalesce(p_on, false),
    'plan_active', public.has_active_plan());
end $$;

revoke all on function public.in_preview() from public;
revoke all on function public.is_super_eff() from public;
revoke all on function public.set_preview_mode(boolean) from public;
grant execute on function public.in_preview()      to authenticated;
grant execute on function public.is_super_eff()    to authenticated;
grant execute on function public.set_preview_mode(boolean) to authenticated;

-- 发布会议 / 保存布局 的额度判断改用"生效中的管理员特权"
create or replace function public.check_meeting_allowed()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_count integer;
  v_invite integer;
begin
  if public.is_super_eff() then return new; end if;
  select count(*) into v_count from public.meetings where owner_id = new.owner_id;
  if not public.has_active_plan() and v_count >= 1 then
    raise exception '免费额度已用完：未开通套餐最多发布 1 场会议，购买套餐后不限场次' using errcode = '42501';
  end if;
  v_invite := coalesce(jsonb_array_length(new.invite), 0);
  if not public.has_active_plan() and v_invite > 20 then
    raise exception '免费额度限制：单场最多邀请 20 人（当前 % 人），购买套餐后不限人数', v_invite
      using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function public.check_layout_allowed()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_owner uuid;
begin
  select owner_id into v_owner from public.meetings where id = new.meeting_id;
  if not public.is_super_eff() and not (v_owner = auth.uid() and public.has_active_plan()) then
    raise exception '会场布局是会员功能，请先购买套餐' using errcode = '42501';
  end if;
  return new;
end $$;


-- ============================================================
-- 22. v2.8 会议回收站（删除后保留 30 天，可恢复/彻底删除）
-- ============================================================
create table if not exists public.meetings_trash (
  id         uuid primary key,
  owner_id   uuid,
  title      text not null default '',
  data       jsonb not null,
  deleted_at timestamptz not null default now()
);
create index if not exists meetings_trash_owner_idx on public.meetings_trash (owner_id, deleted_at desc);

alter table public.meetings_trash enable row level security;
drop policy if exists trash_owner_all on public.meetings_trash;
create policy trash_owner_all on public.meetings_trash
  for all to authenticated
  using (owner_id = auth.uid() or public.is_super())
  with check (owner_id = auth.uid() or public.is_super());

-- 恢复会议（并把它从回收站移除）
create or replace function public.restore_meeting(p_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_row public.meetings_trash;
begin
  select * into v_row from public.meetings_trash where id = p_id;
  if not found then
    return jsonb_build_object('ok', false, 'error', '回收站里没有这场会议');
  end if;
  if not public.is_super() and v_row.owner_id <> auth.uid() then
    return jsonb_build_object('ok', false, 'error', '无权恢复');
  end if;
  insert into public.meetings select * from jsonb_populate_record(null::public.meetings, v_row.data)
   on conflict (id) do nothing;
  delete from public.meetings_trash where id = p_id;
  return jsonb_build_object('ok', true);
end $$;

revoke all on function public.restore_meeting(uuid) from public;
grant execute on function public.restore_meeting(uuid) to authenticated;
