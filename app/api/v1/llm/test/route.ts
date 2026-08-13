import { NextResponse } from 'next/server';
import { createLLMClient } from '@/src/server/tts/llm';
import { settings } from '@/src/server/tts/config';
import { errorDetail, jsonError, llmTestSchema } from '@/src/server/tts/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/**
 * LLM 连通性自检。
 *
 * 需要 ADMIN_TOKEN —— 这个接口会用服务端的 API key 真实调用模型(花钱),
 * 不能对公众开放。未配置 ADMIN_TOKEN 时直接拒绝, 避免"忘记配置就等于不设防"。
 */
export async function POST(request: Request) {
  const expected = process.env.ADMIN_TOKEN || '';
  const provided = request.headers.get('x-admin-token') || '';
  if (!expected || provided !== expected) {
    return jsonError(401, '需要有效的 x-admin-token');
  }
  try {
    const body = llmTestSchema.parse(await request.json());
    const client = createLLMClient(settings.llm);
    const result = await client.generateJson({
      systemPrompt: 'You are a strict JSON generator. Return JSON only.',
      userPrompt: body.text,
      responseFormatJson: true,
      purpose: 'connectivity_test',
    });
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return jsonError(502, errorDetail(error));
  }
}
