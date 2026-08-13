-- 聚合 enrichment 批量回写。
--
-- 400 章逐条 update 会产生 400 次数据库往返；调用方按 25 章一批传入，
-- 本函数一次 UPDATE FROM 完成一批，并保留 analysis_revision 版本保护。
create or replace function public.save_chapter_enrichment_batch(
  p_project_id uuid,
  p_target_revision bigint,
  p_items jsonb
)
returns jsonb
language plpgsql
as $$
declare
  v_updated integer;
begin
  if jsonb_typeof(p_items) <> 'array' then
    raise exception using errcode = '22023', message = 'items must be an array';
  end if;

  update public.chapters c
     set enrichment = item.value->'enrichment',
         digest = item.value->'digest',
         enrichment_revision = p_target_revision,
         enriched = true
    from jsonb_array_elements(p_items) item(value)
   where c.id = (item.value->>'chapter_id')::uuid
     and c.project_id = p_project_id
     and c.analysis_revision <= p_target_revision;

  get diagnostics v_updated = row_count;
  return jsonb_build_object(
    'requested', jsonb_array_length(p_items),
    'updated', v_updated,
    'target_revision', p_target_revision
  );
end;
$$;

grant execute on function public.save_chapter_enrichment_batch(uuid, bigint, jsonb)
  to service_role;
