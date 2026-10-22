-- ============================================================
--  诊断：为什么超管看不到某份名单
--  用法：Supabase → SQL Editor → 整段粘贴 → Run
-- ============================================================

-- 0) 我现在是谁？是不是超管？
select auth.uid() as 我的uid,
       (select emp_no from public.profiles where id = auth.uid()) as 我的工号,
       (select name   from public.profiles where id = auth.uid()) as 我的姓名,
       public.is_super() as 我是超管;

-- 1) 云端到底有谁上传过名单？（按归属人统计）
select r.owner_id,
       coalesce(p.name, '(无归属/历史数据)') as 归属人,
       coalesce(p.emp_no, '—')              as 工号,
       count(*)                             as 名单条数
  from public.roster r
  left join public.profiles p on p.id = r.owner_id
 group by r.owner_id, p.name, p.emp_no
 order by count(*) desc;

-- 2) 我自己的名单有多少条？
select count(*) as 我名下名单条数
  from public.roster
 where owner_id = auth.uid();

-- 3) 没有归属人的历史数据（v1 时期导入的）
select count(*) as 无归属名单条数
  from public.roster
 where owner_id is null;

-- 4) 超管能否看到全部（RLS 校验）
select count(*) as 超管可见总条数 from public.roster;
