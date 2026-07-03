import { NextResponse } from 'next/server';
import { errorDetail, jsonError, pipelineRunSchema } from '@/src/server/tts/http';
import { getSettings } from '@/src/server/tts/service';
import { PipelineRunner } from '@/src/server/tts/runner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 800;

export async function POST(request: Request) {
  try {
    const body = pipelineRunSchema.parse(await request.json());
    const runner = new PipelineRunner(getSettings());
    const result = await runner.runMinimal(body);
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(500, errorDetail(error));
  }
}
