-- Whether Mike looks for facts worth remembering after a conversation at all.
--
-- On unless someone turns it off. A matter where the suggestions are noise —
-- one that is nearly finished, or one where everything worth knowing is already
-- written down — should be able to stop them rather than keep turning them
-- down.
alter table public.projects
  add column if not exists suggest_facts boolean not null default true;
