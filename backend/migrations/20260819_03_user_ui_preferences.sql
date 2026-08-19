-- How a person has arranged the panels in a project conversation is their own
-- choice, and it should follow them to any computer they sign in from rather
-- than living in one browser. This is a general store for that kind of small
-- personal display setting, keyed by user, so later ones can reuse it without
-- another table or another migration.
create table if not exists public.user_ui_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  preferences jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.user_ui_preferences enable row level security;

-- Only the signed-in person may read or write their own row. The backend uses
-- the service role and bypasses this; the policy protects direct API access.
drop policy if exists user_ui_preferences_own_row on public.user_ui_preferences;
create policy user_ui_preferences_own_row
  on public.user_ui_preferences
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
