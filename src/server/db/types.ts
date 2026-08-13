import type { AnyRecord } from '../tts/types';

export type ProjectStatus =
  | 'pending'
  | 'chapterizing'
  | 'processing'
  | 'completed'
  | 'partially_failed'
  | 'failed'
  | 'aggregation_failed';

export type SourceMode = 'whole_book' | 'per_chapter';
export type ChapterStatus = 'pending' | 'running' | 'succeeded' | 'failed';
export type JobKind = 'chapterize' | 'chapter' | 'aggregate';
export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed';
export type AggregateStatus = 'clean' | 'dirty' | 'running' | 'failed';

export interface DemoUser {
  id: string;
  email: string;
  created_at: string;
  last_seen_at: string;
}

export interface Project {
  id: string;
  user_id: string;
  title: string;
  source_mode: SourceMode;
  status: ProjectStatus;
  chapters_total: number;
  chapters_done: number;
  chapters_failed: number;
  next_chapter_index: number;
  content_revision: number;
  aggregated_revision: number;
  aggregate_status: AggregateStatus;
  book_result: AnyRecord | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChapterRow {
  id: string;
  project_id: string;
  chapter_index: number;
  title: string;
  source_text: string;
  status: ChapterStatus;
  result: AnyRecord | null;
  digest: AnyRecord | null;
  enrichment: AnyRecord | null;
  enriched: boolean;
  created_revision: number;
  analysis_revision: number;
  enrichment_revision: number;
  skip_llm: boolean;
  upload_batch_id: string | null;
  client_file_name: string | null;
  source_encoding: string | null;
  source_hash: string | null;
  error: string | null;
  char_count: number;
  duration_ms: number | null;
  created_at: string;
  updated_at: string;
}

/** 章节列表用的轻量投影——不含 source_text / result / digest 这些大字段 */
export type ChapterSummary = Pick<
  ChapterRow,
  'id' | 'project_id' | 'chapter_index' | 'title' | 'status' | 'enriched'
  | 'created_revision' | 'analysis_revision' | 'enrichment_revision'
  | 'skip_llm' | 'error' | 'char_count' | 'duration_ms'
>;

export const CHAPTER_SUMMARY_COLUMNS =
  'id, project_id, chapter_index, title, status, enriched, created_revision, analysis_revision, enrichment_revision, skip_llm, error, char_count, duration_ms';

export interface Job {
  id: string;
  project_id: string;
  chapter_id: string | null;
  kind: JobKind;
  status: JobStatus;
  attempts: number;
  max_attempts: number;
  lease_expires_at: string | null;
  run_after: string;
  error: string | null;
  target_revision: number | null;
  created_at: string;
  updated_at: string;
}

export interface FinishChapterResult {
  project_id: string;
  chapters_total: number;
  chapters_done: number;
  chapters_failed: number;
  all_chapters_done: boolean;
  aggregate_created: boolean;
  content_revision: number;
  project_status: string;
}
