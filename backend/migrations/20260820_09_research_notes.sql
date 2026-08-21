-- The assistant's running research notes are a document in the matter, marked
-- so the same chat finds and appends to its own notes rather than starting a
-- second one. source_ref holds the chat id, which the existing partial unique
-- index on (project_id, source_kind, source_ref) turns into "one notes
-- document per chat" for free.
--
-- Additive only: widening a check constraint cannot invalidate existing rows.

alter table public.documents
  drop constraint if exists documents_source_kind_check;
alter table public.documents
  add constraint documents_source_kind_check
  check (source_kind is null or source_kind in ('case', 'legislation', 'research_notes'));
