export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type AnyRecord = Record<string, any>;

export interface AppSettings {
  name: string;
  env: string;
  dataDir: string;
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
  rulesFallbackEnabled: boolean;
  dialogueSpanPromptFile: string;
  chapterTitleValidationPromptFile: string;
  quoteSpanRecoveryPromptFile: string;
  roleVoiceProfilePromptFile: string;
  roleVoiceProfileMinorGroupPromptFile: string;
}

export interface Settings {
  app: AppSettings;
  llm: LLMSettings;
  pipeline: PipelineSettings;
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
  extra?: AnyRecord;
}

export interface LLMClient {
  generateJson(request: LLMJsonRequest): Promise<AnyRecord>;
}

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
