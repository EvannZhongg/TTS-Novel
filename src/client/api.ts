'use client';

/**
 * 内部 API 的浏览器侧封装。
 *
 * 浏览器永远不直连 Supabase —— 一律走 /api/app/*, 由服务端用 secret key 访问。
 * 邮箱既是标识也是凭据(未经验证), 从 localStorage 读取。
 */

const EMAIL_KEY = 'multicast_ebook_test_email';
const EMAIL_HISTORY_KEY = 'multicast_ebook_test_email_history';
// 兼容品牌更新前已经保存在浏览器中的邮箱记录。
const LEGACY_EMAIL_KEY = `${'novel'}${'mind'}_email`;
const LEGACY_EMAIL_HISTORY_KEY = `${'novel'}${'mind'}_email_history`;
const MAX_EMAIL_HISTORY = 8;

function normalizeStoredEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function getStoredEmail(): string {
  if (typeof window === 'undefined') return '';
  try {
    const current = window.localStorage.getItem(EMAIL_KEY)
      || window.localStorage.getItem(LEGACY_EMAIL_KEY)
      || '';
    if (current && !window.localStorage.getItem(EMAIL_KEY)) {
      window.localStorage.setItem(EMAIL_KEY, current);
      window.localStorage.removeItem(LEGACY_EMAIL_KEY);
    }
    return current;
  } catch {
    return '';
  }
}

/** 此设备成功使用过的邮箱，用于切换账号时免重复输入。 */
export function getStoredEmails(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const current = normalizeStoredEmail(window.localStorage.getItem(EMAIL_KEY) || '');
    const rawHistory = window.localStorage.getItem(EMAIL_HISTORY_KEY)
      || window.localStorage.getItem(LEGACY_EMAIL_HISTORY_KEY)
      || '[]';
    const parsed = JSON.parse(rawHistory);
    const history = Array.isArray(parsed) ? parsed : [];
    const emails = [...new Set([current, ...history]
      .map((item) => normalizeStoredEmail(typeof item === 'string' ? item : ''))
      .filter(Boolean))]
      .slice(0, MAX_EMAIL_HISTORY);
    if (!window.localStorage.getItem(EMAIL_HISTORY_KEY) && emails.length) {
      window.localStorage.setItem(EMAIL_HISTORY_KEY, JSON.stringify(emails));
      window.localStorage.removeItem(LEGACY_EMAIL_HISTORY_KEY);
    }
    return emails;
  } catch {
    const current = getStoredEmail();
    return current ? [current] : [];
  }
}

export function setStoredEmail(email: string): void {
  try {
    const normalized = normalizeStoredEmail(email);
    const history = getStoredEmails().filter((item) => item !== normalized);
    window.localStorage.setItem(EMAIL_KEY, normalized);
    window.localStorage.setItem(
      EMAIL_HISTORY_KEY,
      JSON.stringify([normalized, ...history].slice(0, MAX_EMAIL_HISTORY)),
    );
  } catch {
    /* 隐私模式下 localStorage 不可用, 忽略 */
  }
}

/** 只退出当前邮箱，保留设备上的邮箱历史，方便快速切换。 */
export function clearStoredEmail(): void {
  try {
    window.localStorage.removeItem(EMAIL_KEY);
    window.localStorage.removeItem(LEGACY_EMAIL_KEY);
  } catch {
    /* ignore */
  }
}

async function request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { error: text.slice(0, 300) };
  }
  if (!response.ok) {
    const message = (payload as { error?: string })?.error || `HTTP ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

// ------------------------------------------------------------------ 类型
export type ProjectStatus =
  | 'pending' | 'chapterizing' | 'processing' | 'completed'
  | 'partially_failed' | 'failed' | 'aggregation_failed';

export type AggregateStatus = 'clean' | 'dirty' | 'running' | 'failed';

export interface ChapterUploadInput {
  title?: string;
  text: string;
  client_file_name?: string;
  source_encoding?: string;
}

export interface ProjectSummary {
  id: string;
  title: string;
  source_mode: 'whole_book' | 'per_chapter';
  status: ProjectStatus;
  chapters_total: number;
  chapters_done: number;
  chapters_failed: number;
  next_chapter_index: number;
  content_revision: number;
  aggregated_revision: number;
  aggregate_status: AggregateStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChapterSummary {
  id: string;
  chapter_index: number;
  title: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  enriched: boolean;
  skip_llm: boolean;
  error: string | null;
  char_count: number;
  duration_ms: number | null;
  created_revision: number;
  analysis_revision: number;
  enrichment_revision: number;
}

export interface AdjacentChapter {
  id: string;
  chapter_index: number;
  title: string;
}

export interface ProjectDetail {
  project: ProjectSummary & { has_book_result: boolean };
  chapters: ChapterSummary[];
  pending_jobs: number;
  should_keep_driving: boolean;
}

export interface ProcessedTask {
  kind?: string;
  status?: string;
  durationMs?: number;
  message?: string;
  chapterId?: string;
}

export interface ChapterDetailResponse {
  chapter: ChapterSummary & { source_text: string; result: Record<string, unknown> | null };
  navigation: { previous: AdjacentChapter | null; next: AdjacentChapter | null };
}

export interface BookResultResponse {
  book_result: Record<string, unknown> | null;
  status: string;
  content_revision: number;
  aggregated_revision: number;
  aggregate_status: AggregateStatus;
  up_to_date: boolean;
}

interface RequestCacheEntry<T> {
  promise: Promise<T>;
  expiresAt: number;
}

// 仅保存在当前页面进程内，不写 localStorage。book_result 在同一项目的章节间
// 完全复用；章节缓存主要用于让“下一章”预取真正命中，而不是导航后再请求一次。
const BOOK_RESULT_CACHE_TTL_MS = 5 * 60 * 1000;
const CHAPTER_PREFETCH_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CHAPTER_CACHE_ENTRIES = 8;
const bookResultCache = new Map<string, RequestCacheEntry<BookResultResponse>>();
const chapterCache = new Map<string, RequestCacheEntry<ChapterDetailResponse>>();

function userResourceKey(email: string, ...parts: string[]): string {
  return [normalizeStoredEmail(email), ...parts].join(':');
}

function rememberRequest<T>(
  cache: Map<string, RequestCacheEntry<T>>,
  key: string,
  ttlMs: number,
  load: () => Promise<T>,
): Promise<T> {
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    // Map 的插入顺序被用作轻量 LRU；命中时移到末尾。
    cache.delete(key);
    cache.set(key, cached);
    return cached.promise;
  }
  if (cached) cache.delete(key);

  const promise = load();
  const entry = { promise, expiresAt: now + ttlMs };
  cache.set(key, entry);
  void promise.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });
  return promise;
}

function trimChapterCache(): void {
  while (chapterCache.size > MAX_CHAPTER_CACHE_ENTRIES) {
    const oldestKey = chapterCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    chapterCache.delete(oldestKey);
  }
}

async function getCachedBookResult(
  projectId: string,
  email: string,
  expectedRevision?: number,
): Promise<BookResultResponse> {
  const key = userResourceKey(email, projectId);
  const load = () => request<BookResultResponse>(
    'GET',
    `/api/app/projects/${projectId}/result?email=${encodeURIComponent(email)}`,
  );

  const cached = bookResultCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    const result = await cached.promise;
    if (expectedRevision === undefined || result.aggregated_revision === expectedRevision) {
      return result;
    }
    // 项目轮询已经看到更新的聚合版本时，旧 book_result 必须立即失效。
    if (bookResultCache.get(key) === cached) bookResultCache.delete(key);
  }

  return rememberRequest(bookResultCache, key, BOOK_RESULT_CACHE_TTL_MS, load);
}

function getCachedChapter(
  projectId: string,
  chapterId: string,
  email: string,
): Promise<ChapterDetailResponse> {
  const key = userResourceKey(email, projectId, chapterId);
  const result = rememberRequest(
    chapterCache,
    key,
    CHAPTER_PREFETCH_CACHE_TTL_MS,
    () => request<ChapterDetailResponse>(
      'GET',
      `/api/app/projects/${projectId}/chapters/${chapterId}?email=${encodeURIComponent(email)}`,
    ),
  );
  trimChapterCache();
  return result;
}

// ------------------------------------------------------------------ 调用
export const api = {
  session: (email: string) => request<{ user_id: string; email: string }>('POST', '/api/app/session', { email }),

  listProjects: (email: string) =>
    request<{ projects: ProjectSummary[] }>('GET', `/api/app/projects?email=${encodeURIComponent(email)}`),

  createWholeBook: (email: string, title: string, text: string) =>
    request<{ project_id: string; status: string }>('POST', '/api/app/projects', {
      email, title, source_mode: 'whole_book', text,
    }),

  createPerChapter: (
    email: string,
    title: string,
    chapters: ChapterUploadInput[],
    requestId = crypto.randomUUID(),
  ) =>
    request<{ project_id: string; status: string; chapters_total: number }>('POST', '/api/app/projects', {
      email, title, source_mode: 'per_chapter', chapters, request_id: requestId,
    }),

  getProject: (projectId: string, email: string) =>
    request<ProjectDetail>('GET', `/api/app/projects/${projectId}?email=${encodeURIComponent(email)}`),

  deleteProject: (projectId: string, email: string) =>
    request<{ deleted: boolean; project_id: string }>(
      'DELETE',
      `/api/app/projects/${projectId}?email=${encodeURIComponent(email)}`,
    ),

  getChapter: (projectId: string, chapterId: string, email: string) =>
    getCachedChapter(projectId, chapterId, email),

  prefetchChapter: (projectId: string, chapterId: string, email: string) => {
    void getCachedChapter(projectId, chapterId, email).catch(() => null);
  },

  getBookResult: (projectId: string, email: string, expectedRevision?: number) =>
    getCachedBookResult(projectId, email, expectedRevision),

  getUsage: (projectId: string, email: string) =>
    request<{ usage: Record<string, number | string>; recent_failures: Record<string, unknown>[] }>(
      'GET', `/api/app/projects/${projectId}/usage?email=${encodeURIComponent(email)}`,
    ),

  appendChapters: (
    projectId: string,
    email: string,
    requestId: string,
    chapters: ChapterUploadInput[],
  ) =>
    request<{
      batch_id: string;
      added: number;
      start_index: number;
      end_index: number;
      chapters_total: number;
      content_revision: number;
      idempotent: boolean;
      chapters: ChapterSummary[];
    }>('POST', `/api/app/projects/${projectId}/chapters`, {
      email, request_id: requestId, chapters,
    }),

  retryFailed: (projectId: string, email: string) =>
    request<{ requeued: number; message: string }>('POST', `/api/app/projects/${projectId}/retry`, { email }),

  processNext: () =>
    request<{ claimed: boolean; processed_count: number; processed: ProcessedTask[] }>(
      'POST', '/api/app/process-next', {},
    ),

  feedback: (payload: {
    email?: string; project_id?: string; chapter_id?: string;
    category?: string; comment?: string;
  }) => request<{ feedback_id: string; message: string }>('POST', '/api/app/feedback', payload),
};

// ------------------------------------------------------------------ 展示辅助
export const STATUS_LABEL: Record<string, string> = {
  pending: '排队中',
  chapterizing: '正在拆章',
  processing: '处理中',
  completed: '当前章节已完成',
  partially_failed: '部分失败',
  failed: '失败',
  aggregation_failed: '全书分析失败',
  running: '进行中',
  succeeded: '已完成',
};

export function isTerminal(status: string): boolean {
  return status === 'completed'
    || status === 'failed'
    || status === 'partially_failed'
    || status === 'aggregation_failed';
}

export function formatDuration(ms: number | null | undefined): string {
  if (!ms) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
