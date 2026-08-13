import { db } from './client';
import { settings } from '../tts/config';
import type { AnyRecord } from '../tts/types';
import type { FinishChapterResult, Job, JobKind } from './types';

/**
 * 任务队列。
 *
 * 并发正确性全部由 Postgres 侧的函数保证(见 supabase/migrations/0002_functions.sql):
 *   claim_next_job     —— for update skip locked，两个并发调用不会领到同一个任务
 *   finish_chapter_job —— 对 projects 行取排他锁，解决"谁是最后一章"竞态
 *   fail_job           —— 退避重试 / 终结
 *
 * 这里只做薄封装。不要在 Node 侧用"先 select 再 update"重新实现这些判断，
 * 那样无法防止竞态。
 */

export async function enqueueJob(input: {
  projectId: string;
  kind: JobKind;
  chapterId?: string | null;
  targetRevision?: number | null;
}): Promise<Job | null> {
  const result = await db()
    .from('jobs')
    .insert({
      project_id: input.projectId,
      kind: input.kind,
      chapter_id: input.chapterId ?? null,
      target_revision: input.targetRevision ?? null,
      max_attempts: settings.queue.maxAttempts,
    })
    .select('*')
    .single();
  if (result.error) {
    // 唯一索引 jobs_one_active_* 会挡掉重复投递，这是预期行为而非错误。
    if (result.error.code === '23505') return null;
    throw new Error(`[db:enqueueJob] ${result.error.message}`);
  }
  return result.data as Job;
}

/** 批量投递章节任务。逐条插入以便让唯一索引单独挡掉已存在的项。 */
export async function enqueueChapterJobs(
  projectId: string,
  chapterIds: string[],
  targetRevision: number,
): Promise<number> {
  let created = 0;
  for (const chapterId of chapterIds) {
    const job = await enqueueJob({ projectId, kind: 'chapter', chapterId, targetRevision });
    if (job) created += 1;
  }
  return created;
}

/** 原子领取下一个可执行任务；无任务时返回 null。 */
export async function claimNextJob(): Promise<Job | null> {
  const result = await db().rpc('claim_next_job', { p_lease_seconds: settings.queue.leaseSeconds });
  if (result.error) throw new Error(`[db:claimNextJob] ${result.error.message}`);
  const data = result.data as Job | Job[] | null;
  if (!data) return null;
  const job = Array.isArray(data) ? (data[0] ?? null) : data;
  // 函数返回 jobs 复合类型，无可领取任务时各字段为 null
  return job && job.id ? job : null;
}

/**
 * 章节任务收尾。递增项目计数，并在所有章节终结时创建聚合任务。
 * 返回值里的 aggregate_created 表明本次调用是否是"最后一个"。
 */
export async function finishChapterJob(input: {
  jobId: string;
  chapterId: string;
  success: boolean;
  error?: string | null;
}): Promise<FinishChapterResult> {
  const result = await db().rpc('finish_chapter_job', {
    p_job_id: input.jobId,
    p_chapter_id: input.chapterId,
    p_success: input.success,
    p_error: input.error ?? null,
  });
  if (result.error) throw new Error(`[db:finishChapterJob] ${result.error.message}`);
  return result.data as FinishChapterResult;
}

/** 任务失败: 未达上限则退避重投，否则标记 failed。 */
export async function failJob(jobId: string, message: string): Promise<{ retrying: boolean; attempts: number; max_attempts: number; kind?: JobKind; chapter_id?: string | null }> {
  const result = await db().rpc('fail_job', { p_job_id: jobId, p_error: message });
  if (result.error) throw new Error(`[db:failJob] ${result.error.message}`);
  return result.data as { retrying: boolean; attempts: number; max_attempts: number; kind?: JobKind; chapter_id?: string | null };
}

export async function succeedJob(jobId: string): Promise<void> {
  const result = await db().from('jobs').update({ status: 'succeeded', error: null, lease_expires_at: null }).eq('id', jobId);
  if (result.error) throw new Error(`[db:succeedJob] ${result.error.message}`);
}

/** 聚合任务收尾: 写 book_result 并把项目置为 completed / partially_failed。 */
export async function finishAggregateJob(input: {
  jobId: string;
  projectId: string;
  targetRevision: number;
  bookResult: AnyRecord;
}): Promise<{
  project_status: string;
  chapters_failed: number;
  published: boolean;
  target_revision: number;
  content_revision: number;
  aggregate_created: boolean;
}> {
  const result = await db().rpc('finish_aggregate_job', {
    p_job_id: input.jobId,
    p_project_id: input.projectId,
    p_target_revision: input.targetRevision,
    p_book_result: input.bookResult,
  });
  if (result.error) throw new Error(`[db:finishAggregateJob] ${result.error.message}`);
  return result.data as {
    project_status: string;
    chapters_failed: number;
    published: boolean;
    target_revision: number;
    content_revision: number;
    aggregate_created: boolean;
  };
}

export async function markAggregateRunning(projectId: string, targetRevision: number): Promise<void> {
  const result = await db().rpc('mark_aggregate_running', {
    p_project_id: projectId,
    p_target_revision: targetRevision,
  });
  if (result.error) throw new Error(`[db:markAggregateRunning] ${result.error.message}`);
}

export async function markAggregateFailed(
  projectId: string,
  targetRevision: number,
  error: string,
): Promise<{ marked_failed: boolean; aggregate_created?: boolean }> {
  const result = await db().rpc('mark_aggregate_failed', {
    p_project_id: projectId,
    p_target_revision: targetRevision,
    p_error: error,
  });
  if (result.error) throw new Error(`[db:markAggregateFailed] ${result.error.message}`);
  return result.data as { marked_failed: boolean; aggregate_created?: boolean };
}

export async function requeueAggregate(
  projectId: string,
): Promise<{ requeued: boolean; content_revision?: number; message: string }> {
  const result = await db().rpc('requeue_aggregate', {
    p_project_id: projectId,
    p_max_attempts: settings.queue.maxAttempts,
  });
  if (result.error) throw new Error(`[db:requeueAggregate] ${result.error.message}`);
  return result.data as { requeued: boolean; content_revision?: number; message: string };
}

export async function countPendingJobs(projectId: string): Promise<number> {
  const result = await db()
    .from('jobs')
    .select('id', { count: 'exact', head: true })
    .eq('project_id', projectId)
    .in('status', ['pending', 'running']);
  if (result.error) throw new Error(`[db:countPendingJobs] ${result.error.message}`);
  return result.count ?? 0;
}

export async function listJobs(projectId: string): Promise<Job[]> {
  const result = await db().from('jobs').select('*').eq('project_id', projectId).order('created_at', { ascending: true });
  if (result.error) throw new Error(`[db:listJobs] ${result.error.message}`);
  return (result.data ?? []) as Job[];
}

// ------------------------------------------------------------------ job_events
/**
 * 承接 runner 的 emitProgress 事件流(原本写 events.jsonl)。
 * 事件量可能很大(每 chunk 每次 LLM 都有)，所以批量写入且失败不阻塞主流程——
 * 日志丢了可以接受，任务失败不行。
 */
export async function appendJobEvents(
  events: { jobId: string | null; projectId: string; chapterId?: string | null; stage?: string; message?: string; payload?: AnyRecord }[],
): Promise<void> {
  if (!events.length) return;
  const rows = events.map((event) => ({
    job_id: event.jobId,
    project_id: event.projectId,
    chapter_id: event.chapterId ?? null,
    stage: event.stage ?? null,
    message: event.message ?? null,
    payload: event.payload ?? null,
  }));
  const result = await db().from('job_events').insert(rows);
  if (result.error) console.error('[db:appendJobEvents] 写入失败(已忽略)', result.error.message);
}

export async function listRecentJobEvents(projectId: string, limit = 200): Promise<AnyRecord[]> {
  const result = await db()
    .from('job_events')
    .select('id, job_id, chapter_id, stage, message, created_at')
    .eq('project_id', projectId)
    .order('id', { ascending: false })
    .limit(limit);
  if (result.error) throw new Error(`[db:listRecentJobEvents] ${result.error.message}`);
  return ((result.data ?? []) as AnyRecord[]).reverse();
}
