# Firm Structure Plan — Implementation Spec

Turn Mike from single-user accounts into a firm-wide tool: roles, an admin
panel, firm-shared content, and firm-visible matters.

Written 2026-08-19 against the tree at `~/mike` on VM 133. Status: SPEC —
nothing built. Verified against the live schema and routes on that date;
re-verify file paths before editing if much time has passed.

**For the implementing agent, read first:**
- This is a shared tree. Commit by path (`git add <files>`), never `git add -A`,
  no stash/reset/checkout of others' work. Coordinate deploys/reboots.
- `docker compose up -d` on this box hangs holding a lock (createbucket) —
  use `--no-deps`, and if a container is left in `Created`, `sudo docker start
  mike-backend-1 mike-frontend-1`. Test without downtime via `docker compose run`.
- Backend tests: `NODE_ENV=production` breaks React.act in the frontend suite —
  don't set it. Both suites were green 08-19; keep them green.
- Schema changes go in BOTH `backend/schema.sql` (canonical) and a new file
  `backend/migrations/YYYYMMDD_NN_<name>.sql` (applied to the live DB). Follow
  the existing migration style (idempotent: `if not exists`, `do $$` guards).
- The DB is Supabase Postgres in the `db` container. Backend uses the service
  role (`createServerSupabase()` in `backend/src/lib/supabase.ts`); RLS is
  enabled with no policies on backend-owned tables — keep that pattern for all
  new tables (enable RLS, revoke direct roles, service_role bypasses).

## 1. Current state (verified facts)

- **Auth**: Supabase GoTrue. `backend/src/middleware/auth.ts` `requireAuth`
  sets `res.locals.userId`, `res.locals.userEmail` (lowercased), `res.locals.token`.
- **Sign-up is OPEN**: `docker-compose.yml` has
  `GOTRUE_DISABLE_SIGNUP: ${GOTRUE_DISABLE_SIGNUP:-false}` and the root `.env`
  does not set it. SMTP is **mailpit** (a local mail catcher) — real invite
  emails will NOT reach anyone's inbox. Invite links must be copy-pasteable.
- **Profiles**: `user_profiles` (user_id unique, email, display_name,
  organisation, tier, model prefs, mfa_on_login, …). Routes in
  `backend/src/routes/user.ts`: GET/POST/PATCH `/user/profile`
  (PATCH validates via `validateProfilePayload`), `/user/ui-preferences`,
  `/user/api-keys`, `/user/mcp-connectors`. Router mounted at both `/user`
  and `/users` (`backend/src/app.ts` lines ~202-203).
- **Matters** = `projects` (user_id NOT NULL → auth.users ON DELETE CASCADE,
  name, cm_number, practice, overview, `visibility text default 'private'`
  (UNUSED in code), `shared_with jsonb` = lowercased email array).
- **Access control** is centralized in `backend/src/lib/access.ts`:
  `checkProjectAccess`, `ensureDocAccess`, `ensureReviewAccess`,
  `filterAccessibleDocumentIds`, `listAccessibleProjectIds`. All logic is
  "owner OR email in shared_with". Every route goes through these — this is
  the single choke point for firm visibility.
- **Documents**: `documents` (project_id nullable, user_id, status,
  folder_id, `library_kind check in ('file','template')`,
  library_folder_id). Bytes live in `document_versions`
  (storage_path, pdf_storage_path, `source check in ('upload','user_upload',
  'assistant_edit','user_accept','user_reject','generated')`, filename,
  file_type, size_bytes, content_sha256…). Library = documents with
  project_id null + library_kind/library_folder_id; folders in
  `library_folders` (per-user, kind 'file'|'template').
- **Workflows**: `workflows` (user_id nullable, title, type, prompt_md,
  columns_config, language, practice, jurisdictions). Per-person sharing via
  `workflow_shares` (workflow_id, shared_by_user_id, shared_with_email,
  allow_edit, unique(workflow_id, email)). Global read-only catalog =
  `workflow_addons` (no user_id) imported per-user. `hidden_workflows`,
  `default_workflow_installations`, `quick_actions` also exist.
- **Audit**: `audit_events` (user_id, user_email, action, status, title,
  surface, project_id, chat_id, document_id, review_id, model, detail jsonb)
  already populated; `backend/src/routes/audit.ts` serves it (currently
  self-scoped).
- **Chat context**: `buildSystemPrompt` in `backend/src/lib/chat/prompts.ts`;
  matter overview + remembered facts already ride along per chat (the "case
  overview" mechanism) — firm/attorney context should follow the same pattern.
- **Frontend**: Next.js app dir. Pages under
  `frontend/src/app/(pages)/{assistant,history,library,projects,settings,
  tabular-reviews,workflows}`. Settings subpages:
  `settings/{api-keys,connectors,features,models,privacy-data,security}`.
  Login/signup at `app/login`, `app/signup`. Per-user display prefs go in
  `user_ui_preferences` via `/user/ui-preferences` (REUSE this for personal
  settings; do NOT invent a new store).
- **API base**: frontend is built with `NEXT_PUBLIC_API_BASE_URL=<pub>/_api`;
  new backend routes need no proxy work (Caddy sends `/_api/*` to :3001).

## 2. Target model (summary)

- One `firms` row per install. Every account is a member with a role:
  `admin` | `attorney` | `paralegal`. First/only firm is seeded by migration;
  the earliest-created existing user becomes admin.
- Accounts are invite-only (signup disabled; invite links minted by admins).
- A matter has: owner (`user_id`, the responsible attorney), `firm_id`, and
  visibility `private` | `firm`. `shared_with` (named people) stays and is
  orthogonal — access = owner OR email in shared_with OR (visibility='firm'
  AND active member of the same firm).
- Firm-scoped content: library folders/templates, workflows, standing
  instructions, drafting style defaults, provider API keys, allowed models.
- Attorney identity on the profile: bar admissions, signature block, title,
  phone, practice areas — injected into chat context and drafting tools.
- Admin panel at `/admin`: people, firm profile, content, AI settings,
  audit, usage.

Non-goals for now: multiple firms per install, conflict walls (see §8),
OneDrive sync (schema prep only, §9), per-matter roles.

---

## 3. Phase 1 — Foundation (firm, roles, invites, visibility, admin basics)

> **STATUS: BUILT AND DEPLOYED 2026-08-20.** What actually shipped, where it
> differs from the plan below, and what is still open:
>
> - **Migrations applied to the live database**: `20260820_02_firm_foundation.sql`
>   (firms / firm_members / firm_invites, `projects.firm_id`, user_id FK
>   CASCADE→RESTRICT, visibility narrowed to private|firm with a check
>   constraint, the seed) and `20260820_03_matter_visibility_in_lists.sql`
>   (adds a `visibility` column to both `get_projects_overview` overloads so
>   the matter list can badge firm matters — those two functions are dropped
>   and recreated, since a returned column cannot be added in place).
> - **The visibility rule lives in exactly two places, on purpose**: SQL
>   `public.can_access_project(...)` (called by all 7 list queries, which
>   previously each carried their own copy of the predicate) and TypeScript
>   `lib/access.ts`. `public.active_member_firm_id(...)` resolves the caller's
>   firm. Change one, change the other.
> - **Existing matters were left `private`.** Nothing that already existed
>   became firm-visible. Only *new* matters default to firm.
> - **Seed result**: one firm ("My Firm"), the earliest account is its
>   administrator.
> - **Verified**: backend suite green (780 passing); a 48-check API smoke test
>   against the live backend covering the admin gate, visibility, invitations,
>   deactivation, hand-over and the last-administrator guard.
> - **Deliberate narrowing of the admin's reach**: an administrator can rename,
>   delete and re-own *firm-visible* matters, but a **private** matter stays
>   between the people on it. An admin's power over a private matter is limited
>   to re-owning it through the recorded `/admin` route.
> - **Still open after Phase 1** (see §7 step 6): `GOTRUE_DISABLE_SIGNUP` is
>   still `false`, so public sign-up remains open until Ethan confirms his
>   account and one invitation round-trip. Until then the ordinary sign-up form
>   is still reachable; the invite flow does not depend on it.
> - **Known follow-up, not a Phase 1 blocker**: closing your own account still
>   deletes the matters you are responsible for (`deleteUserAccountData`
>   removes them explicitly, so the RESTRICT foreign key never fires). For a
>   firm, self-deletion should probably refuse while you still hold firm
>   matters, and point at hand-over instead.

### 3.1 Migration `backend/migrations/<date>_01_firm_foundation.sql`

```sql
create table if not exists public.firms (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address_lines text[] default '{}',
  phone text,
  website text,
  default_jurisdiction text,          -- e.g. 'Kansas'
  citation_style text,                -- free text, e.g. 'Bluebook'
  standing_instructions text,         -- rides every chat (Phase 3 consumes)
  drafting_defaults jsonb,            -- Phase 3 consumes
  allowed_models jsonb,               -- null = all allowed (Phase 4 consumes)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.firm_members (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms(id) on delete cascade,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  role text not null default 'attorney'
    check (role in ('admin','attorney','paralegal')),
  status text not null default 'active'
    check (status in ('active','deactivated')),
  can_edit_firm_library boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists firm_members_firm_idx on public.firm_members(firm_id);

create table if not exists public.firm_invites (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms(id) on delete cascade,
  email text not null,
  role text not null default 'attorney'
    check (role in ('admin','attorney','paralegal')),
  token uuid not null unique default gen_random_uuid(),
  created_by uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null default (now() + interval '14 days'),
  accepted_at timestamptz,
  accepted_user_id uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists firm_invites_email_idx on public.firm_invites(lower(email));

-- Projects belong to the firm; keep user_id as "responsible attorney" but
-- stop account deletion from destroying matters.
alter table public.projects add column if not exists
  firm_id uuid references public.firms(id) on delete set null;
alter table public.projects drop constraint if exists projects_user_id_fkey;
alter table public.projects add constraint projects_user_id_fkey
  foreign key (user_id) references auth.users(id) on delete restrict;
create index if not exists projects_firm_visibility_idx
  on public.projects(firm_id, visibility);

-- Seed: one firm, all existing users as members, earliest user = admin.
insert into public.firms (name)
  select 'My Firm' where not exists (select 1 from public.firms);
insert into public.firm_members (firm_id, user_id, role)
  select (select id from public.firms limit 1), u.id,
         case when u.id = (select id from auth.users order by created_at asc limit 1)
              then 'admin' else 'attorney' end
  from auth.users u
  on conflict (user_id) do nothing;
update public.projects
  set firm_id = (select id from public.firms limit 1)
  where firm_id is null;

-- Existing matters keep today's behavior: mark them private explicitly.
update public.projects set visibility = 'private'
  where visibility is null or visibility not in ('private','firm');

alter table public.firms enable row level security;
alter table public.firm_members enable row level security;
alter table public.firm_invites enable row level security;
-- plus the standard revoke-direct-roles block used by other backend tables.
```

Mirror all of it in `backend/schema.sql`.

**Deliberate choices** (do not re-decide): `visibility` collapses to
`private`/`firm` — the old `'shared'` value is meaningless because
`shared_with` works with either level. Deleting users is NOT the departure
path (restrict FK makes it fail if they own matters); deactivation is.

### 3.2 Backend

**New file `backend/src/lib/firm.ts`:**
- `getFirm(db)` → the single firms row.
- `getMembership(db, userId)` → `{firmId, role, status, canEditFirmLibrary} | null`.
- `isActiveMember(m)`, `isAdmin(m)` helpers.
- Small in-process cache (Map, ~30 s TTL) is acceptable; membership is read
  on most requests.

**New file `backend/src/middleware/requireAdmin.ts`** (or export from
firm.ts): runs after `requireAuth`; loads membership; 403 unless
`role==='admin' && status==='active'`; sets `res.locals.membership`.

**Deactivation enforcement**: in `auth.ts` `requireAuth`, after resolving the
user, look up membership; if `status==='deactivated'`, respond 403
`{detail:"Account deactivated"}`. Also ban the user in GoTrue on deactivation
(below) so tokens stop working — the middleware check is belt-and-braces.

**Access rules — edit `backend/src/lib/access.ts` only** (every route flows
through it):
- `checkProjectAccess`: select `visibility, firm_id` too. After the
  owner/shared_with checks, add: if `visibility==='firm'` and caller is an
  active member of `firm_id` → `{ok:true, isOwner:false}`. New param needed:
  callers currently pass `(projectId, userId, userEmail, db)` — add the
  membership lookup inside the helper (via firm.ts) rather than changing
  every call site.
- `listAccessibleProjectIds`: add a third query,
  `projects where visibility='firm' and firm_id = <caller's firm>` (skip if
  caller has no active membership).
- `filterAccessibleDocumentIds` already unions via
  `listAccessibleProjectIds` — no change beyond the above.
- **Owner-only stays owner-only** (delete, rename, member management,
  visibility change) via the existing `isOwner` flag — except admins: where a
  route checks `isOwner` for destructive matter ops, allow `isOwner || admin`.
  Find these call sites by grepping `isOwner` under `backend/src/routes/`.

**Invite + signup flow** (works with signup disabled and no real SMTP):
- `POST /admin/invites` {email, role} → insert firm_invites row; respond with
  the row including token and a ready-to-copy URL
  `${FRONTEND_URL}/signup?invite=<token>`. Admin copies the link to the
  invitee themselves (email/Teams/etc.).
- `GET /admin/invites` (list, incl. accepted/expired), `DELETE /admin/invites/:id`.
- **Public** `GET /auth/invite/:token` (no requireAuth) → {ok, email, firmName}
  if unexpired+unaccepted; 404 otherwise. Mount a tiny new router in app.ts.
- **Public** `POST /auth/accept-invite` {token, password, displayName} →
  validate token; create the user with the service role client
  (`admin.auth.admin.createUser({email, password, email_confirm:true})` —
  service-role creation bypasses GOTRUE_DISABLE_SIGNUP); insert firm_members
  with the invite's role; mark invite accepted; return ok (frontend then
  signs in normally). Handle "user already exists" as 409.
- Rate-limit both public endpoints with the existing limiter patterns in app.ts.
- After this ships and Ethan's account exists: set `GOTRUE_DISABLE_SIGNUP=true`
  in the root `.env` and recreate the auth container. The compose file already
  anticipates this (comment at line ~52).

**Admin user management** (`backend/src/routes/admin.ts`, mounted at
`/admin`, all behind requireAdmin):
- `GET /admin/members` → firm_members joined with user_profiles
  (email, display_name, role, status, created_at).
- `PATCH /admin/members/:userId` {role?, status?, canEditFirmLibrary?}.
  On `status:'deactivated'` also call
  `admin.auth.admin.updateUserById(userId, {ban_duration:'87600h'})`;
  on reactivate, `ban_duration:'none'`. Refuse to deactivate/demote the last
  active admin (count first).
- `PATCH /admin/projects/:id/owner` {userId} → reassign responsible attorney
  (validates target is an active member). List endpoint
  `GET /admin/projects?ownerId=` to drive the reassignment UI.
- `GET/PATCH /admin/firm` → firms row (name, address_lines, phone,
  default_jurisdiction, citation_style; later fields land in P3/P4).
- Write an `audit_events` row for every admin mutation
  (`action:'admin_member_update'`, `'admin_invite_create'`,
  `'admin_project_reassign'`, `'admin_firm_update'`; surface `'admin'`;
  detail = the change). Use the same insert helper the rest of the backend
  uses (`backend/src/lib/audit.ts`).

**Profile payload**: extend `loadProfile` (user.ts) to include
`{firm: {id, name}, role, status, canEditFirmLibrary}` so the frontend can
gate the admin UI. Never trust the frontend gate alone — requireAdmin is the
real gate.

**Matter visibility API**: in `backend/src/routes/projects.ts`, accept
`visibility` on create/update (owner or admin only; validate
'private'|'firm'), default new matters to `'firm'`, and include
`visibility`, `firm_id`, and an `owner_display_name` in list/detail payloads.
List payloads should mark `isOwner` so the UI can show "yours" vs "firm".

### 3.3 Frontend

- **Signup page** (`app/signup`): read `?invite=` param; call
  `GET /auth/invite/:token`; show the email fixed (not editable) + password +
  display name; submit to `/auth/accept-invite`, then sign in. With no/invalid
  token, show "Ask your firm admin for an invite link." Keep the existing
  open-signup form working until GOTRUE_DISABLE_SIGNUP is flipped, then it
  naturally stops working; the invite path must not depend on it.
- **Admin area** `app/(pages)/admin` with a left-tab layout matching the
  settings pages (`settingsStyles.ts` conventions): tabs People, Firm,
  (later: Content, AI, Audit, Usage). Nav entry visible only when
  `profile.role==='admin'`.
  - People: member table (name, email, role chip, status), role select,
    deactivate/reactivate, "Invite" button → dialog (email, role) → shows the
    generated link with a copy button. Reassign-matters flow for a
    deactivated member (list their matters, pick a new owner).
    Per the UI rules: no checkbox toggles for either/or settings — role and
    status are selects/segmented controls; destructive actions confirm.
  - Firm: name, address lines, phone, jurisdiction, citation style.
- **Matter visibility control**: in the matter's settings/sharing UI (in
  `app/(pages)/projects`), a two-option segmented control **Firm / Private**
  (not a checkbox), owner+admin only; the existing per-email sharing UI stays
  and works with both. Matter lists get a subtle "Firm" badge and show the
  responsible attorney's name on firm matters that aren't yours.

### 3.4 Acceptance (Phase 1 done when all pass)

1. Migration applies cleanly on the live DB (and on a fresh DB via schema.sql).
2. Existing single user is admin of the seeded firm; nothing else changed for
   them; both test suites green.
3. Admin invites a second account via link; invitee registers while
   GOTRUE_DISABLE_SIGNUP=true; lands as attorney.
4. New matter defaults to Firm; the other member sees it (list + open + chat
   + documents + matter search); a Private matter stays invisible to them.
5. Non-owner firm member CANNOT delete/rename a matter or change visibility;
   admin CAN.
6. Deactivated member: token stops working (banned), listed as deactivated,
   their matters reassignable by admin; deleting a user who owns matters
   fails at the DB (restrict) — deactivation is the offered path.
7. Cannot demote/deactivate the last admin.
8. Admin actions appear in audit_events.
9. Integration tests added under `backend/src/__tests__/integration/`
   covering: firm-visible access grant, private denial, admin gate (403 for
   attorney), invite accept flow, last-admin guard. Follow the style of
   `access.supabase.test.ts` / `projects.routes.test.ts`.

---

## 4. Phase 2 — Attorney identity (bar numbers, signature blocks)

### 4.1 Migration `<date>_01_professional_profile.sql`

```sql
alter table public.user_profiles add column if not exists prof_title text;          -- 'Partner', 'Paralegal'…
alter table public.user_profiles add column if not exists prof_phone text;
alter table public.user_profiles add column if not exists practice_areas text[] default '{}';
alter table public.user_profiles add column if not exists bar_admissions jsonb not null default '[]';
  -- [{"state":"Kansas","bar_number":"12345","status":"active"}]
alter table public.user_profiles add column if not exists signature_block text;
  -- exact plain-text block, newlines preserved
```

### 4.2 Backend

- Extend `validateProfilePayload` (user.ts) to accept the new fields with
  validation: bar_admissions = array of {state: nonempty string,
  bar_number: nonempty string, status?: 'active'|'inactive'}, max 20;
  signature_block ≤ 2000 chars; practice_areas string array ≤ 25.
- **New `backend/src/lib/draftingContext.ts`**:
  `getAttorneyContext(db, userId)` → formatted block:

  ```
  Attorney profile (use when drafting or signing):
  Name: <display_name>, <prof_title>
  Bar admissions: Kansas #12345 (active); Missouri #67890
  Phone: … Email: …
  Signature block:
  <signature_block verbatim>
  ```

  plus `getFirmContext(db)` → firm name/address/jurisdiction/citation style
  and (Phase 3) standing_instructions.
- Inject both into `buildSystemPrompt` (`backend/src/lib/chat/prompts.ts`)
  the same way the matter overview rides along — for matter chat, plain chat,
  and word-addin chat paths. Keep it short; it is context, not instructions.
- Drafting tools: where `generate_docx` / `write_document` /
  `replicate_document` assemble documents
  (`backend/src/lib/chat/tools/documentOps.ts` and the generate_docx
  formatting path from the 08-19 drafting-formatting work), the system prompt
  addition above is the mechanism — the model now has the real signature
  block and bar number to place. No tool-schema change required. Verify with
  acceptance test 3 below rather than adding plumbing.

### 4.3 Frontend

- Settings → new "My details" page (`settings/professional` or extend the
  main settings page): title, phone, practice areas (tag input), bar
  admissions (repeatable state+number rows), signature block (monospace
  multi-line textarea with a preview). Plain-language labels
  ("Signature block — pasted into letters exactly as written here").

### 4.4 Acceptance

1. Fields save/load through PATCH /user/profile; validation rejects garbage.
2. Ask the assistant (any matter) "draft a short letter to opposing counsel"
   → the produced .docx ends with the attorney's exact signature block and
   the letter references no invented bar number.
3. A paralegal account (no bar admissions) drafts → no fabricated bar number
   appears; signature block only if they set one.
4. Context block visible in the chat debug/system prompt path used by
   existing prompt tests; unit test for `getAttorneyContext` formatting.

---

## 5. Phase 3 — Firm content (library, workflows, instructions, styles)

### 5.1 Migration `<date>_01_firm_content.sql`

```sql
alter table public.library_folders add column if not exists
  firm_id uuid references public.firms(id) on delete cascade; -- null = personal
alter table public.documents add column if not exists
  firm_id uuid references public.firms(id) on delete set null; -- library docs only
create index if not exists library_folders_firm_idx
  on public.library_folders(firm_id) where firm_id is not null;
create index if not exists documents_firm_library_idx
  on public.documents(firm_id, library_kind, library_folder_id)
  where firm_id is not null and project_id is null;

alter table public.workflows add column if not exists
  firm_id uuid references public.firms(id) on delete cascade; -- null = personal
create index if not exists workflows_firm_idx
  on public.workflows(firm_id) where firm_id is not null;
```

Semantics: `firm_id null` = personal (today's behavior, untouched);
`firm_id set` + `user_id` kept = firm item with a recorded author.

### 5.2 Backend

**Firm library** (`backend/src/routes/library.ts`):
- Every list endpoint returns two scopes: personal (user_id = caller,
  firm_id null — unchanged queries) and firm (firm_id = caller's firm).
  Response shape: add `scope: 'personal'|'firm'` per item rather than
  separate endpoints, so the frontend renders one tree with two top-level
  sections.
- Read access to firm scope: any active member. Write (upload, rename, move,
  delete, new folder) in firm scope: `role==='admin' || canEditFirmLibrary`.
- "Publish to firm": `POST /library/documents/:id/publish` — owner of a
  personal library document copies it into the firm scope (new documents row
  with firm_id + copy of the latest document_versions row pointing at the
  same storage bytes if the storage layer allows, else re-upload the bytes;
  check how `document_versions.storage_path` is consumed before deciding).
  Also works for documents inside matters ("share this document with the
  firm" from the matter view) — copy, not move; the matter copy is untouched.
- Letterhead/templates: no special-casing — they are firm-scope documents
  with `library_kind='template'`, which `replicate_document` already reads.
- **Concrete must-fix**: `buildDocContext` in
  `backend/src/lib/chat/contextBuilders.ts` (~line 573) loads user-attached
  documents with `.eq("user_id", userId)` — a firm-scope template attached to
  a chat by a non-owner would silently drop out. Replace that filter with the
  access rules (owner OR accessible project OR firm-scope library item).

**Firm workflows** (`backend/src/routes/workflows.ts`):
- List = personal ∪ email-shared (existing) ∪ firm (firm_id = caller's firm).
  Tag each with `scope`.
- `POST /workflows/:id/publish-to-firm` (owner): copies the row with firm_id
  set (keep author user_id). The personal original remains; edits to the firm
  copy are admin/author-only. Firm workflows are not individually hideable
  per user via `hidden_workflows`? — they ARE: keep `hidden_workflows`
  working so a member can hide a firm workflow from their own list.
- Admin: `PATCH/DELETE /admin/workflows/:id` for firm-scope rows.

**Standing instructions & styles**:
- `PATCH /admin/firm` now also accepts `standing_instructions` (≤ 4000 chars)
  and `drafting_defaults` jsonb `{font?, font_size_pt?, line_spacing?,
  paragraph_style_notes?}`.
- `getFirmContext` (Phase 2 file) appends standing_instructions to every
  chat's system prompt; drafting_defaults feed the generate_docx formatting
  path (the copy-the-example + formatting-control work deployed 08-19) as the
  fallback when no example document is given.

### 5.3 Frontend

- Library page: two sections, "Firm library" and "My library" (existing tree
  under the second). Upload/new-folder buttons in the firm section only for
  admins/editors; everyone gets "Publish to firm" on their own items and on
  matter documents (with a confirm that says a copy becomes visible to the
  whole firm).
- Workflows page: "Firm" badge/section; "Publish to firm" action on own
  workflows.
- Admin → Content tab: manage firm workflows (rename/delete), designate
  library editors (this is the People tab's `canEditFirmLibrary` control —
  a role-like select "Library: can edit / read only", not a checkbox),
  edit standing instructions and drafting defaults (with a plain-language
  explainer: "Sent silently with every chat in the firm").

### 5.4 Acceptance

1. Member A (attorney, not editor) sees firm templates, uses one to draft via
   `replicate_document`; cannot upload into the firm section (403 + UI hides
   the control).
2. Admin uploads the firm letterhead once; both members' drafting uses it.
3. Publish-to-firm on a personal workflow → appears for everyone; original
   still editable privately; firm copy not editable by non-authors.
4. Standing instructions set to "We are a Kansas firm; cite Kansas law first"
   → visible effect in a fresh chat for a non-admin member.
5. A document inside a private matter published to the firm library is
   readable firm-wide while the matter stays invisible.
6. Integration tests: firm-library write gate, publish copy semantics,
   workflow list union (no duplicates when a workflow is both shared-by-email
   and firm-published).

---

## 6. Phase 4 — Oversight (audit viewer, usage, firm keys, model controls)

### 6.1 Migration `<date>_01_firm_keys.sql`

```sql
create table if not exists public.firm_api_keys (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms(id) on delete cascade,
  provider text not null,             -- same provider ids as user_api_keys
  encrypted_key text not null,        -- same encryption helper as user_api_keys
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique(firm_id, provider)
);
```

Reuse the encryption module `user_api_keys` uses (see
`backend/migrations/20260502_secure_user_api_keys.sql` and the code that
reads it) — same algorithm, same env secret.

### 6.2 Backend

- **Key resolution order** wherever provider keys are resolved for a chat
  call (grep the readers of `user_api_keys`): user's own key → firm key →
  server env key. One helper, used everywhere.
- **Allowed models**: `firms.allowed_models` (jsonb array of model ids; null
  = all). Enforce in the models listing route(s)
  (`backend/src/routes/models.ts`) AND server-side at chat time in
  `resolveModel`/`isAllowed` (`backend/src/lib/llm/models.ts`) — remember
  `ollama/`-prefixed ids are dynamic and must be matchable (allow entries
  like `"ollama/glm-5.2"` and treat the list as exact-match on the full id).
  Admins bypass nothing — the list applies to everyone; admin UI edits it.
- **Audit viewer**: `GET /admin/audit?userId=&action=&projectId=&from=&to=`
  + cursor pagination (reuse `backend/src/lib/pagination.ts`), returning
  events across all users. Read-only.
- **Usage**: `GET /admin/usage?month=YYYY-MM` → per user: chat message count
  and count by model, from `chat_messages` joined through chats (verify the
  role/model columns on `chat_messages` before writing the query — model is
  logged in audit_events too, which may be the simpler source:
  `action`-filtered counts grouped by user_email + model). Pick whichever
  source is accurate for "messages sent"; document the choice in the route.

### 6.3 Frontend

- Admin → AI tab: firm keys (set/replace/remove per provider; never display
  a stored key), allowed-models multi-select over the union of static MODELS
  + currently-listed ollama models, default model note ("personal choices
  still win" — they do, per the saved-preference behavior).
- Admin → Audit tab: filterable table (person, action, matter, date range),
  newest first.
- Admin → Usage tab: month picker, per-person table with model breakdown.

### 6.4 Acceptance

1. Remove the server env key for one provider, set it as a firm key → chats
   still work for all members; member's personal key (if set) wins.
2. Restrict allowed_models to two ids → other models disappear from every
   member's picker AND a direct API call with a forbidden model 4xxes.
3. Audit tab shows both members' actions; filters work; an attorney calling
   /admin/audit gets 403.
4. Usage numbers change when a member sends messages.

---

## 6b. Phase 5 — Form bank (precedents + fillable forms)

Goal: the firm banks its model documents once, and drafting starts from them
automatically — without the user hunting for or attaching anything. Two
distinct kinds live in one bank, distinguished by `usage_mode`:

- **`precedent`** (the primary case, per Ethan): documents for heavy
  inspiration — e.g. three or four operating agreements covering slightly
  different situations, or a wide set of asset purchase agreements. The
  assistant picks the best-fitting variant for the situation at hand, then
  ADAPTS it substantially: reworks parties/facts/deal terms, adds provisions
  the deal needs, drops ones it doesn't — while inheriting the precedent's
  formatting, numbering and structure. It may read a sibling variant to
  borrow a provision the chosen base lacks.
- **`fill`**: true fill-in-the-blank forms (certificate of service,
  engagement letter, intake forms). Structure is fixed; only the defined
  blanks change; `required_fields` drives a fill checklist.

**Why this is cheap in Mike**: the hard machinery already exists and maps
one-to-one onto the two modes — `replicate_document` copies a document
byte-for-byte (real fonts/numbering/letterhead); `write_document` is
explicitly built for whole-document precedent adaptation ("you may add
provisions the original did not have and drop ones it does not need");
`edit_document` handles targeted fills; and the system prompt already tells
the model to prefer a same-kind model document over drafting from scratch
(`backend/src/lib/chat/prompts.ts` ~line 62). What is missing is exactly one
thing: **discovery** — today a template reaches a chat only if the user
attaches it by hand (`buildDocContext` loads only explicitly attached IDs).
The form bank is a metadata + discovery layer over Phase 3's firm template
library, not a new document engine.

Depends on Phase 3 (firm-scope documents) and benefits from Phase 2 (fill
sources). Build order position: after Phase 3; can precede or follow Phase 4.

### 6b.1 Migration `<date>_01_form_bank.sql`

```sql
create table if not exists public.firm_forms (
  id uuid primary key default gen_random_uuid(),
  firm_id uuid not null references public.firms(id) on delete cascade,
  document_id uuid not null unique references public.documents(id) on delete cascade,
    -- must be a firm-scope library document, library_kind='template'
  title text not null,                 -- 'Operating Agreement — member-managed, 2 members'
  document_type text not null,         -- 'operating-agreement' (slug; VARIANTS of the
                                       -- same kind of document share this slug)
  usage_mode text not null default 'precedent'
    check (usage_mode in ('precedent','fill')),
  variant_notes text,                  -- what situation THIS variant covers, written
                                       -- to be compared against its siblings:
                                       -- 'member-managed, two individual members, KS'
  practice text,
  jurisdictions text[] default '{}',
  description text,                    -- when to use / when NOT to use
  drafting_guidance text,              -- notes to the assistant. For 'fill': what to
                                       -- change and what must never be touched. For
                                       -- 'precedent': which provisions are firm-standard
                                       -- and stay, which sections are deal-specific and
                                       -- expected to be reworked or cut.
  required_fields jsonb not null default '[]',
    -- 'fill' mode only (empty for precedents):
    -- [{"key":"client_name","label":"Client full name",
    --   "source":"ask|matter|attorney|firm","hint":"..."}]
  status text not null default 'draft' check (status in ('draft','approved')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists firm_forms_firm_status_idx
  on public.firm_forms(firm_id, status);
```

RLS + revoke block as usual. Only `status='approved'` forms are discoverable
in chat; `draft` is the curation staging state.

### 6b.2 Backend

**Admin CRUD** (`/admin/forms`, requireAdmin — or `canEditFirmLibrary`
editors; use the same gate as firm-library writes):
- `POST /admin/forms` {documentId, ...metadata} — validates the document is
  firm-scope + template kind.
- `GET /admin/forms`, `PATCH /admin/forms/:id`, `DELETE /admin/forms/:id`
  (delete removes the metadata row only, never the document).
- **Ingestion assist** `POST /admin/forms/analyze` {documentId}: reads the
  document text (existing extraction path), makes ONE model call (the
  configured default model) that proposes title, document_type, usage_mode
  (default 'precedent'; propose 'fill' when the text is dominated by blanks —
  underscored runs, `[bracketed]`, `{{placeholders}}`), variant_notes (if
  other bank entries share the proposed document_type, the call receives
  their variant_notes so the new description is written as a CONTRAST to the
  siblings), description, drafting_guidance, and — fill mode only —
  required_fields. Returns the proposal for the admin to edit before saving.
  Never auto-saves.

**Chat discovery — two pieces:**
1. **Catalog in the prompt**: for every chat by an active member, append a
   compact catalog of approved entries to the system prompt, GROUPED by
   document_type, each variant one line (title, usage_mode, variant_notes,
   jurisdictions) — the grouping is what lets the model see "the firm has
   four operating agreements" and choose between them or ask. Assemble in
   `buildSystemPrompt` alongside the Phase 2/3 firm context. Cap at ~50
   entries / ~2000 tokens; past the cap, switch to instructing the model to
   call `find_firm_form` first.
2. **New tool `open_firm_form`** ({form_id} or {document_type}) in
   `toolSchemas.ts` + `toolDispatcher.ts`: by form_id, loads that entry's
   document into the chat's `docIndex`/`docStore` (same registration the
   dispatcher does for replicate results, source_kind `library_template` so
   immutability rules apply) and returns its metadata (usage_mode,
   drafting_guidance, required_fields, variant_notes). By document_type,
   returns the metadata of ALL approved variants WITHOUT loading documents —
   the comparison step — after which the model opens one (or two) by id.
   Also add `find_firm_form` ({query}) for the >50-entries case: simple
   ilike/array match over title/document_type/variant_notes/practice/
   jurisdictions — no embeddings; revisit only if the bank grows past a few
   hundred.

**Drafting flow (prompt work, not plumbing)** — extend the drafting rules in
`prompts.ts`: when a request matches an approved document_type, prefer the
bank. Then by mode:
- **precedent**: compare variants via `open_firm_form(document_type)`; pick
  the best fit for the situation (matter facts + what the user said); if two
  variants fit equally and the choice is substantive, ask the user which
  situation applies instead of guessing. Then `open_firm_form(form_id)` →
  `replicate_document` → `read_document` → `write_document` on the copy:
  adapt fully to the deal — parties, facts, terms, provisions added/dropped —
  honoring drafting_guidance (firm-standard provisions stay). Borrowing: it
  MAY open one sibling variant to lift a provision the base lacks, and must
  say in the reply which precedent it started from and what it borrowed.
- **fill**: `open_firm_form(form_id)` → `replicate_document` → resolve
  required_fields (source 'matter' = matter facts/case overview, 'attorney' =
  Phase 2 attorney context, 'firm' = firm profile, 'ask' = ask the user and
  STOP until answered; never invent a value for a required field) →
  `write_document`/`edit_document` on the copy, changing nothing outside the
  blanks; drafting_guidance is verbatim law ("never alter paragraphs 7–9").
Either mode: always name the bank entry used in the reply, so the attorney
knows the starting point.

**Audit**: log form use (`action:'form_used'`, document_id, form id in
detail) — later this shows which forms the firm actually uses.

### 6b.3 Frontend

- Admin → Content tab → "Form bank" section: list GROUPED by document type
  (a group row like "Operating agreements (4)" expanding to its variants),
  each entry showing title, a Precedent/Fill chip, status chip, jurisdiction.
  Add flow = pick a firm template (or upload one, which routes through the
  firm-library upload) → "Analyze" → editable proposal (title, type,
  Precedent/Fill segmented control, variant notes, description, drafting
  guidance, and — fill mode only — the required-fields table) → save as
  draft → "Approve" (segmented Draft/Approved control, not a checkbox).
  Required-fields rows: label, source select (Ask / From the matter / From
  the attorney / From the firm), hint. Plain-language helper text under
  variant notes: "How this one differs from the firm's other <type>s — the
  AI reads these side by side to pick the right starting point."
- Library page: approved entries appear in the firm Templates section with a
  "Precedent" or "Form" badge; clicking shows the metadata. Members don't
  need to interact with them directly — the chat flow is the product.

### 6b.4 Acceptance

1. **Precedent pick**: admin banks two operating agreements as precedents
   (variant notes: "member-managed, two individual members" vs
   "manager-managed, entity member"). A different member, in a matter whose
   facts say two individual members, asks "draft an operating agreement for
   this client" WITHOUT attaching anything → assistant picks the
   member-managed variant, says so, and the result is a fully adapted
   agreement in the precedent's exact formatting/numbering — verify by
   opening the docx side-by-side with the precedent, not by trusting the
   chat transcript.
2. **Ambiguity**: same request in a matter whose facts don't settle the
   choice → the assistant asks which situation applies instead of guessing.
3. **Adaptation is real**: the produced agreement has the matter's parties
   and terms throughout (no leftover names/dates from the precedent), and a
   provision the deal doesn't need is gone while firm-standard provisions
   flagged in drafting_guidance survive verbatim.
4. **Fill mode**: admin banks the engagement letter as a fill form;
   "prepare our engagement letter for this client" pulls client/matter
   facts, the attorney's signature block, asks for the 'ask' fields (test
   with a fee amount — it must ask, never invent), and changes nothing
   outside the blanks.
5. A draft (unapproved) entry is never offered.
6. `open_firm_form` respects membership (a deactivated user's token gets
   nothing; entries never leak across firms if a second firm ever exists).
7. Integration tests: admin CRUD gates, approved-only catalog, grouped
   document_type metadata listing, open_firm_form registers the doc and
   immutability holds (write attempt on the original is refused, copy path
   works).

## 7. Rollout & ops (per phase)

1. Build/test in the tree (`docker compose run` for a throwaway backend, or
   the repo's test commands) — do not bounce live containers to iterate.
2. Apply the migration to the live DB (psql into the `db` container with the
   service credentials used by prior migrations).
3. Rebuild backend + frontend images (`docker compose build backend frontend`
   using the override's monorepo Dockerfile), then `up -d --no-deps backend
   frontend` (watch for the Created-state hang; `sudo docker start …`).
4. Verify against the public URL (login chain, one acceptance item per area).
5. Commit by path to the current shared working branch, merge to main per the
   fork's process (`gh pr merge` is blocked — push to main).
6. Phase 1 only: after Ethan confirms his account + one test invite worked,
   set `GOTRUE_DISABLE_SIGNUP=true` in the root `.env` and recreate the auth
   container (coordinate — this restarts auth for everyone).

## 8. Anticipated but deliberately NOT built

- **Conflict walls** ("everyone except X" on a firm matter): when needed, add
  `excluded_users jsonb default '[]'` (user ids) to projects and one check in
  `checkProjectAccess`/`listAccessibleProjectIds`. The Phase 1 shape makes
  this a two-line change; do not build it now.
- **Multiple firms**: all queries already key on firm_id; getFirm() is the
  only "single firm" assumption. Leave it.
- **Editor roles per template/folder**: one firm-wide editor flag is enough.

## 9. OneDrive readiness (schema prep only — Phase 1 migration may include it)

```sql
alter table public.documents add column if not exists external_source text
  check (external_source in ('onedrive','sharepoint') or external_source is null);
alter table public.documents add column if not exists external_id text;
alter table public.documents add column if not exists external_sync jsonb;
create index if not exists documents_external_idx
  on public.documents(external_source, external_id)
  where external_source is not null;
```

Rules to preserve until sync is built: bytes may later live outside Mike, so
no new code should assume `document_versions.storage_path` is always
populated for future source types (today it always is — keep the invariant
for existing sources); matter subfolders (`project_subfolders`) and library
folders stay a strict tree so they can mirror a OneDrive/SharePoint folder;
firm-visible matters are the natural SharePoint mapping, private projects the
personal-OneDrive mapping. `document_versions.source` gets a `'sync'` value
added to its check constraint when the integration lands, not before.

## 10. Suggested agent split

One phase per session, in order (1 → 2 → 3 → 5 → 4, or 4 before 5 — Phase 5
needs 3 and benefits from 2; Phase 4 is independent of both); each phase is
independently shippable and each ends with its acceptance list green plus
both test suites green. Do not start a later phase with an earlier one
unverified. Phase 1 is the largest (touches access.ts — highest blast
radius); its integration tests are not optional.
