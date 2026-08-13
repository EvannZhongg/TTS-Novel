import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { settings } from '../tts/config';

/**
 * 服务端 Supabase 客户端。
 *
 * 一律使用 secret key(service_role)——它绕过 RLS。所有表都开了 RLS 且没有任何
 * policy，因此 publishable key 读写会被直接拒绝。浏览器永远不直连 Supabase，
 * 只走 /api/app/* 路由，这样未验证的邮箱凭据不会变成数据库凭据。
 *
 * 注意: 不要把这个模块 import 进任何客户端组件或 src/server/tts/stages.ts。
 * stages 必须保持纯函数(只依赖 settings + LLM)，将来对外 API 才能直接复用。
 */
let cached: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (cached) return cached;
  const { url, secretKey } = settings.supabase;
  if (!url) throw new Error('SUPABASE_URL 未配置');
  if (!secretKey) throw new Error('SUPABASE_SECRET_KEY 未配置');
  cached = createClient(url, secretKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cached;
}

/** Supabase 的 PostgrestError 信息太散，统一包装后再抛，便于定位。 */
export function unwrap<T>(result: { data: T | null; error: { message: string; code?: string; details?: string } | null }, context: string): T {
  if (result.error) {
    const { message, code, details } = result.error;
    throw new Error(`[db:${context}] ${message}${code ? ` (code=${code})` : ''}${details ? ` details=${details}` : ''}`);
  }
  if (result.data === null) throw new Error(`[db:${context}] 返回空数据`);
  return result.data;
}

export function isDbConfigured(): boolean {
  return Boolean(settings.supabase.url && settings.supabase.secretKey);
}

/** 供 /api/v1/health 探活 */
export async function dbHealth(): Promise<{ ok: boolean; error?: string }> {
  if (!isDbConfigured()) return { ok: false, error: 'supabase 未配置' };
  try {
    const { error } = await db().from('projects').select('id', { count: 'exact', head: true });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
