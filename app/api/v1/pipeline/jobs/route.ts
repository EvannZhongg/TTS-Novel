import { after, NextResponse } from 'next/server';
import { createPipelineJob, listPipelineJobs, waitForJobIfRunning } from '@/src/server/tts/service';
import { errorDetail, jsonError, parseIntParam, pipelineRunSchema } from '@/src/server/tts/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 800;

export async function POST(request: Request) {
  try {
    const body = pipelineRunSchema.parse(await request.json());
    const result = await createPipelineJob(body);
    after(() => waitForJobIfRunning(result.job_id));
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(500, errorDetail(error));
  }
}

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limit = parseIntParam(url, 'limit', 100, 1, 500);
    const jobs = await listPipelineJobs(limit);
    return NextResponse.json({ jobs });
  } catch (error) {
    return jsonError(500, errorDetail(error));
  }
}
