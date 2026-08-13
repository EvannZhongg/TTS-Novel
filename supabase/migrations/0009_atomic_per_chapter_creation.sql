-- 首批逐章项目创建也纳入幂等事务；正文版本推进时淘汰尚未开始的旧聚合。

alter table public.projects
  add column if not exists create_request_id uuid;

create unique index if not exists projects_user_create_request_key
  on public.projects (user_id, create_request_id)
  where create_request_id is not null;

-- 同一用户 + request_id 的建项请求安全重放，不产生重复项目。
create or replace function public.create_per_chapter_project(
  p_user_id uuid,
  p_title text,
  p_request_id uuid,
  p_chapters jsonb,
  p_max_attempts integer default 3
)
returns jsonb
language plpgsql
as $$
declare
  v_project_id uuid;
  v_batch_id uuid;
  v_batch jsonb;
begin
  -- 锁用户行，把同一用户的并发建项幂等检查串行化。
  perform 1 from public.demo_users where id = p_user_id for update;

  select id into v_project_id
    from public.projects
   where user_id = p_user_id
     and create_request_id = p_request_id;

  if v_project_id is not null then
    select id into v_batch_id
      from public.chapter_upload_batches
     where project_id = v_project_id
     order by created_at
     limit 1;
    v_batch := public.chapter_batch_response(v_batch_id, true);
    return v_batch || jsonb_build_object(
      'project_id', v_project_id,
      'source_mode', 'per_chapter',
      'status', (select status from public.projects where id = v_project_id)
    );
  end if;

  insert into public.projects (
    user_id, title, source_mode, status, create_request_id
  ) values (
    p_user_id, p_title, 'per_chapter', 'processing', p_request_id
  )
  returning id into v_project_id;

  v_batch := public.append_chapter_batch(
    v_project_id, p_request_id, p_chapters, p_max_attempts
  );

  return v_batch || jsonb_build_object(
    'project_id', v_project_id,
    'source_mode', 'per_chapter',
    'status', 'processing'
  );
end;
$$;

-- 若新章节在聚合尚未开始时到达，直接淘汰旧 pending 任务；新一批章节全部
-- 终结后会为最新 revision 建任务。running 任务不能安全中止，继续依赖版本栅栏。
create or replace function public.supersede_pending_aggregates()
returns trigger
language plpgsql
as $$
begin
  if new.content_revision > old.content_revision then
    update public.jobs
       set status = 'failed',
           error = format(
             'superseded by content revision %s before aggregate started',
             new.content_revision
           ),
           lease_expires_at = null
     where project_id = new.id
       and kind = 'aggregate'
       and status = 'pending'
       and coalesce(target_revision, 0) < new.content_revision;
  end if;
  return new;
end;
$$;

drop trigger if exists projects_supersede_pending_aggregates on public.projects;
create trigger projects_supersede_pending_aggregates
  after update of content_revision on public.projects
  for each row execute function public.supersede_pending_aggregates();

grant execute on function public.create_per_chapter_project(uuid, text, uuid, jsonb, integer)
  to service_role;
