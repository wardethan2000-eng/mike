-- Facts Mike suggests for itself after a conversation.
--
-- A suggested fact is not in force: it is shown to the lawyer as something to
-- accept, correct or turn down, and only an accepted fact is ever sent back to
-- the assistant. Turned-down facts are kept so the same suggestion does not
-- come round again.
alter table public.project_memories
  add column if not exists status text not null default 'accepted';

-- Where the fact came from: someone typed it, or Mike suggested it. Shown on
-- the fact, so a matter that saves suggestions without asking still makes plain
-- which facts nobody checked.
alter table public.project_memories
  add column if not exists origin text not null default 'manual';

-- Only accepted facts are in force, so that is the index the assistant reads by.
create index if not exists idx_project_memories_accepted
  on public.project_memories(project_id)
  where superseded_by is null and status = 'accepted';

-- Per matter: let Mike save what it finds without asking first. Off by default;
-- the facts are still listed and can be removed.
alter table public.projects
  add column if not exists auto_remember boolean not null default false;
