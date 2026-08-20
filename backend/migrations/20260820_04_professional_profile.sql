-- Phase 2 of the firm structure plan (docs/FIRM_STRUCTURE_PLAN.md): who the
-- person asking actually is, professionally.
--
-- A letter has to be signed by somebody, with the right bar number under the
-- right name. Mike had no idea who its user was beyond a display name, so it
-- either left the signature out or invented one. These are the details it
-- needs, kept with the person rather than with any one matter.
--
-- Safe to run more than once.

alter table public.user_profiles
  -- 'Partner', 'Associate', 'Paralegal' — how they sign.
  add column if not exists prof_title text;

alter table public.user_profiles
  add column if not exists prof_phone text;

alter table public.user_profiles
  add column if not exists practice_areas text[] not null default '{}';

-- Where they are admitted to practise, and under what number. A list, because
-- attorneys are commonly admitted in several states:
--   [{"state": "Kansas", "bar_number": "12345", "status": "active"}]
alter table public.user_profiles
  add column if not exists bar_admissions jsonb not null default '[]'::jsonb;

-- The block that goes at the foot of a letter, exactly as they want it to
-- appear. Stored verbatim, newlines and all — it is copied, not reassembled.
alter table public.user_profiles
  add column if not exists signature_block text;
