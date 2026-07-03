import { NextResponse } from 'next/server';
import { getPipelineJob } from '@/src/server/tts/service';
import { errorDetail, jsonError, parseBoolParam, parseIntParam } from '@/src/server/tts/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type Params = { params: Promise<{ jobId: string }> };

export async function GET(request: Request, { params }: Params) {
  try {
    const { jobId } = await params;
    const url = new URL(request.url);
    const includeLogs = parseBoolParam(url, 'include_logs', true);
    const includeResult = parseBoolParam(url, 'include_result', true);
    const logTail = parseIntParam(url, 'log_tail', 500, 0, 5000);
    const job = await getPipelineJob(jobId, { includeLogs, includeResult, logTail });
    if (!job) return jsonError(404, 'pipeline job not found');
    return NextResponse.json(job);
  } catch (error) {
    return jsonError(500, errorDetail(error));
  }
}
