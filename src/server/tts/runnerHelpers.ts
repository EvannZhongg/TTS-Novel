import { toFloat, toInt } from './utils';
import type { AnyRecord, GroundingCandidate, QuoteSpanCandidate, Settings } from './types';

// 当前阶段尚未接入真实音色库，所有人物统一使用占位 ID。
// role_id 仍保持唯一，用于角色绑定；voice_profile_id 不再生成序号。
const PLACEHOLDER_VOICE_PROFILE_ID = 'xxxx';

/**
 * 结果里回显的 pipeline 配置。
 *
 * 原先这段在 runMinimal 里写了两遍(进度快照与最终返回各一份), 两处只要有一处
 * 改动就会静默漂移。抽到这里统一维护。放在 runnerHelpers 而非 stages, 是因为
 * stages 依赖 runner, 反向 import 会形成循环。
 */
export function pipelineConfigSnapshot(settings: Settings): AnyRecord {
  return {
    concurrency: {
      max_parallel_chapters: Math.max(1, settings.pipeline.maxParallelChapters),
      chapter_chunks_are_serial: true,
    },
    grounding: {
      enabled: settings.pipeline.groundingEnabled,
      fuzzy_min_score: settings.pipeline.groundingFuzzyMinScore,
      evidence_fuzzy_min_score: settings.pipeline.groundingEvidenceFuzzyMinScore,
      ambiguity_margin: settings.pipeline.groundingAmbiguityMargin,
      evidence_window_chars: settings.pipeline.groundingEvidenceWindowChars,
    },
    quote_span_recovery: {
      enabled: settings.pipeline.quoteSpanRecoveryEnabled,
      context_chars: settings.pipeline.quoteSpanRecoveryContextChars,
      batch_size: settings.pipeline.quoteSpanRecoveryBatchSize,
      boundary_repair_enabled: settings.pipeline.quoteSpanRecoveryEnabled,
    },
  };
}

export function mergeAliasesFromChapters(chapters: AnyRecord[]): AnyRecord[] {
  const merged: AnyRecord[] = [];
  for (const chapter of chapters) mergeAliasesInto(merged, chapter.aliases ?? []);
  return mergeAliasEntriesCrossCanonical(merged);
}

export function cleanedTextFromChapters(chapters: AnyRecord[]): string {
  const parts: string[] = [];
  for (const chapter of chapters) {
    const title = String(chapter.title ?? '').trim();
    const body = String(chapter.cleaned_text || chapterCleanTextFromChunks(chapter));
    parts.push(title ? `${title}\n${body}` : body);
  }
  return parts.join('\n\n');
}

export function buildRoleProfileInputs(aliases: AnyRecord[], chapters: AnyRecord[], evidenceMaxChars: number): AnyRecord[] {
  const roles: AnyRecord[] = [];
  for (const entry of aliases) {
    const canonicalName = String(entry.canonical_name ?? '').trim();
    if (!canonicalName || canonicalName === 'unknown_speaker') continue;
    const index = roles.length + 1;
    roles.push({
      role_id: `role_${String(index).padStart(4, '0')}`,
      voice_profile_id: PLACEHOLDER_VOICE_PROFILE_ID,
      canonical_name: canonicalName,
      gender: normalizeGender(entry.gender),
      aliases: entryAliases(entry),
      span_evidence: '',
      evidence_char_count: 0,
      evidence_span_count: 0,
      evidence_truncated: false,
    });
  }
  const roleByName = roleLookup(roles);
  for (const chapter of chapters) {
    const chapterTitle = String(chapter.title ?? '');
    for (const chunk of Array.isArray(chapter.chunks) ? chapter.chunks : []) {
      if (!isRecord(chunk)) continue;
      for (const span of Array.isArray(chunk.final_grounded_dialogue_spans) ? chunk.final_grounded_dialogue_spans : []) {
        if (!isRecord(span)) continue;
        const role = spanRole(span, roleByName);
        if (!role) continue;
        if (role.evidence_truncated || role.evidence_char_count >= evidenceMaxChars) continue;
        const sample = spanProfileEvidenceSample(span, chapterTitle);
        if (sample) appendRoleSpanEvidence(role, sample, evidenceMaxChars);
      }
    }
  }
  for (const role of roles) {
    role.span_evidence = String(role.span_evidence ?? '').trim();
    role.evidence_char_count = role.span_evidence.length;
  }
  return roles;
}

function roleLookup(roles: AnyRecord[]): Record<string, AnyRecord> {
  const lookup: Record<string, AnyRecord> = {};
  for (const role of roles) {
    const canonicalName = String(role.canonical_name ?? '').trim();
    if (canonicalName) lookup[canonicalName] = role;
    if (Array.isArray(role.aliases)) {
      for (const alias of role.aliases) {
        const normalized = String(alias).trim();
        if (normalized) lookup[normalized] = role;
      }
    }
  }
  return lookup;
}

function spanRole(span: AnyRecord, roleByName: Record<string, AnyRecord>): AnyRecord | null {
  for (const key of ['canonical_speaker', 'speaker', 'alias_used']) {
    const name = String(span[key] ?? '').trim();
    if (name && roleByName[name]) return roleByName[name];
  }
  return null;
}

function spanProfileEvidenceSample(span: AnyRecord, chapterTitle: string): string {
  const dialogueText = cleanTextField(span.dialogue_text || span.text);
  if (!dialogueText) return '';
  const lines: string[] = [];
  const speaker = cleanTextField(span.canonical_speaker || span.speaker || span.alias_used);
  const headerParts: string[] = [];
  if (chapterTitle) headerParts.push(`章节：${chapterTitle}`);
  if (speaker) headerParts.push(`说话人：${speaker}`);
  lines.push(headerParts.length ? `- ${headerParts.join('；')}` : '-');
  const evidenceBefore = cleanTextField(span.evidence_before);
  const evidenceAfter = cleanTextField(span.evidence_after);
  if (evidenceBefore) lines.push(`  上文：${evidenceBefore}`);
  lines.push(`  对白：${dialogueText}`);
  if (evidenceAfter) lines.push(`  下文：${evidenceAfter}`);
  return lines.join('\n');
}

function appendRoleSpanEvidence(role: AnyRecord, sample: string, maxChars: number): void {
  const current = String(role.span_evidence ?? '');
  const separator = current ? '\n\n' : '';
  const addition = `${separator}${sample}`;
  const remaining = maxChars - current.length;
  if (remaining <= 0) {
    role.evidence_truncated = true;
    return;
  }
  if (addition.length > remaining) {
    role.span_evidence = current + addition.slice(0, remaining);
    role.evidence_truncated = true;
  } else {
    role.span_evidence = current + addition;
  }
  role.evidence_char_count = String(role.span_evidence ?? '').trim().length;
  role.evidence_span_count = toInt(role.evidence_span_count, 0) + 1;
}

export function splitMinorRoleProfileInputs(roleInputs: AnyRecord[], minorSpanThreshold: number): [AnyRecord[], AnyRecord[]] {
  if (minorSpanThreshold < 0) return [[...roleInputs], []];
  const majorRoles: AnyRecord[] = [];
  const minorRoles: AnyRecord[] = [];
  for (const role of roleInputs) {
    const evidenceSpanCount = toInt(role.evidence_span_count, 0);
    if (evidenceSpanCount <= minorSpanThreshold) minorRoles.push(role);
    else majorRoles.push(role);
  }
  return [majorRoles, minorRoles];
}

export function buildMinorRoleProfileGroups(roles: AnyRecord[]): AnyRecord[] {
  const grouped: Record<string, AnyRecord[]> = { male: [], female: [], unknown: [] };
  for (const role of roles) {
    const gender = normalizeGender(role.gender);
    (grouped[gender] ??= []).push(role);
  }
  const groups: AnyRecord[] = [];
  for (const gender of ['male', 'female', 'unknown']) {
    const groupRoles = grouped[gender] ?? [];
    if (!groupRoles.length) continue;
    groups.push({
      group_id: minorRoleGroupId(gender),
      voice_profile_id: PLACEHOLDER_VOICE_PROFILE_ID,
      gender,
      role_count: groupRoles.length,
      roles: groupRoles.slice(0, 30).map(minorRoleProfileSample),
      omitted_role_count: Math.max(0, groupRoles.length - 30),
    });
  }
  return groups;
}

function minorRoleProfileSample(role: AnyRecord): AnyRecord {
  const evidence = cleanTextField(role.span_evidence);
  return {
    canonical_name: role.canonical_name ?? '',
    aliases: Array.isArray(role.aliases) ? role.aliases.slice(0, 5) : [],
    gender: normalizeGender(role.gender),
    evidence_span_count: toInt(role.evidence_span_count, 0),
    span_evidence_preview: evidence.slice(0, 360),
  };
}

function minorRoleGroupId(gender: any): string {
  return `minor_${normalizeGender(gender)}`;
}

export function roleRegistryFromProfileGeneration(
  roleInputs: AnyRecord[],
  majorRoles: AnyRecord[],
  minorRoles: AnyRecord[],
  llmResult: AnyRecord,
): AnyRecord[] {
  const majorRegistry = roleRegistryFromLlmProfiles(majorRoles, llmResult);
  const minorRegistry = roleRegistryFromMinorGroupProfiles(minorRoles, llmResult);
  const registryByRoleId: Record<string, AnyRecord> = {};
  for (const entry of [...majorRegistry, ...minorRegistry]) {
    if (isRecord(entry) && entry.role_id) registryByRoleId[String(entry.role_id)] = entry;
  }
  return roleInputs.map((role) => {
    const entry = registryByRoleId[String(role.role_id ?? '')];
    if (!entry) throw new Error(`role registry missing generated profile for role_id=${role.role_id}`);
    return entry;
  });
}

function roleRegistryFromLlmProfiles(roleInputs: AnyRecord[], llmResult: AnyRecord): AnyRecord[] {
  const rawProfiles = llmResult.voice_profiles;
  if (!Array.isArray(rawProfiles)) throw new Error(`role voice profile response missing voice_profiles list: ${JSON.stringify(llmResult).slice(0, 500)}`);
  if (rawProfiles.length !== roleInputs.length) throw new Error(`role voice profile count mismatch: expected ${roleInputs.length}, got ${rawProfiles.length}`);
  return roleInputs.map((role, index) => {
    const rawProfile = rawProfiles[index];
    if (!isRecord(rawProfile)) throw new Error(`role voice profile must be an object: ${JSON.stringify(rawProfile)}`);
    return roleRegistryEntry(role, llmVoiceProfile(role, rawProfile));
  });
}

function roleRegistryFromMinorGroupProfiles(minorRoles: AnyRecord[], llmResult: AnyRecord): AnyRecord[] {
  if (!minorRoles.length) return [];
  const rawProfiles = llmResult.minor_group_profiles;
  if (!Array.isArray(rawProfiles)) throw new Error(`minor role profile response missing minor_group_profiles list: ${JSON.stringify(llmResult).slice(0, 500)}`);
  const profilesByGroupId: Record<string, AnyRecord> = {};
  for (const rawProfile of rawProfiles) {
    if (!isRecord(rawProfile)) throw new Error(`minor role group profile must be an object: ${JSON.stringify(rawProfile)}`);
    const groupId = String(rawProfile.group_id ?? '').trim();
    if (groupId) profilesByGroupId[groupId] = rawProfile;
  }
  return minorRoles.map((role) => {
    const gender = normalizeGender(role.gender);
    const groupId = minorRoleGroupId(gender);
    const rawProfile = profilesByGroupId[groupId];
    const roleWithSharedVoice = { ...role, voice_profile_id: PLACEHOLDER_VOICE_PROFILE_ID };
    const voiceProfile = rawProfile ? llmVoiceProfile(roleWithSharedVoice, rawProfile, 'llm_minor_group') : fallbackVoiceProfile(gender, `missing minor group profile: ${groupId}`);
    return roleRegistryEntry(roleWithSharedVoice, voiceProfile);
  });
}

function llmVoiceProfile(role: AnyRecord, rawProfile: AnyRecord, source = 'llm'): AnyRecord {
  return {
    description: cleanTextField(rawProfile.description),
    age_group: normalizeAgeGroup(rawProfile.age_group),
    gender: normalizeGender(rawProfile.gender || role.gender),
    confidence: normalizeConfidence(rawProfile.confidence),
    source,
  };
}

export function fallbackRoleRegistry(roleInputs: AnyRecord[], reason: string): AnyRecord[] {
  return roleInputs.map((role) => roleRegistryEntry(role, fallbackVoiceProfile(role.gender, reason)));
}

function roleRegistryEntry(role: AnyRecord, voiceProfile: AnyRecord): AnyRecord {
  return {
    role_id: role.role_id ?? '',
    canonical_name: role.canonical_name ?? '',
    gender: normalizeGender(role.gender),
    aliases: role.aliases ?? [],
    voice_profile_id: role.voice_profile_id ?? '',
    voice_profile: voiceProfile,
    evidence_char_count: toInt(role.evidence_char_count, 0),
    evidence_span_count: toInt(role.evidence_span_count, 0),
    evidence_truncated: Boolean(role.evidence_truncated),
  };
}

function fallbackVoiceProfile(gender: any, reason: string): AnyRecord {
  const normalizedGender = normalizeGender(gender);
  const description = normalizedGender === 'male'
    ? '男性声线，音色自然，发声清晰'
    : normalizedGender === 'female'
      ? '女性声线，音色自然，发声清晰'
      : '中性声线，音色自然，发声清晰';
  return { description, age_group: '未知', gender: normalizedGender, confidence: 0.3, source: 'fallback_gender', fallback_reason: reason };
}

export function bindRoleRegistryToFinalSpans(chapters: AnyRecord[], roleRegistry: AnyRecord[]): void {
  const roleByName = roleLookup(roleRegistry);
  for (const chapter of chapters) {
    for (const chunk of Array.isArray(chapter.chunks) ? chapter.chunks : []) {
      if (!isRecord(chunk)) continue;
      for (const span of Array.isArray(chunk.final_grounded_dialogue_spans) ? chunk.final_grounded_dialogue_spans : []) {
        if (!isRecord(span)) continue;
        const role = spanRole(span, roleByName);
        if (!role) continue;
        span.canonical_speaker = role.canonical_name ?? '';
        span.role_id = role.role_id ?? '';
        span.voice_profile_id = role.voice_profile_id ?? '';
        span.voice_profile = role.voice_profile ?? {};
      }
    }
  }
}

export function buildTtsSegmentsForChapters(chapters: AnyRecord[]): AnyRecord {
  const allSegments: AnyRecord[] = [];
  const summary = emptyTtsSegmentSummary();
  for (const chapter of chapters) {
    const chapterResult = buildTtsSegmentsForChapter(chapter);
    chapter.tts_segments = chapterResult.segments;
    chapter.tts_segment_summary = chapterResult.summary;
    allSegments.push(...chapterResult.segments);
    addTtsSegmentSummary(summary, chapterResult.summary);
  }
  return { segments: allSegments, summary };
}

function buildTtsSegmentsForChapter(chapter: AnyRecord): AnyRecord {
  const chapterText = chapterCleanTextFromChunks(chapter);
  const chapterId = chapter.chapter_id;
  const chapterTitle = String(chapter.title ?? '');
  const [spans, preSkippedSpans] = usableTtsDialogueSpans(chapter, chapterText.length);
  const segments: AnyRecord[] = [];
  let skippedSpans = preSkippedSpans;
  let cursor = 0;
  spans.forEach((span, acceptedIndex) => {
    const interval = spanInterval(span);
    if (!interval) {
      skippedSpans += 1;
      markTtsSegmentSkipped(span, 'invalid_span_interval');
      return;
    }
    const [start, end] = interval;
    if (start < 0 || end > chapterText.length) {
      skippedSpans += 1;
      markTtsSegmentSkipped(span, 'span_outside_chapter_text');
      return;
    }
    if (end <= cursor) {
      skippedSpans += 1;
      markTtsSegmentSkipped(span, 'covered_by_previous_dialogue_segment');
      return;
    }
    if (start < cursor) {
      skippedSpans += 1;
      markTtsSegmentSkipped(span, 'overlaps_previous_dialogue_segment');
      return;
    }
    if (cursor < start) segments.push(ttsNarrationSegment(segments.length, chapterId, chapterTitle, cursor, start, chapterText.slice(cursor, start)));
    const segment = ttsDialogueSegment(segments.length, chapterId, chapterTitle, span, start, end, chapterText.slice(start, end));
    segments.push(segment);
    span.tts_segment_id = segment.segment_id;
    span.tts_segment_skipped = false;
    span.tts_segment_source_index = acceptedIndex;
    cursor = end;
  });
  if (cursor < chapterText.length) segments.push(ttsNarrationSegment(segments.length, chapterId, chapterTitle, cursor, chapterText.length, chapterText.slice(cursor)));
  const summary = ttsSegmentSummary(segments);
  summary.skipped_dialogue_span_count = skippedSpans;
  summary.source_text_chars = chapterText.length;
  summary.coverage_ok = segmentsCoverText(segments, chapterText.length);
  return { segments, summary };
}

function chapterCleanTextFromChunks(chapter: AnyRecord): string {
  const chunks = (Array.isArray(chapter.chunks) ? chapter.chunks : []).filter(isRecord);
  if (!chunks.length) return '';
  const ordered = [...chunks].sort((a, b) => toInt(a.start, 0) - toInt(b.start, 0));
  const parts: string[] = [];
  let cursor = 0;
  for (const chunk of ordered) {
    const start = toInt(chunk.start, cursor);
    let text = String(chunk.text ?? '');
    if (start > cursor) {
      parts.push(' '.repeat(start - cursor));
      cursor = start;
    }
    if (start < cursor) {
      const overlap = cursor - start;
      if (overlap >= text.length) continue;
      text = text.slice(overlap);
    }
    parts.push(text);
    cursor += text.length;
  }
  return parts.join('');
}

function usableTtsDialogueSpans(chapter: AnyRecord, textLength: number): [AnyRecord[], number] {
  const spans: AnyRecord[] = [];
  let skipped = 0;
  for (const chunk of Array.isArray(chapter.chunks) ? chapter.chunks : []) {
    if (!isRecord(chunk)) continue;
    for (const span of Array.isArray(chunk.final_grounded_dialogue_spans) ? chunk.final_grounded_dialogue_spans : []) {
      if (!isRecord(span)) continue;
      const interval = spanInterval(span);
      if (!interval) {
        markTtsSegmentSkipped(span, 'invalid_span_interval');
        skipped += 1;
        continue;
      }
      const [start, end] = interval;
      if (start < 0 || end > textLength) {
        markTtsSegmentSkipped(span, 'span_outside_chapter_text');
        skipped += 1;
        continue;
      }
      if (Boolean(span.superseded)) {
        markTtsSegmentSkipped(span, 'superseded_span');
        skipped += 1;
        continue;
      }
      spans.push(span);
    }
  }
  return [
    spans
      .map((span, index) => ({ span, index }))
      .sort((a, b) => {
        const ai = spanInterval(a.span)?.[0] ?? 0;
        const bi = spanInterval(b.span)?.[0] ?? 0;
        return ai - bi || ttsSpanPriority(b.span) - ttsSpanPriority(a.span) || spanLength(b.span) - spanLength(a.span) || a.index - b.index;
      })
      .map(({ span }) => span),
    skipped,
  ];
}

function ttsSpanPriority(span: AnyRecord): number {
  if (span.source === 'quote_span_recovery') return 30;
  if (span.status === 'match_quote_boundary_repaired') return 20;
  if (String(span.status ?? '').startsWith('match_')) return 10;
  return 0;
}

function spanLength(span: AnyRecord): number {
  const interval = spanInterval(span);
  return interval ? interval[1] - interval[0] : 0;
}

function markTtsSegmentSkipped(span: AnyRecord, reason: string): void {
  span.tts_segment_skipped = true;
  span.tts_segment_skip_reason = reason;
}

function ttsNarrationSegment(index: number, chapterId: any, chapterTitle: string, start: number, end: number, text: string): AnyRecord {
  return { segment_id: ttsSegmentId(chapterId, index), segment_index: index, type: 'narration', chapter_id: chapterId, chapter_title: chapterTitle, start, end, text, char_count: text.length, speaker: 'narrator', speaker_gender: 'unknown', role_id: '', voice_profile_id: '', voice_profile: {} };
}

function ttsDialogueSegment(index: number, chapterId: any, chapterTitle: string, span: AnyRecord, start: number, end: number, text: string): AnyRecord {
  return { segment_id: ttsSegmentId(chapterId, index), segment_index: index, type: 'dialogue', chapter_id: chapterId, chapter_title: chapterTitle, start, end, text, char_count: text.length, speaker: span.canonical_speaker || span.speaker || 'unknown_speaker', raw_speaker: span.speaker ?? '', speaker_gender: normalizeGender(span.speaker_gender), alias_used: span.alias_used ?? '', role_id: span.role_id ?? '', voice_profile_id: span.voice_profile_id ?? '', voice_profile: span.voice_profile ?? {}, emotion: cleanTextField(span.emotion), source: span.source ?? 'llm', status: span.status ?? '', match_score: span.match_score ?? 0, span_index: span.span_index };
}

function ttsSegmentId(chapterId: any, index: number): string {
  const chapterNumber = Number.parseInt(String(chapterId), 10);
  const chapterPart = Number.isFinite(chapterNumber) ? `c${String(chapterNumber).padStart(3, '0')}` : `c${chapterId || 'unknown'}`;
  return `${chapterPart}_s${String(index + 1).padStart(4, '0')}`;
}

function ttsSegmentSummary(segments: AnyRecord[]): AnyRecord {
  const narration = segments.filter((segment) => segment.type === 'narration');
  const dialogue = segments.filter((segment) => segment.type === 'dialogue');
  return { segment_count: segments.length, narration_segment_count: narration.length, dialogue_segment_count: dialogue.length, narration_chars: narration.reduce((sum, segment) => sum + toInt(segment.char_count, 0), 0), dialogue_chars: dialogue.reduce((sum, segment) => sum + toInt(segment.char_count, 0), 0), skipped_dialogue_span_count: 0, source_text_chars: segments.reduce((sum, segment) => sum + toInt(segment.char_count, 0), 0), coverage_ok: true };
}

function emptyTtsSegmentSummary(): AnyRecord {
  return { segment_count: 0, narration_segment_count: 0, dialogue_segment_count: 0, narration_chars: 0, dialogue_chars: 0, skipped_dialogue_span_count: 0, source_text_chars: 0, coverage_ok: true };
}

function addTtsSegmentSummary(target: AnyRecord, source: AnyRecord): void {
  for (const key of ['segment_count', 'narration_segment_count', 'dialogue_segment_count', 'narration_chars', 'dialogue_chars', 'skipped_dialogue_span_count', 'source_text_chars']) {
    target[key] = toInt(target[key], 0) + toInt(source[key], 0);
  }
  target.coverage_ok = Boolean(target.coverage_ok) && source.coverage_ok !== false;
}

function segmentsCoverText(segments: AnyRecord[], textLength: number): boolean {
  let cursor = 0;
  for (const segment of [...segments].sort((a, b) => toInt(a.start, 0) - toInt(b.start, 0))) {
    const start = toInt(segment.start, NaN);
    const end = toInt(segment.end, NaN);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start !== cursor || end < start) return false;
    cursor = end;
  }
  return cursor === textLength;
}

function normalizeAgeGroup(value: any): string {
  const age = String(value ?? '').trim();
  return ['儿童', '少年', '青年', '中年', '老年', '未知'].includes(age) ? age : '未知';
}

function normalizeConfidence(value: any): number {
  const number = toFloat(value, 0);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

export function groundingSummary(groundedSpans: AnyRecord[]): AnyRecord {
  const total = groundedSpans.length;
  const matched = groundedSpans.filter((span) => span?.start !== null && span?.start !== undefined && span?.end !== null && span?.end !== undefined).length;
  const statusCounts: Record<string, number> = {};
  for (const span of groundedSpans) {
    const status = String(span?.status ?? 'unknown');
    statusCounts[status] = (statusCounts[status] ?? 0) + 1;
  }
  return { total, matched, unmatched: total - matched, status_counts: statusCounts };
}

const QUOTE_BOUNDARY_REPAIR_MAX_EXTRA_CHARS = 12;
const QUOTE_BOUNDARY_REPAIR_MIN_OVERLAP_RATIO = 0.65;
const QUOTE_CANDIDATE_COVERED_MIN_RATIO = 0.72;
const QUOTE_RECOVERY_SUPERSEDE_MIN_PRIMARY_OVERLAP_RATIO = 0.55;

export function repairGroundedQuoteBoundaries(quoteCandidates: QuoteSpanCandidate[], groundedSpans: AnyRecord[], offsetBase: number): AnyRecord[] {
  const repairs: AnyRecord[] = [];
  for (const span of groundedSpans) {
    const interval = spanInterval(span);
    if (!interval) continue;
    const candidate = smallestQuoteCandidateContaining(quoteCandidates, interval, offsetBase);
    if (!candidate) continue;
    const candidateInterval: [number, number] = [offsetBase + candidate.start, offsetBase + candidate.end];
    if (candidateInterval[0] === interval[0] && candidateInterval[1] === interval[1]) continue;
    const spanLen = interval[1] - interval[0];
    const candidateLen = candidateInterval[1] - candidateInterval[0];
    if (candidateLen <= spanLen) continue;
    if (candidateLen - spanLen > QUOTE_BOUNDARY_REPAIR_MAX_EXTRA_CHARS) continue;
    const overlapRatio = intervalOverlapLen(interval, candidateInterval) / Math.max(1, spanLen);
    if (overlapRatio < QUOTE_BOUNDARY_REPAIR_MIN_OVERLAP_RATIO) continue;
    repairs.push({ span_index: span.span_index, original_start: interval[0], original_end: interval[1], original_text: span.text || span.dialogue_text || '', repaired_start: candidateInterval[0], repaired_end: candidateInterval[1], repaired_text: candidate.text, quote_candidate_id: candidate.candidate_id, overlap_ratio: Math.round(overlapRatio * 10000) / 10000 });
    span.start = candidateInterval[0];
    span.end = candidateInterval[1];
    setGroundedSpanSourceText(span, candidate.text);
    span.status = 'match_quote_boundary_repaired';
    span.method = 'quote_boundary_repair';
    span.message = 'expanded grounded span to full quote candidate boundary';
  }
  return repairs;
}

function setGroundedSpanSourceText(span: AnyRecord, text: string): void {
  span.text = text;
  span.dialogue_text = text;
  span.match_score = Math.max(toFloat(span.match_score, 0), 1);
}

function smallestQuoteCandidateContaining(quoteCandidates: QuoteSpanCandidate[], interval: [number, number], offsetBase: number): QuoteSpanCandidate | null {
  const containing = quoteCandidates.filter((candidate) => {
    const candidateStart = offsetBase + candidate.start;
    const candidateEnd = offsetBase + candidate.end;
    return candidateStart <= interval[0] && candidateEnd >= interval[1];
  });
  if (!containing.length) return null;
  return containing.sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
}

export function missingQuoteSpanCandidates(quoteCandidates: QuoteSpanCandidate[], groundedSpans: AnyRecord[], offsetBase: number): QuoteSpanCandidate[] {
  const acceptedIntervals = groundedSpans.map(spanInterval).filter((value): value is [number, number] => value !== null);
  return quoteCandidates.filter((candidate) => intervalCoverageRatio([offsetBase + candidate.start, offsetBase + candidate.end], acceptedIntervals) < QUOTE_CANDIDATE_COVERED_MIN_RATIO);
}

export function markQuoteRecoverySupersededSpans(groundedSpans: AnyRecord[], recoveredGroundedSpans: AnyRecord[]): AnyRecord[] {
  const superseded: AnyRecord[] = [];
  if (!groundedSpans.length || !recoveredGroundedSpans.length) return superseded;
  for (const primary of groundedSpans) {
    if (primary.source === 'quote_span_recovery' || Boolean(primary.superseded)) continue;
    const primaryInterval = spanInterval(primary);
    if (!primaryInterval) continue;
    const replacement = bestQuoteRecoveryReplacement(primaryInterval, recoveredGroundedSpans);
    if (!replacement) continue;
    const [recovered, overlapRatio] = replacement;
    const recoveredInterval = spanInterval(recovered);
    if (!recoveredInterval) continue;
    primary.superseded = true;
    primary.superseded_by = 'quote_span_recovery';
    primary.superseded_by_span_index = recovered.span_index;
    primary.superseded_by_start = recoveredInterval[0];
    primary.superseded_by_end = recoveredInterval[1];
    primary.superseded_by_text = recovered.text || recovered.dialogue_text || '';
    primary.superseded_overlap_ratio = Math.round(overlapRatio * 10000) / 10000;
    primary.superseded_reason = 'quote recovery produced a fuller overlapping span';
    superseded.push({ span_index: primary.span_index, start: primaryInterval[0], end: primaryInterval[1], text: primary.text || primary.dialogue_text || '', superseded_by: 'quote_span_recovery', superseded_by_span_index: recovered.span_index, superseded_by_start: recoveredInterval[0], superseded_by_end: recoveredInterval[1], superseded_by_text: recovered.text || recovered.dialogue_text || '', overlap_ratio: Math.round(overlapRatio * 10000) / 10000 });
  }
  return superseded;
}

function bestQuoteRecoveryReplacement(primaryInterval: [number, number], recoveredGroundedSpans: AnyRecord[]): [AnyRecord, number] | null {
  const primaryLen = primaryInterval[1] - primaryInterval[0];
  if (primaryLen <= 0) return null;
  const candidates: Array<[AnyRecord, number, number]> = [];
  for (const recovered of recoveredGroundedSpans) {
    const recoveredInterval = spanInterval(recovered);
    if (!recoveredInterval) continue;
    const recoveredLen = recoveredInterval[1] - recoveredInterval[0];
    if (recoveredLen <= primaryLen) continue;
    const overlap = intervalOverlapLen(primaryInterval, recoveredInterval);
    if (overlap <= 0) continue;
    const overlapRatio = overlap / primaryLen;
    if (overlapRatio < QUOTE_RECOVERY_SUPERSEDE_MIN_PRIMARY_OVERLAP_RATIO) continue;
    candidates.push([recovered, overlapRatio, recoveredLen]);
  }
  if (!candidates.length) return null;
  const [recovered, overlapRatio] = candidates.sort((a, b) => b[1] - a[1] || b[2] - a[2])[0];
  return [recovered, overlapRatio];
}

export function finalGroundedDialogueSpans(groundedSpans: AnyRecord[]): AnyRecord[] {
  return groundedSpans
    .filter((span) => !Boolean(span.superseded))
    .map((span, index) => ({ span, index }))
    .sort((a, b) => {
      const ak = spanSortKey(a.index, a.span);
      const bk = spanSortKey(b.index, b.span);
      return ak[0] - bk[0] || ak[1] - bk[1] || ak[2] - bk[2];
    })
    .map(({ span }) => span);
}

function spanSortKey(index: number, span: AnyRecord): [number, number, number] {
  const interval = spanInterval(span);
  if (!interval) return [1, index, index];
  return [0, interval[0], interval[1]];
}

export function quoteRecoveryToLlmResult(quoteRecoveryResult: AnyRecord, quoteCandidates: QuoteSpanCandidate[]): AnyRecord {
  const rawDecisions = quoteRecoveryResult.candidates;
  if (!Array.isArray(rawDecisions)) throw new Error(`quote recovery candidates must be a list: ${JSON.stringify(quoteRecoveryResult).slice(0, 500)}`);
  if (rawDecisions.length !== quoteCandidates.length) throw new Error(`quote recovery candidate count mismatch: expected ${quoteCandidates.length}, got ${rawDecisions.length}`);
  const spans: AnyRecord[] = [];
  quoteCandidates.forEach((candidate, index) => {
    const decision = rawDecisions[index];
    if (!isRecord(decision)) throw new Error(`quote recovery decision must be an object: ${JSON.stringify(decision)}`);
    if (!Boolean(decision.is_dialogue)) return;
    const returnedText = String(decision.dialogue_text ?? '').trim();
    const span: AnyRecord = { speaker: String(decision.speaker || 'unknown_speaker').trim() || 'unknown_speaker', speaker_gender: normalizeGender(decision.speaker_gender), alias_used: String(decision.alias_used ?? ''), dialogue_text: candidate.text, evidence_before: candidate.context_before, evidence_after: candidate.context_after, emotion: cleanTextField(decision.emotion), confidence: decision.confidence ?? 0, quote_recovery_reason: String(decision.reason ?? '') };
    if (returnedText && returnedText !== candidate.text) span.llm_dialogue_text = returnedText;
    spans.push(span);
  });
  const aliases = quoteRecoveryResult.aliases ?? [];
  if (!Array.isArray(aliases)) throw new Error(`quote recovery aliases must be a list: ${JSON.stringify(quoteRecoveryResult).slice(0, 500)}`);
  return { dialogue_spans: spans, aliases };
}

export function groundRecoveredQuoteSpans(quoteRecoveryLlmResult: AnyRecord, quoteRecoveryResult: AnyRecord, quoteCandidates: QuoteSpanCandidate[], offsetBase: number): AnyRecord[] {
  const rawSpans = quoteRecoveryLlmResult.dialogue_spans;
  if (!Array.isArray(rawSpans)) throw new Error(`quote recovery dialogue_spans must be a list: ${JSON.stringify(quoteRecoveryLlmResult).slice(0, 500)}`);
  const rawDecisions = quoteRecoveryResult.candidates;
  if (!Array.isArray(rawDecisions)) throw new Error(`quote recovery candidates must be a list: ${JSON.stringify(quoteRecoveryResult).slice(0, 500)}`);
  const grounded: AnyRecord[] = [];
  let spanIndex = 0;
  quoteCandidates.forEach((candidate, idx) => {
    const decision = rawDecisions[idx];
    if (!isRecord(decision) || !Boolean(decision.is_dialogue)) return;
    if (spanIndex >= rawSpans.length) return;
    const span = rawSpans[spanIndex];
    spanIndex += 1;
    grounded.push(quoteCandidateGrounding(spanIndex - 1, span, candidate, offsetBase));
  });
  if (grounded.length) return grounded;
  const acceptedCandidates = quoteCandidates.filter((_, idx) => isRecord(rawDecisions[idx]) && Boolean(rawDecisions[idx].is_dialogue));
  const candidatesForSpans = acceptedCandidates.length ? acceptedCandidates : quoteCandidates;
  rawSpans.forEach((span, index) => {
    const candidate = candidatesForSpans[index];
    if (!candidate) return;
    if (!isRecord(span)) throw new Error(`quote recovery dialogue span must be an object: ${JSON.stringify(span)}`);
    grounded.push(quoteCandidateGrounding(index, span, candidate, offsetBase));
  });
  return grounded;
}

function quoteCandidateGrounding(index: number, span: AnyRecord, candidate: QuoteSpanCandidate, offsetBase: number): AnyRecord {
  return { span_index: index, source: 'quote_span_recovery', speaker: span.speaker ?? '', speaker_gender: normalizeGender(span.speaker_gender), alias_used: span.alias_used ?? '', dialogue_text: span.dialogue_text ?? '', evidence_before: span.evidence_before ?? '', evidence_after: span.evidence_after ?? '', emotion: cleanTextField(span.emotion), status: 'match_quote_candidate', start: offsetBase + candidate.start, end: offsetBase + candidate.end, text: candidate.text, match_score: 1, method: 'quote_candidate', message: 'LLM accepted quote span candidate as dialogue', candidates: [] };
}

const WRAPPING_QUOTE_PAIRS: Record<string, string> = { '“': '”', '‘': '’', '「': '」', '『': '』', '《': '》', '〈': '〉', '"': '"', "'": "'" };

export function stripWrappingQuoteChars(text: string): string {
  let stripped = (text || '').trim();
  let changed = true;
  while (changed && stripped.length >= 2) {
    changed = false;
    for (const [left, right] of Object.entries(WRAPPING_QUOTE_PAIRS)) {
      if (stripped.startsWith(left) && stripped.endsWith(right)) {
        stripped = stripped.slice(left.length, stripped.length - right.length).trim();
        changed = true;
        break;
      }
    }
  }
  return stripped;
}

export function cleanTextField(value: any): string {
  return String(value || '').trim();
}

export function spanInterval(span: AnyRecord): [number, number] | null {
  if (span.start === null || span.start === undefined || span.end === null || span.end === undefined) return null;
  const start = toInt(span.start, NaN);
  const end = toInt(span.end, NaN);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) return null;
  return [start, end];
}

function intervalOverlapLen(left: [number, number], right: [number, number]): number {
  return Math.max(0, Math.min(left[1], right[1]) - Math.max(left[0], right[0]));
}

function intervalCoverageRatio(target: [number, number], intervals: Array<[number, number]>): number {
  const targetLen = target[1] - target[0];
  if (targetLen <= 0) return 0;
  const overlaps = intervals
    .map((interval) => [Math.max(target[0], interval[0]), Math.min(target[1], interval[1])] as [number, number])
    .filter(([start, end]) => start < end)
    .sort((a, b) => a[0] - b[0]);
  if (!overlaps.length) return 0;
  let covered = 0;
  let [currentStart, currentEnd] = overlaps[0];
  for (const [start, end] of overlaps.slice(1)) {
    if (start <= currentEnd) currentEnd = Math.max(currentEnd, end);
    else {
      covered += currentEnd - currentStart;
      currentStart = start;
      currentEnd = end;
    }
  }
  covered += currentEnd - currentStart;
  return covered / targetLen;
}

export function mergeAliasesInto(target: AnyRecord[], aliases: any): void {
  if (aliases === null || aliases === undefined) return;
  if (!Array.isArray(aliases)) throw new Error(`LLM aliases must be a list, got ${typeof aliases}`);
  const index = aliasIndex(target);
  for (const entry of aliases) {
    if (!isRecord(entry)) throw new Error(`LLM alias entry must be an object: ${JSON.stringify(entry)}`);
    const canonicalName = String(entry.canonical_name ?? '').trim();
    let rawAliases = entry.aliases ?? [];
    if (rawAliases === null) rawAliases = [];
    if (!Array.isArray(rawAliases)) throw new Error(`LLM aliases field must be a list: ${JSON.stringify(entry)}`);
    if (!canonicalName) {
      if (rawAliases.length) throw new Error(`LLM alias entry missing canonical_name: ${JSON.stringify(entry)}`);
      continue;
    }
    let targetEntry = index[canonicalName];
    if (!targetEntry) {
      targetEntry = newAliasEntry(canonicalName);
      target.push(targetEntry);
      index[canonicalName] = targetEntry;
    }
    const existingAliases = targetEntry.aliases;
    for (const alias of rawAliases) {
      if (typeof alias !== 'string') throw new Error(`LLM alias value must be a string: ${JSON.stringify(entry)}`);
      const normalizedAlias = alias.trim();
      if (!normalizedAlias || normalizedAlias === canonicalName) continue;
      if (!existingAliases.includes(normalizedAlias)) existingAliases.push(normalizedAlias);
    }
    if (isRecord(entry.gender_votes)) mergeGenderVotes(targetEntry, entry.gender_votes);
    else addGenderVote(targetEntry, normalizeGender(entry.gender));
    finalizeGender(targetEntry);
  }
}

export function mergeAliasEntriesCrossCanonical(entries: AnyRecord[]): AnyRecord[] {
  if (entries.length <= 1) return entries;
  const parents = entries.map((_, index) => index);
  function find(index: number): number {
    while (parents[index] !== index) {
      parents[index] = parents[parents[index]];
      index = parents[index];
    }
    return index;
  }
  function union(left: number, right: number): void {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    if (leftRoot < rightRoot) parents[rightRoot] = leftRoot;
    else parents[leftRoot] = rightRoot;
  }
  for (let leftIndex = 0; leftIndex < entries.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < entries.length; rightIndex += 1) {
      if (shouldMergeAliasEntriesStrong(entries[leftIndex], entries[rightIndex])) union(leftIndex, rightIndex);
    }
  }
  const grouped: Record<number, Array<[number, AnyRecord]>> = {};
  entries.forEach((entry, index) => (grouped[find(index)] ??= []).push([index, entry]));
  return Object.entries(grouped)
    .map(([root, group]) => [Number(root), mergeAliasEntryGroup(group)] as [number, AnyRecord])
    .sort((a, b) => a[0] - b[0])
    .map(([, entry]) => entry);
}

function shouldMergeAliasEntriesStrong(left: AnyRecord, right: AnyRecord): boolean {
  const leftCanonical = String(left.canonical_name ?? '').trim();
  const rightCanonical = String(right.canonical_name ?? '').trim();
  const leftAliases = new Set(entryAliases(left));
  const rightAliases = new Set(entryAliases(right));
  return Boolean((leftCanonical && rightAliases.has(leftCanonical)) || (rightCanonical && leftAliases.has(rightCanonical)) || [...leftAliases].some((alias) => rightAliases.has(alias)));
}

function mergeAliasEntryGroup(group: Array<[number, AnyRecord]>): AnyRecord {
  const selectedCanonical = selectGroupCanonicalName(group);
  const merged = newAliasEntry(selectedCanonical);
  const aliases = merged.aliases;
  for (const [, entry] of [...group].sort((a, b) => a[0] - b[0])) {
    const canonicalName = String(entry.canonical_name ?? '').trim();
    if (canonicalName && canonicalName !== selectedCanonical && !aliases.includes(canonicalName)) aliases.push(canonicalName);
    for (const alias of entry.aliases ?? []) {
      if (typeof alias !== 'string') throw new Error(`alias value must be a string: ${JSON.stringify(entry)}`);
      const normalizedAlias = alias.trim();
      if (normalizedAlias && normalizedAlias !== selectedCanonical && !aliases.includes(normalizedAlias)) aliases.push(normalizedAlias);
    }
    if (isRecord(entry.gender_votes)) mergeGenderVotes(merged, entry.gender_votes);
    else addGenderVote(merged, normalizeGender(entry.gender));
  }
  finalizeGender(merged);
  return merged;
}

function selectGroupCanonicalName(group: Array<[number, AnyRecord]>): string {
  for (const [, entry] of [...group].sort((a, b) => a[0] - b[0])) {
    const canonicalName = String(entry.canonical_name ?? '').trim();
    if (canonicalName) return canonicalName;
  }
  throw new Error(`alias group missing canonical_name: ${JSON.stringify(group)}`);
}

function entryAliases(entry: AnyRecord): string[] {
  const rawAliases = entry.aliases ?? [];
  if (!Array.isArray(rawAliases)) throw new Error(`aliases field must be a list: ${JSON.stringify(entry)}`);
  const aliases: string[] = [];
  for (const alias of rawAliases) {
    if (typeof alias !== 'string') throw new Error(`alias value must be a string: ${JSON.stringify(entry)}`);
    const normalized = alias.trim();
    if (normalized && !aliases.includes(normalized)) aliases.push(normalized);
  }
  return aliases;
}

export function mergeGenderVotesFromDialogueSpans(target: AnyRecord[], dialogueSpans: any): void {
  if (dialogueSpans === null || dialogueSpans === undefined) return;
  if (!Array.isArray(dialogueSpans)) throw new Error(`LLM dialogue_spans must be a list, got ${typeof dialogueSpans}`);
  const index = aliasIndex(target);
  for (const span of dialogueSpans) {
    if (!isRecord(span)) throw new Error(`LLM dialogue span must be an object: ${JSON.stringify(span)}`);
    const speaker = String(span.speaker ?? '').trim();
    if (!speaker || speaker === 'unknown_speaker') continue;
    let targetEntry = index[speaker];
    if (!targetEntry) {
      targetEntry = newAliasEntry(speaker);
      target.push(targetEntry);
      index[speaker] = targetEntry;
    }
    addGenderVote(targetEntry, normalizeGender(span.speaker_gender));
    finalizeGender(targetEntry);
  }
}

function aliasIndex(target: AnyRecord[]): Record<string, AnyRecord> {
  const index: Record<string, AnyRecord> = {};
  for (const entry of target) {
    if (isRecord(entry)) index[String(entry.canonical_name ?? '').trim()] = entry;
  }
  return index;
}

function newAliasEntry(canonicalName: string): AnyRecord {
  return { canonical_name: canonicalName, gender: 'unknown', gender_votes: { male: 0, female: 0, unknown: 0 }, aliases: [] };
}

export function normalizeGender(value: any): string {
  const gender = String(value || '').trim().toLowerCase();
  if (['male', 'm', '男', '男性', '雄性', '雄兽', '兽夫'].includes(gender)) return 'male';
  if (['female', 'f', '女', '女性', '雌性', '雌兽', '妻主'].includes(gender)) return 'female';
  return 'unknown';
}

function addGenderVote(entry: AnyRecord, gender: string): void {
  const votes = (entry.gender_votes ??= { male: 0, female: 0, unknown: 0 });
  if (!isRecord(votes)) throw new Error(`gender_votes must be an object: ${JSON.stringify(entry)}`);
  const normalized = normalizeGender(gender);
  votes[normalized] = toInt(votes[normalized], 0) + 1;
}

function mergeGenderVotes(entry: AnyRecord, incomingVotes: AnyRecord): void {
  const votes = (entry.gender_votes ??= { male: 0, female: 0, unknown: 0 });
  if (!isRecord(votes)) throw new Error(`gender_votes must be an object: ${JSON.stringify(entry)}`);
  for (const gender of ['male', 'female', 'unknown']) votes[gender] = toInt(votes[gender], 0) + toInt(incomingVotes[gender], 0);
}

function finalizeGender(entry: AnyRecord): void {
  const votes = (entry.gender_votes ??= { male: 0, female: 0, unknown: 0 });
  const maleCount = toInt(votes.male, 0);
  const femaleCount = toInt(votes.female, 0);
  if (maleCount === 0 && femaleCount === 0) entry.gender = 'unknown';
  else if (maleCount > femaleCount) entry.gender = 'male';
  else if (femaleCount > maleCount) entry.gender = 'female';
  else entry.gender = 'unknown';
}

function isRecord(value: any): value is AnyRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
