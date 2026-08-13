import { createHash } from 'node:crypto';

export interface RawChapterInput {
  title?: string;
  text: string;
  client_file_name?: string;
  source_encoding?: string;
}

export interface PreparedChapterInput {
  title?: string;
  text: string;
  source_hash: string;
  client_file_name?: string;
  source_encoding?: string;
}

/**
 * 入库前只做不会改变语义的基础规范化。
 *
 * 章节正文的进一步清洗仍由 pipeline 负责；这里的目标是让不同平台换行/BOM
 * 不影响去重 hash，同时避免 NUL 进入 Postgres text。
 */
export function normalizeUploadedText(text: string): string {
  return (text || '')
    .replace(/^\ufeff+/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\u2028\u2029]/g, '\n')
    .replace(/\x00/g, '');
}

export function sourceHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function prepareChapterInputs(chapters: RawChapterInput[]): PreparedChapterInput[] {
  const prepared = chapters.map((chapter) => {
    const text = normalizeUploadedText(chapter.text);
    if (!text.trim()) throw new Error('章节正文不能为空');
    return {
      title: chapter.title?.trim() || undefined,
      text,
      source_hash: sourceHash(text),
      client_file_name: chapter.client_file_name?.trim() || undefined,
      source_encoding: chapter.source_encoding?.trim() || undefined,
    };
  });
  const seen = new Set<string>();
  for (const chapter of prepared) {
    if (seen.has(chapter.source_hash)) {
      throw new Error(`上传批次中包含重复正文：${chapter.title || '未命名章节'}`);
    }
    seen.add(chapter.source_hash);
  }
  return prepared;
}
