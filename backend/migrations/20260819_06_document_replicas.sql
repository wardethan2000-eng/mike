-- Mark documents that were produced by copying another document.
--
-- A fresh copy is a document being drafted, not one being marked up: the text
-- it starts with belongs to the document it came from, so the first edits are
-- written straight in instead of being offered as tracked changes to accept.
alter table public.documents
  add column if not exists is_replica boolean not null default false;
