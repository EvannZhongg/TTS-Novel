import { NextResponse } from 'next/server';
import { createLLMClient } from '@/src/server/tts/llm';
import { getSettings } from '@/src/server/tts/service';
import { errorDetail, jsonError, llmTestSchema } from '@/src/server/tts/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const body = llmTestSchema.parse(await request.json());
    const client = createLLMClient(getSettings().llm);
    const result = await client.generateJson({ systemPrompt: 'You are a strict JSON generator. Return JSON only.', userPrompt: body.text, responseFormatJson: true });
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return jsonError(502, errorDetail(error));
  }
}
