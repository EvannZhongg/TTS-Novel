-- 修复 0001 里 revoke 过度收权的问题。
--
-- 事故经过: 0001 末尾写了
--     revoke all on all tables in schema public from anon, authenticated;
-- 意图是让 publishable key 读写被拒。但 Supabase 里 anon / authenticated /
-- service_role 的表权限是通过 GRANT 授予的，且 service_role 的 DML 权限与
-- 这条 revoke 存在交叉影响 —— 实测执行后 service_role 只剩
-- REFERENCES/TRIGGER/TRUNCATE，丢了 SELECT/INSERT/UPDATE/DELETE。
-- 后果是服务端(用 secret key)也读不了任何表，整个应用不可用。
--
-- 正确做法: 只靠 RLS 拦 anon —— 表已 enable row level security 且没有任何
-- policy，anon/authenticated 天然一行都读不到。不需要额外 revoke 表权限。
-- service_role 必须拿回完整 DML。

-- 恢复 service_role 的完整表权限
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

-- 未来新建的表/序列同样自动授予
alter default privileges in schema public
  grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public
  grant usage, select on sequences to service_role;

-- anon / authenticated: 保持无表权限。
-- 双重保险 —— 即使将来有人误加 policy，没有表权限也读不到。
-- (RLS 已开启且无 policy 是第一道防线)
grant usage on schema public to anon, authenticated;

-- 队列函数只允许服务端调用
grant execute on function public.claim_next_job(integer) to service_role;
grant execute on function public.finish_chapter_job(uuid, uuid, boolean, text) to service_role;
grant execute on function public.fail_job(uuid, text) to service_role;
grant execute on function public.finish_aggregate_job(uuid, uuid, jsonb) to service_role;
