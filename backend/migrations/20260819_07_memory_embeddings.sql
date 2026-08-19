-- A fingerprint of each remembered fact's meaning, so that once a matter has
-- collected more facts than fit comfortably in every question, the ones sent
-- can be the ones that bear on what was actually asked.
--
-- Computed on our own machine by the same small local model used for document
-- search (bge-small-en-v1.5, 384 dimensions). Nothing is sent outside for this.
create extension if not exists vector;

alter table public.project_memories
  add column if not exists embedding vector(384);
