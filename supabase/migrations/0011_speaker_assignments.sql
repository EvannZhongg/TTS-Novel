-- 人工修正章节对白说话人。
--
-- pipeline 产出的章节 JSON 保持只读；当前指派放 speaker_assignments，
-- 每次实际变更同时追加 speaker_change_logs，便于审计与后续质量分析。

create table if not exists public.speaker_assignments (
  id                   uuid primary key default gen_random_uuid(),
  project_id           uuid not null references public.projects(id) on delete cascade,
  chapter_id           uuid not null references public.chapters(id) on delete cascade,
  segment_id           text not null,
  segment_start        integer,
  segment_end          integer,
  segment_text         text not null default '',
  original_speaker     text not null default '',
  original_role_id     text not null default '',
  target_role_key      text not null,
  target_role_snapshot jsonb not null,
  changed_by           uuid not null references public.demo_users(id) on delete restrict,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (chapter_id, segment_id)
);

create index if not exists speaker_assignments_project_idx
  on public.speaker_assignments (project_id, chapter_id);

create table if not exists public.speaker_change_logs (
  id                bigserial primary key,
  assignment_id     uuid not null references public.speaker_assignments(id) on delete cascade,
  project_id        uuid not null references public.projects(id) on delete cascade,
  chapter_id        uuid not null references public.chapters(id) on delete cascade,
  segment_id        text not null,
  old_role_snapshot jsonb not null,
  new_role_snapshot jsonb not null,
  changed_by        uuid not null references public.demo_users(id) on delete restrict,
  created_at        timestamptz not null default now()
);

create index if not exists speaker_change_logs_project_idx
  on public.speaker_change_logs (project_id, created_at desc);
create index if not exists speaker_change_logs_chapter_idx
  on public.speaker_change_logs (chapter_id, id desc);

drop trigger if exists speaker_assignments_touch on public.speaker_assignments;
create trigger speaker_assignments_touch before update on public.speaker_assignments
  for each row execute function public.touch_updated_at();

alter table public.speaker_assignments enable row level security;
alter table public.speaker_change_logs enable row level security;

grant select, insert, update, delete on public.speaker_assignments to service_role;
grant select, insert, update, delete on public.speaker_change_logs to service_role;
grant usage, select on sequence public.speaker_change_logs_id_seq to service_role;

create or replace function public.set_speaker_assignment(
  p_project_id uuid,
  p_chapter_id uuid,
  p_segment_id text,
  p_segment_start integer,
  p_segment_end integer,
  p_segment_text text,
  p_original_speaker text,
  p_original_role_id text,
  p_target_role_key text,
  p_changed_by uuid
)
returns jsonb
language plpgsql
security invoker
as $$
declare
  v_owner_id uuid;
  v_book_result jsonb;
  v_target_role jsonb;
  v_existing public.speaker_assignments;
  v_assignment public.speaker_assignments;
  v_old_role jsonb;
  v_log_id bigint;
begin
  if coalesce(trim(p_segment_id), '') = '' then
    raise exception using errcode = '22023', message = 'segment_id is required';
  end if;
  if coalesce(trim(p_target_role_key), '') = '' then
    raise exception using errcode = '22023', message = 'target_role_key is required';
  end if;

  -- 锁章节行，把同一句对白的并发修改串行化；同时校验项目/章节关系。
  select p.user_id, p.book_result
    into v_owner_id, v_book_result
    from public.chapters c
    join public.projects p on p.id = c.project_id
   where c.id = p_chapter_id
     and p.id = p_project_id
   for update of c;

  if not found then
    raise exception using errcode = 'P0002', message = 'chapter not found in project';
  end if;
  if v_owner_id <> p_changed_by then
    raise exception using errcode = '42501', message = 'project owner mismatch';
  end if;

  -- 只允许选择当前小说 role_registry 中的人物。无 role_id 的旧数据以 name:人物名 为 key。
  select role.value
    into v_target_role
    from jsonb_array_elements(coalesce(v_book_result->'role_registry', '[]'::jsonb)) role(value)
   where coalesce(
           nullif(trim(role.value->>'role_id'), ''),
           'name:' || trim(coalesce(role.value->>'canonical_name', ''))
         ) = p_target_role_key
     and trim(coalesce(role.value->>'canonical_name', '')) <> ''
   limit 1;

  if v_target_role is null then
    raise exception using errcode = '22023', message = 'target role is not in current project role registry';
  end if;

  select *
    into v_existing
    from public.speaker_assignments
   where chapter_id = p_chapter_id
     and segment_id = p_segment_id
   for update;

  if found and v_existing.target_role_key = p_target_role_key then
    return jsonb_build_object(
      'changed', false,
      'assignment', to_jsonb(v_existing),
      'log_id', null
    );
  end if;

  if v_existing.id is null then
    v_old_role := jsonb_build_object(
      'role_id', coalesce(p_original_role_id, ''),
      'canonical_name', coalesce(p_original_speaker, ''),
      'source', 'pipeline'
    );
  else
    v_old_role := v_existing.target_role_snapshot;
  end if;

  insert into public.speaker_assignments (
    project_id, chapter_id, segment_id, segment_start, segment_end, segment_text,
    original_speaker, original_role_id, target_role_key, target_role_snapshot, changed_by
  ) values (
    p_project_id, p_chapter_id, p_segment_id, p_segment_start, p_segment_end,
    coalesce(p_segment_text, ''), coalesce(p_original_speaker, ''),
    coalesce(p_original_role_id, ''), p_target_role_key, v_target_role, p_changed_by
  )
  on conflict (chapter_id, segment_id) do update
    set segment_start = excluded.segment_start,
        segment_end = excluded.segment_end,
        segment_text = excluded.segment_text,
        target_role_key = excluded.target_role_key,
        target_role_snapshot = excluded.target_role_snapshot,
        changed_by = excluded.changed_by
  returning * into v_assignment;

  insert into public.speaker_change_logs (
    assignment_id, project_id, chapter_id, segment_id,
    old_role_snapshot, new_role_snapshot, changed_by
  ) values (
    v_assignment.id, p_project_id, p_chapter_id, p_segment_id,
    v_old_role, v_target_role, p_changed_by
  )
  returning id into v_log_id;

  return jsonb_build_object(
    'changed', true,
    'assignment', to_jsonb(v_assignment),
    'log_id', v_log_id
  );
end;
$$;

revoke all on function public.set_speaker_assignment(
  uuid, uuid, text, integer, integer, text, text, text, text, uuid
) from public, anon, authenticated;
grant execute on function public.set_speaker_assignment(
  uuid, uuid, text, integer, integer, text, text, text, text, uuid
) to service_role;
