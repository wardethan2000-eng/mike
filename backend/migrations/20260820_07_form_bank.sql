-- Phase 5 of the firm structure plan (docs/FIRM_STRUCTURE_PLAN.md):
-- the firm's form bank.
--
-- The firm already has a shared library. What it does not have is a way to
-- say, about a document already on those shelves, "this is our operating
-- agreement for a two-member, member-managed company", "these paragraphs are
-- ours and must not be reworded", "this is a fill-in form and these are its
-- blanks". This table holds exactly those notes, one row per banked document,
-- so Mike can find the right starting point on its own instead of waiting for
-- somebody to attach a file.
--
-- Nothing here holds a document. The bytes stay in the firm library where they
-- already are; removing a note leaves the document untouched.
--
-- Safe to run more than once.

create table if not exists public.firm_forms (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms(id) on delete cascade,
  -- The banked document. Must be a firm-library template; the routes check
  -- that. One set of notes per document.
  document_id uuid not null unique references public.documents(id) on delete cascade,
  title text not null,
  -- Versions of the same kind of document share this slug, which is what lets
  -- Mike see that the firm has four operating agreements and compare them.
  document_type text not null,
  -- 'precedent' = a model to adapt heavily. 'fill' = a form where only the
  -- named blanks change.
  usage_mode text not null default 'precedent'
    check (usage_mode in ('precedent','fill')),
  -- What situation this version covers, written to be read against its
  -- siblings: "member-managed, two individual members, Kansas".
  variant_notes text,
  practice text,
  jurisdictions text[] not null default '{}',
  description text,
  -- Notes for Mike: which paragraphs are the firm's and stay word for word,
  -- which parts are expected to be reworked, what must never be touched.
  drafting_guidance text,
  -- Fill forms only. A list of
  -- {"key","label","source":"ask|matter|attorney|firm","hint"}.
  required_fields jsonb not null default '[]',
  -- Only an approved entry is offered in a chat; a draft is still being
  -- written up.
  status text not null default 'draft' check (status in ('draft','approved')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists firm_forms_firm_status_idx
  on public.firm_forms(firm_id, status);

create index if not exists firm_forms_type_idx
  on public.firm_forms(firm_id, document_type);

alter table public.firm_forms enable row level security;
revoke all on public.firm_forms from anon, authenticated;
