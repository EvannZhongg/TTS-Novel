import type {
  Chapter,
  ChapterTitleCandidate,
  QuoteSpanCandidate,
  TextChunk,
  TextPreprocessResult,
} from './types';

const CHAPTER_TITLE_RE = /^\s*(?:§{2,}\s*(?<marked_title>第\s*[0-9０-９一二三四五六七八九十百千万零两]+\s*(?:章|回).*)|(?<plain_digit_title>第\s*[0-9０-９]+\s*(?:章|回).*)|(?<plain_chinese_title>第\s*[一二三四五六七八九十百千万零两]+\s*(?:章|回)(?:\s*$|[\s：:].*))|(?<numbered_title>[一二三四五六七八九十百千万零两]{1,4}\s*[、.．]\s*\S.{0,120}))\s*$/;

interface LineRecord {
  line_number: number;
  start: number;
  end: number;
  text: string;
}

export class Chapterizer {
  findTitleCandidates(text: string, contextLines = 2): ChapterTitleCandidate[] {
    const records = lineRecords(text);
    const candidates: ChapterTitleCandidate[] = [];
    records.forEach((record, index) => {
      const match = CHAPTER_TITLE_RE.exec(record.text);
      if (!match?.groups) return;
      const title = (match.groups.marked_title || match.groups.plain_digit_title || match.groups.plain_chinese_title || match.groups.numbered_title || '').trim();
      candidates.push({
        candidate_id: `t${String(candidates.length + 1).padStart(4, '0')}`,
        line_number: record.line_number,
        start: record.start,
        end: record.end,
        raw_line: record.text,
        title,
        context_before: context(records, index, contextLines, true),
        context_after: context(records, index, contextLines, false),
      });
    });
    return candidates;
  }

  split(text: string, candidates?: ChapterTitleCandidate[]): Chapter[] {
    const titleCandidates = candidates ?? this.findTitleCandidates(text);
    const matches = orderedUniqueMatches(titleCandidates);
    if (!matches.length) {
      return [{ chapter_id: 1, title: '正文', start: 0, end: text.length, text }];
    }

    const chapters: Chapter[] = [];
    const preface = text.slice(0, matches[0].start).replace(/[\r\n]+$/, '');
    if (preface.trim()) {
      chapters.push({
        chapter_id: chapters.length + 1,
        title: '前言',
        start: 0,
        end: preface.length,
        text: preface,
        skip_llm: true,
        skip_reason: 'content before first recognized chapter title is treated as narration',
      });
    }

    matches.forEach((match, index) => {
      const bodyEnd = index + 1 < matches.length ? matches[index + 1].start : text.length;
      const rawChapterText = text.slice(match.end, bodyEnd);
      const chapterText = rawChapterText.replace(/^[\r\n]+/, '');
      const trim = bodyEnd - chapterText.length;
      chapters.push({
        chapter_id: chapters.length + 1,
        title: match.title,
        start: trim,
        end: bodyEnd,
        text: chapterText,
      });
    });
    return chapters;
  }
}

function lineRecords(text: string): LineRecord[] {
  const records: LineRecord[] = [];
  let offset = 0;
  const regex = /.*(?:\r\n|\n|\r|$)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const lineWithEnding = match[0];
    if (lineWithEnding === '' && match.index === text.length) break;
    const rawLine = lineWithEnding.replace(/[\r\n]+$/, '');
    records.push({
      line_number: records.length + 1,
      start: offset,
      end: offset + rawLine.length,
      text: rawLine,
    });
    offset += lineWithEnding.length;
    if (regex.lastIndex === text.length) break;
  }
  return records;
}

function context(records: LineRecord[], index: number, count: number, before: boolean): string[] {
  if (count <= 0) return [];
  const selected: string[] = [];
  let cursor = before ? index - 1 : index + 1;
  const step = before ? -1 : 1;
  while (cursor >= 0 && cursor < records.length && selected.length < count) {
    const text = records[cursor].text.trim();
    if (text) selected.push(text.slice(0, 200));
    cursor += step;
  }
  if (before) selected.reverse();
  return selected;
}

function orderedUniqueMatches(candidates: ChapterTitleCandidate[]): Array<{ start: number; end: number; title: string }> {
  const matches: Array<{ start: number; end: number; title: string }> = [];
  const seen = new Set<number>();
  [...candidates]
    .sort((a, b) => a.start - b.start)
    .forEach((candidate) => {
      if (seen.has(candidate.start)) return;
      seen.add(candidate.start);
      matches.push({ start: candidate.start, end: candidate.end, title: candidate.title });
    });
  return matches;
}

const NOISE_PATTERNS = [
  /<img\b[^>]*>/gis,
  /img\s+data-ywcc-[^>]*>?/gis,
  /data-ywcc-(?:imgId|path)\s*=\s*"[^"]*"/gi,
  /https?:\/\/[^\s<>"'\]]+/gi,
  /\b(?:www\.)?[A-Za-z0-9-]+(?:\.(?:com\.cn|com|net|org|cn|edu|gov|info|io|co|me|tv|cc|top|xyz))(?:\/[^\s<>"'\]]*)?/gi,
  /\/\S*\.(?:jpg|jpeg|png|gif|webp|svg|bmp)(?:["'\s>]|$)/gi,
  /<[^>]+>/gis,
];
const INLINE_SPACE_RE = /[ \t\u3000]+/g;
const OPENING_PUNCT = new Set('（([{《【“‘"\''.split(''));
const CONTINUATION_PREFIX = new Set('，,、。！？!?；;：:…」』”’）)]}》】'.split(''));
const SOFT_ENDING = new Set('，,、；;：:'.split(''));
const HARD_ENDING = new Set('。！？!?…」』”’）)]}》】'.split(''));
const ASCII_WORD_RE = /[A-Za-z0-9]$/;

export class NovelTextPreprocessor {
  cleanBeforeChapterSplit(text: string): TextPreprocessResult {
    const source = text || '';
    const crlfCount = countOccurrences(source, '\r\n');
    let normalized = source.replace(/\r\n/g, '\n');
    const crCount = countOccurrences(normalized, '\r');
    normalized = normalized.replace(/\r/g, '\n');
    const unicodeLineSeparatorCount = countOccurrences(normalized, '\u2028') + countOccurrences(normalized, '\u2029');
    normalized = normalized.replace(/[\u2028\u2029]/g, '\n');
    const leadingBomCount = (normalized.match(/^\ufeff+/)?.[0].length ?? 0);
    if (leadingBomCount) normalized = normalized.replace(/^\ufeff+/, '');
    const nulCount = countOccurrences(normalized, '\x00');
    if (nulCount) normalized = normalized.replace(/\x00/g, '');
    return {
      text: normalized,
      stats: {
        stage: 'before_chapter_split',
        input_chars: source.length,
        output_chars: normalized.length,
        crlf_to_lf: crlfCount,
        cr_to_lf: crCount,
        unicode_line_separators_to_lf: unicodeLineSeparatorCount,
        leading_bom_removed: leadingBomCount,
        nul_chars_removed: nulCount,
        line_join_operations: 0,
        blank_line_collapse_operations: 0,
        noise_spans_removed: 0,
      },
    };
  }

  cleanChapterText(text: string): TextPreprocessResult {
    const normalized = this.cleanBeforeChapterSplit(text).text;
    const stripped = stripNoiseRegions(normalized);
    const paragraphs: string[] = [];
    let current = '';
    let blankOrNoiseLines = 0;
    let softLineJoins = 0;
    const lines = stripped.text.split('\n');
    for (const rawLine of lines) {
      const line = cleanChapterLine(rawLine);
      if (!line) {
        blankOrNoiseLines += 1;
        if (current) {
          paragraphs.push(current);
          current = '';
        }
        continue;
      }
      if (!current) {
        current = line;
        continue;
      }
      if (shouldJoinLines(current, line)) {
        current = joinLines(current, line);
        softLineJoins += 1;
        continue;
      }
      paragraphs.push(current);
      current = line;
    }
    if (current) paragraphs.push(current);
    const cleaned = paragraphs.join('\n\n');
    return {
      text: cleaned,
      stats: {
        stage: 'after_chapter_split',
        input_chars: (text || '').length,
        output_chars: cleaned.length,
        lines_in: lines.length,
        paragraphs_out: paragraphs.length,
        blank_or_noise_lines: blankOrNoiseLines,
        soft_line_joins: softLineJoins,
        noise_spans_removed: stripped.noiseSpansRemoved,
        noise_chars_removed: stripped.noiseCharsRemoved,
      },
    };
  }
}

function countOccurrences(text: string, query: string): number {
  if (!query) return 0;
  let count = 0;
  let index = text.indexOf(query);
  while (index >= 0) {
    count += 1;
    index = text.indexOf(query, index + query.length);
  }
  return count;
}

function cleanChapterLine(line: string): string {
  return (line || '').replace(/\ufeff/g, '').trim().replace(INLINE_SPACE_RE, ' ').trim();
}

function shouldJoinLines(previous: string, current: string): boolean {
  if (!previous || !current) return false;
  if (OPENING_PUNCT.has(previous.at(-1) || '')) return true;
  if (CONTINUATION_PREFIX.has(current[0])) return true;
  if (SOFT_ENDING.has(previous.at(-1) || '')) return true;
  return !HARD_ENDING.has(previous.at(-1) || '');
}

function joinLines(previous: string, current: string): string {
  if (ASCII_WORD_RE.test(previous) && /^[A-Za-z0-9]/.test(current)) return `${previous} ${current}`;
  return `${previous}${current}`;
}

function stripNoiseRegions(text: string): { text: string; noiseSpansRemoved: number; noiseCharsRemoved: number } {
  const spans = findNoiseSpans(text);
  if (!spans.length) return { text, noiseSpansRemoved: 0, noiseCharsRemoved: 0 };
  const parts: string[] = [];
  let previousEnd = 0;
  let removed = 0;
  for (const [start, end] of spans) {
    parts.push(text.slice(previousEnd, start));
    removed += end - start;
    previousEnd = end;
  }
  parts.push(text.slice(previousEnd));
  return { text: parts.join(''), noiseSpansRemoved: spans.length, noiseCharsRemoved: removed };
}

function findNoiseSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const pattern of NOISE_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text || '')) !== null) {
      spans.push([match.index, match.index + match[0].length]);
    }
  }
  return mergeSpans(spans);
}

function mergeSpans(spans: Array<[number, number]>): Array<[number, number]> {
  if (!spans.length) return [];
  const ordered = [...spans].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Array<[number, number]> = [ordered[0]];
  for (const [start, end] of ordered.slice(1)) {
    const last = merged[merged.length - 1];
    if (start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

const OPEN_QUOTES: Record<string, string> = { '“': '”', '‘': '’' };
const CLOSE_QUOTES = new Set(['”', '’']);
const SOFT_SPLIT_CHARS = new Set('。！？；.!?;'.split(''));

export class Chunker {
  constructor(private readonly maxChars = 1800, private readonly overlapChars = 0) {}

  split({ chapterId, text }: { chapterId: number; text: string }): TextChunk[] {
    if (!text) return [];
    const chunks: TextChunk[] = [];
    let start = 0;
    let index = 1;
    while (start < text.length) {
      const desiredEnd = Math.min(start + this.maxChars, text.length);
      const end = quoteSafeEnd(text, start, desiredEnd);
      chunks.push({
        chunk_id: `c${String(chapterId).padStart(3, '0')}_${String(index).padStart(3, '0')}`,
        chapter_id: chapterId,
        start,
        end,
        text: text.slice(start, end),
        context_before: text.slice(Math.max(0, start - this.overlapChars), start),
        context_after: text.slice(end, Math.min(text.length, end + this.overlapChars)),
      });
      if (end === text.length) break;
      start = end;
      index += 1;
    }
    return chunks;
  }
}

function quoteSafeEnd(text: string, start: number, desiredEnd: number): number {
  if (desiredEnd >= text.length) return text.length;
  if (desiredEnd <= start) return desiredEnd;
  const splitBeforeQuote = bestSafeSplitBefore(text, start, desiredEnd);
  if (splitBeforeQuote > start) return splitBeforeQuote;
  const quoteClose = closingQuoteAfter(text, start, desiredEnd);
  if (quoteClose !== null) return quoteClose + 1;
  return desiredEnd;
}

function bestSafeSplitBefore(text: string, start: number, desiredEnd: number): number {
  const minEnd = start + Math.max(1, Math.floor((desiredEnd - start) / 2));
  for (const separator of ['\n\n', '\n']) {
    const index = text.lastIndexOf(separator, desiredEnd - 1);
    if (index >= start + 1 && index >= minEnd && !insideQuote(text, start, index)) return index + separator.length;
  }
  for (let index = desiredEnd - 1; index > start; index -= 1) {
    if (index >= minEnd && SOFT_SPLIT_CHARS.has(text[index]) && !insideQuote(text, start, index + 1)) return index + 1;
  }
  return start;
}

function closingQuoteAfter(text: string, start: number, desiredEnd: number): number | null {
  const stack: string[] = [];
  for (let index = start; index < desiredEnd; index += 1) {
    const char = text[index];
    if (OPEN_QUOTES[char]) stack.push(OPEN_QUOTES[char]);
    else if (CLOSE_QUOTES.has(char) && stack.length && char === stack[stack.length - 1]) stack.pop();
  }
  if (!stack.length) return null;
  const closeIndex = text.indexOf(stack[stack.length - 1], desiredEnd);
  return closeIndex === -1 ? null : closeIndex;
}

function insideQuote(text: string, start: number, end: number): boolean {
  const stack: string[] = [];
  for (const char of text.slice(start, end)) {
    if (OPEN_QUOTES[char]) stack.push(OPEN_QUOTES[char]);
    else if (CLOSE_QUOTES.has(char) && stack.length && char === stack[stack.length - 1]) stack.pop();
  }
  return stack.length > 0;
}

const PAIRED_QUOTES: Record<string, string> = { '“': '”', '「': '」', '『': '』' };
const SYMMETRIC_QUOTES = new Set(['"']);

export function findQuoteSpanCandidates(text: string, contextChars = 80): QuoteSpanCandidate[] {
  const candidates: QuoteSpanCandidate[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (PAIRED_QUOTES[char]) {
      const close = PAIRED_QUOTES[char];
      const closeIndex = text.indexOf(close, index + 1);
      if (closeIndex === -1) {
        index += 1;
        continue;
      }
      appendQuoteCandidate(candidates, text, index, index + 1, closeIndex, char, close, contextChars);
      index = closeIndex + 1;
      continue;
    }
    if (SYMMETRIC_QUOTES.has(char)) {
      const closeIndex = text.indexOf(char, index + 1);
      if (closeIndex === -1) {
        index += 1;
        continue;
      }
      appendQuoteCandidate(candidates, text, index, index + 1, closeIndex, char, char, contextChars);
      index = closeIndex + 1;
      continue;
    }
    index += 1;
  }
  return candidates;
}

function appendQuoteCandidate(
  candidates: QuoteSpanCandidate[],
  text: string,
  quoteStart: number,
  start: number,
  end: number,
  quoteOpen: string,
  quoteClose: string,
  contextChars: number,
): void {
  const raw = text.slice(start, end);
  const candidateText = raw.trim();
  if (!candidateText) return;
  const leadingTrim = raw.length - raw.trimStart().length;
  const trailingTrim = raw.length - raw.trimEnd().length;
  const normalizedStart = start + leadingTrim;
  const normalizedEnd = end - trailingTrim;
  candidates.push({
    candidate_id: `q${String(candidates.length + 1).padStart(4, '0')}`,
    start: normalizedStart,
    end: normalizedEnd,
    text: text.slice(normalizedStart, normalizedEnd),
    quote_open: quoteOpen,
    quote_close: quoteClose,
    context_before: text.slice(Math.max(0, quoteStart - contextChars), quoteStart),
    context_after: text.slice(end + 1, Math.min(text.length, end + 1 + contextChars)),
  });
}
