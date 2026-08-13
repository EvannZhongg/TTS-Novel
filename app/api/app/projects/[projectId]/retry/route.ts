import { handleRoute, requireOwnedProject } from '@/src/server/api/helpers';
import { db } from '@/src/server/db/client';
import { requeueAggregate } from '@/src/server/db/jobs';
import { sessionSchema } from '@/src/server/api/schemas';
import { settings } from '@/src/server/tts/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 重试失败章节。
 *
 * 复位状态与回退 chapters_failed 必须原子完成, 所以走
 * requeue_failed_chapters() 函数(它会锁住 project 行)。
 * 直接 UPDATE 会导致 chapters_failed 不回退, 项目永远显示"N 章失败";
 * 且旧版 finish_chapter_job 会因为"已存在聚合任务"而不再触发新聚合,
 * 项目卡死在 partially_failed —— 这两个缺陷已在 0004 修正。
 */
export async function POST(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  return handleRoute(async () => {
    const { projectId } = await params;
    const body = sessionSchema.parse(await request.json());
    const { project } = await requireOwnedProject(projectId, body.email);

    const rpc = await db().rpc('requeue_failed_chapters', {
      p_project_id: projectId,
      p_max_attempts: settings.queue.maxAttempts,
    });
    if (rpc.error) throw new Error(rpc.error.message);
    const outcome = rpc.data as { requeued: number; chapter_ids: string[] };

    if (outcome.requeued > 0) {
      return {
        requeued: outcome.requeued,
        kind: 'chapters',
        message: `已重新投递 ${outcome.requeued} 个失败章节`,
      };
    }
    if (project.aggregate_status === 'failed' || project.status === 'aggregation_failed') {
      const aggregate = await requeueAggregate(projectId);
      return {
        requeued: aggregate.requeued ? 1 : 0,
        kind: 'aggregate',
        message: aggregate.requeued ? '已重新投递全书分析任务' : aggregate.message,
      };
    }
    return {
      requeued: 0,
      kind: 'none',
      message: '没有失败任务需要重试',
    };
  });
}
