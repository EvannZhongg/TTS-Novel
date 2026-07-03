import path from 'node:path';
import type { Settings } from './types';

function env(name: string, fallback = ''): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function envInt(name: string, fallback: number): number {
  const value = env(name, '');
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envFloat(name: string, fallback: number): number {
  const value = env(name, '');
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const value = env(name, '');
  if (!value) return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(value.toLowerCase());
}

export function loadSettings(): Settings {
  return {
    app: {
      name: env('APP_NAME', 'tts-pipeline-next'),
      env: env('APP_ENV', process.env.NODE_ENV || 'development'),
      dataDir: env('APP_DATA_DIR', process.env.VERCEL ? '/tmp/tts-pipeline-data' : path.join(process.cwd(), 'data')),
    },
    llm: {
      provider: env('LLM_PROVIDER', 'openai_compatible'),
      baseUrl: env('LLM_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, ''),
      apiKey: env('LLM_API_KEY', ''),
      model: env('LLM_MODEL', 'gpt-4o-mini'),
      timeoutSeconds: envInt('LLM_TIMEOUT_SECONDS', 120),
      temperature: envFloat('LLM_TEMPERATURE', 0),
      maxOutputTokens: envInt('LLM_MAX_OUTPUT_TOKENS', 8192),
      retryMaxAttempts: envInt('LLM_RETRY_MAX_ATTEMPTS', 3),
      retryBackoffSeconds: envFloat('LLM_RETRY_BACKOFF_SECONDS', 1),
      logFailedResponseChars: envInt('LLM_LOG_FAILED_RESPONSE_CHARS', 2000),
    },
    pipeline: {
      chunkMaxChars: envInt('PIPELINE_CHUNK_MAX_CHARS', 800),
      chunkOverlapChars: envInt('PIPELINE_CHUNK_OVERLAP_CHARS', 0),
      maxParallelChapters: envInt('PIPELINE_MAX_PARALLEL_CHAPTERS', 3),
      chapterTitleValidationEnabled: envBool('PIPELINE_CHAPTER_TITLE_VALIDATION_ENABLED', true),
      chapterTitleValidationBatchSize: envInt('PIPELINE_CHAPTER_TITLE_VALIDATION_BATCH_SIZE', 30),
      chapterTitleContextLines: envInt('PIPELINE_CHAPTER_TITLE_CONTEXT_LINES', 2),
      groundingEnabled: envBool('PIPELINE_GROUNDING_ENABLED', true),
      groundingFuzzyMinScore: envFloat('PIPELINE_GROUNDING_FUZZY_MIN_SCORE', 0.9),
      groundingEvidenceFuzzyMinScore: envFloat('PIPELINE_GROUNDING_EVIDENCE_FUZZY_MIN_SCORE', 0.86),
      groundingAmbiguityMargin: envFloat('PIPELINE_GROUNDING_AMBIGUITY_MARGIN', 0.03),
      groundingEvidenceWindowChars: envInt('PIPELINE_GROUNDING_EVIDENCE_WINDOW_CHARS', 240),
      quoteSpanRecoveryEnabled: envBool('PIPELINE_QUOTE_SPAN_RECOVERY_ENABLED', true),
      quoteSpanRecoveryContextChars: envInt('PIPELINE_QUOTE_SPAN_RECOVERY_CONTEXT_CHARS', 80),
      quoteSpanRecoveryBatchSize: envInt('PIPELINE_QUOTE_SPAN_RECOVERY_BATCH_SIZE', 20),
      roleVoiceProfileEnabled: envBool('PIPELINE_ROLE_VOICE_PROFILE_ENABLED', true),
      roleVoiceProfileEvidenceMaxChars: envInt('PIPELINE_ROLE_VOICE_PROFILE_EVIDENCE_MAX_CHARS', 1600),
      roleVoiceProfileBatchSize: envInt('PIPELINE_ROLE_VOICE_PROFILE_BATCH_SIZE', 8),
      roleVoiceProfileMaxParallelBatches: envInt('PIPELINE_ROLE_VOICE_PROFILE_MAX_PARALLEL_BATCHES', 3),
      roleVoiceProfileMinorSpanThreshold: envInt('PIPELINE_ROLE_VOICE_PROFILE_MINOR_SPAN_THRESHOLD', 1),
      rulesFallbackEnabled: envBool('PIPELINE_RULES_FALLBACK_ENABLED', false),
      dialogueSpanPromptFile: env('DIALOGUE_SPAN_PROMPT_FILE', 'dialogue_span_extraction.zh.md'),
      chapterTitleValidationPromptFile: env('CHAPTER_TITLE_VALIDATION_PROMPT_FILE', 'chapter_title_validation.zh.md'),
      quoteSpanRecoveryPromptFile: env('QUOTE_SPAN_RECOVERY_PROMPT_FILE', 'quote_span_recovery.zh.md'),
      roleVoiceProfilePromptFile: env('ROLE_VOICE_PROFILE_PROMPT_FILE', 'role_voice_profile.zh.md'),
      roleVoiceProfileMinorGroupPromptFile: env('ROLE_VOICE_PROFILE_MINOR_GROUP_PROMPT_FILE', 'role_voice_profile_minor_group.zh.md'),
    },
  };
}

export const settings = loadSettings();
