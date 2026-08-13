import { Chapterizer, Chunker, findQuoteSpanCandidates, NovelTextPreprocessor } from './text';
import { SourceGrounder } from './grounding';
import { createLLMClient, renderPrompt } from './llm';
import { jsonSafeCopy } from './utils';
import type { AnyRecord, Chapter, ChapterTitleCandidate, LLMClient, LLMJsonRequest, LLMMetricSink, PipelineRunRequest, ProgressCallback, QuoteSpanCandidate, Settings } from './types';
import {
  bindRoleRegistryToFinalSpans,
  buildMinorRoleProfileGroups,
  buildRoleProfileInputs,
  buildTtsSegmentsForChapters,
  cleanTextField,
  cleanedTextFromChapters,
  fallbackRoleRegistry,
  finalGroundedDialogueSpans,
  groundingSummary,
  groundRecoveredQuoteSpans,
  markQuoteRecoverySupersededSpans,
  mergeAliasEntriesCrossCanonical,
  mergeAliasesFromChapters,
  mergeAliasesInto,
  mergeGenderVotesFromDialogueSpans,
  missingQuoteSpanCandidates,
  normalizeGender,
  pipelineConfigSnapshot,
  quoteRecoveryToLlmResult,
  repairGroundedQuoteBoundaries,
  roleRegistryFromProfileGeneration,
  spanInterval,
  splitMinorRoleProfileInputs,
  stripWrappingQuoteChars,
} from './runnerHelpers';

type ChapterCompletedCallback = (snapshot: AnyRecord) => void;

export class PipelineRunner {
  private llmRequestCounter = 0;
  readonly preprocessor = new NovelTextPreprocessor();
  readonly chapterizer = new Chapterizer();
  readonly chunker: Chunker;
  readonly grounder: SourceGrounder;
  readonly llm: LLMClient;

  constructor(
    private readonly settings: Settings,
    private readonly progressCallback?: ProgressCallback,
    private readonly chapterCompletedCallback?: ChapterCompletedCallback,
    /** 仅测试用: 注入 cassette 客户端做等价性比对, 生产环境不要传 */
    llmOverride?: LLMClient,
    /** LLM 调用观测回调; runner 自己不落库, 交给 worker 处理 */
    metricSink?: LLMMetricSink,
  ) {
    this.chunker = new Chunker(settings.pipeline.chunkMaxChars, settings.pipeline.chunkOverlapChars);
    this.grounder = new SourceGrounder({
      fuzzyMinScore: settings.pipeline.groundingFuzzyMinScore,
      evidenceFuzzyMinScore: settings.pipeline.groundingEvidenceFuzzyMinScore,
      ambiguityMargin: settings.pipeline.groundingAmbiguityMargin,
      evidenceWindowChars: settings.pipeline.groundingEvidenceWindowChars,
    });
    this.llm = llmOverride ?? createLLMClient(settings.llm, metricSink);
  }

  private emitProgress(stage: string, message: string, data: AnyRecord = {}): void {
    this.progressCallback?.({ stage, message, ...data });
  }

  private async generateJsonWithLog({ request, purpose, stage, context = {} }: { request: LLMJsonRequest; purpose: string; stage: string; context?: AnyRecord }): Promise<AnyRecord> {
    this.llmRequestCounter += 1;
    const requestId = `llm_${String(this.llmRequestCounter).padStart(4, '0')}`;
    const contextPayload = jsonSafeCopy(context);
    try {
      // purpose 用于 llm_calls 的分类统计; 它不进上游请求体
      const result = await this.llm.generateJson({ ...request, purpose });
      this.emitProgress(stage, 'LLM 请求完成', { event_type: 'llm_response', llm_request_id: requestId, llm_purpose: purpose, llm_context: contextPayload, llm_response: jsonSafeCopy(result) });
      return result;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emitProgress(stage, 'LLM 请求失败', { event_type: 'llm_response', llm_request_id: requestId, llm_purpose: purpose, llm_context: contextPayload, error: err.message, error_type: err.name });
      console.error('[pipeline-llm-error]', JSON.stringify({ event: 'pipeline_llm_error', stage, purpose, llm_request_id: requestId, context: contextPayload, error_type: err.name, error: err.message, stack: err.stack ?? '' }, null, 2));
      throw err;
    }
  }

  async runMinimal(input: PipelineRunRequest): Promise<AnyRecord> {
    const request = { book_title: input.book_title || 'untitled', text: input.text, chapter_ids: input.chapter_ids ?? null };
    this.emitProgress('preprocess', '开始拆章前预处理');
    const beforeSplit = this.preprocessor.cleanBeforeChapterSplit(request.text);
    this.emitProgress('preprocess', '拆章前预处理完成', { input_chars: beforeSplit.stats.input_chars, output_chars: beforeSplit.stats.output_chars });

    this.emitProgress('chapter_candidates', '开始识别章节标题候选');
    const titleCandidates = this.chapterizer.findTitleCandidates(beforeSplit.text, this.settings.pipeline.chapterTitleContextLines);
    this.emitProgress('chapter_candidates', '章节标题候选识别完成', { candidate_count: titleCandidates.length });

    this.emitProgress('chapter_validation', '开始 LLM 验证章节标题候选', { candidate_count: titleCandidates.length });
    const [acceptedTitleCandidates, titleValidation] = await this.validateChapterTitleCandidates({ bookTitle: request.book_title, candidates: titleCandidates });
    this.emitProgress('chapter_validation', '章节标题验证完成', { accepted_count: titleValidation.accepted_count, rejected_count: titleValidation.rejected_count });

    this.emitProgress('chapter_split', '开始按已接受标题拆章');
    let chapters = this.chapterizer.split(beforeSplit.text, acceptedTitleCandidates);
    if (request.chapter_ids?.length) {
      const set = new Set(request.chapter_ids);
      chapters = chapters.filter((chapter) => set.has(chapter.chapter_id));
    }
    this.emitProgress('chapter_split', '章节拆分完成', { chapter_count: chapters.length });
    const configSnapshot = pipelineConfigSnapshot(this.settings);
    this.chapterCompletedCallback?.({
      type: 'init',
      book_title: request.book_title,
      status: 'running_partial',
      note: 'Partial pipeline result for frontend progressive rendering.',
      preprocessing: beforeSplit.stats,
      chapter_title_detection: titleValidation,
      ...configSnapshot,
      chapters: chapters.map((chapter) => ({
        chapter_id: chapter.chapter_id,
        title: chapter.title,
        start: chapter.start,
        end: chapter.end,
        original_char_count: chapter.text.length,
        status: 'pending',
        chunks: [],
      })),
    });

    this.emitProgress('span_extraction', '开始章节/chunk 处理与 LLM dialogue span 抽取', { chapter_count: chapters.length });
    const results = await this.processChapters({ bookTitle: request.book_title, chapters });
    this.emitProgress('aliases', '开始合并角色 aliases');
    const aliases = mergeAliasesFromChapters(results);
    this.emitProgress('role_voice_profile', '开始生成全书角色声线 profiles', { role_count: aliases.length });
    const roleVoiceProfileGeneration = await this.buildRoleRegistry({ bookTitle: request.book_title, aliases, chapters: results });
    const roleRegistry = Array.isArray(roleVoiceProfileGeneration.role_registry) ? roleVoiceProfileGeneration.role_registry : [];
    bindRoleRegistryToFinalSpans(results, roleRegistry);
    const ttsSegmentation = buildTtsSegmentsForChapters(results);
    this.emitProgress('completed', 'Pipeline 完成', { alias_count: aliases.length, role_count: roleRegistry.length, chapter_count: results.length, tts_segment_count: ttsSegmentation.summary.segment_count });

    return {
      book_title: request.book_title,
      status: 'completed_minimal',
      note: 'Minimal pipeline returns LLM dialogue spans with source grounding, quote boundary repair, optional quote recovery, and TTS narration/dialogue segments.',
      preprocessing: beforeSplit.stats,
      chapter_title_detection: titleValidation,
      ...configSnapshot,
      aliases,
      role_voice_profile_generation: roleVoiceProfileGeneration,
      role_registry: roleRegistry,
      cleaned_text: cleanedTextFromChapters(results),
      tts_segments: ttsSegmentation.segments,
      tts_segment_summary: ttsSegmentation.summary,
      chapters: results,
    };
  }

  async processChapters({ bookTitle, chapters }: { bookTitle: string; chapters: Chapter[] }): Promise<AnyRecord[]> {
    const maxParallel = Math.max(1, this.settings.pipeline.maxParallelChapters);
    this.emitProgress('chapter_concurrency', '章节并发配置已生效', { max_parallel_chapters: maxParallel, chapter_count: chapters.length });
    const results = new Array<AnyRecord>(chapters.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(maxParallel, chapters.length) }, async () => {
      while (cursor < chapters.length) {
        const index = cursor;
        cursor += 1;
        const chapterResult = await this.processChapter({ bookTitle, chapter: chapters[index] });
        results[index] = chapterResult;
        this.chapterCompletedCallback?.({ type: 'chapter_completed', chapter: chapterResult });
      }
    });
    await Promise.all(workers);
    return results;
  }

  async processChapter({ bookTitle, chapter }: { bookTitle: string; chapter: Chapter }): Promise<AnyRecord> {
    this.emitProgress('chapter_processing', '开始处理章节', { chapter_id: chapter.chapter_id, title: chapter.title });
    const chapterCleaning = this.preprocessor.cleanChapterText(chapter.text);
    const chapterText = chapterCleaning.text;
    const chunks = this.chunker.split({ chapterId: chapter.chapter_id, text: chapterText });
    const chapterResult: AnyRecord = { chapter_id: chapter.chapter_id, title: chapter.title, start: chapter.start, end: chapter.end, cleaned_text: chapterText, char_count: chapterText.length, original_char_count: chapter.text.length, preprocessing: chapterCleaning.stats, aliases: [], chunks: [] };
    let chapterAliases: AnyRecord[] = [];
    this.emitProgress('chapter_processing', '章节清洗和 chunk 切分完成', { chapter_id: chapter.chapter_id, title: chapter.title, chunk_count: chunks.length });
    if (chapter.skip_llm) {
      chapterResult.llm_skipped = true;
      chapterResult.skip_reason = chapter.skip_reason || 'chapter configured to skip LLM extraction';
      chapterResult.chunks = chunks.map((chunk) => ({
        chunk_id: chunk.chunk_id,
        start: chunk.start,
        end: chunk.end,
        text: chunk.text,
        text_preview: chunk.text.slice(0, 300),
        llm_skipped: true,
        skip_reason: chapterResult.skip_reason,
        llm_result: { dialogue_spans: [], aliases: [] },
        quote_span_candidates: [],
        missed_quote_span_candidates: [],
        quote_recovery_result: { candidates: [], aliases: [], skipped: true },
        quote_recovery_llm_result: { dialogue_spans: [], aliases: [] },
        quote_boundary_repairs: [],
        recovered_grounded_dialogue_spans: [],
        quote_recovery_superseded_spans: [],
        grounded_dialogue_spans: [],
        final_grounded_dialogue_spans: [],
        grounding_summary: groundingSummary([]),
        final_grounding_summary: groundingSummary([]),
      }));
      this.emitProgress('chapter_processing', '章节配置为旁白，跳过 LLM span 抽取', { chapter_id: chapter.chapter_id, title: chapter.title, chunk_count: chunks.length });
      return chapterResult;
    }

    const pendingQuoteRecovery: AnyRecord[] = [];
    for (const chunk of chunks) {
      this.emitProgress('span_extraction', '开始抽取 chunk dialogue spans', { chapter_id: chapter.chapter_id, title: chapter.title, chunk_id: chunk.chunk_id });
      const llmResult = await this.extractDialogueSpans({ bookTitle, chapterTitle: chapter.title, chunkId: chunk.chunk_id, targetText: chunk.text, contextBefore: chunk.context_before, contextAfter: chunk.context_after, knownAliases: chapterAliases });
      try {
        mergeGenderVotesFromDialogueSpans(chapterAliases, llmResult.dialogue_spans ?? []);
        mergeAliasesInto(chapterAliases, llmResult.aliases ?? []);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logInvalidLlmOutput(
          'dialogue_span_extraction',
          'Invalid dialogue extraction response while merging aliases/gender votes',
          { book_title: bookTitle, chapter_id: chapter.chapter_id, chapter_title: chapter.title, chunk_id: chunk.chunk_id },
          { error_type: err.name, error: err.message, stack: err.stack ?? '', llm_result: llmResult },
        );
        throw err;
      }
      chapterAliases = mergeAliasEntriesCrossCanonical(chapterAliases);
      const spanCount = Array.isArray(llmResult.dialogue_spans) ? llmResult.dialogue_spans.length : 0;
      this.emitProgress('grounding', 'LLM span 抽取完成，开始 source grounding', { chapter_id: chapter.chapter_id, title: chapter.title, chunk_id: chunk.chunk_id, span_count: spanCount });
      const groundedSpans = this.settings.pipeline.groundingEnabled ? this.groundDialogueSpans({ chunkText: chunk.text, offsetBase: chunk.start, llmResult }) : [];

      let quoteCandidates: QuoteSpanCandidate[] = [];
      let missedQuoteCandidates: QuoteSpanCandidate[] = [];
      const quoteRecoveryResult: AnyRecord = { candidates: [], aliases: [] };
      const quoteRecoveryLlmResult: AnyRecord = { dialogue_spans: [], aliases: [] };
      const recoveredGroundedSpans: AnyRecord[] = [];
      let quoteBoundaryRepairs: AnyRecord[] = [];
      const quoteRecoverySupersededSpans: AnyRecord[] = [];
      if (this.settings.pipeline.quoteSpanRecoveryEnabled) {
        quoteCandidates = findQuoteSpanCandidates(chunk.text, this.settings.pipeline.quoteSpanRecoveryContextChars);
        quoteBoundaryRepairs = repairGroundedQuoteBoundaries(quoteCandidates, groundedSpans, chunk.start);
        if (quoteBoundaryRepairs.length) this.emitProgress('quote_boundary_repair', '已修复引号内对白边界', { chapter_id: chapter.chapter_id, title: chapter.title, chunk_id: chunk.chunk_id, repaired_count: quoteBoundaryRepairs.length });
        missedQuoteCandidates = missingQuoteSpanCandidates(quoteCandidates, groundedSpans, chunk.start);
        if (missedQuoteCandidates.length) this.emitProgress('quote_recovery', '已收集 chunk 遗漏引号候选，等待章节级统一验证', { chapter_id: chapter.chapter_id, title: chapter.title, chunk_id: chunk.chunk_id, candidate_count: quoteCandidates.length, missed_count: missedQuoteCandidates.length });
      }
      const finalGroundedSpans = finalGroundedDialogueSpans(groundedSpans);
      this.emitProgress('grounding', 'chunk source grounding 完成', { chapter_id: chapter.chapter_id, title: chapter.title, chunk_id: chunk.chunk_id, ...groundingSummary(groundedSpans) });
      const chunkResult: AnyRecord = { chunk_id: chunk.chunk_id, start: chunk.start, end: chunk.end, text: chunk.text, text_preview: chunk.text.slice(0, 300), llm_result: llmResult, quote_span_candidates: quoteCandidates, missed_quote_span_candidates: missedQuoteCandidates, quote_recovery_result: quoteRecoveryResult, quote_recovery_llm_result: quoteRecoveryLlmResult, quote_boundary_repairs: quoteBoundaryRepairs, recovered_grounded_dialogue_spans: recoveredGroundedSpans, quote_recovery_superseded_spans: quoteRecoverySupersededSpans, grounded_dialogue_spans: groundedSpans, final_grounded_dialogue_spans: finalGroundedSpans, grounding_summary: groundingSummary(groundedSpans), final_grounding_summary: groundingSummary(finalGroundedSpans) };
      chapterResult.chunks.push(chunkResult);
      if (missedQuoteCandidates.length) pendingQuoteRecovery.push({ chunk, chunk_result: chunkResult, missed_quote_candidates: missedQuoteCandidates });
    }

    if (this.settings.pipeline.quoteSpanRecoveryEnabled && pendingQuoteRecovery.length) {
      const chapterRecoveryCandidates = pendingQuoteRecovery.flatMap((item) => item.missed_quote_candidates as QuoteSpanCandidate[]);
      this.emitProgress('quote_recovery', '开始章节级统一验证遗漏引号候选', { chapter_id: chapter.chapter_id, title: chapter.title, chunk_count: pendingQuoteRecovery.length, missed_count: chapterRecoveryCandidates.length });
      const chapterRecoveryResult = await this.recoverQuoteSpans({ bookTitle, chapterTitle: chapter.title, chunkId: `chapter_${String(chapter.chapter_id).padStart(3, '0')}`, targetText: chapterText, quoteCandidates: chapterRecoveryCandidates, knownAliases: chapterAliases });
      mergeAliasesInto(chapterAliases, chapterRecoveryResult.aliases ?? []);
      let decisionOffset = 0;
      let totalRecovered = 0;
      let totalSuperseded = 0;
      for (const item of pendingQuoteRecovery) {
        const chunk = item.chunk;
        const chunkResult = item.chunk_result;
        const missedQuoteCandidates = item.missed_quote_candidates as QuoteSpanCandidate[];
        const decisionCount = missedQuoteCandidates.length;
        const chunkRecoveryResult: AnyRecord = { candidates: (chapterRecoveryResult.candidates ?? []).slice(decisionOffset, decisionOffset + decisionCount), aliases: [], chapter_level_recovery: true };
        decisionOffset += decisionCount;
        const chunkRecoveryLlmResult = quoteRecoveryToLlmResult(chunkRecoveryResult, missedQuoteCandidates);
        mergeGenderVotesFromDialogueSpans(chapterAliases, chunkRecoveryLlmResult.dialogue_spans ?? []);
        const recoveredGroundedSpans = groundRecoveredQuoteSpans(chunkRecoveryLlmResult, chunkRecoveryResult, missedQuoteCandidates, chunk.start);
        const groundedSpans = [...chunkResult.grounded_dialogue_spans, ...recoveredGroundedSpans];
        const quoteRecoverySupersededSpans = markQuoteRecoverySupersededSpans(groundedSpans, recoveredGroundedSpans);
        const finalGroundedSpans = finalGroundedDialogueSpans(groundedSpans);
        Object.assign(chunkResult, { quote_recovery_result: chunkRecoveryResult, quote_recovery_llm_result: chunkRecoveryLlmResult, recovered_grounded_dialogue_spans: recoveredGroundedSpans, quote_recovery_superseded_spans: quoteRecoverySupersededSpans, grounded_dialogue_spans: groundedSpans, final_grounded_dialogue_spans: finalGroundedSpans, grounding_summary: groundingSummary(groundedSpans), final_grounding_summary: groundingSummary(finalGroundedSpans) });
        totalRecovered += recoveredGroundedSpans.length;
        totalSuperseded += quoteRecoverySupersededSpans.length;
      }
      chapterResult.quote_recovery_result = { candidate_count: chapterRecoveryCandidates.length, chunk_count: pendingQuoteRecovery.length, aliases: chapterRecoveryResult.aliases ?? [], chapter_level_recovery: true };
      chapterAliases = mergeAliasEntriesCrossCanonical(chapterAliases);
      this.emitProgress('quote_recovery', '章节级遗漏引号候选验证完成', { chapter_id: chapter.chapter_id, title: chapter.title, recovered_count: totalRecovered, superseded_count: totalSuperseded });
    }

    chapterResult.aliases = chapterAliases;
    this.emitProgress('chapter_processing', '章节处理完成', { chapter_id: chapter.chapter_id, title: chapter.title, alias_count: chapterAliases.length });
    return chapterResult;
  }

  private groundDialogueSpans({ chunkText, offsetBase, llmResult }: { chunkText: string; offsetBase: number; llmResult: AnyRecord }): AnyRecord[] {
    const rawSpans = llmResult.dialogue_spans ?? [];
    if (!Array.isArray(rawSpans)) {
      logInvalidLlmOutput('dialogue_span_extraction', 'LLM dialogue_spans must be a list', { offsetBase, chunk_text_chars: chunkText.length }, llmResult);
      throw new Error(`LLM dialogue_spans must be a list: ${JSON.stringify(llmResult).slice(0, 500)}`);
    }
    return rawSpans.map((span, index) => {
      if (!span || typeof span !== 'object' || Array.isArray(span)) {
        logInvalidLlmOutput('dialogue_span_extraction', 'LLM dialogue span must be an object', { offsetBase, span_index: index, chunk_text_chars: chunkText.length }, { span, llm_result: llmResult });
        throw new Error(`LLM dialogue span must be an object: ${JSON.stringify(span)}`);
      }
      const item = span as AnyRecord;
      const result = this.grounder.locateDialogueSpan({ sourceText: chunkText, dialogueText: String(item.dialogue_text ?? ''), evidenceBefore: String(item.evidence_before ?? ''), evidenceAfter: String(item.evidence_after ?? ''), offsetBase });
      const rawDialogueText = String(item.dialogue_text ?? '');
      const strippedDialogueText = stripWrappingQuoteChars(rawDialogueText);
      const dialogueText = result.start !== null && result.end !== null ? result.text : strippedDialogueText;
      const grounded: AnyRecord = { span_index: index, speaker: item.speaker ?? '', speaker_gender: normalizeGender(item.speaker_gender), alias_used: item.alias_used ?? '', dialogue_text: dialogueText, evidence_before: item.evidence_before ?? '', evidence_after: item.evidence_after ?? '', emotion: cleanTextField(item.emotion), status: result.status, start: result.start, end: result.end, text: result.text, match_score: result.match_score, method: result.method, message: result.message, candidates: result.candidates };
      if (rawDialogueText !== dialogueText) grounded.raw_dialogue_text = rawDialogueText;
      return grounded;
    });
  }

  private async extractDialogueSpans(args: { bookTitle: string; chapterTitle: string; chunkId: string; targetText: string; contextBefore: string; contextAfter: string; knownAliases?: AnyRecord[] }): Promise<AnyRecord> {
    const payload = { book_title: args.bookTitle, chapter_title: args.chapterTitle, chunk_id: args.chunkId, context_before: args.contextBefore, target_text: args.targetText, context_after: args.contextAfter, known_aliases: args.knownAliases ?? [] };
    const userPrompt = await renderPrompt(this.settings.pipeline.dialogueSpanPromptFile, { payload_json: JSON.stringify(payload, null, 2) });
    return this.generateJsonWithLog({ request: { systemPrompt: '你是小说多角色 TTS 文本分析助手。你必须只返回 JSON 对象。', userPrompt, responseFormatJson: true }, purpose: 'dialogue_span_extraction', stage: 'span_extraction', context: { book_title: args.bookTitle, chapter_title: args.chapterTitle, chunk_id: args.chunkId, target_text_chars: args.targetText.length, context_before_chars: args.contextBefore.length, context_after_chars: args.contextAfter.length, known_alias_count: (args.knownAliases ?? []).length } });
  }

  private async recoverQuoteSpans(args: { bookTitle: string; chapterTitle: string; chunkId: string; targetText: string; quoteCandidates: QuoteSpanCandidate[]; knownAliases?: AnyRecord[] }): Promise<AnyRecord> {
    const allDecisions: AnyRecord[] = [];
    let mergedAliases: AnyRecord[] = [];
    const batchSize = Math.max(1, this.settings.pipeline.quoteSpanRecoveryBatchSize);
    for (let start = 0; start < args.quoteCandidates.length; start += batchSize) {
      const batch = args.quoteCandidates.slice(start, start + batchSize);
      const result = await this.recoverQuoteSpanBatch({ ...args, quoteCandidates: batch });
      const decisions = result.candidates;
      if (!Array.isArray(decisions)) {
        logInvalidLlmOutput('quote_span_recovery', 'Invalid quote span recovery response: candidates must be a list', { book_title: args.bookTitle, chapter_title: args.chapterTitle, chunk_id: args.chunkId, expected_count: batch.length }, result);
        throw new Error(`Invalid quote span recovery response: ${JSON.stringify(result).slice(0, 500)}`);
      }
      if (decisions.length !== batch.length) {
        logInvalidLlmOutput('quote_span_recovery', 'Quote span recovery response count mismatch', { book_title: args.bookTitle, chapter_title: args.chapterTitle, chunk_id: args.chunkId, expected_count: batch.length, actual_count: decisions.length }, result);
        throw new Error(`Quote span recovery response count mismatch: expected ${batch.length}, got ${decisions.length}`);
      }
      for (const decision of decisions) {
        if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
          logInvalidLlmOutput('quote_span_recovery', 'Invalid quote span recovery decision', { book_title: args.bookTitle, chapter_title: args.chapterTitle, chunk_id: args.chunkId }, { decision, llm_result: result });
          throw new Error(`Invalid quote span recovery decision: ${JSON.stringify(decision)}`);
        }
        allDecisions.push(decision);
      }
      try {
        mergeAliasesInto(mergedAliases, result.aliases ?? []);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        logInvalidLlmOutput(
          'quote_span_recovery',
          'Invalid quote span recovery aliases',
          { book_title: args.bookTitle, chapter_title: args.chapterTitle, chunk_id: args.chunkId, expected_count: batch.length },
          { error_type: err.name, error: err.message, stack: err.stack ?? '', llm_result: result },
        );
        throw err;
      }
      mergedAliases = mergeAliasEntriesCrossCanonical(mergedAliases);
    }
    return { candidates: allDecisions, aliases: mergedAliases };
  }

  private async recoverQuoteSpanBatch(args: { bookTitle: string; chapterTitle: string; chunkId: string; targetText: string; quoteCandidates: QuoteSpanCandidate[]; knownAliases?: AnyRecord[] }): Promise<AnyRecord> {
    const payload = { book_title: args.bookTitle, chapter_title: args.chapterTitle, chunk_id: args.chunkId, target_text: args.targetText, known_aliases: args.knownAliases ?? [], quote_candidates: args.quoteCandidates.map((candidate) => ({ context_before: candidate.context_before, quote_open: candidate.quote_open, candidate_text: candidate.text, quote_close: candidate.quote_close, context_after: candidate.context_after })) };
    const userPrompt = await renderPrompt(this.settings.pipeline.quoteSpanRecoveryPromptFile, { payload_json: JSON.stringify(payload, null, 2) });
    return this.generateJsonWithLog({ request: { systemPrompt: '你是小说多角色 TTS 引号候选对白验证助手。你必须只返回 JSON 对象。', userPrompt, responseFormatJson: true }, purpose: 'quote_span_recovery', stage: 'quote_recovery', context: { book_title: args.bookTitle, chapter_title: args.chapterTitle, chunk_id: args.chunkId, target_text_chars: args.targetText.length, quote_candidate_count: args.quoteCandidates.length, known_alias_count: (args.knownAliases ?? []).length } });
  }

  async buildRoleRegistry({ bookTitle, aliases, chapters }: { bookTitle: string; aliases: AnyRecord[]; chapters: AnyRecord[] }): Promise<AnyRecord> {
    const roleInputs = buildRoleProfileInputs(aliases, chapters, Math.max(1, this.settings.pipeline.roleVoiceProfileEvidenceMaxChars));
    if (!roleInputs.length) return { enabled: this.settings.pipeline.roleVoiceProfileEnabled, status: 'empty', role_registry: [] };
    if (!this.settings.pipeline.roleVoiceProfileEnabled) return { enabled: false, status: 'disabled_fallback', role_registry: fallbackRoleRegistry(roleInputs, 'role voice profile disabled') };
    const batchSize = Math.max(1, this.settings.pipeline.roleVoiceProfileBatchSize);
    const maxParallelBatches = Math.max(1, this.settings.pipeline.roleVoiceProfileMaxParallelBatches);
    const minorSpanThreshold = Math.trunc(this.settings.pipeline.roleVoiceProfileMinorSpanThreshold);
    const [majorRoles, minorRoles] = splitMinorRoleProfileInputs(roleInputs, minorSpanThreshold);
    this.emitProgress('role_voice_profile', '角色声线 profile 并发配置已生效', { role_count: roleInputs.length, major_role_count: majorRoles.length, minor_role_count: minorRoles.length, minor_span_threshold: minorSpanThreshold, batch_size: batchSize, max_parallel_batches: maxParallelBatches, batch_count: majorRoles.length ? Math.ceil(majorRoles.length / batchSize) : 0 });
    let llmResult: AnyRecord | null = null;
    try {
      llmResult = await this.generateRoleVoiceProfilesWithMinorGroups({ bookTitle, majorRoles, minorRoles, batchSize, maxParallelBatches });
      return { enabled: true, status: 'llm_enriched', role_registry: roleRegistryFromProfileGeneration(roleInputs, majorRoles, minorRoles, llmResult), llm_result: llmResult, batch_size: batchSize, max_parallel_batches: maxParallelBatches, minor_span_threshold: minorSpanThreshold };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      logInvalidLlmOutput(
        'role_voice_profile',
        'Role voice profile generation failed; falling back to deterministic profiles',
        { book_title: bookTitle, role_count: roleInputs.length, major_role_count: majorRoles.length, minor_role_count: minorRoles.length, batch_size: batchSize, max_parallel_batches: maxParallelBatches, minor_span_threshold: minorSpanThreshold },
        { error_type: err.name, error: err.message, stack: err.stack ?? '', llm_result: llmResult },
      );
      const message = error instanceof Error ? error.message : String(error);
      return { enabled: true, status: 'fallback', error: message, role_registry: fallbackRoleRegistry(roleInputs, message), batch_size: batchSize, max_parallel_batches: maxParallelBatches, minor_span_threshold: minorSpanThreshold };
    }
  }

  private async generateRoleVoiceProfilesWithMinorGroups(args: { bookTitle: string; majorRoles: AnyRecord[]; minorRoles: AnyRecord[]; batchSize: number; maxParallelBatches: number }): Promise<AnyRecord> {
    const majorResult = args.majorRoles.length ? await this.generateRoleVoiceProfilesBatched({ bookTitle: args.bookTitle, roles: args.majorRoles, batchSize: args.batchSize, maxParallelBatches: args.maxParallelBatches }) : { voice_profiles: [], batch_count: 0, batch_size: args.batchSize, max_parallel_batches: args.maxParallelBatches };
    let minorGroups: AnyRecord[] = [];
    let minorResult: AnyRecord = { group_profiles: [] };
    if (args.minorRoles.length) {
      minorGroups = buildMinorRoleProfileGroups(args.minorRoles);
      this.emitProgress('role_voice_profile', '开始生成低频角色共享声线 profile', { minor_role_count: args.minorRoles.length, minor_group_count: minorGroups.length });
      minorResult = await this.generateMinorRoleVoiceProfiles({ bookTitle: args.bookTitle, roleGroups: minorGroups });
      this.emitProgress('role_voice_profile', '低频角色共享声线 profile 完成', { minor_role_count: args.minorRoles.length, minor_group_count: minorGroups.length });
    }
    return { voice_profiles: majorResult.voice_profiles ?? [], minor_group_profiles: minorResult.group_profiles ?? [], major_role_count: args.majorRoles.length, minor_role_count: args.minorRoles.length, minor_groups: minorGroups, major_result: majorResult, minor_result: minorResult, batch_count: majorResult.batch_count ?? 0, batch_size: args.batchSize, max_parallel_batches: args.maxParallelBatches };
  }

  private async generateRoleVoiceProfilesBatched(args: { bookTitle: string; roles: AnyRecord[]; batchSize: number; maxParallelBatches: number }): Promise<AnyRecord> {
    const batches: AnyRecord[][] = [];
    for (let start = 0; start < args.roles.length; start += args.batchSize) batches.push(args.roles.slice(start, start + args.batchSize));
    if (batches.length === 1) {
      const result = await this.generateRoleVoiceProfiles({ bookTitle: args.bookTitle, roles: batches[0] });
      return { ...result, batch_count: 1, batch_size: args.batchSize, max_parallel_batches: args.maxParallelBatches };
    }
    const indexedResults = new Array<AnyRecord>(batches.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(args.maxParallelBatches, batches.length) }, async () => {
      while (cursor < batches.length) {
        const index = cursor;
        cursor += 1;
        const batch = batches[index];
        this.emitProgress('role_voice_profile', '开始生成角色声线 profile batch', { batch_index: index + 1, batch_count: batches.length, role_count: batch.length });
        indexedResults[index] = await this.generateRoleVoiceProfiles({ bookTitle: args.bookTitle, roles: batch });
        this.emitProgress('role_voice_profile', '角色声线 profile batch 完成', { batch_index: index + 1, batch_count: batches.length, role_count: batch.length });
      }
    });
    await Promise.all(workers);
    const voiceProfiles: AnyRecord[] = [];
    for (const [index, result] of indexedResults.entries()) {
      if (!Array.isArray(result.voice_profiles)) {
        logInvalidLlmOutput(
          'role_voice_profile',
          'Invalid role voice profile response: voice_profiles must be a list',
          { book_title: args.bookTitle, batch_index: index + 1, batch_count: batches.length, expected_count: batches[index]?.length ?? 0 },
          result,
        );
        throw new Error(`Invalid role voice profile response: ${JSON.stringify(result).slice(0, 500)}`);
      }
      voiceProfiles.push(...result.voice_profiles);
    }
    return { voice_profiles: voiceProfiles, batch_count: batches.length, batch_size: args.batchSize, max_parallel_batches: args.maxParallelBatches, batches: indexedResults };
  }

  private async generateRoleVoiceProfiles(args: { bookTitle: string; roles: AnyRecord[] }): Promise<AnyRecord> {
    const payload = { book_title: args.bookTitle, roles: args.roles };
    const userPrompt = await renderPrompt(this.settings.pipeline.roleVoiceProfilePromptFile, { payload_json: JSON.stringify(payload, null, 2) });
    return this.generateJsonWithLog({ request: { systemPrompt: '你是小说多角色 TTS 角色声线设计助手。你必须只返回 JSON 对象。', userPrompt, responseFormatJson: true }, purpose: 'role_voice_profile', stage: 'role_voice_profile', context: { book_title: args.bookTitle, role_count: args.roles.length } });
  }

  private async generateMinorRoleVoiceProfiles(args: { bookTitle: string; roleGroups: AnyRecord[] }): Promise<AnyRecord> {
    const payload = { book_title: args.bookTitle, role_groups: args.roleGroups };
    const userPrompt = await renderPrompt(this.settings.pipeline.roleVoiceProfileMinorGroupPromptFile, { payload_json: JSON.stringify(payload, null, 2) });
    return this.generateJsonWithLog({ request: { systemPrompt: '你是小说多角色 TTS 低频角色共享声线设计助手。你必须只返回 JSON 对象。', userPrompt, responseFormatJson: true }, purpose: 'role_voice_profile_minor_group', stage: 'role_voice_profile', context: { book_title: args.bookTitle, minor_group_count: args.roleGroups.length, minor_role_count: args.roleGroups.reduce((sum, group) => sum + Number(group.role_count || 0), 0) } });
  }

  async validateChapterTitleCandidates({ bookTitle, candidates }: { bookTitle: string; candidates: ChapterTitleCandidate[] }): Promise<[ChapterTitleCandidate[], AnyRecord]> {
    if (!candidates.length) return [[], { enabled: this.settings.pipeline.chapterTitleValidationEnabled, candidate_count: 0, accepted_count: 0, rejected_count: 0, batches: [], decisions: [] }];
    if (!this.settings.pipeline.chapterTitleValidationEnabled) {
      return [candidates, { enabled: false, candidate_count: candidates.length, accepted_count: candidates.length, rejected_count: 0, batches: [], decisions: candidates.map((candidate) => ({ candidate_id: candidate.candidate_id, line_number: candidate.line_number, raw_line: candidate.raw_line, title: candidate.title, is_chapter_title: true, normalized_title: candidate.title, confidence: 1, reason: 'validation disabled' })) }];
    }
    const accepted: ChapterTitleCandidate[] = [];
    const decisions: AnyRecord[] = [];
    const batches: AnyRecord[] = [];
    const batchSize = Math.max(1, this.settings.pipeline.chapterTitleValidationBatchSize);
    let batchIndex = 1;
    for (let start = 0; start < candidates.length; start += batchSize, batchIndex += 1) {
      const batch = candidates.slice(start, start + batchSize);
      const result = await this.validateChapterTitleBatch({ bookTitle, batchIndex, candidates: batch });
      batches.push(result);
      const batchDecisions = result.candidates;
      if (!Array.isArray(batchDecisions)) {
        logInvalidLlmOutput('chapter_title_validation', 'Invalid chapter title validation response: candidates must be a list', { book_title: bookTitle, batch_index: batchIndex, expected_count: batch.length }, result);
        throw new Error(`Invalid chapter title validation response: ${JSON.stringify(result).slice(0, 500)}`);
      }
      if (batchDecisions.length !== batch.length) {
        logInvalidLlmOutput('chapter_title_validation', 'Chapter title validation response count mismatch', { book_title: bookTitle, batch_index: batchIndex, expected_count: batch.length, actual_count: batchDecisions.length }, result);
        throw new Error(`Chapter title validation response count mismatch: expected ${batch.length}, got ${batchDecisions.length}`);
      }
      batch.forEach((candidate, index) => {
        const rawDecision = batchDecisions[index];
        if (!rawDecision || typeof rawDecision !== 'object' || Array.isArray(rawDecision)) {
          logInvalidLlmOutput('chapter_title_validation', 'Invalid chapter title validation decision', { book_title: bookTitle, batch_index: batchIndex, candidate, decision_index: index }, { decision: rawDecision, llm_result: result });
          throw new Error(`Invalid chapter title validation decision: ${JSON.stringify(rawDecision)}`);
        }
        const isChapterTitle = Boolean(rawDecision.is_chapter_title);
        const decision = { candidate_id: candidate.candidate_id, line_number: candidate.line_number, raw_line: candidate.raw_line, title: candidate.title, is_chapter_title: isChapterTitle, normalized_title: String(rawDecision.normalized_title || candidate.title), confidence: Number(rawDecision.confidence ?? 0), reason: String(rawDecision.reason || '') };
        decisions.push(decision);
        if (isChapterTitle) accepted.push({ ...candidate, title: decision.normalized_title || candidate.title });
      });
    }
    return [accepted, { enabled: true, candidate_count: candidates.length, accepted_count: accepted.length, rejected_count: candidates.length - accepted.length, batches, decisions }];
  }

  private async validateChapterTitleBatch({ bookTitle, batchIndex, candidates }: { bookTitle: string; batchIndex: number; candidates: ChapterTitleCandidate[] }): Promise<AnyRecord> {
    const payload = { book_title: bookTitle, batch_index: batchIndex, candidates: candidates.map((candidate) => ({ line_number: candidate.line_number, raw_line: candidate.raw_line, title: candidate.title, context_before: candidate.context_before, context_after: candidate.context_after })) };
    const userPrompt = await renderPrompt(this.settings.pipeline.chapterTitleValidationPromptFile, { payload_json: JSON.stringify(payload, null, 2) });
    return this.generateJsonWithLog({ request: { systemPrompt: '你是小说文本结构分析助手。你必须只返回 JSON 对象。', userPrompt, responseFormatJson: true }, purpose: 'chapter_title_validation', stage: 'chapter_validation', context: { book_title: bookTitle, batch_index: batchIndex, candidate_count: candidates.length } });
  }
}

export async function runChapterPreview(runner: PipelineRunner, settings: Settings, request: { book_title?: string; text: string; use_llm_validation?: boolean }): Promise<AnyRecord> {
  const bookTitle = request.book_title || 'untitled';
  const beforeSplit = runner.preprocessor.cleanBeforeChapterSplit(request.text);
  const candidates = runner.chapterizer.findTitleCandidates(beforeSplit.text, settings.pipeline.chapterTitleContextLines);
  let acceptedCandidates: ChapterTitleCandidate[];
  let titleValidation: AnyRecord;
  if (request.use_llm_validation ?? true) {
    [acceptedCandidates, titleValidation] = await runner.validateChapterTitleCandidates({ bookTitle, candidates });
  } else {
    acceptedCandidates = candidates;
    titleValidation = { enabled: false, candidate_count: candidates.length, accepted_count: candidates.length, rejected_count: 0, batches: [], decisions: candidates.map((candidate) => ({ candidate_id: candidate.candidate_id, line_number: candidate.line_number, raw_line: candidate.raw_line, title: candidate.title, is_chapter_title: true, normalized_title: candidate.title, confidence: 1, reason: 'rule preview accepted candidate without LLM validation' })) };
  }
  const chapters = runner.chapterizer.split(beforeSplit.text, acceptedCandidates);
  const chapterItems = chapters.map((chapter) => {
    const chapterCleaning = runner.preprocessor.cleanChapterText(chapter.text);
    const chunks = runner.chunker.split({ chapterId: chapter.chapter_id, text: chapterCleaning.text });
    return { chapter_id: chapter.chapter_id, title: chapter.title, start: chapter.start, end: chapter.end, char_count: chapterCleaning.text.length, original_char_count: chapter.text.length, text_preview: chapterCleaning.text.slice(0, 800), preprocessing: chapterCleaning.stats, chunk_count: chunks.length, chunks: chunks.map((chunk) => ({ chunk_id: chunk.chunk_id, start: chunk.start, end: chunk.end, char_count: chunk.text.length, text_preview: chunk.text.slice(0, 300) })) };
  });
  return { book_title: bookTitle, status: 'chapter_preview', note: 'Preview stops at current chapter split and chunk visualization; dialogue span extraction is not executed.', preprocessing: beforeSplit.stats, chapter_title_detection: titleValidation, chapters: chapterItems };
}

function logInvalidLlmOutput(purpose: string, message: string, context: AnyRecord, payload: unknown): void {
  const event = {
    event: 'llm_output_invalid',
    purpose,
    message,
    context: safeLogValue(context),
    payload: safeLogValue(payload),
  };
  console.error('[llm-output-invalid]', stringifyLogEvent(event));
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
