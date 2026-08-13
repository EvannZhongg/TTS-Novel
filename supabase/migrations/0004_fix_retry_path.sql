-- 修复重试路径的两个缺陷(已用 scripts 复现, 见下)。
--
-- 场景: 3 章项目, 第 3 章失败 -> 聚合跑完, 项目 partially_failed。
--       用户点"重试失败章节", 第 3 章这次成功。
--
-- 缺陷 1: chapters_failed 不回退。
--   章节从 failed 变回 pending 时没人减 chapters_failed, 于是重试成功后
--   done=3 且 failed=1, 合计 4 > total 3。项目永远显示"1 章失败"。
--
-- 缺陷 2: 更严重 —— 重试后不再创建聚合任务, 项目永久卡在 partially_failed。
--   原来的 `where not exists (... kind='aggregate')` 会命中上一轮那个已经
--   succeeded 的聚合任务, 于是新的聚合永远不会被创建, 重试的章节结果
--   也就永远不会被纳入全书聚合(没有 role_id / voice_profile / tts_segments)。
--
-- 解法:
--   1. 新增 requeue_failed_chapters(): 在同一临界区里复位章节状态并回退计数。
--   2. finish_chapter_job 改为只在"没有未完成的聚合"时创建, 且允许在上一轮
--      聚合已 succeeded 的情况下再建一个新的 —— 靠 jobs_one_active_aggregate_idx
--      (仅约束 pending/running)保证同时只有一个在跑。

-- ------------------------------------------------ 1. 重试失败章节(原子回退计数)
create or replace function public.requeue_failed_chapters(
  p_project_id uuid
)
returns jsonb
language plpgsql
as $$
declare
  v_failed_ids uuid[];
  v_count      integer;
begin
  -- 锁住 project 行, 保证"复位状态"与"回退计数"在同一临界区,
  -- 不会与并发完成的其他章节交错。
  perform 1 from public.projects where id = p_project_id for update;

  select array_agg(id) into v_failed_ids
    from public.chapters
   where project_id = p_project_id and status = 'failed';

  v_count := coalesce(array_length(v_failed_ids, 1), 0);
  if v_count = 0 then
    return jsonb_build_object('requeued', 0, 'chapter_ids', '[]'::jsonb);
  end if;

  update public.chapters
     set status = 'pending', error = null
   where id = any(v_failed_ids);

  -- 回退失败计数, 否则 done + failed 会超过 total
  update public.projects
     set chapters_failed = greatest(chapters_failed - v_count, 0),
         status = 'processing',
         error = null
   where id = p_project_id;

  return jsonb_build_object(
    'requeued', v_count,
    'chapter_ids', to_jsonb(v_failed_ids)
  );
end;
$$;

-- ------------------------------------ 2. finish_chapter_job: 允许再次触发聚合
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

  -- 临界区: 排他锁住 project 行, 所有并发的章节完成在此串行化。
  select chapters_total, chapters_done, chapters_failed
    into v_total, v_done, v_failed
    from public.projects
   where id = v_project_id
     for update;

  -- 幂等: 同一章节重复完成不重复计数
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

  if v_total > 0 and (v_done + v_failed) >= v_total then
    if v_done = 0 then
      update public.projects set status = 'failed' where id = v_project_id;
      v_project_status := 'failed';
    else
      -- 只要没有"未完成"的聚合就建一个。
      -- 关键区别: 这里看的是 pending/running, 而不是"是否存在过聚合" ——
      -- 否则重试场景下上一轮已 succeeded 的聚合会永久阻止新聚合,
      -- 项目卡死在 partially_failed。
      insert into public.jobs (project_id, kind, status)
      select v_project_id, 'aggregate', 'pending'
       where not exists (
         select 1 from public.jobs
          where project_id = v_project_id
            and kind = 'aggregate'
            and status in ('pending','running')
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

grant execute on function public.requeue_failed_chapters(uuid) to service_role;
grant execute on function public.finish_chapter_job(uuid, uuid, boolean, text) to service_role;
