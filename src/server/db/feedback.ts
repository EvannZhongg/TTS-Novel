import { db, unwrap } from './client';

export interface FeedbackInput {
  userId?: string | null;
  projectId?: string | null;
  chapterId?: string | null;
  category?: string | null;
  comment?: string | null;
}

export async function createFeedback(input: FeedbackInput): Promise<{ id: string }> {
  const result = await db()
    .from('feedback')
    .insert({
      user_id: input.userId ?? null,
      project_id: input.projectId ?? null,
      chapter_id: input.chapterId ?? null,
      category: input.category ?? null,
      comment: input.comment ?? null,
    })
    .select('id')
    .single();
  return unwrap(result, 'createFeedback') as { id: string };
}
