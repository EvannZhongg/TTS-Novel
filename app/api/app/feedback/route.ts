import { badRequest, handleRoute } from '@/src/server/api/helpers';
import { feedbackSchema } from '@/src/server/api/schemas';
import { createFeedback } from '@/src/server/db/feedback';
import { findUserByEmail } from '@/src/server/db/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 用户反馈。这是 demo 存在的主要目的之一(收集拆分质量的真实反馈),
 * 邮箱可选；主要问题和补充说明只要填写一项即可提交。
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    const body = feedbackSchema.parse(await request.json());
    if (!body.comment && !body.category) {
      throw badRequest('请选择主要问题或填写补充说明');
    }
    const user = body.email ? await findUserByEmail(body.email) : null;
    const created = await createFeedback({
      userId: user?.id ?? null,
      projectId: body.project_id ?? null,
      chapterId: body.chapter_id ?? null,
      category: body.category ?? null,
      comment: body.comment ?? null,
    });
    return { feedback_id: created.id, message: '感谢反馈' };
  });
}
