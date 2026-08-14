'use client';

import { use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  api,
  formatDuration,
  getStoredEmail,
  type AdjacentChapter,
} from '@/src/client/api';
import { Alert, BackLink } from '@/src/client/ui';
import { FeedbackCard } from '@/src/client/FeedbackCard';

interface TtsSegment {
  segment_id?: string;
  type?: string;
  speaker?: string;
  original_speaker?: string;
  speaker_corrected?: boolean;
  emotion?: string;
  text?: string;
  start?: number;
  end?: number;
  role_id?: string;
  voice_profile_id?: string;
  voice_profile?: { description?: string; age_group?: string; gender?: string };
}

interface RoleEntry {
  role_id?: string;
  canonical_name?: string;
  gender?: string;
  aliases?: string[];
  voice_profile?: { description?: string; age_group?: string; confidence?: number };
}

function roleKey(role: RoleEntry): string {
  if (role.role_id?.trim()) return role.role_id.trim();
  return role.canonical_name?.trim() ? `name:${role.canonical_name.trim()}` : '';
}

const GENDER_LABEL: Record<string, string> = { male: '男', female: '女', unknown: '未知' };
type ResultView = 'list' | 'visual';

interface VisualSlice {
  key: string;
  text: string;
  segment?: TtsSegment;
}

function normalizeVisualizationText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\n[ \t]+\n/g, '\n\n')
    .replace(/\n{3,}/g, '\n\n');
}

interface PopoverPosition {
  top: number;
  left: number;
  placement: 'left' | 'right' | 'below';
}

function ChapterNavigation({
  projectId,
  previous,
  next,
  position,
}: {
  projectId: string;
  previous: AdjacentChapter | null;
  next: AdjacentChapter | null;
  position: 'header' | 'footer';
}) {
  const item = (
    direction: 'previous' | 'next',
    chapter: AdjacentChapter | null,
  ) => {
    const isPrevious = direction === 'previous';
    const label = isPrevious ? '上一章' : '下一章';
    const arrow = isPrevious ? '←' : '→';
    if (!chapter) {
      return (
        <span className={`chapter-nav-link disabled ${direction}`} aria-disabled="true">
          <span className="chapter-nav-direction">{isPrevious ? `${arrow} ${label}` : `${label} ${arrow}`}</span>
          <small>{isPrevious ? '已经是第一章' : '已经是最后一章'}</small>
        </span>
      );
    }
    return (
      <Link
        className={`chapter-nav-link ${direction}`}
        href={`/projects/${projectId}/chapters/${chapter.id}`}
        title={`${label}：${chapter.title || `第${chapter.chapter_index}章`}`}
        aria-label={`${label}，第${chapter.chapter_index}章，${chapter.title || `第${chapter.chapter_index}章`}`}
      >
        <span className="chapter-nav-direction">{isPrevious ? `${arrow} ${label}` : `${label} ${arrow}`}</span>
        <small>
          第{chapter.chapter_index}章 · {chapter.title || `第${chapter.chapter_index}章`}
        </small>
      </Link>
    );
  };

  return (
    <nav className={`chapter-navigation ${position}`} aria-label="章节切换">
      {item('previous', previous)}
      {item('next', next)}
    </nav>
  );
}

export default function ChapterPage({ params }: { params: Promise<{ projectId: string; chapterId: string }> }) {
  const { projectId, chapterId } = use(params);
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [chapter, setChapter] = useState<Awaited<ReturnType<typeof api.getChapter>>['chapter'] | null>(null);
  const [navigation, setNavigation] = useState<{
    previous: AdjacentChapter | null;
    next: AdjacentChapter | null;
  }>({ previous: null, next: null });
  const [roles, setRoles] = useState<RoleEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showNarration, setShowNarration] = useState(true);
  const [resultView, setResultView] = useState<ResultView>('list');
  const [selectedSegment, setSelectedSegment] = useState<string | null>(null);
  const [popoverPosition, setPopoverPosition] = useState<PopoverPosition | null>(null);
  const [savingSegment, setSavingSegment] = useState<string | null>(null);
  const [speakerMessage, setSpeakerMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const anchorRef = useRef<HTMLElement | null>(null);

  const closeSegmentPopover = useCallback(() => {
    setSelectedSegment(null);
    setPopoverPosition(null);
    anchorRef.current = null;
  }, []);

  useEffect(() => {
    const stored = getStoredEmail();
    if (!stored) router.replace('/');
    else setEmail(stored);
  }, [router]);

  useEffect(() => {
    if (!email) return;
    let alive = true;
    setChapter(null);
    setNavigation({ previous: null, next: null });
    setError(null);
    closeSegmentPopover();
    (async () => {
      try {
        const chapterRes = await api.getChapter(projectId, chapterId, email);
        if (!alive) return;
        setChapter(chapterRes.chapter);
        setNavigation(chapterRes.navigation);
        setRoles(Array.isArray(chapterRes.roles) ? chapterRes.roles : []);
      } catch (err) {
        if (alive) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { alive = false; };
  }, [email, projectId, chapterId, closeSegmentPopover]);

  useEffect(() => {
    // 未完成全书聚合时 enrichment 仍可能变化，不预取这类不稳定结果。
    // 已稳定的章节则提前下载下一章；导航后 api.getChapter 会直接复用该 Promise。
    if (!email || !chapter?.enriched || !navigation.next) return;
    api.prefetchChapter(projectId, navigation.next.id, email);
  }, [chapter?.enriched, email, navigation.next, projectId]);

  const result = chapter?.result as Record<string, unknown> | null | undefined;
  const segments = useMemo(() => (Array.isArray(result?.tts_segments) ? (result!.tts_segments as TtsSegment[]) : []), [result]);
  const dialogueCount = segments.filter((segment) => segment.type === 'dialogue').length;

  // 本章出现过的角色(按 book_result 的声线信息补全)
  const chapterRoles = useMemo(() => {
    const names = new Set(segments.filter((s) => s.type === 'dialogue' && s.speaker).map((s) => s.speaker!));
    return roles.filter((role) => role.canonical_name && names.has(role.canonical_name));
  }, [segments, roles]);

  const visibleSegments = showNarration ? segments : segments.filter((segment) => segment.type === 'dialogue');
  const visualSlices = useMemo<VisualSlice[]>(() => {
    const cleanedText = typeof result?.cleaned_text === 'string' ? result.cleaned_text : '';
    const dialogues = segments
      .filter((segment) =>
        segment.type === 'dialogue'
        && Number.isFinite(segment.start)
        && Number.isFinite(segment.end)
        && Number(segment.end) > Number(segment.start))
      .sort((a, b) => Number(a.start) - Number(b.start));
    const textCandidates = [cleanedText, chapter?.source_text ?? ''].filter(Boolean);
    const baseText = textCandidates.find((text) =>
      dialogues.every((segment) => {
        const start = Number(segment.start);
        const end = Number(segment.end);
        return end <= text.length && (!segment.text || text.slice(start, end) === segment.text);
      })) ?? '';

    if (baseText && dialogues.length) {
      const slices: VisualSlice[] = [];
      let cursor = 0;
      dialogues.forEach((segment, index) => {
        const rawStart = Math.min(baseText.length, Number(segment.start));
        const rawEnd = Math.min(baseText.length, Number(segment.end));
        const hasOpeningQuote = rawStart > cursor && /[“‘「『"]/.test(baseText[rawStart - 1] ?? '');
        const hasClosingQuote = /[”’」』"]/.test(baseText[rawEnd] ?? '');
        const start = Math.max(cursor, hasOpeningQuote ? rawStart - 1 : rawStart);
        const end = Math.max(start, hasClosingQuote ? rawEnd + 1 : rawEnd);
        if (start > cursor) {
          slices.push({ key: `text-${cursor}`, text: normalizeVisualizationText(baseText.slice(cursor, start)) });
        }
        if (end > start) {
          slices.push({
            key: segment.segment_id ?? `dialogue-${index}-${start}`,
            text: normalizeVisualizationText(baseText.slice(start, end)),
            segment,
          });
          cursor = end;
        }
      });
      if (cursor < baseText.length) {
        slices.push({ key: `text-${cursor}`, text: normalizeVisualizationText(baseText.slice(cursor)) });
      }
      if (slices.length) return slices;
    }

    // 旧数据若缺少 start/end，仍可按已经覆盖全文的 TTS segment 顺序展示。
    return segments.map((segment, index) => ({
      key: segment.segment_id ?? `segment-${index}`,
      text: normalizeVisualizationText(segment.text ?? ''),
      segment: segment.type === 'dialogue' ? segment : undefined,
    }));
  }, [chapter?.source_text, result, segments]);

  const selectedVisualSlice = useMemo(
    () => visualSlices.find((slice) => slice.key === selectedSegment) ?? null,
    [selectedSegment, visualSlices],
  );
  const selectedRole = useMemo(() => {
    const segment = selectedVisualSlice?.segment;
    if (!segment) return null;
    return roles.find((role) =>
      (segment.role_id && role.role_id === segment.role_id)
      || role.canonical_name === segment.speaker) ?? null;
  }, [roles, selectedVisualSlice]);

  const updateSpeaker = useCallback(async (segment: TtsSegment, targetRoleKey: string) => {
    if (!segment.segment_id || !targetRoleKey || savingSegment) return;
    setSavingSegment(segment.segment_id);
    setSpeakerMessage(null);
    try {
      const response = await api.updateSegmentSpeaker(
        projectId,
        chapterId,
        email,
        segment.segment_id,
        targetRoleKey,
      );
      setChapter((current) => current
        ? { ...current, result: response.chapter.result }
        : current);
      setSpeakerMessage({
        kind: 'ok',
        text: response.changed ? '说话人已修改，修改日志已保存。' : '该对白已经是所选人物。',
      });
    } catch (err) {
      setSpeakerMessage({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    } finally {
      setSavingSegment(null);
    }
  }, [chapterId, email, projectId, savingSegment]);

  const positionSegmentPopover = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;

    const rect = anchor.getBoundingClientRect();
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      closeSegmentPopover();
      return;
    }

    const gap = 8;
    const edge = 12;
    const popoverWidth = popoverRef.current?.offsetWidth ?? Math.min(240, window.innerWidth - edge * 2);
    const popoverHeight = popoverRef.current?.offsetHeight ?? 112;
    let placement: PopoverPosition['placement'] = 'right';
    let left = rect.right + gap;

    if (left + popoverWidth > window.innerWidth - edge) {
      placement = 'left';
      left = rect.left - popoverWidth - gap;
    }
    if (left < edge) {
      placement = 'below';
      left = Math.min(
        Math.max(edge, rect.left),
        Math.max(edge, window.innerWidth - popoverWidth - edge),
      );
    }

    // 左右悬浮时，让气泡箭头对准说话人按钮的垂直中心。
    const arrowCenterOffset = 22.5;
    let top = placement === 'below'
      ? rect.bottom + 8
      : rect.top + rect.height / 2 - arrowCenterOffset;
    top = Math.min(
      Math.max(edge, top),
      Math.max(edge, window.innerHeight - popoverHeight - edge),
    );
    setPopoverPosition({ top, left, placement });
  }, [closeSegmentPopover]);

  useEffect(() => {
    if (!selectedSegment) return;
    const frame = window.requestAnimationFrame(positionSegmentPopover);

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popoverRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('[data-highlight-id]')) return;
      closeSegmentPopover();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeSegmentPopover();
    };
    const onViewportChange = () => positionSegmentPopover();

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('scroll', onViewportChange, true);
    window.addEventListener('resize', onViewportChange);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('scroll', onViewportChange, true);
      window.removeEventListener('resize', onViewportChange);
    };
  }, [closeSegmentPopover, positionSegmentPopover, selectedSegment]);

  if (!email) return <main className="page" />;
  if (error) {
    return (
      <main className="page">
        <BackLink href={`/projects/${projectId}`}>返回项目</BackLink>
        <Alert kind="error">{error}</Alert>
      </main>
    );
  }
  if (!chapter) return <main className="page"><div className="empty"><span className="spinner-inline" /> 加载中…</div></main>;

  return (
    <main className="page">
      <BackLink href={`/projects/${projectId}`}>返回项目</BackLink>
      <div className="page-header">
        <div>
          <p className="eyebrow">第 {chapter.chapter_index} 章</p>
          <h1>{chapter.title || `第${chapter.chapter_index}章`}</h1>
          <p className="sub">查看本章识别出的角色、声线与对白/旁白序列。</p>
        </div>
        <ChapterNavigation
          projectId={projectId}
          previous={navigation.previous}
          next={navigation.next}
          position="header"
        />
      </div>

      {!chapter.enriched && (
        <div className="chapter-alert">
          <Alert kind="warn">本章还未完成全书聚合, 角色与声线信息可能不完整。</Alert>
        </div>
      )}
      {speakerMessage && (
        <div className="chapter-alert">
          <Alert kind={speakerMessage.kind}>{speakerMessage.text}</Alert>
        </div>
      )}

      <div className="chapter-result-layout">
        {/* 对白 / 旁白序列 */}
        <section className="result-section chapter-result-main">
          <div className="section-bar">
            <div>
              <h2>拆分结果</h2>
              <span>{segments.length} 条内容</span>
            </div>
            <div className="result-view-actions">
              {resultView === 'list' && (
                <label className="narration-toggle">
                  <input type="checkbox" checked={showNarration} onChange={(event) => setShowNarration(event.target.checked)} />
                  显示旁白
                </label>
              )}
              <div className="result-view-toggle" role="tablist" aria-label="结果展示方式">
                <button
                  type="button"
                  className={resultView === 'list' ? 'active' : ''}
                  onClick={() => {
                    setResultView('list');
                    closeSegmentPopover();
                  }}
                  role="tab"
                  aria-selected={resultView === 'list'}
                >
                  结构化列表
                </button>
                <button
                  type="button"
                  className={resultView === 'visual' ? 'active' : ''}
                  onClick={() => setResultView('visual')}
                  role="tab"
                  aria-selected={resultView === 'visual'}
                >
                  原文高亮
                </button>
              </div>
            </div>
          </div>

          {resultView === 'visual' ? (
            visualSlices.length === 0 ? (
              <div className="card empty">本章没有可视化文本。</div>
            ) : (
              <div className="chapter-visualization">
                <p className="visualization-hint">对白句已在原文中标记，点击任一句可以强调显示。</p>
                <div className="visualization-copy">
                  {visualSlices.map((slice) => {
                    if (!slice.segment) return <span key={slice.key}>{slice.text}</span>;
                    const id = slice.key;
                    const active = selectedSegment === id;
                    return (
                      <mark
                        key={slice.key}
                        data-highlight-id={id}
                        className={`sentence-highlight ${active ? 'active' : ''}`}
                        onClick={(event) => {
                          if (active) {
                            closeSegmentPopover();
                            return;
                          }
                          anchorRef.current = event.currentTarget;
                          setSelectedSegment(id);
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            if (active) {
                              closeSegmentPopover();
                              return;
                            }
                            anchorRef.current = event.currentTarget;
                            setSelectedSegment(id);
                          }
                        }}
                        role="button"
                        tabIndex={0}
                        aria-pressed={active}
                        aria-label={`${slice.segment.speaker || '未知角色'}：${slice.text}`}
                        title={`${slice.segment.speaker || '未知角色'}${slice.segment.emotion ? ` · ${slice.segment.emotion}` : ''}`}
                      >
                        {slice.text}
                      </mark>
                    );
                  })}
                </div>
              </div>
            )
          ) : visibleSegments.length === 0 ? (
            <div className="card empty">本章没有抽取到内容。</div>
          ) : (
            <div className="dialogue-list">
              {visibleSegments.map((segment, index) => (
                <div
                  key={segment.segment_id ?? index}
                  className={`dialogue-item ${segment.type === 'narration' ? 'narration' : ''}`}
                >
                  <div className="dialogue-head">
                    {segment.type === 'dialogue' ? (
                      <>
                        <button
                          type="button"
                          className="speaker-edit-trigger"
                          onClick={(event) => {
                            // 以说话人按钮自身为锚点，悬浮窗紧贴名字而不是整条对白。
                            anchorRef.current = event.currentTarget;
                            setSelectedSegment(segment.segment_id ?? null);
                          }}
                          disabled={!segment.segment_id || roles.length === 0}
                          title={roles.length ? '点击修改说话人' : '当前小说还没有可选人物'}
                        >
                          {segment.speaker || '未知'}
                          <span aria-hidden="true">⌄</span>
                        </button>
                        {segment.speaker_corrected && <span className="badge corrected">已修改</span>}
                        {segment.emotion && <span className="badge emotion">{segment.emotion}</span>}
                      </>
                    ) : (
                      <span className="who" style={{ color: 'var(--muted)' }}>旁白</span>
                    )}
                  </div>
                  <div className="dialogue-text">{segment.text}</div>
                </div>
              ))}
            </div>
          )}
        </section>

        <aside className="chapter-insights">
          <section className="insight-section">
            <div className="insight-heading">
              <p className="eyebrow">Overview</p>
              <h2>本章概览</h2>
            </div>
            <dl className="chapter-facts">
              <div><dt>字数</dt><dd>{chapter.char_count.toLocaleString()}</dd></div>
              <div><dt>对白</dt><dd>{dialogueCount} 句</dd></div>
              <div><dt>角色</dt><dd>{chapterRoles.length} 人</dd></div>
              <div><dt>耗时</dt><dd>{formatDuration(chapter.duration_ms)}</dd></div>
            </dl>
          </section>

          {chapterRoles.length > 0 && (
            <section className="insight-section role-insight">
              <div className="insight-heading">
                <p className="eyebrow">Voice profiles</p>
                <h2>角色与声线</h2>
                <span>{chapterRoles.length} 个角色</span>
              </div>
              <div className="compact-role-list">
                {chapterRoles.map((role) => (
                  <article className="compact-role" key={role.role_id ?? role.canonical_name}>
                    <div className="compact-role-head">
                      <strong>{role.canonical_name}</strong>
                      <span>
                        {GENDER_LABEL[role.gender ?? 'unknown'] ?? role.gender}
                        {role.voice_profile?.age_group ? ` · ${role.voice_profile.age_group}` : ''}
                      </span>
                    </div>
                    {role.voice_profile?.description && <p>{role.voice_profile.description}</p>}
                    {role.aliases && role.aliases.length > 1 && (
                      <small>别名：{role.aliases.join('、')}</small>
                    )}
                  </article>
                ))}
              </div>
            </section>
          )}
        </aside>
      </div>

      <ChapterNavigation
        projectId={projectId}
        previous={navigation.previous}
        next={navigation.next}
        position="footer"
      />

      {selectedVisualSlice?.segment && popoverPosition && (
        <div
          ref={popoverRef}
          className={`sentence-popover ${popoverPosition.placement}`}
          style={{ top: popoverPosition.top, left: popoverPosition.left }}
          role="dialog"
          aria-label="修改说话人"
        >
          <label className="sentence-popover-field">
            <span>人物</span>
            <select
              value={selectedRole ? roleKey(selectedRole) : ''}
              onChange={(event) => void updateSpeaker(selectedVisualSlice.segment!, event.target.value)}
              disabled={savingSegment === selectedVisualSlice.segment.segment_id || roles.length === 0}
              aria-label="修改说话人"
            >
              <option value="" disabled>
                {roles.length ? '选择小说人物' : '没有可选人物'}
              </option>
              {roles.map((role) => (
                <option key={roleKey(role)} value={roleKey(role)}>
                  {role.canonical_name}
                </option>
              ))}
            </select>
          </label>
          {selectedVisualSlice.segment.speaker_corrected && (
            <p className="sentence-popover-note">
              原识别：{selectedVisualSlice.segment.original_speaker || 'unknown_speaker'}
            </p>
          )}
          <div className="sentence-popover-row">
            <span>情感</span>
            <strong>{selectedVisualSlice.segment.emotion || '未标注'}</strong>
          </div>
          {savingSegment === selectedVisualSlice.segment.segment_id && (
            <p className="sentence-popover-saving"><span className="spinner-inline" /> 正在保存…</p>
          )}
        </div>
      )}

      <FeedbackCard email={email} projectId={projectId} chapterId={chapterId} />
    </main>
  );
}
