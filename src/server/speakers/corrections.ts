import type { AnyRecord } from '../tts/types';

export interface SpeakerAssignment {
  id: string;
  project_id: string;
  chapter_id: string;
  segment_id: string;
  segment_start: number | null;
  segment_end: number | null;
  segment_text: string;
  original_speaker: string;
  original_role_id: string;
  target_role_key: string;
  target_role_snapshot: AnyRecord;
  changed_by: string;
  created_at: string;
  updated_at: string;
}

export function projectRoleKey(role: AnyRecord): string {
  const roleId = String(role?.role_id ?? '').trim();
  if (roleId) return roleId;
  const name = String(role?.canonical_name ?? '').trim();
  return name ? `name:${name}` : '';
}

export function projectRoles(bookResult: AnyRecord | null | undefined): AnyRecord[] {
  const registry = bookResult?.role_registry;
  if (!Array.isArray(registry)) return [];
  return registry.filter((role) =>
    role
    && typeof role === 'object'
    && String(role.canonical_name ?? '').trim()
    && projectRoleKey(role));
}

export function findProjectRole(bookResult: AnyRecord | null | undefined, roleKey: string): AnyRecord | null {
  return projectRoles(bookResult).find((role) => projectRoleKey(role) === roleKey) ?? null;
}

export function findDialogueSegment(result: AnyRecord | null, segmentId: string): AnyRecord | null {
  if (!result || !Array.isArray(result.tts_segments)) return null;
  return result.tts_segments.find((segment: AnyRecord) =>
    segment?.type === 'dialogue' && String(segment.segment_id ?? '') === segmentId) ?? null;
}

/**
 * 将人工说话人修正叠加到只读 pipeline 结果上。
 *
 * pipeline 原始结果保持不变，人工修正单独存表。这样重跑分析不会抹掉修改日志，
 * 也不会让一次 UI 操作改写数百 KB 的章节 JSON。
 */
export function applySpeakerAssignments(
  result: AnyRecord | null,
  assignments: SpeakerAssignment[],
): AnyRecord | null {
  if (!result || !assignments.length) return result;

  const bySegmentId = new Map(assignments.map((assignment) => [assignment.segment_id, assignment]));
  const byCoordinates = new Map(
    assignments.map((assignment) => [assignmentCoordinateKey(assignment), assignment]),
  );
  const correctedSegments = (Array.isArray(result.tts_segments) ? result.tts_segments : [])
    .map((segment: AnyRecord) => applyToSegment(segment, bySegmentId, byCoordinates));

  const correctedChunks = (Array.isArray(result.chunks) ? result.chunks : []).map((chunk: AnyRecord) => ({
    ...chunk,
    final_grounded_dialogue_spans: (
      Array.isArray(chunk?.final_grounded_dialogue_spans)
        ? chunk.final_grounded_dialogue_spans
        : []
    ).map((span: AnyRecord) => applyToSpan(span, assignments)),
  }));

  return {
    ...result,
    tts_segments: correctedSegments,
    chunks: correctedChunks,
  };
}

export function correctedSegment(segment: AnyRecord, role: AnyRecord): AnyRecord {
  const originalSpeaker = String(segment.original_speaker ?? segment.speaker ?? 'unknown_speaker');
  const canonicalName = String(role.canonical_name ?? '').trim();
  return {
    ...segment,
    speaker: canonicalName,
    speaker_gender: role.voice_profile?.gender || role.gender || 'unknown',
    role_id: role.role_id ?? '',
    voice_profile_id: role.voice_profile_id ?? '',
    voice_profile: role.voice_profile ?? {},
    speaker_corrected: true,
    original_speaker: originalSpeaker,
  };
}

function applyToSegment(
  segment: AnyRecord,
  bySegmentId: Map<string, SpeakerAssignment>,
  byCoordinates: Map<string, SpeakerAssignment>,
): AnyRecord {
  if (segment?.type !== 'dialogue') return segment;
  const segmentId = String(segment.segment_id ?? '');
  let assignment = bySegmentId.get(segmentId);

  // segment_id 由顺序生成。重新聚合后顺序可能变化，因此必须核对坐标与文本；
  // 若 id 已变化，则允许用完全相同的坐标+文本恢复人工修正。
  if (assignment && !assignmentMatchesSegment(assignment, segment)) assignment = undefined;
  assignment ??= byCoordinates.get(segmentCoordinateKey(segment));
  if (!assignment) return segment;
  return correctedSegment(segment, assignment.target_role_snapshot);
}

function applyToSpan(span: AnyRecord, assignments: SpeakerAssignment[]): AnyRecord {
  const assignment = assignments.find((item) =>
    item.segment_start === nullableNumber(span?.start)
    && item.segment_end === nullableNumber(span?.end)
    && item.segment_text === String(span?.text ?? span?.dialogue_text ?? ''));
  if (!assignment) return span;
  const role = assignment.target_role_snapshot;
  return {
    ...span,
    canonical_speaker: role.canonical_name ?? '',
    role_id: role.role_id ?? '',
    voice_profile_id: role.voice_profile_id ?? '',
    voice_profile: role.voice_profile ?? {},
    speaker_corrected: true,
    original_speaker: span.original_speaker ?? span.canonical_speaker ?? span.speaker ?? '',
  };
}

function assignmentMatchesSegment(assignment: SpeakerAssignment, segment: AnyRecord): boolean {
  return assignmentCoordinateKey(assignment) === segmentCoordinateKey(segment);
}

function assignmentCoordinateKey(assignment: SpeakerAssignment): string {
  return [
    assignment.segment_start ?? '',
    assignment.segment_end ?? '',
    assignment.segment_text,
  ].join('\u0000');
}

function segmentCoordinateKey(segment: AnyRecord): string {
  return [
    nullableNumber(segment?.start) ?? '',
    nullableNumber(segment?.end) ?? '',
    String(segment?.text ?? ''),
  ].join('\u0000');
}

function nullableNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
