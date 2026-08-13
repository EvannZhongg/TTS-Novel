-- 多播电子书测试系统 Phase 1: 队列函数
--
-- 这个文件里的两个函数承载了整个系统的并发正确性。
-- 不要把这些判断挪到应用层 —— Node 侧的 "先 select 再 update" 无法防止竞态。

-- ------------------------------------------------------------ 1. 原子领任务
-- for update skip locked 是关键: 两个并发调用会各自拿到不同的行,
-- 而不是都拿到同一行然后互相覆盖。
--
-- 同时顺手回收租约过期的任务(实例猝死 / 超时导致 status 卡在 running)。
create or replace function public.claim_next_job(
  p_lease_seconds integer default 300
)
returns public.jobs
language plpgsql
as $$
declare
  v_job public.jobs;
begin
  -- 先把租约过期的 running 任务打回 pending, 让它们可被重新领取。
  -- attempts 已在领取时递增过, 所以这里不再加, 避免双重计数。
  update public.jobs
     set status = 'pending',
         lease_expires_at = null,
         error = coalesce(error, 'lease expired; requeued')
   where status = 'running'
     and lease_expires_at is not null
     and lease_expires_at < now();

  update public.jobs j
     set status = 'running',
         attempts = j.attempts + 1,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         error = null
   where j.id = (
     select id
       from public.jobs
      where status = 'pending'
        and run_after <= now()
      order by created_at
      for update skip locked
      limit 1
   )
  returning j.* into v_job;

  return v_job;   -- 无可领取任务时返回 null
end;
$$;

-- --------------------------------------------- 2. 章节完成 + 决定谁建聚合任务
-- 这是最容易出错的地方。两章同时完成时有两种失败模式:
--   A. 双方都认为自己是最后一个 -> 建出两个 aggregate 任务(重复聚合)
--   B. 双方都认为自己不是最后一个 -> 一个都不建, 项目永久卡在 processing
--
-- 解法: 先对 projects 行取排他锁, 把"递增计数"和"判断是否最后一个"放进同一个
-- 临界区。加上 0001 里的 jobs_one_active_aggregate_idx 唯一索引兜底。
--
-- 失败的章节不阻塞聚合: 只要 done + failed >= total 就触发聚合,
-- 项目落到 partially_failed。
create or replace function public.finish_chapter_job(
  p_job_id     uuid,
  p_chapter_id uuid,
  p_success    boolean,
  p_error      text default null
)
returns jsonb
language plpgsql
as $$
declare
  v_project_id      uuid;
  v_total           integer;
  v_done            integer;
  v_failed          integer;
  v_already_counted boolean;
  v_aggregate_created boolean := false;
  v_project_status  text;
begin
  select project_id into v_project_id
    from public.chapters where id = p_chapter_id;

  if v_project_id is null then
    raise exception 'chapter % not found', p_chapter_id;
  end if;

  -- 临界区开始: 排他锁住 project 行。
  -- 所有并发的章节完成操作在这里串行化。
  select chapters_total, chapters_done, chapters_failed
    into v_total, v_done, v_failed
    from public.projects
   where id = v_project_id
     for update;

  -- 幂等保护: 同一章节重复完成(任务重试/重复投递)不应重复计数。
  select status in ('succeeded','failed') into v_already_counted
    from public.chapters where id = p_chapter_id;

  update public.chapters
     set status = case when p_success then 'succeeded' else 'failed' end,
         error  = p_error
   where id = p_chapter_id;

  update public.jobs
     set status = case when p_success then 'succeeded' else 'failed' end,
         error  = p_error,
         lease_expires_at = null
   where id = p_job_id;

  if not v_already_counted then
    if p_success then
      v_done := v_done + 1;
    else
      v_failed := v_failed + 1;
    end if;

    update public.projects
       set chapters_done   = v_done,
           chapters_failed = v_failed
     where id = v_project_id;
  end if;

  -- 是否所有章节都已终结?
  if v_total > 0 and (v_done + v_failed) >= v_total then
    if v_done = 0 then
      -- 全军覆没, 没有可聚合的内容
      update public.projects set status = 'failed' where id = v_project_id;
      v_project_status := 'failed';
    else
      -- 建聚合任务。where not exists 防止重复,
      -- 唯一索引 jobs_one_active_aggregate_idx 是最后一道防线。
      insert into public.jobs (project_id, kind, status)
      select v_project_id, 'aggregate', 'pending'
       where not exists (
         select 1 from public.jobs
          where project_id = v_project_id and kind = 'aggregate'
       );
      v_aggregate_created := true;
      v_project_status := 'processing';
    end if;
  else
    v_project_status := 'processing';
  end if;

  return jsonb_build_object(
    'project_id',         v_project_id,
    'chapters_total',     v_total,
    'chapters_done',      v_done,
    'chapters_failed',    v_failed,
    'all_chapters_done',  (v_total > 0 and (v_done + v_failed) >= v_total),
    'aggregate_created',  v_aggregate_created,
    'project_status',     v_project_status
  );
end;
$$;

-- ------------------------------------------------ 3. 任务失败: 退避或终结
-- 未达 max_attempts -> 打回 pending 并按 2^n 退避;
-- 达到上限 -> 标记 failed。章节任务的最终失败要走 finish_chapter_job
-- 才能推进项目计数, 所以这里只处理"还能重试"和"非章节任务"。
create or replace function public.fail_job(
  p_job_id uuid,
  p_error  text
)
returns jsonb
language plpgsql
as $$
declare
  v_job public.jobs;
begin
  select * into v_job from public.jobs where id = p_job_id for update;
  if v_job.id is null then
    raise exception 'job % not found', p_job_id;
  end if;

  if v_job.attempts < v_job.max_attempts then
    update public.jobs
       set status = 'pending',
           error = p_error,
           lease_expires_at = null,
           -- 5s, 10s, 20s ...
           run_after = now() + make_interval(secs => 5 * power(2, greatest(v_job.attempts - 1, 0))::int)
     where id = p_job_id;
    return jsonb_build_object('retrying', true, 'attempts', v_job.attempts,
                              'max_attempts', v_job.max_attempts);
  end if;

  update public.jobs
     set status = 'failed', error = p_error, lease_expires_at = null
   where id = p_job_id;

  return jsonb_build_object('retrying', false, 'attempts', v_job.attempts,
                            'max_attempts', v_job.max_attempts,
                            'chapter_id', v_job.chapter_id, 'kind', v_job.kind);
end;
$$;

-- ------------------------------------------------------ 4. 聚合完成: 收尾项目
create or replace function public.finish_aggregate_job(
  p_job_id      uuid,
  p_project_id  uuid,
  p_book_result jsonb
)
returns jsonb
language plpgsql
as $$
declare
  v_failed integer;
begin
  update public.jobs
     set status = 'succeeded', error = null, lease_expires_at = null
   where id = p_job_id;

  select chapters_failed into v_failed
    from public.projects where id = p_project_id;

  update public.projects
     set book_result = p_book_result,
         status = case when coalesce(v_failed, 0) > 0
                       then 'partially_failed' else 'completed' end
   where id = p_project_id;

  return jsonb_build_object(
    'project_status', case when coalesce(v_failed, 0) > 0
                          then 'partially_failed' else 'completed' end,
    'chapters_failed', coalesce(v_failed, 0)
  );
end;
$$;

-- 这些函数只应由服务端 (service_role) 调用。
-- 授权在 0003 里统一处理 —— 这里不做 revoke, 避免像 0001 那样连带影响
-- service_role 自身的权限。
