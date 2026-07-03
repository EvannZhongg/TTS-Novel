import { NextResponse } from 'next/server';
import { getPipelineJobLogs } from '@/src/server/tts/service';
import { errorDetail, jsonError, parseIntParam } from '@/src/server/tts/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type Params = { params: Promise<{ jobId: string }> };

export async function GET(request: Request, { params }: Params) {
  try {
    const { jobId } = await params;
    const url = new URL(request.url);
    const tail = parseIntParam(url, 'tail', 500, 0, 10000);
    const logs = await getPipelineJobLogs(jobId, tail);
    if (!logs) return jsonError(404, 'pipeline job not found');
    return NextResponse.json({ job_id: jobId, logs });
  } catch (error) {
    return jsonError(500, errorDetail(error));
  }
}
