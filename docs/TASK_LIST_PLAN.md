# Keeping the assistant on track through a long job — implementation plan

Written 2026-08-20 for a later implementation session. Read this whole file
before writing code.

The assistant writes down the steps of a long job before it starts, ticks them
off as it goes, and the system holds it to that list. This is not the citation
checklist that shipped on 2026-08-20; that one proves coverage of a document's
authorities. This one keeps a multi-part job from ending half-finished.

## For Ethan (plain-language summary)

Ask for something with several parts — prepare three notices, read the case
file, then check the citations in each — and the assistant now writes the steps
down first. You see a short checklist at the top of its reply that fills in as
it works, the same way Claude Code shows its plan.

The running commentary stays — watching it think is useful. What changes is that
it stops being a long scroll. Everything the assistant does before its answer —
its commentary, its reasoning, the tool activity — lives in a working area a few
lines tall that keeps the newest line in view instead of growing down the page,
and collapses to a single line when the job is done. So a finished answer is two
thin lines (the checklist, the working log) above the answer itself, instead of
today's seven "Completed in N steps" blocks and the paragraphs between them.
Both lines expand if you want the detail.

The part that matters most is invisible. If the assistant tries to finish while
steps are still outstanding, the system stops it and sends it back to finish
them. That is the difference between a checklist that decorates and one that
works.

---

## What this has to actually fix

Long jobs fail in specific ways. The design targets each one; anything that
doesn't target one of these is decoration.

1. **Stopping early while sounding finished.** The biggest one, and it is
   already documented in this codebase: on 2026-08-20 an answer reported
   "K.S.A. 17-1252 — ✅ Accurate" having never retrieved it. → the completion
   gate (mechanism 5).
2. **Quietly shrinking the job.** With a whole-list-rewrite tool the model can
   simply send back a shorter list. Claude Code has this hole too. → the core
   invariant, enforced in code.
3. **Drift.** By round 30 the plan written at round 2 has scrolled far out of
   attention. → re-injection (mechanisms 2 and 3).
4. **Never making a plan at all.** Observed: glm-5.2 said "Let me start a
   research notes file" and then ran five more tool batches before doing it.
   Prompt-only instructions are obeyed late or not at all on this model.
   → the late-start nudge (mechanism 1).
5. **Losing the plan at a pause.** `condenseForContinuation` replaces the whole
   working transcript with a written summary. → carry the list verbatim, out of
   band.
6. **Vague steps.** "Research the case" as one step is useless. → prompt
   guidance with a worked example, plus the two-step minimum in code.

This follows the harness rule already established here: **diligence is
mechanical, not promised.**

---

## The core invariant

> A step leaves the list only by being marked **done**, or by being marked
> **dropped with a reason the user will read**. Nothing else removes a step.

The system enforces it: if a step present in the stored list is absent from the
incoming one and was never done or dropped, it is **put back**, and the tool
result says so. This closes failure 2 and is the single most important rule in
the file.

`dropped` needs a non-empty reason, enforced in code. Note this is a
deliberate exception to the earlier decision to refuse a "blocked" status: a
blocked step sits in the list forever and becomes an escape hatch, whereas a
dropped step is terminal *and is printed for the user to see*. Visibility is
what makes it safe. Do not add any status that is neither terminal nor visible.

---

## The five mechanisms, weakest to strongest

**1. Late-start nudge.** If a turn reaches 12 tool rounds with no list, inject
once: "This is turning into a long job. Write the steps down with task_list
before going further." One shot per turn. No attempt to classify the request up
front — round count is a better signal than guessing from the wording.

**2. Tool-result echo.** Every `task_list` call returns the **normalised** list,
so the model sees what the system actually recorded rather than what it sent —
including any step that was put back.

**3. Staleness reminder.** When five tool rounds pass without the list being
touched while steps are outstanding, push a compact reminder naming the
outstanding steps. Triggered by staleness rather than on a timer, so a model
working the list properly is never nagged. Roughly 80 tokens; irrelevant against
the 700k budget.

**4. Budget-aware wrap-up.** `wrapUpInstruction` names the outstanding steps
outright. Today it asks the model to "end with a short list of what still needs
doing" — written from memory. Replace guesswork with state.

**5. The completion gate — the one that does the work.** When the model stops
calling tools and tries to finish, if steps remain outstanding it does not get
to finish. It is sent back with the list and told to either do the work or drop
the steps with a reason.

Implement the gate as **one callback**, not four copies:

```ts
// StreamChatParams
onBeforeFinish?: () => string | null;  // message to continue with, or null to allow finishing
```

Each of the four provider loops (`openai.ts`, `claude.ts`, `gemini.ts`,
`ollama.ts`) calls it at the point where it currently breaks out on "no tool
calls this round", and pushes the returned message instead of finishing. The
shared implementation lives beside the task list so the rules exist once.

Guards, all mandatory:
- At most **2** continuations per turn. Then it finishes regardless.
- Never continue past the run budget, and never after an abort — a user who
  pressed stop is not overruled.
- The gate also runs before `AssistantStreamCitationsFiled` is accepted, since
  filing citations is the other way a turn ends.
- Every continuation is logged with `devLog` so a job that keeps getting sent
  back is diagnosable.

---

## The tool

`task_list`, added to `TOOLS` in `backend/src/lib/chat/tools/toolSchemas.ts` —
the **base** list, not `PROJECT_EXTRA_TOOLS`, because multi-part drafting
happens in general chats too.

⚠️ `FORM_BANK_TOOLS` is the array whose exact contents a test pins with
`toEqual` (`formBankTools.test.ts:180`). `TOOLS` and `PROJECT_EXTRA_TOOLS` are
only checked with `toContain`/`not.toContain`
(`workflowAssetReplication.test.ts:86`), so extending `TOOLS` is safe. Do not
add to the wrong array.

```
{
  steps: [
    { step: string,
      status: "pending" | "doing" | "done" | "dropped",
      reason?: string }     // required when status is "dropped"
  ]
}
```

The whole list, every call. Do **not** add `complete_step`-style operations:
restating the list is the behaviour being bought, and incremental operations let
items fall out of mind.

### Normalising in code

New `backend/src/lib/chat/taskList.ts`, kept free of database and storage
imports so it is unit-testable alone — the same reason `authorityChecklist.ts`
duplicates one string constant instead of importing `researchNotes.ts`.

- Put back any step that vanished without being done or dropped (the invariant).
- At most one `doing`; extras demoted to `pending`, first wins.
- `dropped` with an empty reason is refused.
- Refuse a list of fewer than two steps: "a single step does not need a list".
  Without this, "what is the deadline?" gets a one-item list.
- Cap 20 steps, 200 characters each; drop exact-duplicate text.
- Steps are matched across calls by **normalised text** (trimmed, collapsed
  whitespace, lowercased). Reworded steps therefore read as new ones — accept
  that; the alternative is stable ids the model has to keep straight, which is
  more for it to get wrong.

---

## System prompt changes

A new section immediately after CORE RULES in
`backend/src/lib/chat/prompts.ts`. It governs how work is done generally, so it
belongs high and it belongs in the base prompt. It names no research tools, so
the test asserting the no-research prompt is free of "courtlistener" is
unaffected.

```
WORKING THROUGH A JOB WITH SEVERAL PARTS:
- Before starting work that has more than two distinct parts - several documents to prepare, a file to read and then act on, a set of authorities to check - call task_list with the steps, in the order you will do them.
- Write each step as the finished thing it produces, not the activity: "Draft the demand letter to Acme Holdings", not "look at the Acme file".
- Mark a step "doing" when you start it and "done" in the same response that finishes it. Do not leave the list until the end.
- A step leaves the list two ways only: done, or dropped with a reason the user will read. Never quietly remove one, and never shorten the list because the work is taking a while.
- If the job turns out to need work the list does not cover, add it.
- Do not restate the list in prose. It is already on the screen. Think out loud as much as is useful, but say what you found, not which step you are on.

Example - "prepare demand letters for the three defaulting lessees in the Graver file and check the authorities in each":
  1. Read the Graver file and identify the three lessees, amounts and default dates
  2. Draft the demand letter to Acme Holdings
  3. Draft the demand letter to Borden Equipment
  4. Draft the demand letter to Chen Leasing
  5. Check every authority cited across the three letters against its actual text
```

Why it is written this way:
- The worked example carries the granularity rule. The harness finding here is
  that examples beat instructions on small models.
- No escape hatches. "Never shorten the list because the work is taking a while"
  names the observed failure directly rather than leaving it to inference.
- The last line stops the list and the prose saying the same thing twice.
  Commentary itself is wanted and is not discouraged — the interface contains
  it rather than the prompt suppressing it.

Also update the existing research-notes line in LEGAL SOURCES so the two are not
confused: **the list is what still has to be done; the notes are what was
found.** One sentence, no more.

---

## The interface

### The checklist

One block, rendered from a single `task_list` event:

```
  ✓  Read the Graver file and identify the three lessees
  ✓  Draft the demand letter to Acme Holdings
  ▸  Draft the demand letter to Borden Equipment
  ·  Draft the demand letter to Chen Leasing
  ·  Check every authority cited across the three letters
```

- Renders at the position the list first appeared in the message, updating in
  place. Not pinned to the viewport — the chat already auto-scrolls and a fixed
  strip fights it.
- Done steps ticked and muted, current step marked, pending plain, dropped
  struck through with its reason beside it.
- When the turn ends: collapses to one line — "5 steps — all done", or
  "3 of 5 steps done, 1 dropped" — expandable. Expanded by default only if
  something is outstanding.

⚠️ **Latest wins, and only one is persisted.** A long job may update the list
fifteen times. The SSE stream carries every update so the block animates live,
but only **one** `task_list` entry may end up in the persisted `events[]` —
overwrite in place rather than appending, the way `turnEditState` keeps one
version row per document per turn. Getting this wrong bloats every
`chat_messages` row and every `contextBuilders` scan, and renders fifteen
blocks in reloaded history. This is the single biggest UI trap in the feature.

### The working area

Everything the assistant produces **before its final answer** — reasoning,
commentary paragraphs, and the "Completed in N steps" tool blocks — goes into
one working area sitting directly under the checklist.

While the turn runs:
- The working area has a **fixed height of about five lines** and keeps its
  newest line in view. Older material scrolls up inside it. The page does not
  grow as the job runs.
- The paragraph the assistant is writing **right now** renders at full size
  below the working area, so current thinking is comfortable to read.
- When tool activity follows a paragraph, that paragraph slides up into the
  working area. This is the rule that decides what is "working" and what is
  "the answer", and it needs no backend signal and no guessing: **a content run
  followed by tool activity is working; the run with nothing after it is the
  answer.**

When the turn ends:
- The whole working area collapses to one line — "Worked for 4 minutes ·
  34 steps" — expandable to the full log in original order.
- The checklist above it collapses to its own one-line summary.
- The final answer is untouched: full size, permanent, never inside the box.

A finished long answer therefore reads:

```
  [ ✓ 5 steps — all done                      ]   ← expandable
  [ › Worked for 4 minutes · 34 steps         ]   ← expandable

  The answer itself, at full size.
```

Two thin lines instead of seven blocks and the paragraphs between them, with
nothing thrown away.

Why the tool blocks stop mattering: `AssistantMessage.tsx:312` groups
**consecutive** non-content events into one "Completed in N steps" wrapper, and
a content event **splits** the run — which is why today's memo review rendered
seven of them. Once every one of those wrappers is inside a collapsed working
area, how many there are stops being a problem, so the grouping logic can be
left exactly as it is.

⚠️ Do not solve this by suppressing the commentary in the prompt. An earlier
draft of this plan did; it was the wrong trade. Watching the assistant think is
worth keeping, and the scroll is a layout problem with a layout fix.

### The trailing line

If a turn ends with steps outstanding, one line at the bottom: "Still to do:
draft the notice to Chen; check the authorities." Silent when everything is
done, matching the existing notes.

⚠️ **Consolidate the trailing notes before adding this.** An answer can already
carry two italic lines — the "not retrieved" diligence note and the citation
checklist — and this makes three. Refactor `streaming.ts` so all trailing notes
are collected and emitted as **one** italic block, capped at three lines,
before the third is added.

### The pause card

`stopReasonLabel` in `runBudget.ts` gains the counts: "Paused after 120 research
steps — 3 of 7 steps done." Improves a string that already exists.

---

## Storage and the long horizon

A long job may span several user messages, a pause, a restart and a day.

Migration:

```sql
alter table public.chats
  add column if not exists task_list jsonb,
  add column if not exists task_list_updated_at timestamptz;
```

`chats` currently holds only id / project_id / user_id / title / created_at.

⚠️ Apply with
`sudo docker cp file mike-db-1:/tmp/m.sql && sudo docker exec mike-db-1 psql -U postgres -f /tmp/m.sql`
— piping SQL over stdin is blocked in this environment.

Per **chat**, not per matter. A firm-wide matter workplan is a different,
product-level feature with its own permissions questions. Do not smuggle it in.

Lifecycle:
- Loaded at the start of every turn, so a follow-up message and "Keep going"
  both pick up the same list.
- Cleared automatically when a turn ends with every step done or dropped.
- The model may clear it by sending an empty list.
- Survives a backend restart, unlike the in-memory paused-turn store.
- If a list is outstanding when a new user message arrives, it is loaded and the
  injection says so plainly: "There is a list from earlier in this chat. If the
  user has moved on to something else, clear it." The model decides, and the
  decision is visible in the list.

### Resume

`condenseForContinuation` must carry the list **verbatim**, read from
`chats.task_list` rather than from the condensate. It is small, it is intent
rather than findings, and putting intent through a summariser is precisely how
steps get dropped. State it as a plain numbered list in the continuation
message, above the condensed notes.

The paused-turn plumbing already proven for research notes is the pattern to
copy: a live reference threaded through `StreamChatParams`, read inside the four
provider loops where `wrapUpInstruction` is pushed.

---

## What this does not do

The model writes its own list, so it can write a poor one, or tick a step it did
not really do. The trailing line therefore says steps were **marked** done,
which is the honest word.

A later extension could cross-check: a step reading "draft the demand letter"
marked done in a turn where no `doc_created` or `doc_edited` event fired is
suspicious. Deliberately **not** in version 1 — matching step text to events is
guesswork, and a false accusation is worse than no check.

---

## Order of work

1. `taskList.ts` — normalising, the invariant, rendering. Pure, with unit tests.
2. Migration, tool schema, dispatcher branch, load and save on the chat.
3. Prompt section, and the one-line split from research notes.
4. Re-injection: late-start nudge, staleness reminder, wrap-up, condense.
5. **The completion gate** — `onBeforeFinish` in `StreamChatParams`, all four
   provider loops, with its guards and logging.
6. Consolidate the trailing notes, then add the outstanding-steps line and the
   pause-card counts.
7. The checklist component, latest-wins, plus its collapsed summary.
8. The working area: fixed height with newest-line-in-view while streaming, the
   slide-up rule, and the collapse-to-one-line at turn end.
9. Browser verification and the A/B below.
10. Later, if wanted: seed the list from a firm workflow's steps when one is
    applied (`workflow_applied` already fires).

Steps 1–6 are backend and verifiable through the trailing line and the pause
card before any interface exists. Steps 7 and 8 are independent of each other
and can be reviewed separately.

---

## Tests and definition of done

**Unit.** The invariant (a vanished step comes back; a dropped step with a
reason does not; a dropped step without a reason is refused); one `doing`;
the two-step refusal; caps and duplicates; the late-start nudge firing once at
12 rounds and not at 11; the staleness reminder at 5 untouched rounds and not
before; the completion gate returning a continuation while steps are
outstanding, returning null after 2 continuations, and returning null when
aborted or out of budget; the condensed continuation carrying the list
unchanged; the trailing block staying at or under three lines when all three
notes fire.

**Browser (mandatory).** This codebase has repeatedly shipped work that passed
`tsc` and the full suite and was broken at first click — the citation checklist
counted the assistant's own notes as a document under review, and only the
browser caught it. Run a genuine three-document job in the Graver matter with
`glm-5.2 (local)`. Confirm: the list appears early; it ticks over as work lands;
the working area stays about five lines tall for the whole run and never grows
the page; the current paragraph is readable at full size and slides up when work
resumes; both the checklist and the working area collapse to one line each at
the end and expand again; the final answer never renders inside the box;
stopping part-way and pressing "Keep going" resumes against the surviving list;
a reloaded page shows one checklist block, not fifteen.

**The gate that decides whether this shipped.** Run the same three-document
request twice, once with the feature off and once on, and count the deliverables
that actually exist at the end. If the list does not increase the number of
finished documents, it is decoration and should not ship in that form. Record
both runs. Metrics from inside the model — steps it marked done — do not count;
count the documents.

---

## Files

- new: `backend/src/lib/chat/taskList.ts`,
  `backend/src/lib/__tests__/taskList.test.ts`,
  `backend/migrations/<date>_task_list.sql`,
  a checklist component and a working-area component under
  `frontend/src/app/components/assistant/`
- `backend/src/lib/chat/tools/toolSchemas.ts` — the tool, in `TOOLS`
- `backend/src/lib/chat/tools/toolDispatcher.ts` — the branch
- `backend/src/lib/chat/prompts.ts` — the new section, and the notes split
- `backend/src/lib/chat/streaming.ts` — turn state, single persisted event,
  trailing-note consolidation, outstanding-steps line
- `backend/src/lib/llm/types.ts` — the live reference and `onBeforeFinish`
- `backend/src/lib/llm/{openai,claude,gemini,ollama}.ts` — reminders and the gate
- `backend/src/lib/llm/runBudget.ts` — `wrapUpInstruction`, `stopReasonLabel`
- `backend/src/lib/chat/runResume.ts` — carry the list through condensing
- `backend/src/routes/chat.ts`, `backend/src/routes/projectChat.ts` — load and
  save around the turn
- `frontend/src/app/components/shared/types.ts` — the event type
- `frontend/src/app/components/assistant/AssistantMessage.tsx` — render the
  checklist, and route pre-answer groups into the working area using the
  "followed by tool activity" rule (the grouping logic itself stays as it is)

## State of the tree when this was written (2026-08-20)

Two related features shipped earlier the same day and are **live on the server
but not committed** — the working tree is dirty on purpose:

- **Research notes** (`backend/src/lib/chat/researchNotes.ts`, tool
  `research_notes`): a running `.txt` notes document per chat, stored the way a
  typed "Text" note is, appended as a new version per call. Migration
  `20260820_09_research_notes.sql` is **already applied** to the database.
- **Citation checklist** (`backend/src/lib/chat/authorityChecklist.ts`): the
  system extracts a reviewed document's authorities and reports at the end which
  were never retrieved.

Both are worth reading before starting, because this feature reuses their
shapes:

- `authorityChecklist.ts` is the model for `taskList.ts`: a **pure** module with
  no database or storage imports, so it unit-tests on its own. It deliberately
  duplicates one string constant rather than importing `researchNotes.ts`, with
  a test asserting the two still match. Do the same rather than reaching for a
  convenient import.
- The live-reference-through-`StreamChatParams` plumbing this plan needs is
  already in place for `params.researchNotes`, threaded through all four
  provider loops. Copy that pattern exactly; it is proven.
- The trailing italic note mechanism (both notes at the end of
  `runLLMStream`) is what the outstanding-steps line joins, and is why they must
  be consolidated first.

⚠️ **Other Claude sessions have uncommitted work in this same tree.** Files
appeared mid-session on 2026-08-20 that were nothing to do with the work in
hand (`liveAnswers.ts`, `scripts/deploy.sh`, `app.ts`, `docker-compose.yml`).
Do not commit unless asked, and if asked, **commit only your own paths by
name**. Never `git stash`, `git reset` or `git checkout`.

Backend test count was 975 passing / 24 skipped after those two features. There
is one pre-existing uncaught error in
`src/__tests__/integration/projectChat.routes.test.ts` ("write after end" on a
deliberate stream-failure test) — it was there beforehand and is not a
regression to chase.

## Environment reminders

The tree at `~/mike` on VM 133 (`ssh 192.168.68.133`, branch
`feat/statute-citations`) is **shared** — other sessions have uncommitted work in
it. Never run `git stash/reset/checkout`; commit by path only, and only if
asked. Build and test with
`sudo docker run --rm -v /home/ubuntu/mike:/work -w /work/backend node:22-slim sh -c "./node_modules/.bin/tsc --noEmit && npx vitest run"`.
Deploy with `sudo docker compose build backend` then
`sudo docker compose up -d --no-deps backend`, detached from the SSH session.
A frontend change needs `sudo docker compose build frontend` as well. Test in
the Graver matter (`3bb3ee1f-5a9d-447c-a691-6e34c8ea5cec`) with model
`glm-5.2 (local)`; the default Gemini model has no key.
