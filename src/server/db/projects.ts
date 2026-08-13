import { db, unwrap } from './client';
import type { AnyRecord } from '../tts/types';
import type { Project, ProjectStatus, SourceMode } from './types';
import type { ChapterBatchInput, ChapterBatchResult } from './chapters';

/**
 * 项目读写。
 *
 * 小说原文存在 project_sources 表(而非 projects 表)，这样列项目列表时不会把
 * 几 MB 的全文一起拖出来。将来若要换 Supabase Storage，只需改动本文件的
 * saveProjectSource / getProjectSource 两个函数。
 *
 * projects.book_result 只存全书级聚合(aliases / role_registry / summary)，
 * 绝不含完整 chapters——实测 400 章长篇的完整章节数据约 87MB，
 * 存成单个 jsonb 会让查询无法接受。见 docs/phase0-measurements.md。
 */

// 列项目时排除 book_result(可能几百 KB)
const PROJECT_LIST_COLUMNS =
  'id, user_id, title, source_mode, status, chapters_total, chapters_done, chapters_failed, next_chapter_index, content_revision, aggregated_revision, aggregate_status, error, created_at, updated_at';

export type ProjectListItem = Omit<Project, 'book_result'>;

export async function createProject(input: {
  userId: string;
  title: string;
  sourceMode: SourceMode;
  status?: ProjectStatus;
}): Promise<Project> {
  const result = await db()
    .from('projects')
    .insert({
      user_id: input.userId,
      title: input.title,
      source_mode: input.sourceMode,
      status: input.status ?? 'pending',
    })
    .select('*')
    .single();
  return unwrap(result, 'createProject') as Project;
}

/** 逐章项目 + 首批章节在一个数据库事务中创建，并由 requestId 保证幂等。 */
export async function createPerChapterProject(input: {
  userId: string;
  title: string;
  requestId: string;
  chapters: ChapterBatchInput[];
  maxAttempts: number;
}): Promise<ChapterBatchResult & {
  project_id: string;
  source_mode: 'per_chapter';
  status: ProjectStatus;
}> {
  const result = await db().rpc('create_per_chapter_project', {
    p_user_id: input.userId,
    p_title: input.title,
    p_request_id: input.requestId,
    p_chapters: input.chapters,
    p_max_attempts: input.maxAttempts,
  });
  if (result.error) throw new Error(`[db:createPerChapterProject] ${result.error.message}`);
  return result.data as ChapterBatchResult & {
    project_id: string;
    source_mode: 'per_chapter';
    status: ProjectStatus;
  };
}

export async function listProjectsByUser(userId: string, limit = 50): Promise<ProjectListItem[]> {
  const result = await db()
    .from('projects')
    .select(PROJECT_LIST_COLUMNS)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (result.error) throw new Error(`[db:listProjectsByUser] ${result.error.message}`);
  return (result.data ?? []) as unknown as ProjectListItem[];
}

export async function getProject(projectId: string): Promise<Project | null> {
  const result = await db().from('projects').select('*').eq('id', projectId).maybeSingle();
  if (result.error) throw new Error(`[db:getProject] ${result.error.message}`);
  return (result.data as Project | null) ?? null;
}

/** 不含 book_result 的元数据读取，用于进度轮询这类高频调用。 */
export async function getProjectMeta(projectId: string): Promise<ProjectListItem | null> {
  const result = await db().from('projects').select(PROJECT_LIST_COLUMNS).eq('id', projectId).maybeSingle();
  if (result.error) throw new Error(`[db:getProjectMeta] ${result.error.message}`);
  return (result.data as unknown as ProjectListItem | null) ?? null;
}

export async function updateProject(
  projectId: string,
  patch: Partial<Pick<
    Project,
    | 'status' | 'chapters_total' | 'next_chapter_index'
    | 'content_revision' | 'aggregated_revision' | 'aggregate_status'
    | 'error' | 'title' | 'book_result'
  >>,
): Promise<void> {
  const result = await db().from('projects').update(patch).eq('id', projectId);
  if (result.error) throw new Error(`[db:updateProject] ${result.error.message}`);
}

/**
 * 删除项目根记录。数据库外键负责级联删除原文、章节、任务、日志、
 * LLM 调用记录与反馈，避免应用层漏删任一关联表。
 */
export async function deleteProject(projectId: string): Promise<void> {
  const result = await db().from('projects').delete().eq('id', projectId);
  if (result.error) throw new Error(`[db:deleteProject] ${result.error.message}`);
}

// ------------------------------------------------------------------ 原文存取
export async function saveProjectSource(projectId: string, rawText: string): Promise<void> {
  const result = await db()
    .from('project_sources')
    .upsert({ project_id: projectId, raw_text: rawText, char_count: rawText.length }, { onConflict: 'project_id' });
  if (result.error) throw new Error(`[db:saveProjectSource] ${result.error.message}`);
}

export async function getProjectSource(projectId: string): Promise<string | null> {
  const result = await db().from('project_sources').select('raw_text').eq('project_id', projectId).maybeSingle();
  if (result.error) throw new Error(`[db:getProjectSource] ${result.error.message}`);
  return (result.data?.raw_text as string | undefined) ?? null;
}

/** 全书聚合结果。只存摘要级内容，完整章节请从 chapters.result 单独取。 */
export async function saveBookResult(projectId: string, bookResult: AnyRecord): Promise<void> {
  await updateProject(projectId, { book_result: bookResult });
}
