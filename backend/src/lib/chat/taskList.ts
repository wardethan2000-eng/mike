// The job list.
//
// A request with several parts — three notices to prepare, a file to read and
// then act on, a set of authorities to check — is the work that gets left half
// finished. The model writes the steps down before it starts, ticks them off as
// it goes, and the system holds it to the list: if it tries to finish while
// steps are still outstanding it is sent back to finish them.
//
// A checklist the model can ignore is decoration, so the rules that matter live
// here in code rather than in the prompt:
//
//   A step leaves the list only by being marked done, or by being marked
//   dropped with a reason the user will read. Nothing else removes a step.
//
// Kept free of database and storage imports so it unit-tests on its own — the
// same reason authorityChecklist.ts is a pure module.

/**
 * Whether the job list is in play. On by default; set CHAT_TASK_LIST=0 to run
 * a turn without it, which is how the two arms of the A/B are compared.
 */
export function taskListEnabled(): boolean {
  return process.env.CHAT_TASK_LIST !== "0";
}

export type TaskStatus = "pending" | "doing" | "done" | "dropped";

export type TaskStep = {
  step: string;
  status: TaskStatus;
  /** Required when the status is "dropped"; shown to the user. */
  reason?: string;
};

/** Steps are matched across calls on this form, so wording tweaks read as new
 * steps. The alternative is ids the model has to keep straight, which is more
 * for it to get wrong. */
export function taskKey(step: string): string {
  return step.replace(/\s+/g, " ").trim().toLowerCase();
}

export const MAX_STEPS = 20;
export const MAX_STEP_CHARS = 200;

/** Rounds of tools before a turn with no list is told to write one. */
export const LATE_START_ROUNDS = 12;
/** Rounds the list may go untouched, with steps outstanding, before a nudge. */
export const STALENESS_ROUNDS = 5;
/** How many times one turn may be sent back to finish its list. */
export const MAX_CONTINUATIONS = 2;

export type TaskListTurnState = {
  steps: TaskStep[];
  /** Tool rounds run in this turn. Drives the late-start nudge. */
  rounds: number;
  /** Tool rounds since task_list was last called. Drives the staleness nudge. */
  roundsSinceTouched: number;
  /** The model has called task_list at least once, this turn or earlier. */
  everCalled: boolean;
  /** The late-start nudge fires at most once per turn. */
  lateStartNudged: boolean;
  /** Times the completion gate has sent this turn back. */
  continuations: number;
  /** Set when the list changed, so the turn knows to write it to the chat. */
  dirty: boolean;
};

export function newTaskListTurnState(
  steps: TaskStep[] = [],
): TaskListTurnState {
  return {
    steps,
    rounds: 0,
    roundsSinceTouched: 0,
    everCalled: steps.length > 0,
    lateStartNudged: false,
    continuations: 0,
    dirty: false,
  };
}

export function isOutstanding(step: TaskStep): boolean {
  return step.status === "pending" || step.status === "doing";
}

export function outstandingSteps(steps: TaskStep[]): TaskStep[] {
  return steps.filter(isOutstanding);
}

function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_STEP_CHARS);
}

function cleanStatus(value: unknown): TaskStatus | null {
  if (value === "pending" || value === "doing" || value === "done") return value;
  if (value === "dropped") return "dropped";
  return null;
}

export type TaskListUpdate =
  | { ok: true; steps: TaskStep[]; restored: string[]; cleared: boolean }
  | { ok: false; error: string };

/**
 * Fold an incoming whole-list rewrite into the list already stored.
 *
 * The model sends the whole list every call, which is the behaviour being
 * bought — restating the list is what keeps it in mind. What that allows is a
 * quietly shorter list, so anything outstanding that went missing is put back
 * and the tool result says so.
 */
export function normalizeTaskList(
  previous: TaskStep[],
  incoming: unknown,
): TaskListUpdate {
  if (!Array.isArray(incoming)) {
    return {
      ok: false,
      error:
        "Send the whole list as `steps`: an array of { step, status } objects.",
    };
  }

  // An empty list is how the model says the job is over and the list is no
  // longer wanted. Everything else has to survive the round trip.
  if (incoming.length === 0) {
    return { ok: true, steps: [], restored: [], cleared: true };
  }

  const cleaned: TaskStep[] = [];
  const seen = new Set<string>();
  let sawDoing = false;
  for (const raw of incoming) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const row = raw as Record<string, unknown>;
    const text = cleanText(row.step ?? row.text ?? row.title);
    if (!text) continue;
    const key = taskKey(text);
    if (seen.has(key)) continue;
    const status = cleanStatus(row.status) ?? "pending";
    const reason = cleanText(row.reason);
    if (status === "dropped" && !reason) {
      return {
        ok: false,
        error: `"${text}" was dropped with no reason. A step only leaves the list by being done, or dropped with a reason the user will read. Send it again with a reason, or finish it.`,
      };
    }
    seen.add(key);
    // At most one step is in hand at a time; the first one wins and the rest
    // go back to pending, so "doing" stays a claim about now.
    let finalStatus = status;
    if (status === "doing") {
      if (sawDoing) finalStatus = "pending";
      else sawDoing = true;
    }
    cleaned.push(
      finalStatus === "dropped"
        ? { step: text, status: finalStatus, reason }
        : { step: text, status: finalStatus },
    );
    if (cleaned.length >= MAX_STEPS) break;
  }

  if (cleaned.length === 0) {
    return {
      ok: false,
      error:
        "No usable steps. Each entry needs a `step` describing what it produces.",
    };
  }
  if (cleaned.length < 2 && previous.length === 0) {
    return {
      ok: false,
      error:
        "A single step does not need a list. Call task_list only when the job has more than two distinct parts; otherwise just do the work.",
    };
  }

  // The invariant. Anything the stored list had that is outstanding and did
  // not come back goes back in, next to where it was.
  const byKey = new Map(cleaned.map((s) => [taskKey(s.step), s] as const));
  const merged = [...cleaned];
  const restored: string[] = [];
  for (let i = 0; i < previous.length; i += 1) {
    const old = previous[i];
    const key = taskKey(old.step);
    if (byKey.has(key)) continue;
    // A step already finished or dropped is kept quietly, so the list still
    // reads as the whole job when it is done. An outstanding one is put back
    // and reported.
    const predecessorKey = i > 0 ? taskKey(previous[i - 1].step) : null;
    const at = predecessorKey
      ? merged.findIndex((s) => taskKey(s.step) === predecessorKey)
      : -1;
    const insertAt = at >= 0 ? at + 1 : merged.length;
    merged.splice(insertAt, 0, old);
    byKey.set(key, old);
    if (isOutstanding(old)) restored.push(old.step);
  }

  const steps = merged.slice(0, MAX_STEPS);
  return { ok: true, steps, restored, cleared: false };
}

/** How the list reads in the tool result, so the model sees what was recorded
 * rather than what it sent. */
export function renderTaskListForModel(steps: TaskStep[]): string {
  return steps
    .map((s, i) => {
      const mark =
        s.status === "done"
          ? "done"
          : s.status === "doing"
            ? "doing"
            : s.status === "dropped"
              ? `dropped: ${s.reason ?? ""}`
              : "to do";
      return `${i + 1}. [${mark}] ${s.step}`;
    })
    .join("\n");
}

export type TaskListToolResult = Record<string, unknown>;

/**
 * Run one task_list call against the turn's state. Returns what goes back to
 * the model; the state is updated in place.
 */
export function applyTaskListCall(
  state: TaskListTurnState,
  incoming: unknown,
): TaskListToolResult {
  const update = normalizeTaskList(state.steps, incoming);
  if (!update.ok) return { error: update.error };
  state.steps = update.steps;
  state.everCalled = true;
  state.roundsSinceTouched = 0;
  state.dirty = true;
  if (update.cleared) {
    return { list: "cleared", note: "The list is empty; nothing is being tracked." };
  }
  const outstanding = outstandingSteps(state.steps);
  const result: TaskListToolResult = {
    list: renderTaskListForModel(state.steps),
    outstanding: outstanding.length,
  };
  if (update.restored.length) {
    result.put_back = update.restored;
    result.note =
      "These steps were missing from the list you sent and have been put back. A step only leaves the list by being done, or dropped with a reason.";
  }
  return result;
}

/** "3 of 5 steps done, 1 dropped" — the one line the collapsed list shows. */
export function taskListSummary(steps: TaskStep[]): string {
  if (steps.length === 0) return "No steps";
  const done = steps.filter((s) => s.status === "done").length;
  const dropped = steps.filter((s) => s.status === "dropped").length;
  const plural = steps.length === 1 ? "step" : "steps";
  if (done === steps.length) return `${steps.length} ${plural} — all done`;
  const parts = [`${done} of ${steps.length} ${plural} done`];
  if (dropped) parts.push(`${dropped} dropped`);
  const outstanding = steps.length - done - dropped;
  if (dropped && outstanding) parts.push(`${outstanding} outstanding`);
  return parts.join(", ");
}

function joinSteps(steps: TaskStep[], max = 5): string {
  const shown = steps.slice(0, max).map((s) => s.step);
  const rest = steps.length - shown.length;
  return shown.join("; ") + (rest > 0 ? `; and ${rest} more` : "");
}

/** Round-count nudge for a turn that is running long with no list at all. */
export function lateStartNudge(state: TaskListTurnState): string | null {
  if (state.everCalled || state.lateStartNudged) return null;
  if (state.rounds < LATE_START_ROUNDS) return null;
  state.lateStartNudged = true;
  return "[System] This is turning into a long job. Write the steps down with task_list before going further.";
}

/**
 * Compact reminder for a list that has gone untouched while steps are still
 * outstanding. Triggered by staleness rather than a timer, so a model working
 * the list properly is never nagged.
 */
export function stalenessReminder(state: TaskListTurnState): string | null {
  if (!state.everCalled) return null;
  if (state.roundsSinceTouched < STALENESS_ROUNDS) return null;
  const outstanding = outstandingSteps(state.steps);
  if (outstanding.length === 0) return null;
  state.roundsSinceTouched = 0;
  return `[System] Still outstanding on your list: ${joinSteps(outstanding)}. Update it with task_list as you finish each one.`;
}

/** The outstanding steps, named, for the budget wrap-up. */
export function wrapUpOutstandingLine(steps: TaskStep[]): string | null {
  const outstanding = outstandingSteps(steps);
  if (outstanding.length === 0) return null;
  return `Still outstanding on your list: ${joinSteps(outstanding, 8)}. Say which of these you finished and which you did not, rather than writing that list from memory.`;
}

/**
 * The completion gate. The model has stopped calling tools and is trying to
 * finish; if steps are still outstanding it does not get to. This is the one
 * mechanism that makes the list more than decoration, so its guards are
 * mandatory: two continuations at most, never after an abort, and never past
 * the run's budget.
 */
export function taskListContinuation(args: {
  steps: TaskStep[];
  continuations: number;
  aborted?: boolean;
  budgetExhausted?: boolean;
}): string | null {
  if (args.aborted) return null;
  if (args.budgetExhausted) return null;
  if (args.continuations >= MAX_CONTINUATIONS) return null;
  const outstanding = outstandingSteps(args.steps);
  if (outstanding.length === 0) return null;
  return [
    "[System] You have not finished the list you wrote.",
    `Still outstanding: ${joinSteps(outstanding, 8)}.`,
    "Do that work now, or call task_list and drop the steps you are not going to do with a reason the user will read.",
    "Do not answer as though the job is complete while steps are outstanding.",
  ].join(" ");
}

/** The trailing line the reader sees when a turn ends with work outstanding. */
export function outstandingNote(steps: TaskStep[]): string | null {
  const outstanding = outstandingSteps(steps);
  if (outstanding.length === 0) return null;
  return `Still to do: ${joinSteps(outstanding, 5)}.`;
}

/**
 * What the model is told at the start of a turn that inherits a list from
 * earlier in the chat. The model decides whether it still applies, and the
 * decision is visible in the list itself.
 */
export function carriedListSection(steps: TaskStep[]): string | null {
  if (steps.length === 0) return null;
  return [
    "THE LIST FROM EARLIER IN THIS CHAT:",
    renderTaskListForModel(steps),
    "There is a list from earlier in this chat. If the user has moved on to something else, clear it by calling task_list with an empty steps array. Otherwise carry on with it and keep it up to date.",
  ].join("\n");
}

/** The list as a plain numbered list, for a condensed continuation. Carried
 * verbatim rather than through the summariser, because putting intent through
 * a summariser is how steps get dropped. */
export function taskListForContinuation(steps: TaskStep[]): string | null {
  if (steps.length === 0) return null;
  return `The list you were working to, unchanged:\n${renderTaskListForModel(steps)}`;
}

/** Storage shape for chats.task_list. Validated on the way back in, because a
 * row written by an older build must never crash a turn. */
export function readStoredTaskList(value: unknown): TaskStep[] {
  if (!value || typeof value !== "object") return [];
  const rows = Array.isArray(value)
    ? value
    : ((value as Record<string, unknown>).steps as unknown);
  if (!Array.isArray(rows)) return [];
  const steps: TaskStep[] = [];
  for (const raw of rows) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const text = cleanText(row.step);
    const status = cleanStatus(row.status);
    if (!text || !status) continue;
    const reason = cleanText(row.reason);
    if (status === "dropped" && !reason) continue;
    steps.push(status === "dropped" ? { step: text, status, reason } : { step: text, status });
    if (steps.length >= MAX_STEPS) break;
  }
  return steps;
}

/** A list with nothing left outstanding is finished, and is cleared from the
 * chat so the next question starts clean. */
export function isFinished(steps: TaskStep[]): boolean {
  return steps.length > 0 && outstandingSteps(steps).length === 0;
}
