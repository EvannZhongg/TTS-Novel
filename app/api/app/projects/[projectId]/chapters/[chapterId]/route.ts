import { handleRoute, notFound, requireOwnedProject, searchEmail } from '@/src/server/api/helpers';
import { getAdjacentChapters, getChapter, mergeChapterResult } from '@/src/server/db/chapters';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 单章结果(完整版, 含 chunks 与 spans) */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ projectId: string; chapterId: string }> },
) {
  return handleRoute(async () => {
    const { projectId, chapterId } = await params;
    await requireOwnedProject(projectId, searchEmail(request));
    const chapter = await getChapter(chapterId);
    if (!chapter || chapter.project_id !== projectId) throw notFound('章节不存在');
    const navigation = await getAdjacentChapters(projectId, chapter.chapter_index);

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
        result: mergeChapterResult(chapter.result, chapter.enrichment),
      },
      navigation,
    };
  });
}
