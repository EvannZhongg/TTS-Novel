-- 多播电子书测试系统 Phase 1: 核心 schema
-- 设计依据见 docs/phase0-measurements.md
--
-- 关键取舍:
--   1. 大文本单独成表 (project_sources.raw_text / chapters.source_text),
--      避免 select * from projects 把整本小说拖出来。
--   2. chapters 同时存两份结果: result(完整, 给结果页) + digest(精简, 给聚合)。
--      实测 digest 只有完整版的 20%; 400 章长篇聚合需读 17MB 而非 87MB。
--   3. projects.book_result 只存全书级摘要(aliases/role_registry/summary),
--      绝不含完整 chapters —— 否则会变成几十到几百 MB 的 jsonb。
--   4. RLS 全表开启且不建任何 policy => anon/publishable key 一律拒绝;
--      服务端用 secret key (service_role) 绕过 RLS。

-- ---------------------------------------------------------------- demo_users
-- 不使用 Supabase Auth。邮箱即凭据(未经验证), 见前端提示文案。
create table if not exists public.demo_users (
  id           uuid primary key default gen_random_uuid(),
  email        text not null,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

-- 邮箱大小写不敏感唯一。用函数索引而非 citext, 少一个扩展依赖。
create unique index if not exists demo_users_email_lower_key
  on public.demo_users (lower(email));

-- ------------------------------------------------------------------ projects
create table if not exists public.projects (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.demo_users(id) on delete cascade,
  title           text not null,
  source_mode     text not null check (source_mode in ('whole_book', 'per_chapter')),
  status          text not null default 'pending'
                    check (status in ('pending','chapterizing','processing',
                                      'completed','partially_failed','failed')),
  chapters_total  integer not null default 0,
  chapters_done   integer not null default 0,
  chapters_failed integer not null default 0,
  book_result     jsonb,          -- 仅全书级聚合, 不含 chapters
  error           text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index if not exists projects_user_created_idx
  on public.projects (user_id, created_at desc);

-- 小说原文单独一表: 几 MB 的 text 靠 TOAST 存储, 不拖慢 projects 查询。
create table if not exists public.project_sources (
  project_id uuid primary key references public.projects(id) on delete cascade,
  raw_text   text not null,
  char_count integer not null default 0,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------------ chapters
create table if not exists public.chapters (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  chapter_index integer not null,          -- 1-based, 对应 pipeline 的 chapter_id
  title         text not null default '',
  source_text   text not null,
  status        text not null default 'pending'
                  check (status in ('pending','running','succeeded','failed')),
  result        jsonb,                     -- 完整单章结果 (~200KB), 给用户结果页
  digest        jsonb,                     -- 精简版 (~20%), 只给聚合任务读
  enriched      boolean not null default false,  -- 聚合是否已回写 role_id/voice_profile
  skip_llm      boolean not null default false,  -- 前言等旁白章节
  error         text,
  char_count    integer not null default 0,
  duration_ms   integer,                   -- 单章耗时, 用于发现超时风险章节
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (project_id, chapter_index)
);

create index if not exists chapters_project_idx
  on public.chapters (project_id, chapter_index);

-- 供项目页快速统计各状态章节数
create index if not exists chapters_project_status_idx
  on public.chapters (project_id, status);

-- ---------------------------------------------------------------------- jobs
create table if not exists public.jobs (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects(id) on delete cascade,
  chapter_id       uuid references public.chapters(id) on delete cascade,
  kind             text not null check (kind in ('chapterize','chapter','aggregate')),
  status           text not null default 'pending'
                     check (status in ('pending','running','succeeded','failed')),
  attempts         integer not null default 0,
  max_attempts     integer not null default 3,
  lease_expires_at timestamptz,             -- 过期即可被重新领取(防实例猝死卡死队列)
  run_after        timestamptz not null default now(),  -- 指数退避
  error            text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  -- chapter 任务必须带 chapter_id; chapterize/aggregate 必须不带
  constraint jobs_chapter_id_matches_kind check (
    (kind = 'chapter' and chapter_id is not null) or
    (kind <> 'chapter' and chapter_id is null)
  )
);

-- 领取队列的主索引: 只索引 pending 行, 表随时间增长也不退化
create index if not exists jobs_claimable_idx
  on public.jobs (run_after, created_at)
  where status = 'pending';

create index if not exists jobs_project_idx on public.jobs (project_id);

-- 租约回收扫描
create index if not exists jobs_running_lease_idx
  on public.jobs (lease_expires_at)
  where status = 'running';

-- 防重复投递(第二道防线, 第一道是 finish_chapter_job 里的行锁):
-- 同一 project 同时只能有一个未完成的 chapterize / aggregate,
-- 同一 chapter 同时只能有一个未完成的 chapter 任务。
create unique index if not exists jobs_one_active_chapterize_idx
  on public.jobs (project_id) where kind = 'chapterize' and status in ('pending','running');

create unique index if not exists jobs_one_active_aggregate_idx
  on public.jobs (project_id) where kind = 'aggregate' and status in ('pending','running');

create unique index if not exists jobs_one_active_chapter_idx
  on public.jobs (chapter_id) where kind = 'chapter' and status in ('pending','running');

-- ---------------------------------------------------------------- job_events
-- 承接现有 runner.emitProgress 的事件流(原本写 events.jsonl)
create table if not exists public.job_events (
  id         bigserial primary key,
  job_id     uuid references public.jobs(id) on delete cascade,
  project_id uuid references public.projects(id) on delete cascade,
  chapter_id uuid references public.chapters(id) on delete set null,
  stage      text,
  message    text,
  payload    jsonb,
  created_at timestamptz not null default now()
);

create index if not exists job_events_project_idx
  on public.job_events (project_id, id desc);

create index if not exists job_events_job_idx on public.job_events (job_id, id);

-- ------------------------------------------------------------------ feedback
create table if not exists public.feedback (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references public.demo_users(id) on delete set null,
  project_id uuid references public.projects(id) on delete cascade,
  chapter_id uuid references public.chapters(id) on delete cascade,
  category   text,
  comment    text,
  created_at timestamptz not null default now()
);

create index if not exists feedback_created_idx on public.feedback (created_at desc);
create index if not exists feedback_project_idx on public.feedback (project_id);

-- ---------------------------------------------------------------- updated_at
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists projects_touch on public.projects;
create trigger projects_touch before update on public.projects
  for each row execute function public.touch_updated_at();

drop trigger if exists chapters_touch on public.chapters;
create trigger chapters_touch before update on public.chapters
  for each row execute function public.touch_updated_at();

drop trigger if exists jobs_touch on public.jobs;
create trigger jobs_touch before update on public.jobs
  for each row execute function public.touch_updated_at();

-- ----------------------------------------------------------------------- RLS
-- 全部开启, 且故意不建任何 policy => anon / publishable key 读写一律被拒。
-- 服务端一律用 SUPABASE_SECRET_KEY (service_role), 它绕过 RLS。
alter table public.demo_users      enable row level security;
alter table public.projects        enable row level security;
alter table public.project_sources enable row level security;
alter table public.chapters        enable row level security;
alter table public.jobs            enable row level security;
alter table public.job_events      enable row level security;
alter table public.feedback        enable row level security;

-- 注意: 这里刻意不写
--     revoke all on all tables in schema public from anon, authenticated;
-- 那条语句会连带把 service_role 的 SELECT/INSERT/UPDATE/DELETE 一起收掉,
-- 导致服务端(secret key)也读不了任何表 —— 已实际踩过, 见 0003。
-- 拦 anon 只需要上面的 RLS: 表开了 RLS 且无 policy, anon 一行都读不到。
-- service_role 的权限由 0003 显式授予。
