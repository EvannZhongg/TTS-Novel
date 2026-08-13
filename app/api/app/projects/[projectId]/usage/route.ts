import { handleRoute, requireOwnedProject, searchEmail } from '@/src/server/api/helpers';
import { llmUsageForProject, recentLlmFailures } from '@/src/server/db/llmCalls';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 项目的 LLM 用量与失败记录。
 *
 * 用量用于算成本(token 数); 失败记录用于判断是上游抖动还是 prompt 问题 ——
 * 上游连接失败不属于业务逻辑范畴, 但需要看得见才能决定是否重试。
 */
export async function GET(request: Request, { params }: { params: Promise<{ projectId: string }> }) {
  return handleRoute(async () => {
    const { projectId } = await params;
    await requireOwnedProject(projectId, searchEmail(request));
    const [usage, failures] = await Promise.all([
      llmUsageForProject(projectId),
      recentLlmFailures(projectId),
    ]);
    return {
      usage: usage ?? {
        project_id: projectId,
        calls: 0, failed_calls: 0,
        prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
      },
      recent_failures: failures,
    };
  });
}
