import { db } from './client';
import type { AnyRecord } from '../tts/types';
import { CHAPTER_SUMMARY_COLUMNS, type ChapterRow, type ChapterSummary } from './types';

/**
 * 章节读写。
 *
 * 每章存两份结果:
 *   result — 完整单章结果（实测约 200KB/章），给用户结果页按需读取
 *   digest — 精简版(约完整版的 20%)，只给聚合任务读
 *
 * 聚合任务必须只读 digest: 400 章长篇的完整数据约 87MB，一次读完会撞
 * statement_timeout；digest 版约 17MB，可以在单次调用内处理完。
 * 见 docs/phase0-measurements.md。
 */

export interface ChapterInsert {
  chapter_index: number;
  title: string;
  source_text: string;
  skip_llm?: boolean;
  source_hash?: string | null;
  created_revision?: number;
}

export interface ChapterBatchInput {
  title?: string;
  text: string;
  source_hash: string;
  client_file_name?: string;
  source_encoding?: string;
}

export interface ChapterBatchResult {
  batch_id: string;
  request_id: string;
  added: number;
  start_index: number;
  end_index: number;
  content_revision: number;
  idempotent: boolean;
  chapters_total: number;
  chapters: ChapterSummary[];
}

/** 低层批量插入；用户追加和整本拆章应优先走事务 RPC。 */
export async function insertChapters(projectId: string, chapters: ChapterInsert[]): Promise<ChapterSummary[]> {
  if (!chapters.length) return [];
  const rows = chapters.map((chapter) => ({
    project_id: projectId,
    chapter_index: chapter.chapter_index,
    title: chapter.title,
    source_text: chapter.source_text,
    skip_llm: chapter.skip_llm ?? false,
    source_hash: chapter.source_hash ?? null,
    created_revision: chapter.created_revision ?? 1,
    char_count: chapter.source_text.length,
  }));
  const result = await db().from('chapters').insert(rows).select(CHAPTER_SUMMARY_COLUMNS);
  if (result.error) throw new Error(`[db:insertChapters] ${result.error.message}`);
  return (result.data ?? []) as unknown as ChapterSummary[];
}

/**
 * 原子追加一个用户上传批次。
 *
 * 序号分配、章节插入、项目计数/版本递增与任务创建全部在 Postgres 的同一个
 * 事务中完成。requestId 重放时返回第一次的结果，不重复创建章节。
 */
export async function appendChapterBatch(input: {
  projectId: string;
  requestId: string;
  chapters: ChapterBatchInput[];
  maxAttempts: number;
}): Promise<ChapterBatchResult> {
  const result = await db().rpc('append_chapter_batch', {
    p_project_id: input.projectId,
    p_request_id: input.requestId,
    p_chapters: input.chapters,
    p_max_attempts: input.maxAttempts,
  });
  if (result.error) throw new Error(`[db:appendChapterBatch] ${result.error.message}`);
  return result.data as ChapterBatchResult;
}

/** 整本拆章结果的原子提交：写章节、推进版本并创建全部章节任务。 */
export async function commitChapterizeResult(input: {
  projectId: string;
  chapters: Array<{
    title: string;
    text: string;
    skip_llm?: boolean;
    source_hash: string;
  }>;
  maxAttempts: number;
}): Promise<{ chapter_count: number; content_revision: number }> {
  const result = await db().rpc('commit_chapterize_result', {
    p_project_id: input.projectId,
    p_chapters: input.chapters,
    p_max_attempts: input.maxAttempts,
  });
  if (result.error) throw new Error(`[db:commitChapterizeResult] ${result.error.message}`);
  return result.data as { chapter_count: number; content_revision: number };
}

/** 章节列表(轻量投影，不含正文与结果) */
export async function listChapterSummaries(projectId: string): Promise<ChapterSummary[]> {
  const result = await db()
    .from('chapters')
    .select(CHAPTER_SUMMARY_COLUMNS)
    .eq('project_id', projectId)
    .order('chapter_index', { ascending: true });
  if (result.error) throw new Error(`[db:listChapterSummaries] ${result.error.message}`);
  return (result.data ?? []) as unknown as ChapterSummary[];
}

export async function getChapter(chapterId: string): Promise<ChapterRow | null> {
  const result = await db().from('chapters').select('*').eq('id', chapterId).maybeSingle();
  if (result.error) throw new Error(`[db:getChapter] ${result.error.message}`);
  return (result.data as ChapterRow | null) ?? null;
}

export interface AdjacentChapter {
  id: string;
  chapter_index: number;
  title: string;
}

/**
 * 取当前章节前后最近的已完成章节。
 *
 * 部分失败项目中可能存在 failed/pending 空档；导航跳过这些没有详情结果的章节，
 * 保证按钮点击后总能进入可阅读的章节页。
 */
export async function getAdjacentChapters(
  projectId: string,
  chapterIndex: number,
): Promise<{ previous: AdjacentChapter | null; next: AdjacentChapter | null }> {
  const columns = 'id, chapter_index, title';
  const [previousResult, nextResult] = await Promise.all([
    db()
      .from('chapters')
      .select(columns)
      .eq('project_id', projectId)
      .eq('status', 'succeeded')
      .lt('chapter_index', chapterIndex)
      .order('chapter_index', { ascending: false })
      .limit(1)
      .maybeSingle(),
    db()
      .from('chapters')
      .select(columns)
      .eq('project_id', projectId)
      .eq('status', 'succeeded')
      .gt('chapter_index', chapterIndex)
      .order('chapter_index', { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);
  if (previousResult.error) {
    throw new Error(`[db:getAdjacentChapters:previous] ${previousResult.error.message}`);
  }
  if (nextResult.error) {
    throw new Error(`[db:getAdjacentChapters:next] ${nextResult.error.message}`);
  }
  return {
    previous: (previousResult.data as AdjacentChapter | null) ?? null,
    next: (nextResult.data as AdjacentChapter | null) ?? null,
  };
}

/** 把不可变的完整单章结果与聚合产生的轻量 enrichment 合成前端消费形状。 */
export function mergeChapterResult(
  result: AnyRecord | null,
  enrichment: AnyRecord | null,
): AnyRecord | null {
  if (!result) return null;
  if (!enrichment) return result;

  const enrichedChunks = new Map<string, AnyRecord>();
  for (const chunk of Array.isArray(enrichment.chunks) ? enrichment.chunks : []) {
    if (chunk && typeof chunk === 'object') enrichedChunks.set(String(chunk.chunk_id ?? ''), chunk as AnyRecord);
  }

  return {
    ...result,
    ...enrichment,
    chunks: (Array.isArray(result.chunks) ? result.chunks : []).map((chunk: AnyRecord) => {
      const extra = enrichedChunks.get(String(chunk.chunk_id ?? ''));
      return extra ? { ...chunk, ...extra } : chunk;
    }),
  };
}

/** 供 worker 取正文去跑 pipeline —— 只要 index/title/source_text/skip_llm */
export async function getChapterForProcessing(
  chapterId: string,
): Promise<Pick<
  ChapterRow,
  'id' | 'project_id' | 'chapter_index' | 'title' | 'source_text' | 'skip_llm'
> | null> {
  const result = await db()
    .from('chapters')
    .select('id, project_id, chapter_index, title, source_text, skip_llm')
    .eq('id', chapterId)
    .maybeSingle();
  if (result.error) throw new Error(`[db:getChapterForProcessing] ${result.error.message}`);
  return (result.data as never) ?? null;
}

export async function markChapterRunning(chapterId: string): Promise<void> {
  const result = await db().from('chapters').update({ status: 'running', error: null }).eq('id', chapterId);
  if (result.error) throw new Error(`[db:markChapterRunning] ${result.error.message}`);
}

/**
 * 写入单章结果。注意这里不改 status —— 状态推进统一由
 * finish_chapter_job() 在同一临界区里完成，避免与项目计数产生竞态。
 */
export async function saveChapterResult(
  chapterId: string,
  payload: { result: AnyRecord; digest: AnyRecord; durationMs: number; analysisRevision: number },
): Promise<void> {
  const result = await db()
    .from('chapters')
    .update({
      result: payload.result,
      digest: payload.digest,
      duration_ms: payload.durationMs,
      analysis_revision: payload.analysisRevision,
      enrichment: null,
      enrichment_revision: 0,
      enriched: false,
    })
    .eq('id', chapterId);
  if (result.error) throw new Error(`[db:saveChapterResult] ${result.error.message}`);
}

/**
 * 分页读取所有 digest 供聚合使用。
 * 必须分页: 单次请求返回几十 MB 会超时。
 */
export async function streamChapterDigests(
  projectId: string,
  targetRevision: number,
  pageSize = 40,
): Promise<{ chapter_id: string; chapter_index: number; digest: AnyRecord }[]> {
  const collected: { chapter_id: string; chapter_index: number; digest: AnyRecord }[] = [];
  for (let from = 0; ; from += pageSize) {
    const result = await db()
      .from('chapters')
      .select('id, chapter_index, digest')
      .eq('project_id', projectId)
      .eq('status', 'succeeded')
      .not('digest', 'is', null)
      .lte('created_revision', targetRevision)
      .order('chapter_index', { ascending: true })
      .range(from, from + pageSize - 1);
    if (result.error) throw new Error(`[db:streamChapterDigests] ${result.error.message}`);
    const rows = result.data ?? [];
    for (const row of rows) {
      collected.push({
        chapter_id: row.id as string,
        chapter_index: row.chapter_index as number,
        digest: row.digest as AnyRecord,
      });
    }
    if (rows.length < pageSize) break;
  }
  return collected;
}

/**
 * 聚合会给 span 绑定 role_id / voice_profile，并生成 tts_segments。
 * 这些改动发生在内存里，必须回写，否则 UI 上所有对白都没有角色和声线——
 * 而那看起来像是 LLM 没识别出角色，极易误判为算法问题。
 * enriched 标志就是为了让这一步的遗漏能被检查出来。
 */
export async function saveEnrichedChapterBatch(input: {
  projectId: string;
  targetRevision: number;
  items: Array<{ chapter_id: string; enrichment: AnyRecord; digest: AnyRecord }>;
}): Promise<{ requested: number; updated: number; target_revision: number }> {
  if (!input.items.length) {
    return { requested: 0, updated: 0, target_revision: input.targetRevision };
  }
  const result = await db().rpc('save_chapter_enrichment_batch', {
    p_project_id: input.projectId,
    p_target_revision: input.targetRevision,
    p_items: input.items,
  });
  if (result.error) throw new Error(`[db:saveEnrichedChapterBatch] ${result.error.message}`);
  return result.data as { requested: number; updated: number; target_revision: number };
}

export async function countChaptersByStatus(projectId: string): Promise<Record<string, number>> {
  const result = await db().from('chapters').select('status').eq('project_id', projectId);
  if (result.error) throw new Error(`[db:countChaptersByStatus] ${result.error.message}`);
  const counts: Record<string, number> = {};
  for (const row of result.data ?? []) {
    const status = String((row as AnyRecord).status);
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

/** 重试失败章节: 复位状态并重新投递任务(任务投递在 jobs.ts) */
export async function resetFailedChapters(projectId: string): Promise<ChapterSummary[]> {
  const result = await db()
    .from('chapters')
    .update({ status: 'pending', error: null })
    .eq('project_id', projectId)
    .eq('status', 'failed')
    .select(CHAPTER_SUMMARY_COLUMNS);
  if (result.error) throw new Error(`[db:resetFailedChapters] ${result.error.message}`);
  return (result.data ?? []) as unknown as ChapterSummary[];
}
