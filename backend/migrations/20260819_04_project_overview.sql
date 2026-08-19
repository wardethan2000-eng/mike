-- Case overview: the standing instructions a lawyer writes for a matter —
-- who we act for, what we are trying to achieve, how they want things done.
-- It is sent with every question asked inside the matter, so the assistant
-- does not have to be told the same background over and over.
alter table public.projects
  add column if not exists overview text;
