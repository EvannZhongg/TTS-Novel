'use client';

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { api, formatDuration, getStoredEmail, isTerminal, STATUS_LABEL } from '@/src/client/api';
import {
  ChapterBatchEditor,
  type ChapterDraft,
} from '@/src/client/ChapterBatchEditor';
import { useProjectDriver } from '@/src/client/useProjectDriver';
import { Alert, BackLink, ProgressBar, StatusBadge } from '@/src/client/ui';

type ProjectView = 'chapters' | 'roles';

interface ProjectRole {
  role_id?: string;
  canonical_name?: string;
  gender?: string;
  aliases?: string[];
  voice_profile_id?: string;
  voice_profile?: {
    description?: string;
    age_group?: string;
    gender?: string;
    confidence?: number;
    source?: string;
  };
  evidence_span_count?: number;
}

const GENDER_LABEL: Record<string, string> = {
  male: '男',
  female: '女',
  unknown: '未知',
};
const PLACEHOLDER_VOICE_PROFILE_ID = 'xxxx';

export default function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [retryMsg, setRetryMsg] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [usage, setUsage] = useState<Record<string, number | string> | null>(null);
  const [appendOpen, setAppendOpen] = useState(false);
  const [appendDrafts, setAppendDrafts] = useState<ChapterDraft[]>([]);
  const [appendRequestId, setAppendRequestId] = useState('');
  const [appending, setAppending] = useState(false);
  const [appendError, setAppendError] = useState<string | null>(null);
  const [appendMsg, setAppendMsg] = useState<string | null>(null);
  const [projectView, setProjectView] = useState<ProjectView>('chapters');
  const [roles, setRoles] = useState<ProjectRole[]>([]);
  const [rolesRevision, setRolesRevision] = useState(0);
  const [rolesLoading, setRolesLoading] = useState(false);
  const [rolesError, setRolesError] = useState<string | null>(null);

  useEffect(() => {
    const stored = getStoredEmail();
    if (!stored) router.replace('/');
    else setEmail(stored);
  }, [router]);

  useEffect(() => {
    if (!appendOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !appending) setAppendOpen(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [appendOpen, appending]);

  const { detail, error, loading, driving, refresh } = useProjectDriver(projectId, email);

  // 人物列表按需读取；新一轮全书聚合发布后 aggregated_revision 变化，会自动刷新。
  useEffect(() => {
    const project = detail?.project;
    if (projectView !== 'roles' || !email || !project?.has_book_result) return;
    if (rolesRevision === project.aggregated_revision && roles.length > 0) return;

    let alive = true;
    setRolesLoading(true);
    setRolesError(null);
    void api.getBookResult(projectId, email, project.aggregated_revision)
      .then((response) => {
        if (!alive) return;
        const registry = (response.book_result as { role_registry?: ProjectRole[] } | null)?.role_registry;
        setRoles(Array.isArray(registry) ? registry : []);
        setRolesRevision(response.aggregated_revision);
      })
      .catch((err) => {
        if (alive) setRolesError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (alive) setRolesLoading(false);
      });
    return () => { alive = false; };
  }, [
    detail?.project.aggregated_revision,
    detail?.project.has_book_result,
    email,
    projectId,
    projectView,
    roles.length,
    rolesRevision,
  ]);

  // 完成后取一次 token 用量
  useEffect(() => {
    if (!detail || !email) return;
    if (!isTerminal(detail.project.status)) return;
    void api.getUsage(projectId, email).then((res) => setUsage(res.usage)).catch(() => null);
  }, [detail, email, projectId]);

  const onRetry = async () => {
    setRetrying(true);
    setRetryMsg(null);
    try {
      const res = await api.retryFailed(projectId, email);
      setRetryMsg(res.message);
      refresh();
    } catch (err) {
      setRetryMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setRetrying(false);
    }
  };

  const openAppend = () => {
    setAppendDrafts([{ id: crypto.randomUUID(), title: '', text: '' }]);
    setAppendRequestId(crypto.randomUUID());
    setAppendError(null);
    setAppendOpen(true);
  };

  const onAppend = async () => {
    const valid = appendDrafts.filter((chapter) => chapter.text.trim());
    if (!valid.length) {
      setAppendError('请至少提供一个章节的正文');
      return;
    }
    setAppending(true);
    setAppendError(null);
    try {
      const result = await api.appendChapters(
        projectId,
        email,
        appendRequestId,
        valid.map((chapter) => ({
          title: chapter.title.trim() || undefined,
          text: chapter.text,
          client_file_name: chapter.clientFileName,
          source_encoding: chapter.sourceEncoding,
        })),
      );
      setAppendMsg(
        result.idempotent
          ? `该上传请求已提交过，已恢复第 ${result.start_index}–${result.end_index} 章。`
          : `已追加 ${result.added} 章（第 ${result.start_index}–${result.end_index} 章），正在处理。`,
      );
      setAppendOpen(false);
      setUsage(null);
      refresh();
    } catch (err) {
      setAppendError(err instanceof Error ? err.message : String(err));
    } finally {
      setAppending(false);
    }
  };

  if (!email) return <main className="page" />;
  if (loading) return <main className="page"><div className="empty"><span className="spinner-inline" /> 加载中…</div></main>;
  if (error && !detail) return <main className="page"><BackLink href="/">返回项目列表</BackLink><Alert kind="error">{error}</Alert></main>;
  if (!detail) return <main className="page" />;

  const { project, chapters, pending_jobs } = detail;
  const failedChapters = chapters.filter((chapter) => chapter.status === 'failed');
  const terminal = isTerminal(project.status);

  return (
    <main className="page">
      <BackLink href="/">返回项目列表</BackLink>
      <div className="page-header">
        <div>
          <p className="eyebrow">Project</p>
          <h1>{project.title}</h1>
          <p className="sub">
            {project.source_mode === 'whole_book' ? '整本上传' : '逐章上传'} ·{' '}
            {new Date(project.created_at).toLocaleString('zh-CN')}
          </p>
        </div>
        <div className="page-actions">
          <StatusBadge status={project.status} />
        </div>
      </div>

      {error && <Alert kind="warn">轮询出错(将继续重试):{error}</Alert>}
      {retryMsg && <Alert kind="ok">{retryMsg}</Alert>}
      {appendMsg && <Alert kind="ok">{appendMsg}</Alert>}
      {project.error && <Alert kind="error">{project.error}</Alert>}

      {/* 进度 */}
      <section className="card project-overview">
        <div className="overview-head">
          <div>
            <strong className="overview-title">
              {project.chapters_total > 0
                ? `${project.chapters_done} / ${project.chapters_total} 章已完成`
                : STATUS_LABEL[project.status] ?? project.status}
            </strong>
            {project.chapters_failed > 0 && (
              <span className="failed-copy">{project.chapters_failed} 章失败</span>
            )}
          </div>
          <div className="overview-side">
            {usage && Number(usage.calls) > 0 && (
              <dl className="overview-usage" aria-label="模型调用用量">
                <div>
                  <dt>模型调用</dt>
                  <dd>{Number(usage.calls).toLocaleString()}</dd>
                </div>
                <div>
                  <dt>消耗 Token</dt>
                  <dd>{Number(usage.total_tokens).toLocaleString()}</dd>
                </div>
                <div>
                  <dt>调用失败</dt>
                  <dd>{Number(usage.failed_calls).toLocaleString()}</dd>
                </div>
              </dl>
            )}
            {!terminal && (
              <span className="sub overview-processing">
                {driving && <span className="spinner-inline" />}{' '}
                {pending_jobs > 0 ? `处理中(${pending_jobs} 个任务排队)` : '等待任务'}
              </span>
            )}
          </div>
        </div>
        {project.chapters_total > 0 && (
          <div style={{ marginTop: 12 }}>
            <ProgressBar done={project.chapters_done} failed={project.chapters_failed} total={project.chapters_total} />
          </div>
        )}
        {!terminal && (
          <p className="sub" style={{ marginTop: 12, marginBottom: 0 }}>
            处理会持续几十秒到几分钟。可以关闭页面稍后回来 —— 进度保存在服务端。
          </p>
        )}

        {project.chapters_total > 0 && (
          <div className={`aggregate-state aggregate-${project.aggregate_status}`}>
            <div>
              <strong>全书角色与声线</strong>
              <span>
                {project.aggregate_status === 'clean'
                  ? `已更新至正文版本 ${project.aggregated_revision}`
                  : project.aggregate_status === 'running'
                    ? `正在汇总正文版本 ${project.content_revision}`
                    : project.aggregate_status === 'failed'
                      ? `正文版本 ${project.content_revision} 汇总失败`
                      : `正文已更新至版本 ${project.content_revision}，等待汇总`}
              </span>
            </div>
            {project.aggregate_status !== 'clean' && (
              <span className="aggregate-version">
                已发布 v{project.aggregated_revision} / 最新 v{project.content_revision}
              </span>
            )}
          </div>
        )}

        {/* 失败章节的刷新重试入口 */}
        {(failedChapters.length > 0 || project.aggregate_status === 'failed') && (
          <div className="retry-row">
            <button className="btn btn-primary small" onClick={onRetry} disabled={retrying}>
              {retrying
                ? '重新提交中…'
                : failedChapters.length
                  ? `重试 ${failedChapters.length} 个失败章节`
                  : '重试全书分析'}
            </button>
            <span className="sub">失败通常是模型服务临时不可用，重试不会重复创建章节。</span>
          </div>
        )}
      </section>

      {/* 章节列表 */}
      <section className="chapter-section">
        <div className="section-bar">
          <div>
            <h2>{projectView === 'chapters' ? '章节' : '人物与音色'}</h2>
            <span>
              {projectView === 'chapters'
                ? `${chapters.length} 章`
                : rolesLoading && roles.length === 0
                  ? '加载中…'
                  : `${roles.length} 个人物`}
            </span>
          </div>
          <div className="section-actions">
            <div className="project-view-toggle" role="tablist" aria-label="项目内容视图">
              <button
                type="button"
                className={projectView === 'chapters' ? 'active' : ''}
                onClick={() => setProjectView('chapters')}
                role="tab"
                aria-selected={projectView === 'chapters'}
              >
                章节列表
              </button>
              <button
                type="button"
                className={projectView === 'roles' ? 'active' : ''}
                onClick={() => setProjectView('roles')}
                role="tab"
                aria-selected={projectView === 'roles'}
              >
                人物列表
              </button>
            </div>
            {project.source_mode === 'per_chapter' && (
              <button type="button" className="btn btn-primary small" onClick={openAppend}>
                + 继续上传章节
              </button>
            )}
          </div>
        </div>
        {projectView === 'chapters' ? (
          chapters.length === 0 ? (
            <div className="card empty">
              {project.status === 'chapterizing'
                ? <><span className="spinner-inline" /> 正在拆分章节…</>
                : '还没有章节'}
            </div>
          ) : (
            <div className="chapter-table">
              <div className="chapter-table-head" aria-hidden="true">
                <span>序号</span>
                <span>章节名称</span>
                <span>字数</span>
                <span>耗时</span>
                <span>状态</span>
                <span />
              </div>
              {chapters.map((chapter) => {
                const done = chapter.status === 'succeeded';
                const cls = `chapter-item ${done ? 'clickable' : ''} ${chapter.status === 'failed' ? 'is-failed' : ''} ${chapter.status === 'running' ? 'is-running' : ''}`;
                const inner = (
                  <>
                    <span className="idx">#{chapter.chapter_index}</span>
                    <span className="name">{chapter.title || `第${chapter.chapter_index}章`}</span>
                    <span className="stat">{chapter.char_count.toLocaleString()} 字</span>
                    <span className="stat">{formatDuration(chapter.duration_ms)}</span>
                    <StatusBadge status={chapter.status} />
                    <span className="row-arrow" aria-hidden="true">{done ? '→' : ''}</span>
                  </>
                );
                return done ? (
                  <Link key={chapter.id} href={`/projects/${projectId}/chapters/${chapter.id}`} className={cls}>
                    {inner}
                  </Link>
                ) : (
                  <div key={chapter.id} className={cls} title={chapter.error ?? undefined}>
                    {inner}
                  </div>
                );
              })}
            </div>
          )
        ) : (
          <div className="project-role-view">
            {project.aggregate_status !== 'clean' && project.has_book_result && (
              <Alert kind="warn">
                当前显示的是已发布版本 v{project.aggregated_revision} 的人物与音色；
                最新正文 v{project.content_revision} 尚在汇总，完成后会自动更新。
              </Alert>
            )}
            {rolesError && <Alert kind="error">{rolesError}</Alert>}
            {rolesLoading && roles.length === 0 ? (
              <div className="card empty"><span className="spinner-inline" /> 正在加载人物列表…</div>
            ) : !project.has_book_result ? (
              <div className="card empty">
                <h2>人物列表尚未生成</h2>
                <p className="sub">所有章节处理完成并完成全书汇总后，将在这里展示人物与对应音色。</p>
              </div>
            ) : roles.length === 0 ? (
              <div className="card empty">当前全书结果中没有识别到人物。</div>
            ) : (
              <>
                {rolesLoading && (
                  <p className="role-refreshing"><span className="spinner-inline" /> 正在更新人物列表…</p>
                )}
                <div className="project-role-grid">
                  {roles.map((role, index) => {
                    const gender = role.voice_profile?.gender || role.gender || 'unknown';
                    const confidence = Number(role.voice_profile?.confidence);
                    return (
                      <article className="project-role-card" key={role.role_id || `${role.canonical_name}-${index}`}>
                        <div className="project-role-head">
                          <div>
                            <span className="project-role-index">#{String(index + 1).padStart(2, '0')}</span>
                            <h3>{role.canonical_name || '未命名人物'}</h3>
                          </div>
                          <div className="project-role-tags">
                            <span>{GENDER_LABEL[gender] ?? gender}</span>
                            {role.voice_profile?.age_group && <span>{role.voice_profile.age_group}</span>}
                          </div>
                        </div>
                        <div className="project-role-voice">
                          <span>音色描述</span>
                          <p>{role.voice_profile?.description || '暂无音色描述'}</p>
                        </div>
                        {Array.isArray(role.aliases) && role.aliases.length > 0 && (
                          <p className="project-role-aliases">
                            <span>别名</span>
                            {role.aliases.join('、')}
                          </p>
                        )}
                        <dl className="project-role-meta">
                          <div>
                            <dt>音色 ID</dt>
                            <dd>{PLACEHOLDER_VOICE_PROFILE_ID}</dd>
                          </div>
                          <div>
                            <dt>对白证据</dt>
                            <dd>{Number(role.evidence_span_count || 0).toLocaleString()} 条</dd>
                          </div>
                          <div>
                            <dt>置信度</dt>
                            <dd>{Number.isFinite(confidence) ? `${Math.round(confidence * 100)}%` : '—'}</dd>
                          </div>
                        </dl>
                      </article>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        )}
      </section>

      {appendOpen && (
        <div
          className="drawer-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !appending) setAppendOpen(false);
          }}
        >
          <aside className="chapter-drawer" role="dialog" aria-modal="true" aria-labelledby="appendChapterTitle">
            <div className="drawer-head">
              <div>
                <p className="eyebrow">Continue project</p>
                <h2 id="appendChapterTitle">继续上传章节</h2>
                <p>新章节将从第 {project.next_chapter_index} 章开始，上传后立即进入处理队列。</p>
              </div>
              <button
                type="button"
                className="drawer-close"
                onClick={() => setAppendOpen(false)}
                disabled={appending}
                aria-label="关闭"
              >
                ×
              </button>
            </div>
            <div className="drawer-body">
              {appendError && <Alert kind="error">{appendError}</Alert>}
              <ChapterBatchEditor
                compact
                chapters={appendDrafts}
                onChange={setAppendDrafts}
                startIndex={project.next_chapter_index}
              />
            </div>
            <div className="drawer-actions">
              <span>
                正文会按实际内容计算去重指纹；重复章节将被拒绝。
              </span>
              <div>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => setAppendOpen(false)}
                  disabled={appending}
                >
                  取消
                </button>
                <button type="button" className="btn btn-primary" onClick={onAppend} disabled={appending}>
                  {appending ? '上传中…' : '上传并开始处理'}
                </button>
              </div>
            </div>
          </aside>
        </div>
      )}
    </main>
  );
}
