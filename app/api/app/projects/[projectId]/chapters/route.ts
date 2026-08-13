import { badRequest, handleRoute, requireOwnedProject, searchEmail } from '@/src/server/api/helpers';
import { appendChaptersSchema } from '@/src/server/api/schemas';
import { appendChapterBatch, listChapterSummaries } from '@/src/server/db/chapters';
import { settings } from '@/src/server/tts/config';
import { prepareChapterInputs } from '@/src/server/text/ingest';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 章节列表(轻量, 不含正文与结果) */
export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  return handleRoute(async () => {
    const { projectId } = await params;
    await requireOwnedProject(projectId, searchEmail(request));
    return { chapters: await listChapterSummaries(projectId) };
  });
}

/**
 * 向 per_chapter 项目追加章节。
 *
 * 追加由 append_chapter_batch() 在单个数据库事务内完成，request_id 可安全重放。
 * 新批次会推进 content_revision；旧聚合即使稍后完成也不能发布为最新结果。
 */
export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  return handleRoute(async () => {
    const { projectId } = await params;
    const body = appendChaptersSchema.parse(await request.json());
    const { project } = await requireOwnedProject(projectId, body.email);
    if (project.source_mode !== 'per_chapter') {
      throw badRequest('只有逐章模式的项目可以追加章节');
    }

    try {
      return await appendChapterBatch({
        projectId,
        requestId: body.request_id,
        chapters: prepareChapterInputs(body.chapters),
        maxAttempts: settings.queue.maxAttempts,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/duplicate chapter|chapter already exists|duplicate key/i.test(message)) {
        throw badRequest(message.replace(/^\[db:appendChapterBatch\]\s*/, ''));
      }
      throw error;
    }
  });
}
