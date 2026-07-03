import { NextResponse } from 'next/server';
import { chapterPreviewSchema, errorDetail, jsonError } from '@/src/server/tts/http';
import { getSettings } from '@/src/server/tts/service';
import { PipelineRunner, runChapterPreview } from '@/src/server/tts/runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const body = chapterPreviewSchema.parse(await request.json());
    const settings = getSettings();
    const runner = new PipelineRunner(settings);
    const result = await runChapterPreview(runner, settings, body);
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(500, errorDetail(error));
  }
}
