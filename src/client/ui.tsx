'use client';

import Link from 'next/link';
import { STATUS_LABEL } from './api';

/** 状态徽章。颜色语义沿用 globals.css 里既有的 badge 变体。 */
export function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'completed' || status === 'succeeded' ? 'green'
      : status === 'failed' || status === 'aggregation_failed' ? 'red'
        : status === 'partially_failed' ? 'amber'
          : status === 'processing' || status === 'chapterizing' || status === 'running' ? 'purple'
            : '';
  return <span className={`badge ${cls}`}>{STATUS_LABEL[status] ?? status}</span>;
}

export function ProgressBar({ done, failed, total }: { done: number; failed: number; total: number }) {
  const safeTotal = Math.max(total, 1);
  const pct = Math.min(100, Math.round(((done + failed) / safeTotal) * 100));
  const tone = failed > 0 ? (done > 0 ? 'warn' : 'error') : done >= total && total > 0 ? 'done' : '';
  return (
    <div className="progress-track" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className={`progress-fill ${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Alert({ kind, children }: { kind: 'error' | 'warn' | 'ok'; children: React.ReactNode }) {
  return <div className={`alert ${kind}`}>{children}</div>;
}

export function BackLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link href={href} className="crumb">
      ← {children}
    </Link>
  );
}

export function StatTile({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="stat-tile">
      <div className="k">{label}</div>
      <div className="v">{value}</div>
    </div>
  );
}
