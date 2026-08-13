import { db } from './client';
import type { AnyRecord, LLMCallMetric } from '../tts/types';

/**
 * LLM 调用日志。
 *
 * 成功的调用只存指标(约 200 bytes); 失败的才额外存 error 与 prompt/响应片段。
 * 依据: 实测约 3.5 次调用/章、单次 prompt+响应约 4.4KB, 全量存在
 * 100 用户 × 400 章规模下会到 600MB, 只存指标则约 27MB。
 * 见 docs/phase0-measurements.md。
 */

export interface LlmCallInsert extends LLMCallMetric {
  projectId: string;
  chapterId?: string | null;
  jobId?: string | null;
}

export async function appendLlmCalls(calls: LlmCallInsert[]): Promise<void> {
  if (!calls.length) return;
  const rows = calls.map((call) => ({
    project_id: call.projectId,
    chapter_id: call.chapterId ?? null,
    job_id: call.jobId ?? null,
    purpose: call.purpose,
    model: call.model,
    status: call.status,
    attempt: call.attempt,
    duration_ms: call.durationMs,
    prompt_tokens: call.promptTokens ?? null,
    completion_tokens: call.completionTokens ?? null,
    total_tokens: call.totalTokens ?? null,
    // 成功的调用不存这三项
    error: call.status === 'failed' ? (call.error ?? null) : null,
    prompt_excerpt: call.status === 'failed' ? (call.promptExcerpt ?? null) : null,
    response_excerpt: call.status === 'failed' ? (call.responseExcerpt ?? null) : null,
  }));
  const result = await db().from('llm_calls').insert(rows);
  if (result.error) {
    // 日志写失败不应让任务失败
    console.error('[db:appendLlmCalls] 写入失败(已忽略)', result.error.message);
  }
}

/** 项目的 token 用量与失败率(Dashboard 用) */
export async function llmUsageForProject(projectId: string): Promise<AnyRecord | null> {
  const result = await db().from('llm_usage_by_project').select('*').eq('project_id', projectId).maybeSingle();
  if (result.error) throw new Error(`[db:llmUsageForProject] ${result.error.message}`);
  return (result.data as AnyRecord | null) ?? null;
}

/** 最近的失败调用, 用于排障 */
export async function recentLlmFailures(projectId: string, limit = 20): Promise<AnyRecord[]> {
  const result = await db()
    .from('llm_calls')
    .select('id, purpose, model, attempt, duration_ms, error, prompt_excerpt, response_excerpt, created_at')
    .eq('project_id', projectId)
    .eq('status', 'failed')
    .order('id', { ascending: false })
    .limit(limit);
  if (result.error) throw new Error(`[db:recentLlmFailures] ${result.error.message}`);
  return (result.data ?? []) as AnyRecord[];
}

/** 清理超过保留期的日志(job_events + llm_calls)。 */
export async function pruneLogs(retainDays = 14): Promise<AnyRecord> {
  const result = await db().rpc('prune_logs', { p_retain_days: retainDays });
  if (result.error) throw new Error(`[db:pruneLogs] ${result.error.message}`);
  return result.data as AnyRecord;
}
