import { settings } from '../tts/config';
import {
  buildBookResult,
  buildChapterDigest,
  runAggregateStage,
  runChapterizeStage,
  runChapterStage,
} from '../tts/stages';
import type { AnyRecord, Chapter, LLMCallMetric } from '../tts/types';
import {
  getChapterForProcessing,
  commitChapterizeResult,
  listChapterSummaries,
  markChapterRunning,
  saveChapterResult,
  saveEnrichedChapterBatch,
  streamChapterDigests,
} from '../db/chapters';
import {
  appendJobEvents,
  claimNextJob,
  failJob,
  finishAggregateJob,
  finishChapterJob,
  markAggregateFailed,
  markAggregateRunning,
  succeedJob,
} from '../db/jobs';
import { getProject, getProjectSource, updateProject } from '../db/projects';
import { appendLlmCalls, type LlmCallInsert } from '../db/llmCalls';
import type { Job } from '../db/types';
import { sourceHash } from '../text/ingest';

/**
 * 队列 worker —— 唯一同时接触 DB 与 pipeline 的地方。
 *
 * src/server/tts/stages.ts 刻意保持纯函数(零 DB 依赖), 所有读写都在这里。
 * 这样将来那个 {key, text} 对外接口可以直接调 runChapterStage, 不碰数据库。
 *
 * 一次调用处理一个任务。实测单章约 35s, 远低于 Vercel 的 300s 上限;
 * 整本(400 章串行 233 分钟)必须靠反复调用推进, 见 docs/phase0-measurements.md。
 */

interface JobEventInput {
  jobId: string | null;
  projectId: string;
  chapterId?: string | null;
  stage?: string;
  message?: string;
  payload?: AnyRecord;
}

export interface ProcessResult {
  claimed: boolean;
  jobId?: string;
  kind?: string;
  projectId?: string;
  chapterId?: string;
  status?: 'succeeded' | 'failed' | 'retrying';
  durationMs?: number;
  message?: string;
  detail?: AnyRecord;
}

/** 领一个任务并处理完。无任务可领时返回 { claimed: false }。 */
export async function processNextJob(): Promise<ProcessResult> {
  const job = await claimNextJob();
  if (!job) return { claimed: false };

  const startedAt = Date.now();
  // collector 在这里创建, 并在 finally 里 flush ——
  // 失败的 LLM 调用日志恰恰是最需要的那部分, 不能因为任务抛异常就丢掉。
  const events = collectEvents(job);
  try {
    const detail = await runJob(job, events);
    return {
      claimed: true,
      jobId: job.id,
      kind: job.kind,
      projectId: job.project_id,
      chapterId: job.chapter_id ?? undefined,
      status: 'succeeded',
      durationMs: Date.now() - startedAt,
      detail,
    };
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    const durationMs = Date.now() - startedAt;
    console.error('[worker] 任务失败', JSON.stringify({
      job_id: job.id, kind: job.kind, project_id: job.project_id,
      chapter_id: job.chapter_id, attempts: job.attempts,
      duration_ms: durationMs, error: err.message,
    }));
    return handleJobFailure(job, err, durationMs);
  } finally {
    // flush 内部已吞异常
    await events.flush();
  }
}

type EventCollector = ReturnType<typeof collectEvents>;

async function runJob(job: Job, events: EventCollector): Promise<AnyRecord> {
  switch (job.kind) {
    case 'chapterize':
      return runChapterizeJob(job, events);
    case 'chapter':
      return runChapterJob(job, events);
    case 'aggregate':
      return runAggregateJob(job, events);
    default:
      throw new Error(`未知任务类型: ${job.kind}`);
  }
}

/**
 * 任务失败处理。
 *
 * 章节任务达到重试上限时必须走 finish_chapter_job —— 只有它会推进项目计数
 * 并在需要时创建聚合任务。若只标记 job failed, 项目会永远卡在 processing。
 */
async function handleJobFailure(job: Job, error: Error, durationMs: number): Promise<ProcessResult> {
  const outcome = await failJob(job.id, error.message);
  await safeEvents([{
    jobId: job.id, projectId: job.project_id, chapterId: job.chapter_id,
    stage: 'failed',
    message: outcome.retrying ? `任务失败, 将重试(${outcome.attempts}/${outcome.max_attempts})` : `任务最终失败: ${error.message}`,
    payload: { error: error.message, attempts: outcome.attempts, retrying: outcome.retrying },
  }]);

  if (!outcome.retrying && job.kind === 'chapter' && job.chapter_id) {
    // 关键: 让失败的章节推进项目计数, 不阻塞其余章节与最终聚合
    const finished = await finishChapterJob({
      jobId: job.id, chapterId: job.chapter_id, success: false, error: error.message,
    });
    if (finished.aggregate_created) {
      await safeEvents([{
        jobId: null, projectId: job.project_id, stage: 'aggregate_queued',
        message: '所有章节已终结(含失败), 已创建聚合任务',
        payload: finished as unknown as AnyRecord,
      }]);
    }
  }

  if (!outcome.retrying && job.kind === 'chapterize') {
    await updateProject(job.project_id, { status: 'failed', error: error.message });
  }
  if (!outcome.retrying && job.kind === 'aggregate') {
    const targetRevision = job.target_revision ?? 0;
    await markAggregateFailed(job.project_id, targetRevision, error.message);
  }

  return {
    claimed: true, jobId: job.id, kind: job.kind, projectId: job.project_id,
    chapterId: job.chapter_id ?? undefined,
    status: outcome.retrying ? 'retrying' : 'failed',
    durationMs, message: error.message,
  };
}

// ------------------------------------------------------------------ 拆章任务
async function runChapterizeJob(job: Job, events: EventCollector): Promise<AnyRecord> {
  const project = await getProject(job.project_id);
  if (!project) throw new Error(`project ${job.project_id} 不存在`);
  const rawText = await getProjectSource(job.project_id);
  if (!rawText) throw new Error(`project ${job.project_id} 没有原文`);

  const outcome = await runChapterizeStage(
    { bookTitle: project.title, text: rawText },
    settings,
    events.push,
    undefined,
    events.metricSink,
  );

  if (!outcome.chapters.length) throw new Error('拆章结果为空, 无法继续');

  const committed = await commitChapterizeResult({
    projectId: job.project_id,
    maxAttempts: settings.queue.maxAttempts,
    chapters: outcome.chapters.map((chapter) => ({
      title: chapter.title,
      text: chapter.text,
      skip_llm: chapter.skip_llm ?? false,
      source_hash: sourceHash(chapter.text),
    })),
  });
  await succeedJob(job.id);
  await events.flush([{
    jobId: job.id, projectId: job.project_id, stage: 'chapterize_done',
    message: `拆章完成, 共 ${committed.chapter_count} 章`,
    payload: committed,
  }]);

  return committed;
}

// ------------------------------------------------------------------ 单章任务
async function runChapterJob(job: Job, events: EventCollector): Promise<AnyRecord> {
  if (!job.chapter_id) throw new Error('chapter 任务缺少 chapter_id');
  const row = await getChapterForProcessing(job.chapter_id);
  if (!row) throw new Error(`chapter ${job.chapter_id} 不存在`);
  const project = await getProject(job.project_id);
  if (!project) throw new Error(`project ${job.project_id} 不存在`);
  const targetRevision = job.target_revision ?? project.content_revision;

  await markChapterRunning(job.chapter_id);

  // 组装 pipeline 需要的 Chapter 结构。start/end 用章节内偏移即可 ——
  // 单章处理不依赖全书坐标。
  const chapter: Chapter = {
    chapter_id: row.chapter_index,
    title: row.title,
    start: 0,
    end: row.source_text.length,
    text: row.source_text,
    skip_llm: row.skip_llm,
  };

  const startedAt = Date.now();
  const result = await runChapterStage({ bookTitle: project.title, chapter }, settings, events.push, undefined, events.metricSink);
  const durationMs = Date.now() - startedAt;

  if (durationMs > settings.queue.chapterSlowWarnMs) {
    console.warn('[worker] 单章耗时偏长, 接近平台函数上限风险', JSON.stringify({
      project_id: job.project_id, chapter_id: job.chapter_id,
      chapter_index: row.chapter_index, duration_ms: durationMs,
      chars: row.source_text.length,
    }));
  }

  await saveChapterResult(job.chapter_id, {
    result,
    digest: buildChapterDigest(result),
    durationMs,
    analysisRevision: targetRevision,
  });

  // finish_chapter_job 会在同一临界区里推进计数并决定是否创建聚合任务
  const finished = await finishChapterJob({ jobId: job.id, chapterId: job.chapter_id, success: true });

  const extra: JobEventInput[] = [{
    jobId: job.id, projectId: job.project_id, chapterId: job.chapter_id,
    stage: 'chapter_done',
    message: `第 ${row.chapter_index} 章完成(${durationMs}ms)`,
    payload: { duration_ms: durationMs, chapters_done: finished.chapters_done, chapters_total: finished.chapters_total },
  }];
  if (finished.aggregate_created) {
    extra.push({
      jobId: null, projectId: job.project_id, chapterId: null,
      stage: 'aggregate_queued', message: '所有章节已完成, 已创建聚合任务',
      payload: finished as unknown as AnyRecord,
    });
  }
  await events.flush(extra);

  return { chapter_index: row.chapter_index, duration_ms: durationMs, progress: finished };
}

// ------------------------------------------------------------------ 聚合任务
async function runAggregateJob(job: Job, events: EventCollector): Promise<AnyRecord> {
  const project = await getProject(job.project_id);
  if (!project) throw new Error(`project ${job.project_id} 不存在`);
  if (!job.target_revision) throw new Error('aggregate 任务缺少 target_revision');
  const targetRevision = job.target_revision;
  await markAggregateRunning(job.project_id, targetRevision);

  // 只读 digest: 完整章节数据在 400 章长篇上约 87MB, 一次读完会超时;
  // digest 约 17MB。见 docs/phase0-measurements.md。
  const digests = await streamChapterDigests(job.project_id, targetRevision);
  if (!digests.length) throw new Error('没有可聚合的章节结果');

  const chapters = digests.map((row) => row.digest);
  const aggregate = await runAggregateStage({ bookTitle: project.title, chapters }, settings, events.push, undefined, events.metricSink);

  // ⚠️ 聚合会原地改写 chapters: 给 span 绑 role_id / voice_profile,
  // 并写入 chapter.tts_segments。必须回写, 否则 UI 上所有对白都没有角色和声线 ——
  // 而那看起来像 LLM 没识别出角色, 极易误判为算法问题。
  // chapters.enriched 就是为了让这一步的遗漏能被查出来。
  const enrichmentRows = digests.map((row, index) => {
    const enrichedDigest = aggregate.enrichedChapters[index];
    return {
      chapter_id: row.chapter_id,
      enrichment: buildChapterEnrichment(enrichedDigest),
      digest: enrichedDigest,
    };
  });
  const enrichmentBatchSize = 25;
  for (let offset = 0; offset < enrichmentRows.length; offset += enrichmentBatchSize) {
    await saveEnrichedChapterBatch({
      projectId: job.project_id,
      targetRevision,
      items: enrichmentRows.slice(offset, offset + enrichmentBatchSize),
    });
  }

  const bookResult = buildBookResult({
    bookTitle: project.title,
    settings,
    aggregate,
    chapterCount: digests.length,
    contentRevision: targetRevision,
  });

  const finished = await finishAggregateJob({
    jobId: job.id,
    projectId: job.project_id,
    targetRevision,
    bookResult,
  });
  await events.flush([{
    jobId: job.id, projectId: job.project_id, stage: 'aggregate_done',
    message: finished.published
      ? `全书聚合完成: ${aggregate.roleRegistry.length} 个角色, ${aggregate.ttsSegments.length} 个 TTS segment`
      : `版本 ${targetRevision} 聚合完成但正文已更新，结果未发布`,
    payload: {
      role_count: aggregate.roleRegistry.length,
      tts_segment_count: aggregate.ttsSegments.length,
      project_status: finished.project_status,
      published: finished.published,
      target_revision: targetRevision,
      content_revision: finished.content_revision,
    },
  }]);

  return {
    role_count: aggregate.roleRegistry.length,
    tts_segment_count: aggregate.ttsSegments.length,
    project_status: finished.project_status,
    published: finished.published,
    target_revision: targetRevision,
    content_revision: finished.content_revision,
  };
}

/**
 * 聚合只保存相对单章原始结果新增/改写的部分，避免用精简 digest 覆盖完整 result，
 * 也避免再复制一份完整章节 JSON。
 */
function buildChapterEnrichment(chapter: AnyRecord): AnyRecord {
  return {
    tts_segments: chapter.tts_segments ?? [],
    tts_segment_summary: chapter.tts_segment_summary ?? {},
    chunks: (Array.isArray(chapter.chunks) ? chapter.chunks : []).map((chunk: AnyRecord) => ({
      chunk_id: chunk.chunk_id,
      final_grounded_dialogue_spans: Array.isArray(chunk.final_grounded_dialogue_spans)
        ? chunk.final_grounded_dialogue_spans
        : [],
    })),
  };
}

// ------------------------------------------------------------------ 事件收集
/**
 * runner 的 emitProgress 事件量很大(每 chunk 每次 LLM 都有), 逐条写库会拖慢
 * 任务并浪费连接。这里先在内存累积, 任务结束时一次性批量写入。
 *
 * 只保留里程碑事件, 丢掉 llm_response 这种带完整响应体的 —— 那些能把
 * job_events 撑成最大的表。
 */
const NOISY_EVENT_TYPES = new Set(['llm_response']);

function collectEvents(job: Job) {
  const buffer: JobEventInput[] = [];
  const llmCalls: LlmCallInsert[] = [];
  return {
    /** 交给 LLM client 的观测回调。只累积, 任务结束时统一落库。 */
    metricSink: (metric: LLMCallMetric) => {
      llmCalls.push({
        ...metric,
        projectId: job.project_id,
        chapterId: job.chapter_id,
        jobId: job.id,
      });
    },
    push: (event: AnyRecord) => {
      if (NOISY_EVENT_TYPES.has(String(event.event_type ?? ''))) return;
      const { stage, message, ...rest } = event;
      buffer.push({
        jobId: job.id,
        projectId: job.project_id,
        chapterId: job.chapter_id,
        stage: stage ? String(stage) : undefined,
        message: message ? String(message) : undefined,
        payload: Object.keys(rest).length ? rest : undefined,
      });
    },
    flush: async (extra: typeof buffer = []) => {
      await safeEvents([...buffer, ...extra]);
      buffer.length = 0;
      await appendLlmCalls(llmCalls);   // 内部已吞异常, 日志失败不影响任务
      llmCalls.length = 0;
    },
  };
}

/** 日志写失败不应导致任务失败 —— 日志可以丢, 任务不行。 */
async function safeEvents(events: Parameters<typeof appendJobEvents>[0]): Promise<void> {
  try {
    await appendJobEvents(events);
  } catch (error) {
    console.error('[worker] 事件写入失败(已忽略)', error instanceof Error ? error.message : String(error));
  }
}

/** 供 /api/app/projects/[id] 轮询用: 章节列表 + 概要 */
export async function projectProgress(projectId: string) {
  const [project, chapters] = await Promise.all([
    getProject(projectId),
    listChapterSummaries(projectId),
  ]);
  return { project, chapters };
}
