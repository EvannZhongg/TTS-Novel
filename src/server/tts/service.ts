import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { settings } from './config';
import { PipelineJobStore } from './jobStore';
import { PipelineRunner } from './runner';
import { jsonSafeCopy, nowIso } from './utils';
import type { AnyRecord, PipelineRunRequest } from './types';

const MAX_JOB_LOGS = 500;
const JOB_STORE = new PipelineJobStore(path.join(settings.app.dataDir, 'pipeline_jobs'), MAX_JOB_LOGS);
const PIPELINE_JOBS = new Map<string, AnyRecord>();
const JOB_PROMISES = new Map<string, Promise<void>>();

export function getSettings() {
  return settings;
}

export function getJobStore() {
  return JOB_STORE;
}

export async function appendJobLog(job: AnyRecord, event: AnyRecord): Promise<void> {
  const item = { ts: nowIso(), ...event };
  await JOB_STORE.appendLog(job, item);
}

export function jobResponse(job: AnyRecord, { includeLogs, includeResult, logTail }: { includeLogs: boolean; includeResult: boolean; logTail: number }): AnyRecord {
  return {
    job_id: job.job_id,
    status: job.status,
    stage: job.stage,
    message: job.message,
    created_at: job.created_at,
    started_at: job.started_at,
    completed_at: job.completed_at,
    request_summary: job.request_summary,
    storage: job.storage,
    logs: includeLogs ? (logTail === 0 ? [] : (job.logs ?? []).slice(-logTail)) : [],
    result: includeResult && job.status === 'completed' ? job.result ?? null : null,
    partial_result: job.partial_result ?? null,
    error: job.error,
  };
}

export async function createPipelineJob(request: PipelineRunRequest): Promise<AnyRecord> {
  const jobId = randomUUID().replace(/-/g, '');
  const payload = { book_title: request.book_title || 'untitled', text: request.text, chapter_ids: request.chapter_ids ?? null };
  const job = await JOB_STORE.createJob({ jobId, requestPayload: payload, createdAt: nowIso() });
  PIPELINE_JOBS.set(jobId, job);
  await appendJobLog(job, { stage: 'queued', message: '任务已创建，等待执行' });
  const promise = runPipelineJob(jobId, payload).finally(() => JOB_PROMISES.delete(jobId));
  JOB_PROMISES.set(jobId, promise);
  return { job_id: jobId, status: 'queued', storage: job.storage };
}


function createPartialAccumulator(jobId: string): AnyRecord {
  return { job_id: jobId, status: 'running_partial', chapters: [], completed_chapter_ids: [], updated_at: nowIso() };
}

function applyPartialSnapshot(partial: AnyRecord, snapshot: AnyRecord): void {
  partial.updated_at = nowIso();
  if (snapshot.type === 'init') {
    for (const [key, value] of Object.entries(snapshot)) {
      if (key !== 'type') partial[key] = value;
    }
    partial.completed_chapter_ids = [];
    return;
  }
  if (snapshot.type !== 'chapter_completed' || !snapshot.chapter) return;
  const chapter = snapshot.chapter;
  partial.chapters = Array.isArray(partial.chapters) ? partial.chapters : [];
  const index = partial.chapters.findIndex((item: AnyRecord) => item?.chapter_id === chapter.chapter_id);
  const completedChapter = { ...chapter, status: 'completed' };
  if (index >= 0) partial.chapters[index] = completedChapter;
  else partial.chapters.push(completedChapter);
  partial.chapters.sort((a: AnyRecord, b: AnyRecord) => Number(a.chapter_id || 0) - Number(b.chapter_id || 0));
  const completedIds = new Set([...(partial.completed_chapter_ids || []), chapter.chapter_id]);
  partial.completed_chapter_ids = [...completedIds].sort((a, b) => Number(a) - Number(b));
}

async function runPipelineJob(jobId: string, request: PipelineRunRequest): Promise<void> {
  const job = PIPELINE_JOBS.get(jobId);
  if (!job) return;
  job.status = 'running';
  job.started_at = nowIso();
  await JOB_STORE.saveJobMetadata(job);
  await appendJobLog(job, { stage: 'running', message: '任务开始执行' });
  let logQueue = Promise.resolve();
  const progress = (event: AnyRecord) => {
    logQueue = logQueue
      .then(() => appendJobLog(job, event))
      .catch((error) => console.error('[pipeline-job-log] append failed', error));
  };
  const drainLogs = async () => {
    await logQueue.catch((error) => console.error('[pipeline-job-log] drain failed', error));
  };
  const partial = createPartialAccumulator(jobId);
  let partialQueue = Promise.resolve();
  const savePartialSnapshot = (snapshot: AnyRecord) => {
    applyPartialSnapshot(partial, snapshot);
    const payload = JSON.parse(JSON.stringify(partial));
    job.partial_result = payload;
    partialQueue = partialQueue
      .then(() => JOB_STORE.savePartialResult(job, payload))
      .catch((error) => console.error('[pipeline-partial] save failed', error));
  };
  const drainPartial = async () => {
    await partialQueue.catch((error) => console.error('[pipeline-partial] drain failed', error));
  };
  const runner = new PipelineRunner(settings, progress, savePartialSnapshot);
  try {
    const result = await runner.runMinimal(request);
    await drainPartial();
    partial.status = 'completed';
    partial.updated_at = nowIso();
    job.partial_result = JSON.parse(JSON.stringify(partial));
    await drainLogs();
    await JOB_STORE.savePartialResult(job, job.partial_result || partial);
    job.status = 'completed';
    job.completed_at = nowIso();
    await JOB_STORE.saveResult(job, result);
    await appendJobLog(job, { stage: 'completed', message: '任务执行完成' });
  } catch (error) {
    await drainPartial();
    await drainLogs();
    partial.status = 'failed';
    partial.updated_at = nowIso();
    job.partial_result = JSON.parse(JSON.stringify(partial));
    await JOB_STORE.savePartialResult(job, job.partial_result || partial);
    const err = error instanceof Error ? error : new Error(String(error));
    job.status = 'failed';
    job.stage = 'failed';
    job.message = err.message;
    job.error = err.message;
    job.completed_at = nowIso();
    await JOB_STORE.saveError(job, { error: err.message, error_type: err.name, stack: err.stack, completed_at: job.completed_at });
    logPipelineJobFailure(job, err);
    await appendJobLog(job, { stage: 'failed', message: err.message });
  }
}

export async function listPipelineJobs(limit: number): Promise<AnyRecord[]> {
  return (await JOB_STORE.listJobs(limit)).map((job) => jobResponse(job, { includeLogs: false, includeResult: false, logTail: 0 }));
}

export async function getPipelineJob(jobId: string, { includeLogs, includeResult, logTail }: { includeLogs: boolean; includeResult: boolean; logTail: number }): Promise<AnyRecord | null> {
  let job = PIPELINE_JOBS.get(jobId) ?? null;
  if (!job) job = await JOB_STORE.getJob(jobId, { includeLogs, includeResult, logTail });
  if (!job) return null;
  if (PIPELINE_JOBS.has(jobId) && includeLogs) job.logs = await JOB_STORE.readLogs(jobId, logTail);
  if (!PIPELINE_JOBS.has(jobId) || !job.partial_result) {
    const partial = await JOB_STORE.readPartialResult(jobId);
    if (partial) job.partial_result = partial;
  }
  if (PIPELINE_JOBS.has(jobId) && includeResult && job.status === 'completed') {
    const persisted = await JOB_STORE.getJob(jobId, { includeLogs: false, includeResult: true, logTail: 0 });
    if (persisted) job.result = persisted.result;
  }
  return jobResponse(job, { includeLogs, includeResult, logTail });
}

export async function getPipelineJobLogs(jobId: string, tail: number): Promise<AnyRecord[] | null> {
  const job = PIPELINE_JOBS.get(jobId) ?? (await JOB_STORE.getJob(jobId, { includeLogs: false, includeResult: false }));
  if (!job) return null;
  return JOB_STORE.readLogs(jobId, tail);
}

export async function savePipelineJobFrontendResult(jobId: string, request: { result: AnyRecord; source?: string }): Promise<AnyRecord | null> {
  const job = PIPELINE_JOBS.get(jobId) ?? (await JOB_STORE.getJob(jobId, { includeLogs: false, includeResult: false }));
  if (!job) return null;
  const payload = {
    ...request.result,
    saved_at: nowIso(),
    source: request.source || request.result.source || 'frontend',
    job: {
      ...(request.result.job || {}),
      job_id: jobId,
    },
  };
  const storage = await JOB_STORE.saveFrontendResult(jobId, payload);
  job.storage = storage;
  if (PIPELINE_JOBS.has(jobId)) PIPELINE_JOBS.get(jobId)!.storage = storage;
  await appendJobLog(job, { stage: job.stage || 'completed', event_type: 'frontend_result', message: '前端完整 JSON 结果已保存', frontend_result_path: storage.frontend_result_path });
  return { job_id: jobId, ok: true, storage };
}

export async function getPipelineJobFrontendResult(jobId: string): Promise<AnyRecord | null> {
  const job = PIPELINE_JOBS.get(jobId) ?? (await JOB_STORE.getJob(jobId, { includeLogs: false, includeResult: false }));
  if (!job) return null;
  return JOB_STORE.getFrontendResult(jobId);
}

export async function waitForJobIfRunning(jobId: string): Promise<void> {
  await JOB_PROMISES.get(jobId);
}

function logPipelineJobFailure(job: AnyRecord, error: Error): void {
  console.error('[pipeline-job-failed]', stringifyLogEvent({
    event: 'pipeline_job_failed',
    job_id: job.job_id,
    status: job.status,
    stage: job.stage,
    message: job.message,
    request_summary: safeLogValue(job.request_summary),
    storage: safeLogValue(job.storage),
    partial_summary: {
      status: job.partial_result?.status ?? null,
      chapter_count: Array.isArray(job.partial_result?.chapters) ? job.partial_result.chapters.length : 0,
      completed_chapter_ids: job.partial_result?.completed_chapter_ids ?? [],
    },
    error_type: error.name,
    error: error.message,
    stack: error.stack ?? '',
    completed_at: job.completed_at,
  }));
}

function safeLogValue(value: unknown): unknown {
  try {
    return jsonSafeCopy(value);
  } catch (error) {
    return {
      non_json_serializable: true,
      value_type: typeof value,
      string_value: String(value),
      serialization_error: error instanceof Error ? error.message : String(error),
    };
  }
}

function stringifyLogEvent(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch (error) {
    return JSON.stringify({
      event: 'log_serialization_failed',
      error: error instanceof Error ? error.message : String(error),
      value: String(value),
    });
  }
}
