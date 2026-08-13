'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, isTerminal, type ProjectDetail } from './api';

/**
 * 项目进度轮询 + 队列驱动。
 *
 * 为什么要前端驱动: Vercel 上没有常驻 worker, 而单章约 35s、整本几十章需要
 * 几十分钟, 不可能在一次函数调用里跑完。所以项目页在轮询的同时, 持续保持
 * 若干个 /api/app/process-next 在飞, 每个推进一个任务。
 *
 * 状态全在 Postgres 里, 所以刷新页面、换设备、关掉再打开都能接着跑 ——
 * 这也是为什么这里不需要任何本地进度状态。
 *
 * 并发安全由 claim_next_job 的 for update skip locked 保证, 前端多发几个请求
 * 不会导致同一章被处理两次。
 */

const POLL_INTERVAL_MS = 2000;
const MAX_IN_FLIGHT = 3;   // 与后端 PIPELINE_MAX_PARALLEL_CHAPTERS 默认值一致

export interface DriveState {
  detail: ProjectDetail | null;
  error: string | null;
  loading: boolean;
  driving: boolean;
  refresh: () => void;
}

export function useProjectDriver(projectId: string, email: string): DriveState {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [driving, setDriving] = useState(false);

  // 用 ref 记录在飞请求数与卸载标记, 避免闭包捕获过期值
  const inFlight = useRef(0);
  const alive = useRef(true);
  const [refreshToken, setRefreshToken] = useState(0);

  const refresh = useCallback(() => setRefreshToken((n) => n + 1), []);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  useEffect(() => {
    if (!projectId || !email) {
      setLoading(false);
      return;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;

    const pump = async () => {
      // 补足在飞请求。每个请求领一个任务, 处理完才返回(可能几十秒)。
      while (inFlight.current < MAX_IN_FLIGHT) {
        inFlight.current += 1;
        setDriving(true);
        void api
          .processNext()
          .catch(() => null)          // 单个任务失败已由后端记录, 前端不打断轮询
          .finally(() => {
            inFlight.current -= 1;
            if (inFlight.current === 0 && alive.current) setDriving(false);
          });
      }
    };

    const tick = async () => {
      if (stopped) return;
      try {
        const next = await api.getProject(projectId, email);
        if (stopped || !alive.current) return;
        setDetail(next);
        setError(null);
        setLoading(false);

        // 还有活干就继续驱动队列
        if (!isTerminal(next.project.status) && next.pending_jobs > 0) {
          await pump();
        }
        if (!isTerminal(next.project.status)) {
          timer = setTimeout(tick, POLL_INTERVAL_MS);
        } else {
          setDriving(false);
        }
      } catch (err) {
        if (stopped || !alive.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
        // 出错也继续轮询, 可能只是一次网络抖动
        timer = setTimeout(tick, POLL_INTERVAL_MS * 2);
      }
    };

    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [projectId, email, refreshToken]);

  return { detail, error, loading, driving, refresh };
}
