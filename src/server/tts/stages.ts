import { PipelineRunner } from './runner';
import {
  bindRoleRegistryToFinalSpans,
  buildTtsSegmentsForChapters,
  cleanedTextFromChapters,
  mergeAliasesFromChapters,
  pipelineConfigSnapshot,
} from './runnerHelpers';

export { pipelineConfigSnapshot };
import type { AnyRecord, Chapter, LLMClient, LLMMetricSink, ProgressCallback, Settings } from './types';

/**
 * Pipeline 的三个可独立调用阶段。
 *
 * ⚠️ 本文件必须保持"纯函数"性质: 只依赖 settings 与 LLM client,
 *    不得 import 任何 src/server/db/* 或队列相关模块。
 *
 * 原因: 后续对外 API 服务的形态是 {key, text} 单章进 → 结果出。
 * 只要 stage 不含 DB 依赖, 那个接口就能直接调 runChapterStage 拿结果,
 * 一行数据库代码都不需要。所有 DB 读写都收口在 src/server/queue/worker.ts。
 *
 * 三个阶段的职责边界(来自实测, 见 docs/phase0-measurements.md):
 *   chapterize —— 纯正则拆章 + 可选 LLM 标题校验。快, 无需分片。
 *   chapter    —— 单章完整分析。实测约 35s/章, 远低于 300s 上限, 是安全的任务粒度。
 *   aggregate  —— 全书级 aliases / 声线 / TTS。只读各章 digest。
 */

// ------------------------------------------------------------------ Stage 1: 拆章
export interface ChapterizeStageInput {
  bookTitle: string;
  text: string;
  /** 关掉可省一轮 LLM(纯正则拆章), 用于"先给用户看章节列表再确认" */
  useLlmValidation?: boolean;
}

export interface ChapterizeStageOutput {
  bookTitle: string;
  preprocessing: AnyRecord;
  chapterTitleDetection: AnyRecord;
  chapters: Chapter[];
  /** 拆章前预处理后的全文。章节 start/end 以此为基准。 */
  normalizedText: string;
}

export async function runChapterizeStage(
  input: ChapterizeStageInput,
  settings: Settings,
  onProgress?: ProgressCallback,
  llmOverride?: LLMClient,
  metricSink?: LLMMetricSink,
): Promise<ChapterizeStageOutput> {
  const bookTitle = input.bookTitle || 'untitled';
  const runner = new PipelineRunner(settings, onProgress, undefined, llmOverride, metricSink);
  const emit = (stage: string, message: string, data: AnyRecord = {}) => onProgress?.({ stage, message, ...data });

  emit('preprocess', '开始拆章前预处理');
  const beforeSplit = runner.preprocessor.cleanBeforeChapterSplit(input.text);
  emit('preprocess', '拆章前预处理完成', {
    input_chars: beforeSplit.stats.input_chars,
    output_chars: beforeSplit.stats.output_chars,
  });

  emit('chapter_candidates', '开始识别章节标题候选');
  const candidates = runner.chapterizer.findTitleCandidates(beforeSplit.text, settings.pipeline.chapterTitleContextLines);
  emit('chapter_candidates', '章节标题候选识别完成', { candidate_count: candidates.length });

  let accepted = candidates;
  let titleValidation: AnyRecord;
  if (input.useLlmValidation === false) {
    titleValidation = {
      enabled: false,
      candidate_count: candidates.length,
      accepted_count: candidates.length,
      rejected_count: 0,
      decisions: candidates.map((candidate) => ({
        candidate_id: candidate.candidate_id,
        line_number: candidate.line_number,
        raw_line: candidate.raw_line,
        title: candidate.title,
        is_chapter_title: true,
        confidence: 1,
        reason: 'llm validation disabled for this stage call',
        source: 'rule',
      })),
    };
  } else {
    emit('chapter_validation', '开始 LLM 验证章节标题候选', { candidate_count: candidates.length });
    [accepted, titleValidation] = await runner.validateChapterTitleCandidates({ bookTitle, candidates });
    emit('chapter_validation', '章节标题验证完成', {
      accepted_count: titleValidation.accepted_count,
      rejected_count: titleValidation.rejected_count,
    });
  }

  emit('chapter_split', '开始按已接受标题拆章');
  const chapters = runner.chapterizer.split(beforeSplit.text, accepted);
  emit('chapter_split', '章节拆分完成', { chapter_count: chapters.length });

  return {
    bookTitle,
    preprocessing: beforeSplit.stats,
    chapterTitleDetection: titleValidation,
    chapters,
    normalizedText: beforeSplit.text,
  };
}

// ------------------------------------------------------------------ Stage 2: 单章
export interface ChapterStageInput {
  bookTitle: string;
  chapter: Chapter;
}

/**
 * 分析单章。直接复用 runner.processChapter —— 它对单章完全自洽
 * (清洗 → chunk → 逐 chunk LLM 抽取 → grounding → 章节级引号补抽),
 * 这也正是选择"章节"作为任务粒度的原因。
 */
export async function runChapterStage(
  input: ChapterStageInput,
  settings: Settings,
  onProgress?: ProgressCallback,
  llmOverride?: LLMClient,
  metricSink?: LLMMetricSink,
): Promise<AnyRecord> {
  const runner = new PipelineRunner(settings, onProgress, undefined, llmOverride, metricSink);
  return runner.processChapter({ bookTitle: input.bookTitle || 'untitled', chapter: input.chapter });
}

// ------------------------------------------------------------------ Stage 3: 聚合
export interface AggregateStageInput {
  bookTitle: string;
  /** 各章结果(可以是 digest 版本, 见 buildChapterDigest) */
  chapters: AnyRecord[];
}

export interface AggregateStageOutput {
  aliases: AnyRecord[];
  roleVoiceProfileGeneration: AnyRecord;
  roleRegistry: AnyRecord[];
  ttsSegments: AnyRecord[];
  ttsSegmentSummary: AnyRecord;
  /**
   * 聚合会原地改写传入的 chapters(给 span 绑 role_id / voice_profile,
   * 并写入 chapter.tts_segments)。调用方必须把它们回写数据库,
   * 否则 UI 上所有对白都不会有角色和声线。
   */
  enrichedChapters: AnyRecord[];
}

export async function runAggregateStage(
  input: AggregateStageInput,
  settings: Settings,
  onProgress?: ProgressCallback,
  llmOverride?: LLMClient,
  metricSink?: LLMMetricSink,
): Promise<AggregateStageOutput> {
  const bookTitle = input.bookTitle || 'untitled';
  const runner = new PipelineRunner(settings, onProgress, undefined, llmOverride, metricSink);
  const emit = (stage: string, message: string, data: AnyRecord = {}) => onProgress?.({ stage, message, ...data });
  const chapters = input.chapters;

  emit('aliases', '开始合并角色 aliases');
  const aliases = mergeAliasesFromChapters(chapters);

  emit('role_voice_profile', '开始生成全书角色声线 profiles', { role_count: aliases.length });
  const roleVoiceProfileGeneration = await runner.buildRoleRegistry({ bookTitle, aliases, chapters });
  const roleRegistry = Array.isArray(roleVoiceProfileGeneration.role_registry)
    ? roleVoiceProfileGeneration.role_registry
    : [];

  // 以下两步都会原地修改 chapters
  bindRoleRegistryToFinalSpans(chapters, roleRegistry);
  const ttsSegmentation = buildTtsSegmentsForChapters(chapters);

  emit('completed', '全书聚合完成', {
    alias_count: aliases.length,
    role_count: roleRegistry.length,
    chapter_count: chapters.length,
    tts_segment_count: ttsSegmentation.summary.segment_count,
  });

  return {
    aliases,
    roleVoiceProfileGeneration,
    roleRegistry,
    ttsSegments: ttsSegmentation.segments,
    ttsSegmentSummary: ttsSegmentation.summary,
    enrichedChapters: chapters,
  };
}

// ------------------------------------------------------------------ digest 精简
/**
 * 聚合只需要章节结果的一个子集。实测完整单章约 200KB, digest 约 20%,
 * 400 章长篇因此从 87MB 降到 17MB —— 这是聚合任务能在单次调用内跑完的前提。
 *
 * 保留字段的依据(全部来自 runnerHelpers 里三个全书级函数的实际读取):
 *   mergeAliasesFromChapters      读 chapter.aliases
 *   buildRoleProfileInputs        读 chapter.title + chunks[].final_grounded_dialogue_spans
 *   bindRoleRegistryToFinalSpans  改写 chunks[].final_grounded_dialogue_spans
 *   buildTtsSegmentsForChapter    读 chapter.chunks(经 chapterCleanTextFromChunks)
 *                                 + final_grounded_dialogue_spans
 *
 * 注意 chapterCleanTextFromChunks 依赖 chunk.text 拼接章节全文, 所以 chunk.text
 * 必须保留 —— 去掉它会让 TTS 旁白切分错位。
 */
const DIGEST_SPAN_FIELDS = new Set([
  'span_index',
  'speaker',
  'canonical_speaker',
  'alias_used',
  'speaker_gender',
  'emotion',
  'dialogue_text',
  'text',
  'start',
  'end',
  'status',
  'match_score',
  'method',
  'source',
  'role_id',
  'voice_profile_id',
  'voice_profile',
  'evidence_before',
  'evidence_after',
  'tts_segment_skipped',
  'tts_segment_skip_reason',
]);

function digestSpan(span: AnyRecord): AnyRecord {
  const out: AnyRecord = {};
  for (const [key, value] of Object.entries(span)) {
    if (DIGEST_SPAN_FIELDS.has(key)) out[key] = value;
  }
  return out;
}

export function buildChapterDigest(chapter: AnyRecord): AnyRecord {
  const chunks = Array.isArray(chapter.chunks) ? chapter.chunks : [];
  return {
    chapter_id: chapter.chapter_id,
    title: chapter.title ?? '',
    start: chapter.start,
    end: chapter.end,
    cleaned_text: chapter.cleaned_text ?? '',
    char_count: chapter.char_count,
    original_char_count: chapter.original_char_count,
    aliases: chapter.aliases ?? [],
    llm_skipped: chapter.llm_skipped ?? false,
    skip_reason: chapter.skip_reason,
    chunks: chunks.map((chunk: AnyRecord) => ({
      chunk_id: chunk.chunk_id,
      start: chunk.start,
      end: chunk.end,
      // chapterCleanTextFromChunks 靠它重建章节文本, 不能省
      text: chunk.text,
      final_grounded_dialogue_spans: (Array.isArray(chunk.final_grounded_dialogue_spans)
        ? chunk.final_grounded_dialogue_spans
        : []
      ).map(digestSpan),
    })),
  };
}

/**
 * 全书级结果(存 projects.book_result)。
 * 刻意不含 chapters —— 完整章节数据几十到几百 MB, 存成单个 jsonb 会让查询崩掉。
 * 章节内容一律按需从 chapters.result 单独取。
 */
export function buildBookResult(input: {
  bookTitle: string;
  settings: Settings;
  preprocessing?: AnyRecord | null;
  chapterTitleDetection?: AnyRecord | null;
  aggregate: AggregateStageOutput;
  chapterCount: number;
  contentRevision?: number;
}): AnyRecord {
  return {
    schema_version: 'multicast_ebook_book_result_v1',
    book_title: input.bookTitle,
    status: 'completed',
    content_revision: input.contentRevision ?? 1,
    ...pipelineConfigSnapshot(input.settings),
    preprocessing: input.preprocessing ?? null,
    chapter_title_detection: input.chapterTitleDetection ?? null,
    aliases: input.aggregate.aliases,
    role_voice_profile_generation: input.aggregate.roleVoiceProfileGeneration,
    role_registry: input.aggregate.roleRegistry,
    tts_segment_summary: input.aggregate.ttsSegmentSummary,
    chapter_count: input.chapterCount,
  };
}

/**
 * 把三个阶段的产物重新拼成与旧 runMinimal 完全一致的结构。
 * 等价性基准消费这个形状，因此必须保持字段顺序与命名。
 */
export function assembleBookResult(input: {
  bookTitle: string;
  settings: Settings;
  preprocessing: AnyRecord;
  chapterTitleDetection: AnyRecord;
  aggregate: AggregateStageOutput;
  chapters: AnyRecord[];
}): AnyRecord {
  const config = pipelineConfigSnapshot(input.settings);
  return {
    book_title: input.bookTitle,
    status: 'completed_minimal',
    note: 'Minimal pipeline returns LLM dialogue spans with source grounding, quote boundary repair, optional quote recovery, and TTS narration/dialogue segments.',
    preprocessing: input.preprocessing,
    chapter_title_detection: input.chapterTitleDetection,
    concurrency: config.concurrency,
    grounding: config.grounding,
    quote_span_recovery: config.quote_span_recovery,
    aliases: input.aggregate.aliases,
    role_voice_profile_generation: input.aggregate.roleVoiceProfileGeneration,
    role_registry: input.aggregate.roleRegistry,
    cleaned_text: cleanedTextFromChapters(input.chapters),
    tts_segments: input.aggregate.ttsSegments,
    tts_segment_summary: input.aggregate.ttsSegmentSummary,
    chapters: input.chapters,
  };
}
