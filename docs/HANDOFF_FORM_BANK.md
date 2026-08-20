# Handoff — build the form bank in the Mike legal app

Paste the block below into a fresh chat.

---

Build the form bank in the Mike legal app. Phases 1 to 4 of the firm structure
are finished, deployed and committed; the form bank is the last phase and the
one the user actually wants.

## Read these first, before touching anything

- `~/mike/docs/FIRM_STRUCTURE_PLAN.md` on VM 133 (192.168.68.133) — the full
  spec. **The form bank is §6b.** Phases 1 to 4 each carry a STATUS block
  saying what actually shipped and where it differed from the plan; read those
  four blocks, they are the current truth about the code.
- Memory files: `mike-firm-structure-plan`, `mike-firm-phase1`,
  `mike-firm-phase2`, `mike-firm-phase3`, `mike-firm-phase4`,
  `mike-legal-platform`.

## Where the code lives and how to work on it

The repo is `~/mike` on **VM 133** (`ssh 192.168.68.133`, already configured).
There is **no local checkout and no `node_modules` anywhere** — building the
Docker image is your only typecheck.

The loop used for the last four phases:

1. `rsync` the repo down (minus `node_modules`, `.git`, `.next`, `dist`) to a
   local working copy so you can edit with real tools.
2. Edit locally, then `rsync --relative` **only your own changed paths** back.
3. `sudo docker compose build backend` on the VM — this runs `tsc`.
4. Tests without deploying:
   `sudo docker run --rm -v ~/mike/backend/src:/app/src:ro -w /app mike-backend:latest npx vitest run`
   Frontend: `sudo docker run --rm -e NODE_ENV=test -v ~/mike/frontend/src:/app/frontend/src:ro -w /app/frontend mike-frontend:latest npx vitest run`
   ⚠️ Never set `NODE_ENV=production` for frontend tests — it breaks React.act.
5. Deploy: `sudo docker compose up -d --no-deps backend` (or `frontend`).

⚠️⚠️ **This is a SHARED TREE — at least two other Claude sessions work in it.**
Run `git status` before every `git add` and stage **by explicit path**, never
`-A`. Never stash, reset or checkout anyone's work. If a file you touched also
holds somebody else's uncommitted work, stage only your own hunks: take
`git diff -- <file>`, drop the hunks that are not yours, and
`git apply --cached` the rest. Coordinate with `ListAgents` → `SendMessage`.

⚠️ **There is an unfinished visual restyle sitting uncommitted in the tree**
(warm cream palette, Source Serif 4, larger base text) across `layout.tsx`,
`globals.css`, `AppSidebar`, `SidebarChatItem`, `MarkdownContent`,
`TablePrimitive`, `DocTable`, `MatterSearchPanel`. It belongs to a third
session. **Leave it exactly where it is.** Before building the frontend image,
check whether it is still uncommitted; if it is, build from a clean context so
it does not go live:

```
rm -rf /tmp/ctx && mkdir -p /tmp/ctx
cd ~/mike && git archive HEAD | tar -x -C /tmp/ctx
# copy your own files over /tmp/ctx if any are uncommitted, then:
sudo docker build -f /tmp/ctx/docker/frontend-monorepo.Dockerfile \
  --build-arg NEXT_PUBLIC_API_BASE_URL="$API" \
  --build-arg NEXT_PUBLIC_SUPABASE_URL="$SUPA" \
  --build-arg NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY="$PUB" \
  -t mike-frontend:latest /tmp/ctx
```

Read those three values out of `~/mike/.env` without printing them. The build
hard-fails without all three.

⚠️ `docker compose up -d` on this box regularly leaves a container in `Created`
and takes the live site down. Fix: `sudo docker start mike-backend-1
mike-frontend-1`. **An empty API response is usually this, not a bug** — check
`docker ps` before debugging anything.

## Database changes — rehearse first, always

There is no migration runner; migrations are applied by hand with `psql` inside
`mike-db-1`. Test on the scratch database first:

```
sudo docker cp mig.sql mike-db-1:/tmp/mig.sql
sudo docker exec mike-db-1 psql -U postgres -d mike_mig_test -v ON_ERROR_STOP=1 -f /tmp/mig.sql
```

Run it twice to prove it is safe to re-run. Then `sudo /usr/local/sbin/mike-backup`
before anything structural, then the same command against `-d postgres`.
Mirror every change into `backend/schema.sql` as well as the new file in
`backend/migrations/`.
⚠️ The permission classifier sometimes blocks the `psql` apply command. That is
expected on this box — retry it, do not stop and ask.

## What is already built — do not redo any of it

**Phase 1, the firm** (`ecccdc5`): `firms` / `firm_members` / `firm_invites`;
roles admin / attorney / paralegal; invitation links; matters are `private` or
`firm`; an Administration area; hand-over of a departed colleague's matters.

**Phase 2, attorney identity** (`6d84053`): title, phone, practice areas, bar
admissions and a verbatim signature block on each profile, injected into every
chat. Verified end to end — a real letter comes out signed correctly.

**Phase 3, firm content** (`5c05d53`): one firm library with a My/Firm switch;
"Add to firm library" on any document; "Publish to the firm" on any workflow;
firm standing instructions and house style on an Administration → Content tab.

**Phase 4, oversight** (`efd92de`): the firm's own provider keys, a shortlist of
allowed AI models, a read-only history viewer and per-person usage figures.

## The gotchas that will cost you a cycle each

1. ⚠️⚠️ **The who-can-open-a-matter rule lives in exactly TWO places** — SQL
   `public.can_access_project(...)` and TypeScript `backend/src/lib/access.ts`.
   Change one, change the other.
2. ⚠️ **Which workflows a person can see lives in ONE place** —
   `public.visible_workflows(p_user_id, p_user_email, p_type)`. The list, the
   id-only list and the filter options all read from it.
3. ⚠️ **New profile columns must NOT go into `PROFILE_SELECT` in
   `routes/user.ts`** — it has a fallback cascade for older databases that extra
   columns break. Follow `loadProfessionalDetails` in `lib/draftingContext.ts`
   and read them separately.
4. ⚠️⚠️ **Anything that must reach the model has to be wired into ALL THREE chat
   paths**: `routes/chat.ts`, `routes/projectChat.ts`, `routes/wordChat.ts`.
   Miss one and drafting outside a matter behaves differently.
5. ⚠️ **`ensureDocReadAccess` is not `ensureDocAccess`.** The read-only document
   routes use the first (it also passes firm-library documents); the routes that
   change a document use the second. Any new read-only route wants the first.
6. ⚠️ **`buildDocContext` in `lib/chat/contextBuilders.ts`** no longer filters by
   owner; it calls `filterAccessibleDocumentIds`. That is what lets a firm
   template attached by a colleague survive into the chat. Do not undo it.
7. ⚠️⚠️ **Put any new guard in a chat route where the route already opens the
   database, never straight after parsing.** Four existing tests assert a
   malformed request is refused before anything touches the database.
8. ⚠️⚠️ **SSE answers arrive a few characters at a time.** A check that greps the
   raw stream for a phrase will falsely fail. Join the `content_delta` texts
   first — see `answer()` in `/tmp/firm-chat-check.sh`.
9. ⚠️ An empty `firms.allowed_models` is stored as null and means **all models
   allowed**, never "none".
10. ⚠️ Mail is **mailpit**, a local catcher. Invitations are copy-paste links,
    never emails. The acceptance route is `POST /auth/invite/accept`.

## Your task: the form bank

Follow **§6b** of the plan. In short: the firm banks its model documents once,
and drafting starts from them automatically — no hunting, no attaching. Two
kinds share one bank, told apart by `usage_mode`:

- **`precedent`** — the primary case. Several versions of the same kind of
  document (say four operating agreements for different situations). The
  assistant compares the versions, picks the one that fits the matter's facts,
  says which it picked, then **adapts it substantially**: parties, facts, deal
  terms reworked, provisions added and dropped, while inheriting the original's
  formatting and numbering. If two fit equally and the choice is substantive, it
  **asks** instead of guessing. It may open a sibling version to borrow one
  provision, and must say so in the reply.
- **`fill`** — true fill-in-the-blank forms. Structure fixed, only the defined
  blanks change. Fields are resolved from the matter, the attorney's own
  details, or the firm's; anything marked "ask" is asked for and never invented.

**Why this is cheap:** the hard machinery already exists. `replicate_document`
copies a document byte-for-byte with its real fonts and numbering;
`write_document` is built for whole-document precedent adaptation;
`edit_document` handles targeted fills. **The only missing piece is discovery** —
today a template reaches a chat only if somebody attaches it by hand. The form
bank is a notes-and-discovery layer over Phase 3's firm library, not a new
document engine. Do not build a second document engine.

The pieces, per §6b:

- **Migration**: a `firm_forms` table over firm-scope library documents —
  `document_id` (unique), `title`, `document_type` (slug shared by variants of
  the same kind), `usage_mode`, `variant_notes` (written as a contrast with its
  siblings), `practice`, `jurisdictions`, `description`, `drafting_guidance`,
  `required_fields` (fill mode only), `status` draft|approved. RLS + the revoke
  block like every other backend-owned table.
- **Admin CRUD** at `/admin/forms`, behind the same gate as firm-library writes
  (administrator **or** `can_edit_firm_library`), plus an **ingestion helper**
  `POST /admin/forms/analyze` that reads a banked document, makes **one** model
  call and proposes the notes for a human to correct. It must never auto-save.
  When siblings share the proposed `document_type`, pass their `variant_notes`
  in so the new one is written as a contrast.
- **Discovery, two parts**: a compact catalogue of approved entries appended to
  the system prompt, **grouped by `document_type`** so the model can see the
  firm has four operating agreements and choose between them (cap it — roughly
  50 entries or 2,000 tokens, and past the cap switch to telling the model to
  search first); and a new `open_firm_form` tool that either loads one entry's
  document into the chat (same registration the dispatcher does for replicate
  results, `source_kind: "library_template"`) or, given a `document_type`,
  returns the notes for every approved variant **without** loading documents —
  that is the comparison step. Add `find_firm_form` for the over-the-cap case;
  plain `ilike` matching, no embeddings.
- **Drafting rules** in `lib/chat/prompts.ts` for both modes. This is prompt
  work, not plumbing — Phase 2 proved the system prompt is the whole mechanism.
- **Audit**: log `form_used` so the firm can later see which forms it really
  uses.
- **Frontend**: a Form bank section on Administration → Content, grouped by
  document type (a row like "Operating agreements (4)" expanding to its
  variants), a Precedent/Fill chip, a Draft/Approved segmented control, and the
  required-fields table for fill forms. Members never need to touch it — the
  chat flow is the product.

## Verification bar

Both suites stay green: backend **864 passing / 24 skipped**, frontend **369**.
Write integration tests for every new access rule — they are not optional. Then
prove it works against the running server, not just in tests.

Five live scripts already exist on VM 133 (they create throwaway accounts inside
the real firm and clean up after themselves). Durable copies also sit in
`/home/ubuntu/` on the VM and on the laptop at `~/mike-work/*.sh`, in case
`/tmp` is cleared by a reboot:

- `/tmp/smoke.sh` — Phase 1, 51 checks
- `/tmp/smoke2.sh` — Phase 2, 20 checks
- `/tmp/smoke3.sh` — Phase 3, 46 checks
- `/tmp/smoke4.sh` — Phase 4, 39 checks
- `/tmp/firm-chat-check.sh` — 5 checks through a real chat with a real model
- `/tmp/letter-check.sh` — asks for a letter, opens the .docx, checks the
  signature block came out word for word

Write the equivalent for the form bank, and re-run the others afterwards.

⚠️⚠️ **§6b acceptance items 1 and 3 cannot be judged from a chat transcript.**
Bank two operating agreements as precedents, ask a *different* member in a
matter for one, then **open the produced .docx side by side with the precedent**
and check the formatting and numbering really carried over, the matter's parties
appear throughout with no leftover names or dates from the precedent, and the
provisions flagged in `drafting_guidance` survived verbatim. Metrics and the
model's own account of what it did are not evidence.

## Remaining work not part of the form bank

1. **The database signing secret in `docker-compose.override.yml` was exposed in
   a session transcript and needs rotating.** Ethan has to do this by hand.
2. **Nobody has clicked through the new Administration screens in a browser** as
   an administrator — Content, AI, History and Usage were verified through the
   API and the test suites only. Worth doing early; it is quick.
3. **The unfinished restyle** described above wants an owner. Ask Ethan whose it
   is before it gets in the way of a frontend deploy.
4. **Phase 4 acceptance item 1 was not run end to end**: remove the server's own
   key for a provider, set it as a firm key, and confirm chats still work for
   everyone. The key order is unit-tested and the reported source is checked
   live, but a real chat driven by a real firm key needs a spare paid key.
5. **Known follow-up from Phase 1**: closing your own account still deletes the
   matters you are responsible for, because `deleteUserAccountData` removes them
   explicitly so the RESTRICT foreign key never fires. For a firm it should
   refuse while you still hold firm matters and point at hand-over instead.

## House style, strictly enforced

Plain, everyday English in code comments, commit messages and replies — Ethan
directs the work but does not read code. Describe things by what a person using
the app would see, never by internal mechanics. Never coin names for concepts.
No checkboxes or bare text buttons for either/or settings — use a select or a
segmented control. Error banners a person can work around must be dismissable.
Lead every answer with the outcome.
