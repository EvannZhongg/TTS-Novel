import { NextResponse } from 'next/server';
import { z } from 'zod';

/**
 * 遗留的 /api/v1 辅助。
 *
 * 旧的 pipeline 路由(run / jobs / chapter-preview)已在 Phase 5 删除,
 * 它们的 schema 也随之移除。这里只剩 /api/v1/llm/test 还在用的部分。
 * 内部 API(/api/app/*)的校验在 src/server/api/schemas.ts。
 */

export const llmTestSchema = z.object({ text: z.string() });

export function jsonError(status: number, detail: unknown): NextResponse {
  return NextResponse.json({ detail }, { status });
}

export function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
