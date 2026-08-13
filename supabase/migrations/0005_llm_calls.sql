-- LLM 调用日志 + 日志保留策略。
--
-- 目的:
--   1. 记录 token 用量 —— 这是付费 API 最有价值的数据, 而当前代码把
--      响应里的 usage 字段直接丢掉了(llm.ts 只读 choices[0].message.content)。
--   2. 失败可定位: 上游连接失败不是业务 bug, 但需要知道"哪些调用失败了、
--      失败前发的是什么 prompt", 才能判断是上游抖动还是 prompt 有问题。
--
-- 体量取舍(基于实测: 约 3.5 次调用/章, 单次 prompt+响应约 4.4KB):
--   全量存 prompt+响应 -> 100 用户 × 400 章 ≈ 603 MB
--   只存指标 + 失败片段 -> 同规模 ≈ 27 MB
-- 所以成功的调用只留指标, 失败的才留 2000 字截断片段。

create table if not exists public.llm_calls (
  id          bigserial primary key,
  project_id  uuid references public.projects(id) on delete cascade,
  chapter_id  uuid references public.chapters(id) on delete set null,
  job_id      uuid references public.jobs(id) on delete set null,

  -- 哪一类调用: dialogue_span_extraction / chapter_title_validation /
  -- quote_span_recovery / role_voice_profile / role_voice_profile_minor_group
  purpose     text not null,
  model       text,
  status      text not null check (status in ('ok', 'failed')),
  attempt     integer not null default 1,
  duration_ms integer,

  -- token 用量。上游若不返回 usage 则为 null。
  prompt_tokens     integer,
  completion_tokens integer,
  total_tokens      integer,

  -- 以下三列仅在 status='failed' 时写入
  error            text,
  prompt_excerpt   text,
  response_excerpt text,

  created_at timestamptz not null default now()
);

-- 按项目查日志(排障)
create index if not exists llm_calls_project_idx
  on public.llm_calls (project_id, id desc);

-- 只扫失败记录 —— 部分索引, 表增长也不退化
create index if not exists llm_calls_failed_idx
  on public.llm_calls (created_at desc)
  where status = 'failed';

-- 成本聚合 / 保留期清理都按时间扫
create index if not exists llm_calls_created_idx
  on public.llm_calls (created_at);

alter table public.llm_calls enable row level security;
grant select, insert, update, delete on public.llm_calls to service_role;
grant usage, select on sequence public.llm_calls_id_seq to service_role;

-- ------------------------------------------------------------ 日志保留: 14 天
-- job_events 与 llm_calls 都是只增不减的日志表, 不清理会变成库里最大的表。
-- 由 /api/app/process-next 低频触发, 或将来接 cron。
create or replace function public.prune_logs(
  p_retain_days integer default 14
)
returns jsonb
language plpgsql
as $$
declare
  v_cutoff    timestamptz := now() - make_interval(days => greatest(p_retain_days, 1));
  v_events    integer;
  v_llm_calls integer;
begin
  delete from public.job_events where created_at < v_cutoff;
  get diagnostics v_events = row_count;

  delete from public.llm_calls where created_at < v_cutoff;
  get diagnostics v_llm_calls = row_count;

  return jsonb_build_object(
    'cutoff', v_cutoff,
    'job_events_deleted', v_events,
    'llm_calls_deleted', v_llm_calls
  );
end;
$$;

grant execute on function public.prune_logs(integer) to service_role;

-- ------------------------------------------------------- 成本/用量聚合视图
-- 供 Dashboard 直接查: 每个项目花了多少 token、失败率多少。
create or replace view public.llm_usage_by_project as
select
  project_id,
  count(*)                                              as calls,
  count(*) filter (where status = 'failed')             as failed_calls,
  sum(coalesce(prompt_tokens, 0))                       as prompt_tokens,
  sum(coalesce(completion_tokens, 0))                   as completion_tokens,
  sum(coalesce(total_tokens, 0))                        as total_tokens,
  round(avg(duration_ms) filter (where status = 'ok'))  as avg_ok_duration_ms,
  max(created_at)                                       as last_call_at
from public.llm_calls
group by project_id;

grant select on public.llm_usage_by_project to service_role;
