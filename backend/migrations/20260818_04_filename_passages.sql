-- Some documents have no text to read — a photograph of a damaged roof, a scan
-- that recognised nothing inside it. Their filename, though, is often a good
-- description ("Shattered roof skylight leaving the interior exposed..."), so it
-- is stored as a single passage and searched like any other. It is marked here
-- so a result can say the match was on the file's name, not on text inside the
-- file, and so the assistant does not quote a photograph as if it held words.
alter table public.document_passages
  add column if not exists from_filename boolean not null default false;

-- The search function gains that flag in its result. Everything else is exactly
-- as migration 03 left it.
drop function if exists public.search_document_passages(uuid, uuid, text, integer, text);

create or replace function public.search_document_passages(
  p_user_id uuid,
  p_project_id uuid,
  p_query text,
  p_limit integer default 20,
  p_query_embedding text default null
)
returns table (
  passage_id uuid,
  document_id uuid,
  page integer,
  ordinal integer,
  content text,
  from_ocr boolean,
  from_filename boolean,
  rank real,
  matched_by text
)
language sql
stable
as $$
  with current_passages as (
    select p.*
    from public.document_passages p
    join public.documents d
      on d.id = p.document_id
     and d.current_version_id = p.version_id
    where p.user_id = p_user_id
      and (p_project_id is null or p.project_id = p_project_id)
  ),
  q_embed as (
    select case
             when p_query_embedding is null or p_query_embedding = '' then null
             else p_query_embedding::vector(384)
           end as v
  ),
  full_text as (
    select cp.id,
           row_number() over (
             order by ts_rank(cp.content_tsv, websearch_to_tsquery('english', p_query)) desc,
                      cp.document_id, cp.ordinal
           ) as rnk
    from current_passages cp
    where cp.content_tsv @@ websearch_to_tsquery('english', p_query)
  ),
  fuzzy as (
    select cp.id,
           row_number() over (
             order by word_similarity(p_query, cp.content) desc,
                      cp.document_id, cp.ordinal
           ) as rnk
    from current_passages cp
    where word_similarity(p_query, cp.content) >= 0.4
  ),
  semantic as (
    select cp.id,
           row_number() over (order by cp.embedding <=> (select v from q_embed)) as rnk
    from current_passages cp
    where (select v from q_embed) is not null
      and cp.embedding is not null
    order by cp.embedding <=> (select v from q_embed)
    limit 50
  ),
  ids as (
    select id from full_text
    union select id from fuzzy
    union select id from semantic
  ),
  fused as (
    select i.id,
           coalesce(1.2 / (60 + ft.rnk), 0)
         + coalesce(1.0 / (60 + fz.rnk), 0)
         + coalesce(1.0 / (60 + se.rnk), 0) as rrf,
           ft.id is not null as in_words,
           se.id is not null as in_meaning
    from ids i
    left join full_text ft on ft.id = i.id
    left join fuzzy fz     on fz.id = i.id
    left join semantic se  on se.id = i.id
  )
  select cp.id as passage_id,
         cp.document_id,
         cp.page,
         cp.ordinal,
         cp.content,
         cp.from_ocr,
         cp.from_filename,
         f.rrf::real as rank,
         case
           when f.in_words then 'words'
           when f.in_meaning then 'meaning'
           else 'similar'
         end as matched_by
  from fused f
  join current_passages cp on cp.id = f.id
  order by f.rrf desc, cp.document_id, cp.ordinal
  limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;

revoke all on function public.search_document_passages(uuid, uuid, text, integer, text)
  from public, anon, authenticated;
grant execute on function public.search_document_passages(uuid, uuid, text, integer, text)
  to service_role;
