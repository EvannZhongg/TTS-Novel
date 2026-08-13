export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type AnyRecord = Record<string, any>;

export interface AppSettings {
  name: string;
  env: string;
}

export interface LLMSettings {
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutSeconds: number;
  temperature: number;
  maxOutputTokens: number;
  retryMaxAttempts: number;
  retryBackoffSeconds: number;
  logFailedResponseChars: number;
}

export interface PipelineSettings {
  chunkMaxChars: number;
  chunkOverlapChars: number;
  maxParallelChapters: number;
  chapterTitleValidationEnabled: boolean;
  chapterTitleValidationBatchSize: number;
  chapterTitleContextLines: number;
  groundingEnabled: boolean;
  groundingFuzzyMinScore: number;
  groundingEvidenceFuzzyMinScore: number;
  groundingAmbiguityMargin: number;
  groundingEvidenceWindowChars: number;
  quoteSpanRecoveryEnabled: boolean;
  quoteSpanRecoveryContextChars: number;
  quoteSpanRecoveryBatchSize: number;
  roleVoiceProfileEnabled: boolean;
  roleVoiceProfileEvidenceMaxChars: number;
  roleVoiceProfileBatchSize: number;
  roleVoiceProfileMaxParallelBatches: number;
  roleVoiceProfileMinorSpanThreshold: number;
  dialogueSpanPromptFile: string;
  chapterTitleValidationPromptFile: string;
  quoteSpanRecoveryPromptFile: string;
  roleVoiceProfilePromptFile: string;
  roleVoiceProfileMinorGroupPromptFile: string;
}

export interface SupabaseSettings {
  url: string;
  secretKey: string;
  publishableKey: string;
}

export interface QueueSettings {
  /** 领取任务后的租约时长；过期的 running 任务会被回收重投 */
  leaseSeconds: number;
  /** 章节任务最大重试次数 */
  maxAttempts: number;
  /** 单章耗时超过该阈值即告警(实测约 35s/章，接近平台上限时需要关注) */
  chapterSlowWarnMs: number;
  /** 单次 process-next 请求最多连续处理几个任务 */
  maxTasksPerRequest: number;
}

export interface Settings {
  app: AppSettings;
  llm: LLMSettings;
  pipeline: PipelineSettings;
  supabase: SupabaseSettings;
  queue: QueueSettings;
}

export interface PipelineRunRequest {
  book_title?: string;
  text: string;
  chapter_ids?: number[] | null;
}

export interface LLMJsonRequest {
  systemPrompt: string;
  userPrompt: string;
  responseFormatJson?: boolean;
  /** 会被 spread 进上游请求体, 不要往里塞观测用字段 */
  extra?: AnyRecord;
  /**
   * 仅用于观测分类(dialogue_span_extraction / role_voice_profile ...)。
   * 刻意独立于 extra —— extra 会进 API payload, 放这里会改变上游请求体
   * 并污染 cassette 的 prompt 指纹。
   */
  purpose?: string;
}

export interface LLMClient {
  generateJson(request: LLMJsonRequest): Promise<AnyRecord>;
}

/**
 * 单次 LLM 调用的观测记录。
 *
 * 由 LLM client 产出、经 sink 交给调用方处理 —— client 自己不碰数据库,
 * 这样 stages.ts 仍然是纯函数(零 DB 依赖), 落库统一发生在 worker 层。
 *
 * 成功的调用只带指标; 失败时才附 promptExcerpt / responseExcerpt,
 * 因为全量存 prompt+响应在 100 用户规模下会到 600MB(实测)。
 */
export interface LLMCallMetric {
  purpose: string;
  model: string;
  status: 'ok' | 'failed';
  attempt: number;
  durationMs: number;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  error?: string;
  promptExcerpt?: string;
  responseExcerpt?: string;
}

export type LLMMetricSink = (metric: LLMCallMetric) => void;

export interface ChapterTitleCandidate {
  candidate_id: string;
  line_number: number;
  start: number;
  end: number;
  raw_line: string;
  title: string;
  context_before: string[];
  context_after: string[];
}

export interface Chapter {
  chapter_id: number;
  title: string;
  start: number;
  end: number;
  text: string;
  skip_llm?: boolean;
  skip_reason?: string;
}

export interface TextPreprocessResult {
  text: string;
  stats: AnyRecord;
}

export interface TextChunk {
  chunk_id: string;
  chapter_id: number;
  start: number;
  end: number;
  text: string;
  context_before: string;
  context_after: string;
}

export interface QuoteSpanCandidate {
  candidate_id: string;
  start: number;
  end: number;
  text: string;
  quote_open: string;
  quote_close: string;
  context_before: string;
  context_after: string;
}

export interface GroundingCandidate {
  start: number;
  end: number;
  text: string;
  dialogue_score: number;
  evidence_before_score: number;
  evidence_after_score: number;
  total_score: number;
  method: string;
}

export interface GroundingResult {
  status: string;
  start: number | null;
  end: number | null;
  text: string;
  match_score: number;
  method: string;
  candidates: GroundingCandidate[];
  message: string;
}

export type ProgressCallback = (event: AnyRecord) => void;
