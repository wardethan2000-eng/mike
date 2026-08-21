# Research Notes Scratchpad + Citation Checklist — Implementation Plan

Written 2026-08-20 for a fresh implementation session. Read this whole file
before writing code. The goal of both features is the same: make long,
thorough legal research work *durable* and *auditable*, so nothing the
assistant found is lost and nothing it skipped goes unnoticed.

## For Ethan (plain-language summary)

- **Feature A — Research notes.** During a long research job, the assistant
  keeps a running notes document inside the matter, writing down each finding
  as it makes it ("citation 3: verified against the opinion text, pin cite
  correct"). You can open it while the work runs, it survives if the session
  pauses or ends, and a later chat can pick up from it instead of starting
  over.
- **Feature B — Citation checklist.** When the assistant is asked to check
  the citations in a document, the system itself first lists every authority
  the document cites, then reports at the end which ones were actually
  checked and which were not. The assistant cannot quietly skip one.

---

## Context the implementer must know

### Where things run
- The app lives on Proxmox VM 133 (`ssh 192.168.68.133`, tree at `~/mike`,
  branch `feat/statute-citations`). It is a SHARED tree: other sessions may
  have uncommitted work. Never run `git stash/reset/checkout`; commit by
  path only if asked to commit.
- Build/test: the host has no node. Use
  `sudo docker run --rm -v /home/ubuntu/mike:/work -w /work/backend node:22-slim sh -c "./node_modules/.bin/tsc --noEmit && npx vitest run --silent"`.
- Deploy: `cd ~/mike && sudo docker compose build backend` then
  `sudo docker compose up -d --no-deps backend` (run compose detached from
  the SSH session with nohup; if a container is left in "Created", plain
  `sudo docker start <name>` fixes it). Site health: `curl localhost:8080` →
  200. If it 502s, check `mike-frontend-1` is running.
- Verify IN THE BROWSER before calling anything done. This codebase has
  twice shipped features that passed tsc + tests and were 100% broken at
  first click. Test in the Graver matter
  (project `3bb3ee1f-5a9d-447c-a691-6e34c8ea5cec`); model `glm-5.2 (local)`
  works; the default Gemini model has no key.

### Harness rules established this week — do not regress them
1. **No silent truncation.** Text a model relies on is either passed whole
   or carries an explicit `[TRUNCATED ...]` marker. Case opinions are now
   always fetched WHOLE (`getCourtlistenerCaseOpinions` has no upper cap;
   the dispatcher passes `includeFullText: true`).
2. **Thinking-model token headroom.** Any `completeText` call gets
   `maxTokens` ≥ 2000 — glm-style models spend the budget on hidden
   reasoning first and return an EMPTY string under small caps. Strip leaked
   `<think>...</think>` / stray `</think>` from small-model output.
3. **Never-guess extraction.** Prompts that fill fields from a document say
   explicitly: not in the document ⇒ say so; never answer from outside it.
4. **Diligence is mechanical, not promised.** The system already appends a
   visible italic note when an answer names a reporter/K.S.A. citation that
   was never retrieved that turn (`streaming.ts`, search "Diligence check").
   Feature B extends this pattern.
5. **Prompt hygiene:** no escape hatches ("if unsure, return X" teaches
   small models to always return X); few-shot examples beat instructions;
   the base system prompt must not name CourtListener tools (a test asserts
   the no-research prompt contains no "courtlistener").

### Key files
- `backend/src/lib/chat/prompts.ts` — main system prompt (CORE RULES,
  DOCUMENT CITATIONS, LEGAL SOURCES sections).
- `backend/src/lib/chat/streaming.ts` — `runLLMStream`: the turn loop,
  citation parsing/repair, the diligence check, event/SSE plumbing
  (`{type:"content"}` events persist; `{type:"content_delta"}` SSE renders
  live).
- `backend/src/lib/chat/tools/toolSchemas.ts` — `PROJECT_EXTRA_TOOLS` is
  the matter-scoped tool list (⚠️ `FORM_BANK_TOOLS` sits adjacent and a test
  pins its exact contents — do not insert into the wrong array).
- `backend/src/lib/chat/tools/toolDispatcher.ts` — `runToolCalls`; has
  `projectId`, `chatId`, `db`, `userId`, courtlistener + legislation turn
  state in scope. `save_to_law` (added 08-20) is a good model for a new
  matter-scoped tool.
- `backend/src/lib/chat/runResume.ts` — pause/resume ("Keep going") and
  `condenseForContinuation`.
- `backend/src/lib/llm/runBudget.ts` — per-turn budget (120 rounds/40 min/
  700k chars) and `wrapUpInstruction` (what the model is told when budget
  runs out).
- Text notes: the "Text" button already saves typed notes as matter
  documents — find its backend route (search `text` note creation under
  `backend/src/routes/projects.ts` or nearby) and REUSE its storage path for
  Feature A rather than inventing a new document kind.
  ⚠️ Known gotcha from that feature: storage URLs are not directly
  browser-reachable; documents must go through the app's download/rendition
  path.

---

## Feature A — Research notes scratchpad

### Behavior
- In a matter chat, the assistant can create and append to ONE running notes
  document per chat, stored as a real matter document named
  `Research Notes — <chat title or topic>` (plain text/markdown content,
  stored the same way the "Text" note feature stores typed notes).
- The document appears in the matter's Documents view (in a "Research"
  folder is NOT required; root or the folder the Text feature uses is fine)
  and updates as the work proceeds.
- A paused turn's notes survive. A resumed turn, or a brand-new chat, can
  read the notes document like any other document.

### Implementation
1. **Tool** `research_notes` in `PROJECT_EXTRA_TOOLS`:
   - Parameters: `{ append: string, topic?: string }`. First call in a chat
     creates the document (topic → filename, default the chat title);
     subsequent calls append a section. Keep it ONE tool — model-facing
     surface should stay small.
   - Dispatcher: track the notes document id in a per-chat lookup (a column
     on `chats` like `research_notes_document_id`, or resolve by
     source-kind+chat-id query — pick whichever the Text-note schema makes
     natural; a migration on `chats` is acceptable and applied with
     `sudo docker cp file mike-db-1:/tmp/m.sql && sudo docker exec mike-db-1 psql -U postgres -f /tmp/m.sql`
     — piping SQL via stdin is blocked in this environment).
   - Append = read current stored text, concatenate with a `\n\n---\n\n`
     separator and a timestamp line, store as a new version (reuse the Text
     feature's update path so versioning/rendition/search indexing all keep
     working). Emit the existing `doc_created`/`doc_edited` event shape so
     the UI shows activity.
2. **Prompt** (`prompts.ts`, new short section, tool-name-free wording is
   NOT required here because PROJECT_EXTRA_TOOLS only exists with research
   — but keep the base-prompt "courtlistener" ban in mind):
   - "For research or review work that covers several authorities or
     documents, or that will take many steps: open a running notes document
     early (research_notes) and write each finding into it AS YOU GO — one
     short dated entry per item, stating what was checked, against what
     text, and the verdict. The notes are the durable record; the chat
     answer summarises them. Do not wait until the end to write notes."
   - Add one line to `wrapUpInstruction` in `runBudget.ts`: if notes were
     kept this turn, say the detail is in the notes document.
3. **Resume**: in `condenseForContinuation`, if the turn used
   `research_notes`, mention the notes document's name in the condensed
   summary so the resumed model re-reads it instead of relying on the
   condensate.
4. **Do NOT**: auto-create notes for every chat (noise), write .docx via the
   generate pipeline per append (slow), or let the tool overwrite user
   documents (create only its own, and only append).

### Tests
- Unit: dispatcher creates once + appends on second call; append preserves
  earlier content; a chat without projectId gets a clean error.
- Browser (mandatory): run a real multi-case review in Graver, watch the
  notes document appear and grow, pause it, press Keep going, confirm the
  resumed answer still matches the notes; open the document in the viewer.

## Feature B — Citation checklist

### Behavior
- When the assistant reviews a document's citations, the SYSTEM (not the
  model) extracts the list of authorities from the document text, and at the
  end of the turn the answer carries a visible coverage line:
  "Checklist: 7 of 9 authorities addressed. Not yet checked: X; Y." The
  existing "Keep going"/follow-up flow picks up the remainder.

### Implementation
1. **Extractor** `extractAuthorities(text: string)` in a new
   `backend/src/lib/chat/authorityChecklist.ts`: reuse the two regexes from
   the diligence check in `streaming.ts` (reporter citations + K.S.A.), plus
   RSMo (`\bRSMo\s*§*\s*\d+\.\d+` style) since Missouri matters exist.
   Return deduped, normalized keys plus display strings. UNIT-TEST this
   against the Graver memo's real citation list (the memo text is a good
   fixture; 8+ distinct authorities).
2. **Turn state**: when `read_document`/`fetch_documents` returns a
   document's text in a turn where the user's message asks for citation
   checking (detect via a cheap keyword test on the user message: contains
   "citation" / "cite" + "check"/"verify"/"review"/"accuracy" — keep the
   trigger conservative and code-side), run the extractor over the document
   text and stash `{docLabel, authorities}` in a per-turn checklist state
   (thread it the same way `courtlistenerTurnState` is threaded).
   Alternative accepted: always extract and only REPORT when the trigger
   matched; choose whichever lands cleaner in `documentOps.ts`.
3. **Coverage report** in `streaming.ts`, next to the existing diligence
   check: covered = fetched cluster citation strings + legislation aliases
   (base section, subsections stripped) — the same covered-set code already
   there; factor it out rather than duplicating. Compare against the
   checklist; append ONE visible note (`content` event + `content_delta`
   SSE, italic) with counts and the missing items (cap 8 + "and N more").
   When everything is covered, say nothing (silence = clean, matching the
   existing note's behavior).
4. **Prompt**: one line in LEGAL SOURCES: "When reviewing a document's
   citations, work from the document's full list of authorities and address
   every one; the system reports any you leave unchecked."
5. **Do NOT**: block or rewrite the model's answer, ask the model to build
   the checklist (that is the laziness vector this feature removes), or
   fire the note on drafting/summarising turns (hence the conservative
   trigger).

### Tests
- Unit: extractor on the memo fixture; covered-set subtraction; trigger
  phrase matching (positive and negative cases).
- Browser (mandatory): in Graver, ask the memo-review question from
  chat 9ddb6444 ("review the attached memo, pull all the cases and statutes,
  check them for accuracy") and confirm (a) the checklist note appears only
  if something was skipped, (b) a deliberately interrupted run (stop button)
  followed by "Keep going" ends with full coverage and no note.

## Order of work
Feature B first (smaller, pure backend, builds on existing code), then A.
Deploy and browser-verify each separately. Full backend suite
(`npx vitest run`) must stay green — 947 tests as of 2026-08-20.
