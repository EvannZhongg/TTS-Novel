import { handleRoute, requireOwnedProject, searchEmail } from '@/src/server/api/helpers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 全书结果。
 *
 * 只返回 book_result（全书级摘要：aliases / role_registry / tts_segment_summary）。
 * 完整章节结果通过章节接口按需读取，避免一次返回几十 MB 的长篇数据。
 */
export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  return handleRoute(async () => {
    const { projectId } = await params;
    const { project } = await requireOwnedProject(projectId, searchEmail(request));
    return {
      book_result: project.book_result,
      status: project.status,
      content_revision: project.content_revision,
      aggregated_revision: project.aggregated_revision,
      aggregate_status: project.aggregate_status,
      up_to_date: project.aggregate_status === 'clean'
        && project.aggregated_revision === project.content_revision,
    };
  });
}
