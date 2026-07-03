import { round4 } from './utils';
import type { GroundingCandidate, GroundingResult } from './types';

const QUOTE_CHARS = new Set('"\'“”‘’「」『』《》〈〉'.split(''));
const WHITESPACE_CHARS = new Set([' ', '\t', '\r', '\n', '\u3000']);
const BRIDGE_CHARS = new Set([...QUOTE_CHARS, ...WHITESPACE_CHARS, ...'，。！？；：、,.!?;:()（）[]【】'.split('')]);
const PUNCT_MAP: Record<string, string> = {
  '，': ',',
  '。': '.',
  '！': '!',
  '？': '?',
  '；': ';',
  '：': ':',
  '（': '(',
  '）': ')',
  '【': '[',
  '】': ']',
  '、': ',',
  '…': '.',
};

interface NormalizedText {
  text: string;
  indexMap: number[];
}

export class SourceGrounder {
  constructor(
    private readonly options: {
      fuzzyMinScore: number;
      evidenceFuzzyMinScore: number;
      ambiguityMargin: number;
      evidenceWindowChars: number;
    },
  ) {}

  locateExact({ sourceText, query, offsetBase = 0 }: { sourceText: string; query: string; offsetBase?: number }): GroundingResult {
    if (!query) return emptyResult('empty_query', 'query is empty');
    const occurrences = findExactOccurrences(sourceText, query);
    if (!occurrences.length) return emptyResult('unmatched', 'query not found');
    const candidates = occurrences.map(([start, end]) =>
      candidate({ sourceText, start, end, offsetBase, dialogueScore: 1, evidenceBeforeScore: 0, evidenceAfterScore: 0, method: 'exact' }),
    );
    if (candidates.length > 1) {
      return {
        status: 'ambiguous',
        start: candidates[0].start,
        end: candidates[0].end,
        text: candidates[0].text,
        match_score: 1,
        method: 'exact',
        candidates,
        message: 'query appears multiple times',
      };
    }
    return acceptedResult('match_exact', candidates[0]);
  }

  locateDialogueSpan({
    sourceText,
    dialogueText,
    evidenceBefore = '',
    evidenceAfter = '',
    offsetBase = 0,
  }: {
    sourceText: string;
    dialogueText: string;
    evidenceBefore?: string;
    evidenceAfter?: string;
    offsetBase?: number;
  }): GroundingResult {
    const dialogue = (dialogueText || '').trim();
    if (!dialogue) return emptyResult('empty_query', 'dialogue_text is empty');

    const exactCandidates = this.exactCandidates({ sourceText, dialogueText: dialogue, evidenceBefore, evidenceAfter, offsetBase });
    const exactDecision = this.decideExact(exactCandidates, evidenceBefore, evidenceAfter);
    if (exactDecision) return exactDecision;

    const normalizedCandidates = this.normalizedExactCandidates({ sourceText, dialogueText: dialogue, evidenceBefore, evidenceAfter, offsetBase });
    const normalizedDecision = this.decideScoredCandidates(normalizedCandidates, 'match_normalized', 0.9, false);
    if (normalizedDecision) return normalizedDecision;

    const fuzzyCandidates = this.fuzzyCandidates({ sourceText, dialogueText: dialogue, evidenceBefore, evidenceAfter, offsetBase });
    const evidencePresent = Boolean((evidenceBefore || '').trim() || (evidenceAfter || '').trim());
    const minScore = evidencePresent ? this.options.evidenceFuzzyMinScore : this.options.fuzzyMinScore;
    const fuzzyDecision = this.decideScoredCandidates(
      fuzzyCandidates,
      evidencePresent ? 'match_fuzzy_evidence' : 'match_fuzzy',
      minScore,
      evidencePresent,
    );
    if (fuzzyDecision) return fuzzyDecision;

    const allCandidates = [...exactCandidates, ...normalizedCandidates, ...fuzzyCandidates]
      .sort((a, b) => b.total_score - a.total_score)
      .slice(0, 5);
    if (allCandidates.length) {
      return {
        status: 'low_confidence',
        start: null,
        end: null,
        text: '',
        match_score: 0,
        method: '',
        candidates: allCandidates,
        message: 'no candidate passed grounding thresholds',
      };
    }
    return emptyResult('unmatched', 'no plausible dialogue candidate found');
  }

  private exactCandidates(args: {
    sourceText: string;
    dialogueText: string;
    evidenceBefore: string;
    evidenceAfter: string;
    offsetBase: number;
  }): GroundingCandidate[] {
    const candidates: GroundingCandidate[] = [];
    const seen = new Set<string>();
    for (const variant of dialogueVariants(args.dialogueText)) {
      for (const [start, end] of findExactOccurrences(args.sourceText, variant)) {
        const key = `${start}:${end}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(
          this.buildCandidate({
            sourceText: args.sourceText,
            start,
            end,
            offsetBase: args.offsetBase,
            dialogueScore: 1,
            evidenceBefore: args.evidenceBefore,
            evidenceAfter: args.evidenceAfter,
            method: 'exact',
          }),
        );
      }
    }
    return candidates;
  }

  private normalizedExactCandidates(args: {
    sourceText: string;
    dialogueText: string;
    evidenceBefore: string;
    evidenceAfter: string;
    offsetBase: number;
  }): GroundingCandidate[] {
    const sourceNorm = normalizeWithMap(args.sourceText);
    const queryNorm = normalizeWithMap(args.dialogueText).text;
    if (!queryNorm) return [];
    const candidates: GroundingCandidate[] = [];
    const seen = new Set<string>();
    let start = sourceNorm.text.indexOf(queryNorm);
    while (start >= 0) {
      const end = start + queryNorm.length;
      const [origStart, origEnd] = normalizedSpanToOriginal(sourceNorm, start, end);
      const key = `${origStart}:${origEnd}`;
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(
          this.buildCandidate({
            sourceText: args.sourceText,
            start: origStart,
            end: origEnd,
            offsetBase: args.offsetBase,
            dialogueScore: 0.96,
            evidenceBefore: args.evidenceBefore,
            evidenceAfter: args.evidenceAfter,
            method: 'normalized_exact',
          }),
        );
      }
      start = sourceNorm.text.indexOf(queryNorm, start + 1);
    }
    return candidates;
  }

  private fuzzyCandidates(args: {
    sourceText: string;
    dialogueText: string;
    evidenceBefore: string;
    evidenceAfter: string;
    offsetBase: number;
  }): GroundingCandidate[] {
    const windows = this.searchWindows(args.sourceText, args.evidenceBefore, args.evidenceAfter);
    const queryNorm = normalizeWithMap(args.dialogueText).text;
    if (!queryNorm) return [];
    const candidates: GroundingCandidate[] = [];
    const seen = new Set<string>();
    for (const [windowStart, windowEnd] of windows) {
      const windowText = args.sourceText.slice(windowStart, windowEnd);
      const windowNorm = normalizeWithMap(windowText);
      for (const [normStart, normEnd, score] of bestFuzzySpans(windowNorm.text, queryNorm)) {
        let [origStart, origEnd] = normalizedSpanToOriginal(windowNorm, normStart, normEnd);
        origStart += windowStart;
        origEnd += windowStart;
        const key = `${origStart}:${origEnd}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(
          this.buildCandidate({
            sourceText: args.sourceText,
            start: origStart,
            end: origEnd,
            offsetBase: args.offsetBase,
            dialogueScore: score,
            evidenceBefore: args.evidenceBefore,
            evidenceAfter: args.evidenceAfter,
            method: 'fuzzy',
          }),
        );
      }
    }
    return candidates.sort((a, b) => b.total_score - a.total_score).slice(0, 8);
  }

  private searchWindows(sourceText: string, evidenceBefore: string, evidenceAfter: string): Array<[number, number]> {
    const beforeAnchors = findAnchorSpans(sourceText, evidenceBefore);
    const afterAnchors = findAnchorSpans(sourceText, evidenceAfter);
    const windows: Array<[number, number]> = [];
    for (const [, beforeEnd] of beforeAnchors) {
      for (const [afterStart] of afterAnchors) {
        if (beforeEnd <= afterStart) windows.push([Math.max(0, beforeEnd - 40), Math.min(sourceText.length, afterStart + 40)]);
      }
    }
    if (!windows.length && beforeAnchors.length) {
      for (const [, beforeEnd] of beforeAnchors) windows.push([beforeEnd, Math.min(sourceText.length, beforeEnd + this.options.evidenceWindowChars)]);
    }
    if (!windows.length && afterAnchors.length) {
      for (const [afterStart] of afterAnchors) windows.push([Math.max(0, afterStart - this.options.evidenceWindowChars), afterStart]);
    }
    if (!windows.length) windows.push([0, sourceText.length]);
    return mergeWindows(windows);
  }

  private buildCandidate(args: {
    sourceText: string;
    start: number;
    end: number;
    offsetBase: number;
    dialogueScore: number;
    evidenceBefore: string;
    evidenceAfter: string;
    method: string;
  }): GroundingCandidate {
    const beforeScore = evidenceBeforeScore({
      sourceText: args.sourceText,
      start: args.start,
      evidence: args.evidenceBefore,
      windowChars: this.options.evidenceWindowChars,
    });
    const afterScore = evidenceAfterScore({
      sourceText: args.sourceText,
      end: args.end,
      evidence: args.evidenceAfter,
      windowChars: this.options.evidenceWindowChars,
    });
    const evidenceScores: number[] = [];
    if ((args.evidenceBefore || '').trim()) evidenceScores.push(beforeScore);
    if ((args.evidenceAfter || '').trim()) evidenceScores.push(afterScore);
    const evidenceScore = evidenceScores.length ? evidenceScores.reduce((a, b) => a + b, 0) / evidenceScores.length : 0;
    const totalScore = evidenceScores.length ? args.dialogueScore * 0.8 + evidenceScore * 0.2 : args.dialogueScore;
    return candidate({
      sourceText: args.sourceText,
      start: args.start,
      end: args.end,
      offsetBase: args.offsetBase,
      dialogueScore: args.dialogueScore,
      evidenceBeforeScore: beforeScore,
      evidenceAfterScore: afterScore,
      totalScore,
      method: args.method,
    });
  }

  private decideExact(candidates: GroundingCandidate[], evidenceBefore: string, evidenceAfter: string): GroundingResult | null {
    if (!candidates.length) return null;
    if (candidates.length === 1) return acceptedResult('match_exact', candidates[0]);
    const evidencePresent = Boolean((evidenceBefore || '').trim() || (evidenceAfter || '').trim());
    if (!evidencePresent) {
      return {
        status: 'ambiguous',
        start: null,
        end: null,
        text: '',
        match_score: 0,
        method: '',
        candidates: [...candidates].sort((a, b) => a.start - b.start).slice(0, 5),
        message: 'exact dialogue appears multiple times and no evidence was supplied',
      };
    }
    const ranked = [...candidates].sort((a, b) => b.total_score - a.total_score);
    const [best, second] = ranked;
    if (best.total_score >= 0.9 && best.total_score - second.total_score >= this.options.ambiguityMargin) {
      return acceptedResult('match_exact_evidence_disambiguated', best);
    }
    return {
      status: 'ambiguous',
      start: null,
      end: null,
      text: '',
      match_score: 0,
      method: '',
      candidates: ranked.slice(0, 5),
      message: 'exact dialogue appears multiple times and evidence did not clearly disambiguate',
    };
  }

  private decideScoredCandidates(candidates: GroundingCandidate[], acceptStatus: string, minScore: number, requireEvidence: boolean): GroundingResult | null {
    if (!candidates.length) return null;
    const ranked = [...candidates].sort((a, b) => b.total_score - a.total_score);
    const best = ranked[0];
    if (requireEvidence && Math.max(best.evidence_before_score, best.evidence_after_score) < 0.8) {
      return { status: 'low_confidence', start: null, end: null, text: '', match_score: 0, method: '', candidates: ranked.slice(0, 5), message: 'best fuzzy candidate lacks supporting evidence' };
    }
    if (best.total_score < minScore) {
      return { status: 'low_confidence', start: null, end: null, text: '', match_score: 0, method: '', candidates: ranked.slice(0, 5), message: `best candidate score ${best.total_score.toFixed(3)} below threshold ${minScore.toFixed(3)}` };
    }
    if (ranked.length > 1 && best.total_score - ranked[1].total_score < this.options.ambiguityMargin) {
      return { status: 'ambiguous', start: null, end: null, text: '', match_score: 0, method: '', candidates: ranked.slice(0, 5), message: 'best candidate is too close to another candidate' };
    }
    return acceptedResult(acceptStatus, best);
  }
}

function emptyResult(status: string, message: string): GroundingResult {
  return { status, start: null, end: null, text: '', match_score: 0, method: '', candidates: [], message };
}

function candidate({
  sourceText,
  start,
  end,
  offsetBase,
  dialogueScore,
  evidenceBeforeScore,
  evidenceAfterScore,
  method,
  totalScore,
}: {
  sourceText: string;
  start: number;
  end: number;
  offsetBase: number;
  dialogueScore: number;
  evidenceBeforeScore: number;
  evidenceAfterScore: number;
  method: string;
  totalScore?: number;
}): GroundingCandidate {
  const score = totalScore ?? dialogueScore;
  return {
    start: offsetBase + start,
    end: offsetBase + end,
    text: sourceText.slice(start, end),
    dialogue_score: round4(dialogueScore),
    evidence_before_score: round4(evidenceBeforeScore),
    evidence_after_score: round4(evidenceAfterScore),
    total_score: round4(score),
    method,
  };
}

function acceptedResult(status: string, cand: GroundingCandidate): GroundingResult {
  return {
    status,
    start: cand.start,
    end: cand.end,
    text: cand.text,
    match_score: cand.total_score,
    method: cand.method,
    candidates: [cand],
    message: '',
  };
}

function dialogueVariants(text: string): string[] {
  return [...new Set([text.trim(), stripWrappingQuotes(text.trim())].filter(Boolean))];
}

function stripWrappingQuotes(text: string): string {
  let stripped = text.trim();
  while (stripped.length >= 2 && QUOTE_CHARS.has(stripped[0]) && QUOTE_CHARS.has(stripped[stripped.length - 1])) {
    stripped = stripped.slice(1, -1).trim();
  }
  return stripped;
}

function findExactOccurrences(sourceText: string, query: string): Array<[number, number]> {
  if (!query) return [];
  const occurrences: Array<[number, number]> = [];
  let start = sourceText.indexOf(query);
  while (start >= 0) {
    occurrences.push([start, start + query.length]);
    start = sourceText.indexOf(query, start + 1);
  }
  return occurrences;
}

function findAnchorSpans(sourceText: string, evidence: string): Array<[number, number]> {
  const cleanEvidence = (evidence || '').trim();
  if (!cleanEvidence) return [];
  const spans: Array<[number, number]> = [];
  const seen = new Set<string>();
  for (const variant of dialogueVariants(cleanEvidence)) {
    for (const [start, end] of findExactOccurrences(sourceText, variant)) {
      const key = `${start}:${end}`;
      if (!seen.has(key)) {
        seen.add(key);
        spans.push([start, end]);
      }
    }
  }
  if (spans.length) return spans;
  const sourceNorm = normalizeWithMap(sourceText);
  const evidenceNorm = normalizeWithMap(cleanEvidence).text;
  if (!evidenceNorm) return [];
  let start = sourceNorm.text.indexOf(evidenceNorm);
  while (start >= 0) {
    const end = start + evidenceNorm.length;
    spans.push(normalizedSpanToOriginal(sourceNorm, start, end));
    start = sourceNorm.text.indexOf(evidenceNorm, start + 1);
  }
  return spans;
}

function evidenceBeforeScore({ sourceText, start, evidence, windowChars }: { sourceText: string; start: number; evidence: string; windowChars: number }): number {
  const cleanEvidence = (evidence || '').trim();
  if (!cleanEvidence) return 0;
  const windowStart = Math.max(0, start - windowChars);
  const window = sourceText.slice(windowStart, start);
  const anchorSpans = findAnchorSpans(window, cleanEvidence)
    .map(([anchorStart, anchorEnd]) => [anchorStart + windowStart, anchorEnd + windowStart] as [number, number])
    .filter(([, anchorEnd]) => anchorEnd <= start);
  if (!anchorSpans.length) return evidenceScore(window, cleanEvidence) * 0.5;
  return Math.max(...anchorSpans.map(([, anchorEnd]) => evidenceProximityScore(sourceText.slice(anchorEnd, start))));
}

function evidenceAfterScore({ sourceText, end, evidence, windowChars }: { sourceText: string; end: number; evidence: string; windowChars: number }): number {
  const cleanEvidence = (evidence || '').trim();
  if (!cleanEvidence) return 0;
  const windowEnd = Math.min(sourceText.length, end + windowChars);
  const window = sourceText.slice(end, windowEnd);
  const anchorSpans = findAnchorSpans(window, cleanEvidence)
    .map(([anchorStart, anchorEnd]) => [anchorStart + end, anchorEnd + end] as [number, number])
    .filter(([anchorStart]) => anchorStart >= end);
  if (!anchorSpans.length) return evidenceScore(window, cleanEvidence) * 0.5;
  return Math.max(...anchorSpans.map(([anchorStart]) => evidenceProximityScore(sourceText.slice(end, anchorStart))));
}

function evidenceProximityScore(gap: string): number {
  if (isBridgeGap(gap)) return 1;
  const normalizedGapLen = normalizeWithMap(gap).text.length;
  if (normalizedGapLen <= 2) return 0.82;
  if (normalizedGapLen <= 8) return 0.72;
  if (normalizedGapLen <= 24) return 0.55;
  if (normalizedGapLen <= 60) return 0.35;
  return 0.2;
}

function isBridgeGap(gap: string): boolean {
  return [...(gap || '')].every((char) => BRIDGE_CHARS.has(char));
}

function evidenceScore(window: string, evidence: string): number {
  const windowNorm = normalizeWithMap(window).text;
  const evidenceNorm = normalizeWithMap(evidence).text;
  if (!evidenceNorm || !windowNorm) return 0;
  if (windowNorm.includes(evidenceNorm)) return 1;
  return bestFuzzyScore(windowNorm, evidenceNorm);
}

function bestFuzzyScore(sourceNorm: string, queryNorm: string): number {
  return bestFuzzySpans(sourceNorm, queryNorm, 1)[0]?.[2] ?? 0;
}

function bestFuzzySpans(sourceNorm: string, queryNorm: string, limit = 5): Array<[number, number, number]> {
  if (!sourceNorm || !queryNorm) return [];
  const queryLen = queryNorm.length;
  const lengthCandidates = [...new Set([queryLen, Math.max(1, Math.floor(queryLen * 0.8)), Math.max(1, Math.floor(queryLen * 0.9)), Math.max(1, Math.floor(queryLen * 1.1)), Math.max(1, Math.floor(queryLen * 1.2))])].sort((a, b) => a - b);
  const spans: Array<[number, number, number]> = [];
  const seen = new Set<string>();
  for (const length of lengthCandidates) {
    if (length > sourceNorm.length) continue;
    for (let start = 0; start <= sourceNorm.length - length; start += 1) {
      const end = start + length;
      const key = `${start}:${end}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const score = sequenceRatio(sourceNorm.slice(start, end), queryNorm);
      if (score >= 0.72) spans.push([start, end, round4(score)]);
    }
  }
  return spans.sort((a, b) => b[2] - a[2]).slice(0, limit);
}

function sequenceRatio(a: string, b: string): number {
  // Ratcliff-Obershelp style similarity close to Python difflib.SequenceMatcher.ratio().
  const memo = new Map<string, number>();
  function longest(i1: number, i2: number, j1: number, j2: number): [number, number, number] {
    let bestI = i1;
    let bestJ = j1;
    let bestSize = 0;
    for (let i = i1; i < i2; i += 1) {
      for (let j = j1; j < j2; j += 1) {
        let k = 0;
        while (i + k < i2 && j + k < j2 && a[i + k] === b[j + k]) k += 1;
        if (k > bestSize) {
          bestI = i;
          bestJ = j;
          bestSize = k;
        }
      }
    }
    return [bestI, bestJ, bestSize];
  }
  function matches(i1: number, i2: number, j1: number, j2: number): number {
    const key = `${i1}:${i2}:${j1}:${j2}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const [i, j, size] = longest(i1, i2, j1, j2);
    if (!size) {
      memo.set(key, 0);
      return 0;
    }
    const total = matches(i1, i, j1, j) + size + matches(i + size, i2, j + size, j2);
    memo.set(key, total);
    return total;
  }
  if (!a.length && !b.length) return 1;
  return (2 * matches(0, a.length, 0, b.length)) / (a.length + b.length);
}

function normalizeWithMap(text: string): NormalizedText {
  const chars: string[] = [];
  const indexMap: number[] = [];
  [...(text || '')].forEach((char, index) => {
    if (WHITESPACE_CHARS.has(char) || QUOTE_CHARS.has(char)) return;
    const normalized = (PUNCT_MAP[char] ?? char).toLowerCase();
    for (const normalizedChar of normalized) {
      chars.push(normalizedChar);
      indexMap.push(index);
    }
  });
  return { text: chars.join(''), indexMap };
}

function normalizedSpanToOriginal(normalized: NormalizedText, start: number, end: number): [number, number] {
  if (start < 0 || end <= start || end > normalized.indexMap.length) throw new Error(`Invalid normalized span: ${start}, ${end}`);
  return [normalized.indexMap[start], normalized.indexMap[end - 1] + 1];
}

function mergeWindows(windows: Array<[number, number]>): Array<[number, number]> {
  const ordered = windows.filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (!ordered.length) return [];
  const merged: Array<[number, number]> = [ordered[0]];
  for (const [start, end] of ordered.slice(1)) {
    const last = merged[merged.length - 1];
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}
