import {
  handleRoute,
  requireOwnedProject,
  requireOwnedProjectMeta,
  searchEmail,
} from '@/src/server/api/helpers';
import { listChapterSummaries } from '@/src/server/db/chapters';
import { countPendingJobs } from '@/src/server/db/jobs';
import { deleteProject } from '@/src/server/db/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 项目进度 + 章节列表。前端轮询这个接口。
 * 刻意不返回 book_result 和各章 result(可能几十 MB), 只给概要。
 */
export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  return handleRoute(async () => {
    const { projectId } = await params;
    const { project } = await requireOwnedProjectMeta(projectId, searchEmail(request));
    const [chapters, pendingJobs] = await Promise.all([
      listChapterSummaries(projectId),
      countPendingJobs(projectId),
    ]);
    const terminal = project.status === 'completed'
      || project.status === 'failed'
      || project.status === 'partially_failed'
      || project.status === 'aggregation_failed';
    return {
      project: {
        id: project.id,
        title: project.title,
        source_mode: project.source_mode,
        status: project.status,
        chapters_total: project.chapters_total,
        chapters_done: project.chapters_done,
        chapters_failed: project.chapters_failed,
        next_chapter_index: project.next_chapter_index,
        content_revision: project.content_revision,
        aggregated_revision: project.aggregated_revision,
        aggregate_status: project.aggregate_status,
        error: project.error,
        created_at: project.created_at,
        updated_at: project.updated_at,
        // 新版聚合会推进 aggregated_revision；状态判断兼容迁移前已有的完成项目。
        has_book_result: project.aggregated_revision > 0
          || project.status === 'completed'
          || project.status === 'partially_failed',
      },
      chapters,
      pending_jobs: pendingJobs,
      // 前端据此决定是否继续驱动队列
      should_keep_driving: !terminal && pendingJobs > 0,
    };
  });
}

/** 删除项目及所有数据库关联内容。项目归属校验通过后由外键级联清理。 */
export async function DELETE(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  return handleRoute(async () => {
    const { projectId } = await params;
    const { project } = await requireOwnedProject(projectId, searchEmail(request));
    await deleteProject(project.id);
    return { deleted: true, project_id: project.id };
  });
}
