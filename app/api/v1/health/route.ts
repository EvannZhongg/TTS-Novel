import { NextResponse } from 'next/server';
import { settings } from '@/src/server/tts/config';
import { dbHealth, isDbConfigured } from '@/src/server/db/client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const database = isDbConfigured() ? await dbHealth() : { ok: false, error: 'supabase 未配置' };
  return NextResponse.json({
    ok: true,
    service: settings.app.name,
    env: settings.app.env,
    llm_provider: settings.llm.provider,
    llm_model: settings.llm.model,
    db: database.ok ? 'ok' : 'error',
    db_error: database.ok ? undefined : database.error,
  });
}
