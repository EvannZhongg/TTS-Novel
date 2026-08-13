-- 持续追加章节 / 连载项目。
--
-- 核心约束:
--   1. 追加批次在数据库事务内完成: 分配序号、插章、递增总数、创建任务不可分割。
--   2. request_id 保证上传重放幂等；source_hash 防止同一章节被重复追加。
--   3. content_revision / aggregated_revision 为全书聚合增加版本栅栏，旧聚合不得
--      覆盖新正文版本。
--   4. 单章完整 result 保持不可变；聚合产物单独写 enrichment。

-- ---------------------------------------------------------------- projects
alter table public.projects
  add column if not exists next_chapter_index integer not null default 1,
  add column if not exists content_revision bigint not null default 0,
  add column if not exists aggregated_revision bigint not null default 0,
  add column if not exists aggregate_status text not null default 'clean';

alter table public.projects
  drop constraint if exists projects_status_check;
alter table public.projects
  add constraint projects_status_check check (
    status in (
      'pending', 'chapterizing', 'processing', 'completed',
      'partially_failed', 'failed', 'aggregation_failed'
    )
  );

alter table public.projects
  add constraint projects_aggregate_status_check check (
    aggregate_status in ('clean', 'dirty', 'running', 'failed')
  );

-- ---------------------------------------------------------------- upload batches
create table if not exists public.chapter_upload_batches (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects(id) on delete cascade,
  request_id       uuid not null,
  status           text not null default 'committed'
                     check (status in ('committed')),
  start_index      integer not null,
  end_index        integer not null,
  chapter_count    integer not null check (chapter_count > 0),
  content_revision bigint not null,
  created_at       timestamptz not null default now(),
  unique (project_id, request_id)
);

create index if not exists chapter_upload_batches_project_idx
  on public.chapter_upload_batches (project_id, created_at desc);

alter table public.chapter_upload_batches enable row level security;
grant select, insert, update, delete on public.chapter_upload_batches to service_role;

-- ---------------------------------------------------------------- chapters
alter table public.chapters
  add column if not exists upload_batch_id uuid references public.chapter_upload_batches(id) on delete set null,
  add column if not exists client_file_name text,
  add column if not exists source_encoding text,
  add column if not exists source_hash text,
  add column if not exists created_revision bigint not null default 1,
  add column if not exists analysis_revision bigint not null default 0,
  add column if not exists enrichment jsonb,
  add column if not exists enrichment_revision bigint not null default 0;

create unique index if not exists chapters_project_source_hash_key
  on public.chapters (project_id, source_hash)
  where source_hash is not null and upload_batch_id is not null;

create index if not exists chapters_project_revision_idx
  on public.chapters (project_id, created_revision, chapter_index);

-- ---------------------------------------------------------------- jobs
alter table public.jobs
  add column if not exists target_revision bigint;

-- 兼容迁移执行时库里残留的测试任务；新任务都会显式写入 revision。
update public.jobs j
   set target_revision = greatest(p.content_revision, 1)
  from public.projects p
 where p.id = j.project_id
   and j.kind in ('chapter', 'aggregate')
   and j.target_revision is null;

alter table public.jobs
  drop constraint if exists jobs_chapter_id_matches_kind;
alter table public.jobs
  add constraint jobs_payload_matches_kind check (
    (kind = 'chapterize' and chapter_id is null and target_revision is null) or
    (kind = 'chapter' and chapter_id is not null and target_revision is not null) or
    (kind = 'aggregate' and chapter_id is null and target_revision is not null)
  );

-- ----------------------------------------------------- helpers: JSON response
create or replace function public.chapter_batch_response(
  p_batch_id uuid,
  p_idempotent boolean default false
)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'batch_id', b.id,
    'request_id', b.request_id,
    'added', b.chapter_count,
    'start_index', b.start_index,
    'end_index', b.end_index,
    'content_revision', b.content_revision,
    'idempotent', p_idempotent,
    'chapters_total', p.chapters_total,
    'chapters', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'id', c.id,
          'project_id', c.project_id,
          'chapter_index', c.chapter_index,
          'title', c.title,
          'status', c.status,
          'enriched', c.enriched,
          'skip_llm', c.skip_llm,
          'error', c.error,
          'char_count', c.char_count,
          'duration_ms', c.duration_ms,
          'created_revision', c.created_revision,
          'analysis_revision', c.analysis_revision,
          'enrichment_revision', c.enrichment_revision
        )
        order by c.chapter_index
      )
      from public.chapters c
      where c.upload_batch_id = b.id
    ), '[]'::jsonb)
  )
  from public.chapter_upload_batches b
  join public.projects p on p.id = b.project_id
  where b.id = p_batch_id;
$$;

-- ---------------------------------------------------- append chapter batch
create or replace function public.append_chapter_batch(
  p_project_id uuid,
  p_request_id uuid,
  p_chapters jsonb,
  p_max_attempts integer default 3
)
returns jsonb
language plpgsql
as $$
declare
  v_project public.projects;
  v_existing_batch_id uuid;
  v_batch_id uuid;
  v_count integer;
  v_start integer;
  v_end integer;
  v_revision bigint;
  v_duplicate_title text;
begin
  if jsonb_typeof(p_chapters) <> 'array' or jsonb_array_length(p_chapters) = 0 then
    raise exception using errcode = '22023', message = 'chapters must be a non-empty array';
  end if;

  select id into v_existing_batch_id
    from public.chapter_upload_batches
   where project_id = p_project_id and request_id = p_request_id;
  if v_existing_batch_id is not null then
    return public.chapter_batch_response(v_existing_batch_id, true);
  end if;

  select * into v_project
    from public.projects
   where id = p_project_id
   for update;
  if v_project.id is null then
    raise exception using errcode = 'P0002', message = 'project not found';
  end if;
  if v_project.source_mode <> 'per_chapter' then
    raise exception using errcode = '22023', message = 'only per_chapter projects accept appended chapters';
  end if;

  -- 锁项目后再查一次幂等键，处理两个相同 request_id 并发进入的情况。
  select id into v_existing_batch_id
    from public.chapter_upload_batches
   where project_id = p_project_id and request_id = p_request_id;
  if v_existing_batch_id is not null then
    return public.chapter_batch_response(v_existing_batch_id, true);
  end if;

  select count(*)::integer into v_count
    from jsonb_array_elements(p_chapters);

  if exists (
    select 1
      from jsonb_array_elements(p_chapters) item
     where nullif(btrim(item->>'text'), '') is null
        or nullif(btrim(item->>'source_hash'), '') is null
  ) then
    raise exception using errcode = '22023', message = 'every chapter requires text and source_hash';
  end if;

  select min(coalesce(nullif(btrim(item->>'title'), ''), '未命名章节'))
    into v_duplicate_title
    from jsonb_array_elements(p_chapters) item
   group by item->>'source_hash'
  having count(*) > 1
   limit 1;
  if v_duplicate_title is not null then
    raise exception using errcode = '23505',
      message = format('duplicate chapter in upload batch: %s', v_duplicate_title);
  end if;

  select coalesce(nullif(btrim(item->>'title'), ''), c.title)
    into v_duplicate_title
    from jsonb_array_elements(p_chapters) item
    join public.chapters c
      on c.project_id = p_project_id
     and c.source_hash = item->>'source_hash'
   limit 1;
  if v_duplicate_title is not null then
    raise exception using errcode = '23505',
      message = format('chapter already exists: %s', v_duplicate_title);
  end if;

  v_start := v_project.next_chapter_index;
  v_end := v_start + v_count - 1;
  v_revision := v_project.content_revision + 1;

  insert into public.chapter_upload_batches (
    project_id, request_id, start_index, end_index, chapter_count, content_revision
  ) values (
    p_project_id, p_request_id, v_start, v_end, v_count, v_revision
  )
  returning id into v_batch_id;

  insert into public.chapters (
    project_id, chapter_index, title, source_text, char_count,
    upload_batch_id, client_file_name, source_encoding, source_hash,
    created_revision
  )
  select
    p_project_id,
    v_start + item.ordinality::integer - 1,
    coalesce(
      nullif(btrim(item.value->>'title'), ''),
      format('第%s章', v_start + item.ordinality::integer - 1)
    ),
    item.value->>'text',
    char_length(item.value->>'text'),
    v_batch_id,
    nullif(btrim(item.value->>'client_file_name'), ''),
    nullif(btrim(item.value->>'source_encoding'), ''),
    item.value->>'source_hash',
    v_revision
  from jsonb_array_elements(p_chapters) with ordinality as item(value, ordinality);

  insert into public.jobs (
    project_id, chapter_id, kind, status, max_attempts, target_revision
  )
  select
    p_project_id, c.id, 'chapter', 'pending', greatest(p_max_attempts, 1), v_revision
  from public.chapters c
  where c.upload_batch_id = v_batch_id;

  update public.projects
     set chapters_total = chapters_total + v_count,
         next_chapter_index = v_end + 1,
         content_revision = v_revision,
         aggregate_status = 'dirty',
         status = 'processing',
         error = null
   where id = p_project_id;

  return public.chapter_batch_response(v_batch_id, false);
end;
$$;

-- ------------------------------------------- commit whole-book chapterization
create or replace function public.commit_chapterize_result(
  p_project_id uuid,
  p_chapters jsonb,
  p_max_attempts integer default 3
)
returns jsonb
language plpgsql
as $$
declare
  v_project public.projects;
  v_count integer;
  v_revision bigint;
begin
  if jsonb_typeof(p_chapters) <> 'array' or jsonb_array_length(p_chapters) = 0 then
    raise exception using errcode = '22023', message = 'chapterize result must be a non-empty array';
  end if;

  select * into v_project
    from public.projects
   where id = p_project_id
   for update;
  if v_project.id is null then
    raise exception using errcode = 'P0002', message = 'project not found';
  end if;
  if v_project.source_mode <> 'whole_book' then
    raise exception using errcode = '22023', message = 'project is not whole_book';
  end if;
  if exists (select 1 from public.chapters where project_id = p_project_id) then
    raise exception using errcode = '23505', message = 'chapterize result already committed';
  end if;

  v_count := jsonb_array_length(p_chapters);
  v_revision := v_project.content_revision + 1;

  insert into public.chapters (
    project_id, chapter_index, title, source_text, skip_llm, char_count,
    source_hash, created_revision
  )
  select
    p_project_id,
    item.ordinality::integer,
    coalesce(nullif(btrim(item.value->>'title'), ''), format('第%s章', item.ordinality)),
    item.value->>'text',
    coalesce((item.value->>'skip_llm')::boolean, false),
    char_length(item.value->>'text'),
    nullif(item.value->>'source_hash', ''),
    v_revision
  from jsonb_array_elements(p_chapters) with ordinality as item(value, ordinality);

  insert into public.jobs (
    project_id, chapter_id, kind, status, max_attempts, target_revision
  )
  select
    p_project_id, c.id, 'chapter', 'pending', greatest(p_max_attempts, 1), v_revision
  from public.chapters c
  where c.project_id = p_project_id;

  update public.projects
     set status = 'processing',
         chapters_total = v_count,
         next_chapter_index = v_count + 1,
         content_revision = v_revision,
         aggregate_status = 'dirty',
         error = null
   where id = p_project_id;

  return jsonb_build_object(
    'chapter_count', v_count,
    'content_revision', v_revision
  );
end;
$$;

-- --------------------------------------------------------- chapter completion
create or replace function public.finish_chapter_job(
  p_job_id     uuid,
  p_chapter_id uuid,
  p_success    boolean,
  p_error      text default null
)
returns jsonb
language plpgsql
as $$
declare
  v_project_id uuid;
  v_total integer;
  v_done integer;
  v_failed integer;
  v_revision bigint;
  v_already_counted boolean;
  v_aggregate_created boolean := false;
  v_project_status text;
  v_rows integer := 0;
begin
  select project_id into v_project_id
    from public.chapters where id = p_chapter_id;
  if v_project_id is null then
    raise exception 'chapter % not found', p_chapter_id;
  end if;

  select chapters_total, chapters_done, chapters_failed, content_revision
    into v_total, v_done, v_failed, v_revision
    from public.projects
   where id = v_project_id
   for update;

  select status in ('succeeded', 'failed') into v_already_counted
    from public.chapters where id = p_chapter_id;

  update public.chapters
     set status = case when p_success then 'succeeded' else 'failed' end,
         error = p_error
   where id = p_chapter_id;

  update public.jobs
     set status = case when p_success then 'succeeded' else 'failed' end,
         error = p_error,
         lease_expires_at = null
   where id = p_job_id;

  if not v_already_counted then
    if p_success then v_done := v_done + 1;
    else v_failed := v_failed + 1;
    end if;
  end if;

  if v_total > 0 and (v_done + v_failed) >= v_total then
    if v_done = 0 then
      v_project_status := 'failed';
      update public.projects
         set chapters_done = v_done,
             chapters_failed = v_failed,
             status = 'failed',
             aggregate_status = 'failed'
       where id = v_project_id;
    else
      insert into public.jobs (project_id, kind, status, target_revision)
      select v_project_id, 'aggregate', 'pending', v_revision
       where not exists (
         select 1 from public.jobs
          where project_id = v_project_id
            and kind = 'aggregate'
            and status in ('pending', 'running')
       );
      get diagnostics v_rows = row_count;
      v_aggregate_created := v_rows = 1;
      v_project_status := 'processing';
      update public.projects
         set chapters_done = v_done,
             chapters_failed = v_failed,
             status = 'processing',
             aggregate_status = 'dirty'
       where id = v_project_id;
    end if;
  else
    v_project_status := 'processing';
    update public.projects
       set chapters_done = v_done,
           chapters_failed = v_failed,
           status = 'processing'
     where id = v_project_id;
  end if;

  return jsonb_build_object(
    'project_id', v_project_id,
    'chapters_total', v_total,
    'chapters_done', v_done,
    'chapters_failed', v_failed,
    'content_revision', v_revision,
    'all_chapters_done', (v_total > 0 and (v_done + v_failed) >= v_total),
    'aggregate_created', v_aggregate_created,
    'project_status', v_project_status
  );
end;
$$;

-- ----------------------------------------------------------- retry chapters
drop function if exists public.requeue_failed_chapters(uuid);
create or replace function public.requeue_failed_chapters(
  p_project_id uuid,
  p_max_attempts integer default 3
)
returns jsonb
language plpgsql
as $$
declare
  v_failed_ids uuid[];
  v_count integer;
  v_revision bigint;
begin
  perform 1 from public.projects where id = p_project_id for update;

  select array_agg(id order by chapter_index) into v_failed_ids
    from public.chapters
   where project_id = p_project_id and status = 'failed';

  v_count := coalesce(array_length(v_failed_ids, 1), 0);
  if v_count = 0 then
    return jsonb_build_object(
      'requeued', 0, 'chapter_ids', '[]'::jsonb, 'content_revision',
      (select content_revision from public.projects where id = p_project_id)
    );
  end if;

  update public.projects
     set chapters_failed = greatest(chapters_failed - v_count, 0),
         content_revision = content_revision + 1,
         aggregate_status = 'dirty',
         status = 'processing',
         error = null
   where id = p_project_id
  returning content_revision into v_revision;

  update public.chapters
     set status = 'pending',
         error = null,
         result = null,
         digest = null,
         analysis_revision = 0,
         enrichment = null,
         enrichment_revision = 0,
         enriched = false
   where id = any(v_failed_ids);

  insert into public.jobs (
    project_id, chapter_id, kind, status, max_attempts, target_revision
  )
  select
    p_project_id, id, 'chapter', 'pending', greatest(p_max_attempts, 1), v_revision
  from public.chapters
  where id = any(v_failed_ids);

  return jsonb_build_object(
    'requeued', v_count,
    'chapter_ids', to_jsonb(v_failed_ids),
    'content_revision', v_revision
  );
end;
$$;

-- -------------------------------------------------------- aggregate lifecycle
create or replace function public.mark_aggregate_running(
  p_project_id uuid,
  p_target_revision bigint
)
returns void
language plpgsql
as $$
begin
  update public.projects
     set aggregate_status = 'running',
         status = 'processing'
   where id = p_project_id
     and content_revision = p_target_revision;
end;
$$;

drop function if exists public.finish_aggregate_job(uuid, uuid, jsonb);
create or replace function public.finish_aggregate_job(
  p_job_id uuid,
  p_project_id uuid,
  p_target_revision bigint,
  p_book_result jsonb
)
returns jsonb
language plpgsql
as $$
declare
  v_project public.projects;
  v_published boolean := false;
  v_aggregate_created boolean := false;
  v_rows integer := 0;
  v_status text;
begin
  select * into v_project
    from public.projects
   where id = p_project_id
   for update;
  if v_project.id is null then
    raise exception 'project % not found', p_project_id;
  end if;

  update public.jobs
     set status = 'succeeded', error = null, lease_expires_at = null
   where id = p_job_id;

  if p_target_revision = v_project.content_revision
     and (v_project.chapters_done + v_project.chapters_failed) >= v_project.chapters_total then
    v_published := true;
    v_status := case when v_project.chapters_failed > 0
      then 'partially_failed' else 'completed' end;
    update public.projects
       set book_result = p_book_result,
           aggregated_revision = p_target_revision,
           aggregate_status = 'clean',
           status = v_status,
           error = null
     where id = p_project_id;
  else
    v_status := 'processing';
    update public.projects
       set aggregate_status = 'dirty',
           status = 'processing'
     where id = p_project_id;

    if v_project.chapters_done > 0
       and (v_project.chapters_done + v_project.chapters_failed) >= v_project.chapters_total then
      insert into public.jobs (project_id, kind, status, target_revision)
      select p_project_id, 'aggregate', 'pending', v_project.content_revision
       where not exists (
         select 1 from public.jobs
          where project_id = p_project_id
            and kind = 'aggregate'
            and status in ('pending', 'running')
       );
      get diagnostics v_rows = row_count;
      v_aggregate_created := v_rows = 1;
    end if;
  end if;

  return jsonb_build_object(
    'project_status', v_status,
    'chapters_failed', v_project.chapters_failed,
    'published', v_published,
    'target_revision', p_target_revision,
    'content_revision', v_project.content_revision,
    'aggregate_created', v_aggregate_created
  );
end;
$$;

create or replace function public.mark_aggregate_failed(
  p_project_id uuid,
  p_target_revision bigint,
  p_error text
)
returns jsonb
language plpgsql
as $$
declare
  v_project public.projects;
  v_rows integer := 0;
begin
  select * into v_project
    from public.projects
   where id = p_project_id
   for update;

  if v_project.content_revision = p_target_revision then
    update public.projects
       set aggregate_status = 'failed',
           status = 'aggregation_failed',
           error = p_error
     where id = p_project_id;
    return jsonb_build_object('marked_failed', true);
  end if;

  update public.projects
     set aggregate_status = 'dirty',
         status = 'processing'
   where id = p_project_id;

  if v_project.chapters_done > 0
     and (v_project.chapters_done + v_project.chapters_failed) >= v_project.chapters_total then
    insert into public.jobs (project_id, kind, status, target_revision)
    select p_project_id, 'aggregate', 'pending', v_project.content_revision
     where not exists (
       select 1 from public.jobs
        where project_id = p_project_id
          and kind = 'aggregate'
          and status in ('pending', 'running')
     );
    get diagnostics v_rows = row_count;
  end if;

  return jsonb_build_object(
    'marked_failed', false,
    'aggregate_created', v_rows = 1
  );
end;
$$;

create or replace function public.requeue_aggregate(
  p_project_id uuid,
  p_max_attempts integer default 3
)
returns jsonb
language plpgsql
as $$
declare
  v_project public.projects;
  v_rows integer := 0;
begin
  select * into v_project
    from public.projects
   where id = p_project_id
   for update;
  if v_project.id is null then
    raise exception 'project % not found', p_project_id;
  end if;
  if v_project.chapters_done = 0
     or (v_project.chapters_done + v_project.chapters_failed) < v_project.chapters_total then
    return jsonb_build_object('requeued', false, 'message', 'chapters are not ready');
  end if;

  insert into public.jobs (
    project_id, kind, status, max_attempts, target_revision
  )
  select
    p_project_id, 'aggregate', 'pending', greatest(p_max_attempts, 1), v_project.content_revision
   where not exists (
     select 1 from public.jobs
      where project_id = p_project_id
        and kind = 'aggregate'
        and status in ('pending', 'running')
   );
  get diagnostics v_rows = row_count;

  if v_rows = 1 then
    update public.projects
       set aggregate_status = 'dirty',
           status = 'processing',
           error = null
     where id = p_project_id;
  end if;

  return jsonb_build_object(
    'requeued', v_rows = 1,
    'content_revision', v_project.content_revision,
    'message', case when v_rows = 1 then 'aggregate requeued' else 'aggregate already active' end
  );
end;
$$;

-- --------------------------------------------------------------- privileges
grant execute on function public.chapter_batch_response(uuid, boolean) to service_role;
grant execute on function public.append_chapter_batch(uuid, uuid, jsonb, integer) to service_role;
grant execute on function public.commit_chapterize_result(uuid, jsonb, integer) to service_role;
grant execute on function public.finish_chapter_job(uuid, uuid, boolean, text) to service_role;
grant execute on function public.requeue_failed_chapters(uuid, integer) to service_role;
grant execute on function public.mark_aggregate_running(uuid, bigint) to service_role;
grant execute on function public.finish_aggregate_job(uuid, uuid, bigint, jsonb) to service_role;
grant execute on function public.mark_aggregate_failed(uuid, bigint, text) to service_role;
grant execute on function public.requeue_aggregate(uuid, integer) to service_role;
