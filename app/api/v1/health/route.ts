import { NextResponse } from 'next/server';
import { getSettings } from '@/src/server/tts/service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const settings = getSettings();
  return NextResponse.json({ ok: true, service: settings.app.name, env: settings.app.env, llm_provider: settings.llm.provider, llm_model: settings.llm.model });
}
