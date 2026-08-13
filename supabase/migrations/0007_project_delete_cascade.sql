-- 删除项目时，反馈也属于项目内容，应与原文、章节、任务和日志一并清理。
-- 其余项目关联表在早期迁移中已经使用 on delete cascade。

alter table public.feedback
  drop constraint if exists feedback_project_id_fkey,
  drop constraint if exists feedback_chapter_id_fkey;

alter table public.feedback
  add constraint feedback_project_id_fkey
    foreign key (project_id) references public.projects(id) on delete cascade,
  add constraint feedback_chapter_id_fkey
    foreign key (chapter_id) references public.chapters(id) on delete cascade;
