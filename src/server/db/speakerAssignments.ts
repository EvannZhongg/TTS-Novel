import { db } from './client';
import type { AnyRecord } from '../tts/types';
import type { SpeakerAssignment } from '../speakers/corrections';

export async function listSpeakerAssignments(chapterId: string): Promise<SpeakerAssignment[]> {
  const result = await db()
    .from('speaker_assignments')
    .select('*')
    .eq('chapter_id', chapterId)
    .order('created_at', { ascending: true });
  if (result.error) throw new Error(`[db:listSpeakerAssignments] ${result.error.message}`);
  return (result.data ?? []) as SpeakerAssignment[];
}

/**
 * 数据库函数会锁住章节行，在同一事务里更新当前指派并追加一条不可变日志。
 * 目标人物也在数据库内再次从 projects.book_result.role_registry 校验。
 */
export async function setSpeakerAssignment(input: {
  projectId: string;
  chapterId: string;
  segmentId: string;
  segmentStart: number | null;
  segmentEnd: number | null;
  segmentText: string;
  originalSpeaker: string;
  originalRoleId: string;
  targetRoleKey: string;
  changedBy: string;
}): Promise<{ changed: boolean; assignment: SpeakerAssignment; log_id: number | null }> {
  const result = await db().rpc('set_speaker_assignment', {
    p_project_id: input.projectId,
    p_chapter_id: input.chapterId,
    p_segment_id: input.segmentId,
    p_segment_start: input.segmentStart,
    p_segment_end: input.segmentEnd,
    p_segment_text: input.segmentText,
    p_original_speaker: input.originalSpeaker,
    p_original_role_id: input.originalRoleId,
    p_target_role_key: input.targetRoleKey,
    p_changed_by: input.changedBy,
  });
  if (result.error) throw new Error(`[db:setSpeakerAssignment] ${result.error.message}`);
  return result.data as {
    changed: boolean;
    assignment: SpeakerAssignment;
    log_id: number | null;
  };
}

export function assignmentRole(assignment: SpeakerAssignment): AnyRecord {
  return assignment.target_role_snapshot ?? {};
}
