-- Phase 4 of the firm structure plan (docs/FIRM_STRUCTURE_PLAN.md):
-- the firm can hold the accounts with the AI providers, so nobody has to paste
-- their own key in to get started.
--
-- Stored exactly the way each person's own key already is: encrypted with the
-- same secret and the same method, and never handed back out.
--
-- Safe to run more than once.

create table if not exists public.firm_api_keys (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms(id) on delete cascade,
  provider text not null,
  encrypted_key text not null,
  iv text not null,
  auth_tag text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (firm_id, provider)
);

create index if not exists firm_api_keys_firm_idx
  on public.firm_api_keys(firm_id);

alter table public.firm_api_keys enable row level security;
revoke all on public.firm_api_keys from anon, authenticated;

-- Which AI models the firm allows lives on the firm row and was created with
-- it in Phase 1; nothing to add here. An empty setting means all of them.
