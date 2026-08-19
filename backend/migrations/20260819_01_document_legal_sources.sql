-- Provenance for documents saved straight out of a chat's legal sources
-- (a CourtListener case, or a statute pulled by the law tools). These three
-- columns are what lets the app tell "this file came from CourtListener case
-- 12345" and therefore refuse to save the same source into the same matter
-- twice.

alter table public.documents
  add column if not exists source_kind text,
  add column if not exists source_ref text,
  add column if not exists source_url text;

alter table public.documents
  drop constraint if exists documents_source_kind_check;
alter table public.documents
  add constraint documents_source_kind_check
  check (source_kind is null or source_kind in ('case', 'legislation'));

-- One copy of a given source per matter. Partial so ordinary uploads (which
-- leave these null) are unaffected.
create unique index if not exists idx_documents_project_source
  on public.documents(project_id, source_kind, source_ref)
  where project_id is not null and source_kind is not null and source_ref is not null;
