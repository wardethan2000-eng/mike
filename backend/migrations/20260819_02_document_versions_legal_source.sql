-- Saving a case or statute into a matter writes a document version whose
-- source is "legal-source", but that value was never added to the allowed
-- list, so every save was rejected by the database. Add it.
-- Additive only: no existing row can violate the wider constraint.

alter table public.document_versions
  drop constraint if exists document_versions_source_check;

alter table public.document_versions
  add constraint document_versions_source_check
  check (source = any (array[
    'upload',
    'user_upload',
    'assistant_edit',
    'user_accept',
    'user_reject',
    'generated',
    'legal-source'
  ]));
