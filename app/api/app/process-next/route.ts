import { settings } from '@/src/server/tts/config';
import { handleRoute } from '@/src/server/api/helpers';
import { processNextSchema } from '@/src/server/api/schemas';
import { processNextJob, type ProcessResult } from '@/src/server/queue/worker';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * 队列驱动入口: 领一个任务并处理完。
 *
 * 为什么是"客户端驱动"而非后台常驻进程: Vercel 上没有常驻 worker,
 * 而单章约 35s、整本 400 章需要 200+ 分钟, 不可能在一次函数调用里跑完。
 * 前端在项目页轮询时并发调用本接口若干次(不超过 maxParallelChapters),
 * 每次推进一个任务, 状态全在 Postgres 里, 因此刷新/换设备都能续跑。
 *
 * 并发安全由 claim_next_job 的 `for update skip locked` 保证:
 * 多个并发请求各自领到不同任务, 不会重复处理同一章。
 *
 * 无需鉴权 —— 它不接受任何目标参数, 只能推进已存在的队列, 拿不到也改不了
 * 任何用户数据。
 */
export async function POST(request: Request) {
  return handleRoute(async () => {
    let maxTasks = settings.queue.maxTasksPerRequest;
    try {
      const body = processNextSchema.parse(await request.json());
      if (body.max_tasks) maxTasks = body.max_tasks;
    } catch {
      // 无 body 或 body 非法时用默认值
    }

    const processed: ProcessResult[] = [];
    for (let i = 0; i < maxTasks; i += 1) {
      const result = await processNextJob();
      if (!result.claimed) break;
      processed.push(result);
    }

    return {
      claimed: processed.length > 0,
      processed_count: processed.length,
      processed,
    };
  });
}
