'use client';

/**
 * 文本文件读取 + 编码识别。
 *
 * 中文小说 TXT 常见 GB18030 / UTF-16, 直接按 UTF-8 读会变乱码。
 * 这里保留了原 app.js 里那套评分式识别的核心思路(BOM 优先, 否则按
 * CJK 占比与乱码特征打分), 但精简掉了调试用的中间输出。
 */

const CANDIDATE_ENCODINGS = ['utf-8', 'gb18030', 'big5'];

function decodeWith(buffer: ArrayBuffer, encoding: string): string | null {
  try {
    return new TextDecoder(encoding, { fatal: false }).decode(buffer);
  } catch {
    return null;
  }
}

/** 评分: CJK 越多越好, 替换符与控制字符越多越差。 */
function scoreText(text: string): number {
  if (!text) return -Infinity;
  const sample = text.slice(0, 4000);
  let cjk = 0;
  let replacement = 0;
  let control = 0;
  for (const char of sample) {
    const code = char.codePointAt(0)!;
    if (code === 0xfffd) replacement += 1;
    else if (code < 9 || (code > 13 && code < 32)) control += 1;
    else if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3000 && code <= 0x303f)) cjk += 1;
  }
  const len = Math.max(sample.length, 1);
  return (cjk / len) * 100 - (replacement / len) * 400 - (control / len) * 200;
}

export async function readTextFile(file: File): Promise<{ text: string; encoding: string }> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // BOM 优先, 最可靠
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: decodeWith(buffer, 'utf-8')!.replace(/^﻿/, ''), encoding: 'utf-8 (BOM)' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: decodeWith(buffer, 'utf-16le') ?? '', encoding: 'utf-16le (BOM)' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: decodeWith(buffer, 'utf-16be') ?? '', encoding: 'utf-16be (BOM)' };
  }

  let best = { text: '', encoding: 'utf-8', score: -Infinity };
  for (const encoding of CANDIDATE_ENCODINGS) {
    const decoded = decodeWith(buffer, encoding);
    if (decoded === null) continue;
    const score = scoreText(decoded);
    if (score > best.score) best = { text: decoded, encoding, score };
  }
  return { text: best.text, encoding: best.encoding };
}
