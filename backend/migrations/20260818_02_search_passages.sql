-- Searching a matter's passages by word.
--
-- One function so the ranking lives in the database. It runs two searches and
-- prefers the first:
--   * full-text search, which understands word stems and phrases; then
--   * a trigram similarity fallback, which tolerates the wrong character or two
--     that text read from a scan always carries — so an OCR'd document is still
--     found when full-text search, matching whole words, misses it.
--
-- Only the current version of each document is searched, so a replaced draft
-- never surfaces alongside the one that supersedes it. Results are scoped to
-- the owner and, when given, to one matter.

create or replace function public.search_document_passages(
  p_user_id uuid,
  p_project_id uuid,
  p_query text,
  p_limit integer default 20
)
returns table (
  passage_id uuid,
  document_id uuid,
  page integer,
  ordinal integer,
  content text,
  from_ocr boolean,
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
  full_text as (
    select
      cp.id, cp.document_id, cp.page, cp.ordinal, cp.content, cp.from_ocr,
      ts_rank(cp.content_tsv, websearch_to_tsquery('english', p_query)) as rank,
      'words'::text as matched_by
    from current_passages cp
    where cp.content_tsv @@ websearch_to_tsquery('english', p_query)
  ),
  fuzzy as (
    -- word_similarity measures the query against the most similar run of words
    -- inside a passage, so a short query still matches a long passage — which
    -- plain similarity(), comparing the two whole strings, never would. This is
    -- what lets a misspelt or OCR-mangled word still be found.
    select
      cp.id, cp.document_id, cp.page, cp.ordinal, cp.content, cp.from_ocr,
      word_similarity(p_query, cp.content) as rank,
      'similar'::text as matched_by
    from current_passages cp
    where word_similarity(p_query, cp.content) >= 0.4
      and not exists (select 1 from full_text ft where ft.id = cp.id)
  )
  select passage_id, document_id, page, ordinal, content, from_ocr, rank, matched_by
  from (
    select id as passage_id, document_id, page, ordinal, content, from_ocr, rank, matched_by
    from full_text
    union all
    select id as passage_id, document_id, page, ordinal, content, from_ocr, rank, matched_by
    from fuzzy
  ) combined
  order by (matched_by = 'words') desc, rank desc, document_id, ordinal
  limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;

revoke all on function public.search_document_passages(uuid, uuid, text, integer)
  from public, anon, authenticated;
grant execute on function public.search_document_passages(uuid, uuid, text, integer)
  to service_role;
