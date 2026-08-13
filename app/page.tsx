'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  api, clearStoredEmail, getStoredEmail, getStoredEmails, setStoredEmail,
  type ProjectSummary,
} from '@/src/client/api';
import { Alert, ProgressBar, StatusBadge } from '@/src/client/ui';

export default function HomePage() {
  const [email, setEmail] = useState('');
  const [inputEmail, setInputEmail] = useState('');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [knownEmails, setKnownEmails] = useState<string[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null);
  const [deletingProjectId, setDeletingProjectId] = useState<string | null>(null);

  useEffect(() => {
    const stored = getStoredEmail();
    setKnownEmails(getStoredEmails());
    setEmail(stored);
    setInputEmail(stored);
    setReady(true);
  }, []);

  const load = useCallback(async (target: string) => {
    if (!target) return;
    setBusy(true);
    try {
      const { projects: list } = await api.listProjects(target);
      setProjects(list);
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 邮箱尚未登记时后端返回 404, 这不是错误, 只是还没有项目
      if (/尚无记录/.test(message)) {
        setProjects([]);
        setError(null);
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (ready && email) void load(email);
  }, [ready, email, load]);

  const signIn = async (targetEmail?: string) => {
    const value = (targetEmail ?? inputEmail).trim().toLowerCase();
    if (!value) return;
    setInputEmail(value);
    setBusy(true);
    try {
      await api.session(value);
      setStoredEmail(value);
      setKnownEmails(getStoredEmails());
      setEmail(value);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const signOut = () => {
    clearStoredEmail();
    setEmail('');
    setInputEmail('');
    setProjects([]);
  };

  const deleteSelectedProject = async () => {
    if (!deleteTarget || !email) return;
    setDeletingProjectId(deleteTarget.id);
    setError(null);
    try {
      await api.deleteProject(deleteTarget.id, email);
      setProjects((current) => current.filter((project) => project.id !== deleteTarget.id));
      setDeleteTarget(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeletingProjectId(null);
    }
  };

  // 注意: 不要用 `if (!ready) return 空白` —— 那会让首屏服务端渲染成空页面,
  // 用户看到一瞬白屏, 且禁用 JS 时完全没有内容。
  // 邮箱入口对未登记用户本就是正确的首屏, 所以默认渲染它;
  // 只有确实从 localStorage 读到邮箱时才切换到项目列表。
  if (!email) {
    return (
      <main className="page page-landing">
        <section className="landing-intro">
          <div className="landing-copy">
            <p className="eyebrow">多播电子书测试系统</p>
            <h1>把小说文本拆成<br />可直接使用的<br />结构化内容</h1>
          </div>
          <ul className="feature-list" aria-label="功能概览">
            <li><strong>自动拆章</strong><span>识别章节标题与正文边界</span></li>
            <li><strong>对白抽取</strong><span>区分旁白、说话人与情绪</span></li>
            <li><strong>角色声线</strong><span>聚合角色别名与声音描述</span></li>
          </ul>
        </section>

        <section className="card identity-card">
          <div className="section-heading">
            <p className="eyebrow">Start</p>
            <h2>用邮箱开始体验</h2>
            <p className="sub">
              无需注册。在任何设备填写同一邮箱，都可以继续查看之前的处理项目。
            </p>
          </div>
          <div className="identity-row" style={ready ? undefined : { opacity: 0.6 }}>
            <input
              type="email"
              placeholder="you@example.com"
              value={inputEmail}
              onChange={(event) => setInputEmail(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') void signIn(); }}
              aria-label="邮箱"
            />
            <button className="btn btn-primary" onClick={() => void signIn()} disabled={busy || !inputEmail.trim()}>
              {busy ? '处理中…' : '开始使用'}
            </button>
          </div>
          {knownEmails.length > 0 && (
            <div className="saved-accounts">
              <span>此设备使用过</span>
              <div className="saved-account-list">
                {knownEmails.map((savedEmail) => (
                  <button
                    key={savedEmail}
                    type="button"
                    onClick={() => void signIn(savedEmail)}
                    disabled={busy}
                    title={`使用 ${savedEmail}`}
                  >
                    <span>{savedEmail}</span>
                    <i aria-hidden="true">→</i>
                  </button>
                ))}
              </div>
            </div>
          )}
          {error && <div style={{ marginTop: 12 }}><Alert kind="error">{error}</Alert></div>}

          {/* 邮箱未经验证, 必须如实告知 —— 任何人填同一邮箱都能看到这些项目 */}
          <p className="privacy-note">
            <strong>隐私提示</strong>
            邮箱不做验证，任何人填写同一邮箱都能查看该邮箱下的项目。
            请勿上传敏感内容或未公开的独家版权作品。
          </p>
        </section>
      </main>
    );
  }

  return (
    <main className="page">
      <div className="page-header dashboard-header">
        <div>
          <p className="eyebrow">多播电子书测试系统</p>
          <h1>我的项目</h1>
          <p className="sub">查看处理进度，继续浏览已完成的章节结果。</p>
        </div>
        <div className="page-actions">
          <span className="account-label">{email}</span>
          <button className="btn btn-ghost small" onClick={signOut}>切换邮箱</button>
          <Link className="btn btn-primary" href="/projects/new">新建项目</Link>
        </div>
      </div>

      {error && <Alert kind="error">{error}</Alert>}

      {busy && !projects.length ? (
        <div className="empty"><span className="spinner-inline" /> 加载中…</div>
      ) : projects.length === 0 ? (
        <div className="card empty">
          <h2>还没有项目</h2>
          <p className="sub">上传整本小说自动拆章，或直接提交已经切分好的章节文本。</p>
          <Link className="btn btn-primary" href="/projects/new" style={{ marginTop: 16 }}>创建第一个项目</Link>
        </div>
      ) : (
        <section className="project-section">
          <div className="section-bar">
            <div>
              <h2>项目记录</h2>
              <span>{projects.length} 个项目</span>
            </div>
            <span className="section-hint">点击项目查看章节和拆分结果</span>
          </div>
          <div className="project-list">
            {projects.map((project) => {
              const deleting = deletingProjectId === project.id;
              return (
                <div key={project.id} className={`project-row ${deleting ? 'deleting' : ''}`}>
                  <Link href={`/projects/${project.id}`} className="project-row-link" aria-label={`查看项目 ${project.title}`}>
                    <div className="project-main">
                      <div className="title">{project.title}</div>
                      <div className="meta">
                        <span>{project.source_mode === 'whole_book' ? '整本上传' : '逐章上传'}</span>
                        <span>{new Date(project.created_at).toLocaleString('zh-CN')}</span>
                      </div>
                    </div>
                    <div className="project-progress">
                      <div className="project-progress-copy">
                        <span>
                          {project.chapters_total > 0
                            ? `${project.chapters_done} / ${project.chapters_total} 章`
                            : '等待拆章'}
                        </span>
                        {project.chapters_failed > 0 && <em>{project.chapters_failed} 章失败</em>}
                      </div>
                      {project.chapters_total > 0 && (
                        <ProgressBar
                          done={project.chapters_done}
                          failed={project.chapters_failed}
                          total={project.chapters_total}
                        />
                      )}
                    </div>
                    <StatusBadge status={project.status} />
                    <span className="row-arrow" aria-hidden="true">→</span>
                  </Link>
                  <button
                    type="button"
                    className="project-delete-btn"
                    onClick={() => setDeleteTarget(project)}
                    disabled={deleting}
                    aria-label={`删除项目 ${project.title}`}
                    title="删除项目"
                  >
                    {deleting ? <span className="spinner-inline" /> : '删除'}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {deleteTarget && (
        <div
          className="confirm-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !deletingProjectId) setDeleteTarget(null);
          }}
        >
          <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="deleteProjectTitle">
            <p className="eyebrow">Delete project</p>
            <h2 id="deleteProjectTitle">删除“{deleteTarget.title}”？</h2>
            <p>
              删除后将一并清除小说原文、章节结果、处理任务、调用记录和相关反馈，
              且无法恢复。
            </p>
            <div className="confirm-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setDeleteTarget(null)}
                disabled={Boolean(deletingProjectId)}
              >
                取消
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void deleteSelectedProject()}
                disabled={Boolean(deletingProjectId)}
              >
                {deletingProjectId ? '删除中…' : '确认删除'}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
