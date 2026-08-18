-- Passages of document text, so a question can be asked of a whole matter
-- rather than of documents handed over one at a time.
--
-- One row per passage. The page number is carried on every row because
-- citations are built from it. user_id and project_id are copied here on
-- purpose: a search must be able to exclude matters the reader cannot open
-- inside the query itself, without joining back to documents.
--
-- The meaning fingerprint (pgvector) arrives in a later migration, once the
-- model — and therefore the number of dimensions — is settled. This migration
-- covers storage and exact-word search only.

create extension if not exists "pg_trgm";

create table if not exists public.document_passages (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents(id) on delete cascade,
  version_id uuid not null references public.document_versions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  -- Page the passage came from. Null when the document has no pages.
  page integer,
  -- Position within the document, from zero. Unique per version.
  ordinal integer not null,
  content text not null,
  -- True when the text came from character recognition, so search results and
  -- anything quoted from them can be treated with the same care as elsewhere.
  from_ocr boolean not null default false,
  content_tsv tsvector generated always as (to_tsvector('english', content)) stored,
  created_at timestamptz not null default now()
);

create unique index if not exists document_passages_version_ordinal_key
  on public.document_passages (version_id, ordinal);

-- Word search.
create index if not exists document_passages_tsv_idx
  on public.document_passages using gin (content_tsv);

-- Tolerates a wrong character or two, which matters because text read from a
-- scan always has some.
create index if not exists document_passages_trgm_idx
  on public.document_passages using gin (content gin_trgm_ops);

-- Scoping a search to what the reader may see, and to a matter.
create index if not exists document_passages_user_project_idx
  on public.document_passages (user_id, project_id);

create index if not exists document_passages_document_idx
  on public.document_passages (document_id);

alter table public.document_passages enable row level security;

grant all privileges on table public.document_passages to service_role;
