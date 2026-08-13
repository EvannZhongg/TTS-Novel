import { db, unwrap } from './client';
import type { DemoUser } from './types';

/**
 * 邮箱即凭据(未经验证)。这里只做规范化 + upsert，不做任何验证——
 * 前端会明确提示"demo 项目非私密"。见 docs/security-model.md。
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function isValidEmailShape(email: string): boolean {
  const value = normalizeEmail(email);
  return value.length <= 254 && EMAIL_RE.test(value);
}

/** 存在则更新 last_seen_at 并返回，不存在则创建。 */
export async function upsertUserByEmail(email: string): Promise<DemoUser> {
  const normalized = normalizeEmail(email);
  const client = db();

  // lower(email) 上有唯一索引，但 upsert 的 onConflict 不支持函数索引，
  // 所以先查后插；并发下插入失败(23505)时回查一次。
  const existing = await client.from('demo_users').select('*').eq('email', normalized).maybeSingle();
  if (existing.error) throw new Error(`[db:upsertUserByEmail] ${existing.error.message}`);
  if (existing.data) {
    const updated = await client
      .from('demo_users')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', existing.data.id)
      .select('*')
      .single();
    return unwrap(updated, 'upsertUserByEmail.touch') as DemoUser;
  }

  const inserted = await client.from('demo_users').insert({ email: normalized }).select('*').single();
  if (inserted.error) {
    if (inserted.error.code === '23505') {
      const raced = await client.from('demo_users').select('*').eq('email', normalized).single();
      return unwrap(raced, 'upsertUserByEmail.raced') as DemoUser;
    }
    throw new Error(`[db:upsertUserByEmail] ${inserted.error.message}`);
  }
  return inserted.data as DemoUser;
}

export async function findUserByEmail(email: string): Promise<DemoUser | null> {
  const result = await db().from('demo_users').select('*').eq('email', normalizeEmail(email)).maybeSingle();
  if (result.error) throw new Error(`[db:findUserByEmail] ${result.error.message}`);
  return (result.data as DemoUser | null) ?? null;
}
