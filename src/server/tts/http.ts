import { NextResponse } from 'next/server';
import { z } from 'zod';

export const pipelineRunSchema = z.object({
  book_title: z.string().optional().default('untitled'),
  text: z.string().min(1),
  chapter_ids: z.array(z.number().int()).nullable().optional(),
});

export const llmTestSchema = z.object({ text: z.string() });

export const chapterPreviewSchema = z.object({
  book_title: z.string().optional().default('untitled'),
  text: z.string().min(1),
  use_llm_validation: z.boolean().optional().default(true),
});

export const frontendResultSchema = z.object({
  result: z.record(z.string(), z.any()),
  source: z.string().optional().default('frontend'),
});

export function parseBoolParam(url: URL, name: string, fallback: boolean): boolean {
  const value = url.searchParams.get(name);
  if (value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export function parseIntParam(url: URL, name: string, fallback: number, min: number, max: number): number {
  const value = url.searchParams.get(name);
  const parsed = value === null ? fallback : Number.parseInt(value, 10);
  const safe = Number.isFinite(parsed) ? parsed : fallback;
  return Math.max(min, Math.min(max, safe));
}

export function jsonError(status: number, detail: unknown): NextResponse {
  return NextResponse.json({ detail }, { status });
}

export function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
