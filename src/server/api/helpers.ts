import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { findUserByEmail, isValidEmailShape, normalizeEmail } from '../db/users';
import { getProject, getProjectMeta, type ProjectListItem } from '../db/projects';
import type { DemoUser, Project } from '../db/types';

/**
 * 内部 API 的共用辅助。
 *
 * 授权模型: 邮箱即凭据(未经验证)。用户在任何设备填同一邮箱就能取回自己的项目 ——
 * 这是刻意的产品取舍(demo 要零摩擦、可跨设备恢复), 代价是任何人填别人的邮箱
 * 就能读到那个人上传的小说全文。前端必须在邮箱输入处明示"demo 项目非私密"。
 * 详见 docs/security-model.md。
 */

/**
 * 带状态码的 API 错误。
 *
 * 不要靠匹配 error.message 的文字来推断状态码 —— 那样一旦文案改动状态码就会
 * 悄悄变错(实测就发生过: "not found: 项目不存在" 被判成 500 而非 404)。
 */
export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export function badRequest(message: string): ApiError {
  return new ApiError(400, message);
}

/** 用 404 而非 403: 403 会确认"该资源存在", 没必要泄露这个信息。 */
export function notFound(message: string): ApiError {
  return new ApiError(404, message);
}

export function jsonError(status: number, detail: string): NextResponse {
  return NextResponse.json({ error: detail }, { status });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 统一的路由异常包装, 避免每个 route 重复 try/catch。 */
export async function handleRoute<T>(fn: () => Promise<T>): Promise<NextResponse> {
  try {
    const data = await fn();
    return NextResponse.json(data ?? { ok: true });
  } catch (error) {
    if (error instanceof ApiError) return jsonError(error.status, error.message);
    // zod 校验失败也归为 400
    if (error instanceof ZodError) {
      return jsonError(400, error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
    }
    console.error('[api] 未预期错误', error);
    return jsonError(500, errorMessage(error));
  }
}

/** 解析并校验邮箱; 形态不合法直接抛错(由 handleRoute 转成 400)。 */
export function requireEmail(email: unknown): string {
  const value = typeof email === 'string' ? normalizeEmail(email) : '';
  if (!isValidEmailShape(value)) throw badRequest('邮箱格式不正确');
  return value;
}

export async function requireUser(email: unknown): Promise<DemoUser> {
  const normalized = requireEmail(email);
  const user = await findUserByEmail(normalized);
  if (!user) throw notFound('该邮箱尚无记录, 请先登记');
  return user;
}

/**
 * 取项目并校验归属。
 *
 * 用 404 而不是 403 —— 403 会暴露"该项目存在", 而项目 id 是 uuid,
 * 没必要让人靠枚举确认存在性。
 */
export async function requireOwnedProject(projectId: string, email: unknown): Promise<{ project: Project; user: DemoUser }> {
  const user = await requireUser(email);
  const project = await getProject(projectId);
  if (!project || project.user_id !== user.id) throw notFound('项目不存在');
  return { project, user };
}

/** 高频元数据读取版本：归属校验时不把可能很大的 book_result 从数据库拖出来。 */
export async function requireOwnedProjectMeta(
  projectId: string,
  email: unknown,
): Promise<{ project: ProjectListItem; user: DemoUser }> {
  const user = await requireUser(email);
  const project = await getProjectMeta(projectId);
  if (!project || project.user_id !== user.id) throw notFound('项目不存在');
  return { project, user };
}

export function searchEmail(request: Request): string | null {
  const value = new URL(request.url).searchParams.get('email');
  return value ? normalizeEmail(value) : null;
}
