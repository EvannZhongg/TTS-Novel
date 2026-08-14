import {
  badRequest,
  handleRoute,
  notFound,
  requireOwnedProject,
  searchEmail,
} from '@/src/server/api/helpers';
import { speakerAssignmentSchema } from '@/src/server/api/schemas';
import { getAdjacentChapters, getChapter, mergeChapterResult } from '@/src/server/db/chapters';
import { listSpeakerAssignments, setSpeakerAssignment } from '@/src/server/db/speakerAssignments';
import {
  applySpeakerAssignments,
  findDialogueSegment,
  findProjectRole,
  projectRoles,
} from '@/src/server/speakers/corrections';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 单章结果(完整版, 含 chunks 与 spans) */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string; chapterId: string }> },
) {
  return handleRoute(async () => {
    const { projectId, chapterId } = await params;
    const { project } = await requireOwnedProject(projectId, searchEmail(request));
    const chapter = await getChapter(chapterId);
    if (!chapter || chapter.project_id !== projectId) throw notFound('章节不存在');
    const [navigation, assignments] = await Promise.all([
      getAdjacentChapters(projectId, chapter.chapter_index),
      listSpeakerAssignments(chapterId),
    ]);
    const mergedResult = mergeChapterResult(chapter.result, chapter.enrichment);
    const currentAssignments = currentProjectAssignments(project.book_result, assignments);

    return {
      chapter: {
        id: chapter.id,
        chapter_index: chapter.chapter_index,
        title: chapter.title,
        status: chapter.status,
        enriched: chapter.enriched,
        enrichment_revision: chapter.enrichment_revision,
        analysis_revision: chapter.analysis_revision,
        skip_llm: chapter.skip_llm,
        error: chapter.error,
        char_count: chapter.char_count,
        duration_ms: chapter.duration_ms,
        source_text: chapter.source_text,
        result: applySpeakerAssignments(mergedResult, currentAssignments),
      },
      navigation,
      roles: projectRoles(project.book_result),
    };
  });
}

/** 修改某一句对白的说话人；目标人物只能来自当前项目的 role_registry。 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ projectId: string; chapterId: string }> },
) {
  return handleRoute(async () => {
    const { projectId, chapterId } = await params;
    const body = speakerAssignmentSchema.parse(await request.json());
    const { project, user } = await requireOwnedProject(projectId, body.email);
    const chapter = await getChapter(chapterId);
    if (!chapter || chapter.project_id !== projectId) throw notFound('章节不存在');

    const role = findProjectRole(project.book_result, body.target_role_key);
    if (!role) throw badRequest('目标说话人不属于当前小说的人物列表');

    const mergedResult = mergeChapterResult(chapter.result, chapter.enrichment);
    const segment = findDialogueSegment(mergedResult, body.segment_id);
    if (!segment) throw notFound('对白不存在，可能章节结果已更新，请刷新后重试');

    const saved = await setSpeakerAssignment({
      projectId,
      chapterId,
      segmentId: body.segment_id,
      segmentStart: finiteNumberOrNull(segment.start),
      segmentEnd: finiteNumberOrNull(segment.end),
      segmentText: String(segment.text ?? ''),
      originalSpeaker: String(segment.original_speaker ?? segment.speaker ?? 'unknown_speaker'),
      originalRoleId: String(segment.role_id ?? ''),
      targetRoleKey: body.target_role_key,
      changedBy: user.id,
    });

    const assignments = currentProjectAssignments(
      project.book_result,
      await listSpeakerAssignments(chapterId),
    );
    return {
      changed: saved.changed,
      log_id: saved.log_id,
      chapter: {
        id: chapter.id,
        result: applySpeakerAssignments(mergedResult, assignments),
      },
    };
  });
}

function finiteNumberOrNull(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function currentProjectAssignments(
  bookResult: Record<string, unknown> | null,
  assignments: Awaited<ReturnType<typeof listSpeakerAssignments>>,
) {
  return assignments.flatMap((assignment) => {
    const currentRole = findProjectRole(bookResult, assignment.target_role_key);
    return currentRole ? [{ ...assignment, target_role_snapshot: currentRole }] : [];
  });
}
