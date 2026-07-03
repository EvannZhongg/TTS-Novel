import { NextResponse } from 'next/server';
import { getPipelineJobFrontendResult, savePipelineJobFrontendResult } from '@/src/server/tts/service';
import { errorDetail, frontendResultSchema, jsonError } from '@/src/server/tts/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

type Params = { params: Promise<{ jobId: string }> };

export async function POST(request: Request, { params }: Params) {
  try {
    const { jobId } = await params;
    const body = frontendResultSchema.parse(await request.json());
    const result = await savePipelineJobFrontendResult(jobId, body);
    if (!result) return jsonError(404, 'pipeline job not found');
    return NextResponse.json(result);
  } catch (error) {
    return jsonError(500, errorDetail(error));
  }
}

export async function GET(_request: Request, { params }: Params) {
  try {
    const { jobId } = await params;
    const payload = await getPipelineJobFrontendResult(jobId);
    if (!payload) return jsonError(404, 'frontend result not found');
    return NextResponse.json(payload);
  } catch (error) {
    return jsonError(500, errorDetail(error));
  }
}
