-- Case memory: the short facts a matter accumulates as work goes on — who the
-- parties are, the dates that matter, the position taken, what was decided,
-- what is still open, how the firm wants things drafted.
--
-- Each fact keeps a link back to where it came from, so it can be checked
-- rather than taken on trust. Facts change, so a fact is superseded by a newer
-- one rather than overwritten: the old wording stays readable.
create table if not exists public.project_memories (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  -- Who wrote it. Kept so a matter shared between people shows whose fact it is.
  user_id uuid not null references auth.users(id) on delete cascade,
  -- One of: parties, dates, position, decisions, questions, drafting.
  category text not null default 'parties',
  body text not null,
  -- Pinned facts are always sent to the assistant, even once a matter has
  -- accumulated more than fits comfortably.
  pinned boolean not null default false,
  -- Where it came from. A document (with the page it was read on), a chat
  -- message, or nothing at all when someone simply typed it in.
  source_document_id uuid references public.documents(id) on delete set null,
  source_page integer,
  source_chat_id uuid references public.chats(id) on delete set null,
  -- Set on the older fact when a newer one replaces it. The old row stays so
  -- the history of a moving deadline is still readable.
  superseded_by uuid references public.project_memories(id) on delete set null,
  superseded_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_project_memories_project
  on public.project_memories(project_id, created_at desc);

-- The facts actually in force: everything that has not been replaced.
create index if not exists idx_project_memories_live
  on public.project_memories(project_id)
  where superseded_by is null;

grant select, insert, update, delete on public.project_memories to service_role;
