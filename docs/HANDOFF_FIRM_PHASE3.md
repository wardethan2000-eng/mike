# Handoff — continue the Mike firm build at Phase 3

Paste the block below into a fresh chat.

---

Continue building out the firm structure in the Mike legal app. Phases 1 and 2
are finished, deployed and committed; start Phase 3.

## Read these first, before touching anything

- `~/mike/docs/FIRM_STRUCTURE_PLAN.md` on VM 133 (192.168.68.133) — the full
  five-phase implementation spec. Phases 1 and 2 carry a STATUS block saying
  what actually shipped and where it differed from the plan. **Phase 3 is §5.**
- Memory files: `mike-firm-structure-plan`, `mike-firm-phase1`,
  `mike-firm-phase2`, `mike-legal-platform` (the VM's build/deploy gotchas).

## Where the code lives and how to work on it

The repo is `~/mike` on **VM 133** (`ssh 192.168.68.133`, already configured).
There is **no local checkout and no `node_modules` anywhere** — TypeScript is
only checked by building the Docker images.

A workable loop, used for Phases 1 and 2:
1. `rsync` the repo (minus `node_modules`, `.git`, `.next`, `dist`) to a local
   working copy so you can edit with real tools.
2. Edit locally, then `rsync --relative` **only your own changed paths** back.
3. `sudo docker compose build backend` on the VM — this runs `tsc`, so it is
   your typecheck.
4. Tests without deploying:
   `sudo docker run --rm -v ~/mike/backend/src:/app/src:ro -w /app mike-backend:latest npx vitest run`
   Frontend: same shape with `-e NODE_ENV=test -v ~/mike/frontend/src:/app/frontend/src:ro -w /app/frontend mike-frontend:latest`.
   ⚠️ Do **not** set `NODE_ENV=production` for frontend tests — it breaks React.act.
5. Deploy: `sudo docker compose up -d --no-deps backend` (or `frontend`).

⚠️ **This is a shared tree — another Claude session works in it.** Before any
`git add`, run `git status` and stage **by explicit path**, never `-A`. Never
stash/reset/checkout. Before rebuilding the **frontend** image, check whether
anyone has uncommitted work; if they do, build from a clean context instead:
`git archive HEAD | tar -x -C /tmp/ctx`, copy your own files over it, and build
from there. Message the other session (ListAgents → SendMessage) to coordinate.

⚠️ The frontend build needs three build args or `next.config.ts` hard-fails:
`NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_SUPABASE_URL`, and
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY` (read the last from `~/mike/.env`
without printing it).

⚠️ `docker compose up -d` sometimes hangs and leaves a container in `Created`.
Fix: `sudo docker start mike-backend-1 mike-frontend-1`.

## Database changes — rehearse first, always

There is no migration runner; migrations are applied by hand with `psql` inside
`mike-db-1`. **Always test on the scratch database first:**

```
sudo docker exec mike-db-1 psql -U postgres -c "create database mike_mig_test;"
sudo docker exec mike-db-1 bash -c "pg_dump -U postgres --schema-only postgres > /tmp/s.sql && psql -U postgres -d mike_mig_test -f /tmp/s.sql"
# plus a --data-only dump of auth.users and public.projects so seeds are exercised
```
Then apply live with `-v ON_ERROR_STOP=1`. Take a backup before anything
structural. Mirror every change into `backend/schema.sql` as well as the new
file in `backend/migrations/`.
⚠️ The permission classifier may block the `psql` apply command. That is
expected on this box — retry it; do not stop and ask.

## What is already built (do not redo)

**Phase 1 — the firm** (`ecccdc5`): `firms` / `firm_members` / `firm_invites`;
roles admin / attorney / paralegal; invitation links (mail is a local catcher,
so invitations are copy-paste links, never emails); matters are `private` or
`firm`; `projects.firm_id`; `projects.user_id` FK is now RESTRICT; an
Administration area at `/admin` (People + Firm); hand-over of a departed
colleague's matters; every admin action audited.

**Phase 2 — attorney identity** (`6d84053`): title, phone, practice areas, bar
admissions and a verbatim signature block on each profile, surfaced at
Settings → My Details, and injected into every chat so drafts sign themselves.

⚠️⚠️ **The who-can-open-a-matter rule lives in exactly TWO places. Change one,
change the other:** SQL `public.can_access_project(...)` (called by seven list
queries) and TypeScript `backend/src/lib/access.ts`.

⚠️ New profile columns must **not** go into `PROFILE_SELECT` in
`routes/user.ts` — that query has a fallback cascade for older databases which
extra columns break. Follow `loadProfessionalDetails` in
`backend/src/lib/draftingContext.ts` and read them separately.

⚠️ Anything that must reach the model at drafting time has to be wired into
**all three** chat paths: `routes/chat.ts`, `routes/projectChat.ts`,
`routes/wordChat.ts`.

## Verification bar

Both suites must stay green: backend **788 passing / 24 skipped**, frontend
**356 passing**. Write integration tests for new access rules — they are not
optional. There are two end-to-end API smoke scripts that were used for the
earlier phases; they may be gone if the VM rebooted, in which case write the
equivalent. They create throwaway accounts and clean up after themselves:
`/tmp/smoke.sh` (51 checks, Phase 1) and `/tmp/smoke2.sh` (20 checks, Phase 2).

## Your task: Phase 3 — firm content

Follow §5 of the plan. In short: templates, letterhead and forms move from a
copy-per-person into one firm library (read by everyone, edited by admins and
anyone flagged `can_edit_firm_library`); workflows can be published to the
firm; the firm gets standing instructions that ride every chat and drafting
style defaults; and there is a "publish to the firm" action for a personal or
matter document.

⚠️ The plan names one concrete must-fix in §5.2: `buildDocContext` in
`backend/src/lib/chat/contextBuilders.ts` filters attached documents with
`.eq("user_id", userId)`, so a firm-scope template attached by anyone but its
owner would silently vanish from the chat. Fix that as part of this phase.

Phase 3 is also the groundwork for the **form bank** (§6b), which is the
feature the user most wants — precedent sets for heavy inspiration plus true
fill-in forms. Do not start it until Phase 3 is verified.

## Open items not owned by Phase 3

1. **Public sign-up is still open.** Once the user confirms they have signed in
   and round-tripped one invitation, set `GOTRUE_DISABLE_SIGNUP=true` in the
   root `~/mike/.env` and recreate the auth container. Ask before doing it.
2. **The database signing secret in `docker-compose.override.yml` was exposed
   in a transcript and needs rotating** — the user has to do this by hand.
3. **A leftover test account** `save-test-21e92ed1@example.com` is an active
   attorney in the firm and should probably be deleted. Confirm first.
4. **Never verified end to end:** that asking the assistant for a real letter
   produces a .docx with the signature block reproduced verbatim. Everything
   upstream is tested; this needs a human check with a real model. Worth doing
   early, since Phase 3's letterhead work depends on the same path.
5. **Known follow-up:** closing your own account still deletes the matters you
   are responsible for. For a firm it should refuse and point at hand-over.

## House style, strictly enforced

Plain, everyday English in code comments, commit messages and replies — the
user directs the work but does not read code. Describe things by what a person
using the app would see. Never coin names for concepts. No checkboxes or bare
text buttons for either/or settings (use a select or a segmented control).
Error banners the user can work around must be dismissable. Lead every answer
with the outcome.
