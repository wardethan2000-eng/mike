-- Meaning-based search. Every passage carries a numeric fingerprint of its
-- meaning (an embedding), so a question phrased differently from the text still
-- finds the right passage — "who pays if this goes wrong" reaching an indemnity
-- clause that never uses those words, which word search alone cannot do.
--
-- The fingerprints are computed on our own machine from a small local model
-- (bge-small-en-v1.5, 384 dimensions). No document text is sent outside for
-- this. See docs/plans/01-search-across-a-matter.md.

create extension if not exists vector;

alter table public.document_passages
  add column if not exists embedding vector(384);

-- Approximate-nearest-neighbour index for cosine distance. Cheap to build at
-- this size and keeps meaning search fast as the collection grows.
create index if not exists document_passages_embedding_idx
  on public.document_passages using hnsw (embedding vector_cosine_ops);


-- The search function gains meaning search and merges it with the two word
-- searches. The query's fingerprint is computed by the caller (the database
-- cannot run the model) and passed in as a text vector literal, or null to skip
-- meaning search entirely — so an older caller, or a moment when the model is
-- unavailable, still gets word and fuzzy search exactly as before.
--
-- The three lists are merged by reciprocal-rank fusion: a passage found by more
-- than one search, or ranked high by any one, rises to the top. Exact words are
-- weighted a little above the rest, so a party name or "Section 7.2" still wins.
drop function if exists public.search_document_passages(uuid, uuid, text, integer);

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
  -- Exact words: understands stems and phrases.
  full_text as (
    select cp.id,
           row_number() over (
             order by ts_rank(cp.content_tsv, websearch_to_tsquery('english', p_query)) desc,
                      cp.document_id, cp.ordinal
           ) as rnk
    from current_passages cp
    where cp.content_tsv @@ websearch_to_tsquery('english', p_query)
  ),
  -- Typo/OCR tolerance: the query against the most similar run of words inside a
  -- passage, so a short query still matches a long passage.
  fuzzy as (
    select cp.id,
           row_number() over (
             order by word_similarity(p_query, cp.content) desc,
                      cp.document_id, cp.ordinal
           ) as rnk
    from current_passages cp
    where word_similarity(p_query, cp.content) >= 0.4
  ),
  -- Meaning: the passages nearest the query's fingerprint. Empty when no
  -- fingerprint was supplied or a passage has not been fingerprinted yet.
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
