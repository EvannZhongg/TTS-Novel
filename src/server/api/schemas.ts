import { z } from 'zod';

/** 内部 API 的请求校验。邮箱即凭据(未经验证), 见 docs/security-model.md。 */

export const sessionSchema = z.object({
  email: z.string().min(3).max(254),
});

/**
 * 逐章上传的单章输入。
 *
 * title 纯粹是可选的展示标签 —— 逐章模式**不做任何标题拆分/识别/校验**:
 * 不从 text 里解析标题, 也不跑 LLM 标题校验(那只属于整本拆章)。
 * 用户不给 title 时自动编号为「第N章」, 仅用于列表展示。
 * text 就是完整章节正文, 原样交给 pipeline。
 */
export const chapterInputSchema = z.object({
  title: z.string().max(200).optional(),
  text: z.string().min(1).refine((value) => value.trim().length > 0, '章节正文不能为空'),
  client_file_name: z.string().max(500).optional(),
  source_encoding: z.string().max(80).optional(),
});

export const createProjectSchema = z
  .object({
    email: z.string().min(3).max(254),
    title: z.string().min(1).max(200),
    source_mode: z.enum(['whole_book', 'per_chapter']),
    /** whole_book: 整本原文, 后台任务负责拆章 */
    text: z.string().min(1).optional(),
    /** per_chapter: 直接给定章节 */
    chapters: z.array(chapterInputSchema).min(1).optional(),
    /** 客户端重试时复用；旧调用方不传则由服务端生成 */
    request_id: z.string().uuid().optional(),
  })
  .refine(
    (value) => (value.source_mode === 'whole_book' ? Boolean(value.text) : Boolean(value.chapters?.length)),
    { message: 'whole_book 需要 text; per_chapter 需要 chapters' },
  );

export const appendChaptersSchema = z.object({
  email: z.string().min(3).max(254),
  request_id: z.string().uuid(),
  chapters: z.array(chapterInputSchema).min(1),
});

export const feedbackSchema = z.object({
  email: z.string().min(3).max(254).optional(),
  project_id: z.string().uuid().optional(),
  chapter_id: z.string().uuid().optional(),
  category: z.string().max(60).optional(),
  comment: z.string().max(4000).optional(),
});

export const processNextSchema = z.object({
  /** 一次请求最多连续处理几个任务; 默认取 settings.queue.maxTasksPerRequest */
  max_tasks: z.number().int().min(1).max(10).optional(),
});
