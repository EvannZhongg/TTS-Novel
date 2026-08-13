import { randomUUID } from 'node:crypto';
import { badRequest, handleRoute, requireUser, searchEmail } from '@/src/server/api/helpers';
import { createProjectSchema } from '@/src/server/api/schemas';
import { upsertUserByEmail } from '@/src/server/db/users';
import {
  createPerChapterProject,
  createProject,
  listProjectsByUser,
  saveProjectSource,
} from '@/src/server/db/projects';
import { enqueueJob } from '@/src/server/db/jobs';
import { settings } from '@/src/server/tts/config';
import { prepareChapterInputs } from '@/src/server/text/ingest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 项目列表 */
export async function GET(request: Request) {
  return handleRoute(async () => {
    const user = await requireUser(searchEmail(request));
    const projects = await listProjectsByUser(user.id);
    return { projects };
  });
}

/**
 * 新建项目。两种模式:
 *
 * whole_book  —— 传整本原文。拆章作为后台任务(含 LLM 标题校验), 因为整本
 *                拆章 + 逐章分析在 Vercel 上跑不完一次函数调用。
 * per_chapter —— 直接给定章节数组, 跳过拆章, 立即投递章节任务。
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const body = createProjectSchema.parse(await request.json());
    // 新建项目时允许顺便登记邮箱, 省掉一次 /session 往返
    const user = await upsertUserByEmail(body.email);

    if (body.source_mode === 'whole_book') {
      const project = await createProject({
        userId: user.id,
        title: body.title,
        sourceMode: 'whole_book',
        status: 'chapterizing',
      });
      await saveProjectSource(project.id, body.text!);
      await enqueueJob({ projectId: project.id, kind: 'chapterize' });
      return {
        project_id: project.id,
        status: project.status,
        source_mode: project.source_mode,
        message: '已创建项目, 正在后台拆章',
      };
    }

    const chapters = body.chapters!;
    try {
      // 逐章项目以 chapters.source_text 为唯一事实来源，不再维护一份会随追加而
      // 过期的 project_sources 拼接全文。
      const created = await createPerChapterProject({
        userId: user.id,
        title: body.title,
        requestId: body.request_id ?? randomUUID(),
        chapters: prepareChapterInputs(chapters),
        maxAttempts: settings.queue.maxAttempts,
      });
      return {
        project_id: created.project_id,
        status: created.status,
        source_mode: created.source_mode,
        chapters_total: created.chapters_total,
        content_revision: created.content_revision,
        batch_id: created.batch_id,
        idempotent: created.idempotent,
        message: created.idempotent
          ? '该创建请求已提交过，已恢复项目'
          : `已创建项目, ${created.added} 章待处理`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/重复正文|duplicate chapter|chapter already exists|duplicate key/i.test(message)) {
        throw badRequest(message.replace(/^\[db:createPerChapterProject\]\s*/, ''));
      }
      throw error;
    }
  });
}
