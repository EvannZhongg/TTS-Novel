-- 反馈不再收集简单星级，只保留主要问题与补充说明。
alter table public.feedback
  drop column if exists rating;
