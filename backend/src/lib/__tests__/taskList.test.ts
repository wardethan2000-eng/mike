import { describe, it, expect } from "vitest";
import {
    LATE_START_ROUNDS,
    MAX_STEPS,
    MAX_STEP_CHARS,
    STALENESS_ROUNDS,
    applyTaskListCall,
    carriedListSection,
    isFinished,
    lateStartNudge,
    newTaskListTurnState,
    normalizeTaskList,
    outstandingNote,
    outstandingSteps,
    readStoredTaskList,
    renderTaskListForModel,
    stalenessReminder,
    taskListContinuation,
    taskListForContinuation,
    taskListSummary,
    wrapUpOutstandingLine,
    type TaskStep,
} from "../chat/taskList";

const THREE_LETTERS: TaskStep[] = [
    { step: "Read the Graver file and identify the three lessees", status: "done" },
    { step: "Draft the demand letter to Acme Holdings", status: "doing" },
    { step: "Draft the demand letter to Borden Equipment", status: "pending" },
];

describe("the core invariant", () => {
    it("puts back an outstanding step that vanished from the list", () => {
        const result = normalizeTaskList(THREE_LETTERS, [
            { step: "Read the Graver file and identify the three lessees", status: "done" },
            { step: "Draft the demand letter to Acme Holdings", status: "done" },
        ]);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.restored).toEqual([
            "Draft the demand letter to Borden Equipment",
        ]);
        expect(result.steps.map((s) => s.step)).toContain(
            "Draft the demand letter to Borden Equipment",
        );
    });

    it("puts the step back next to where it was, not at the end", () => {
        const previous: TaskStep[] = [
            { step: "One", status: "done" },
            { step: "Two", status: "pending" },
            { step: "Three", status: "pending" },
        ];
        const result = normalizeTaskList(previous, [
            { step: "One", status: "done" },
            { step: "Three", status: "doing" },
        ]);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.steps.map((s) => s.step)).toEqual(["One", "Two", "Three"]);
    });

    it("lets a step leave when it is dropped with a reason", () => {
        const result = normalizeTaskList(THREE_LETTERS, [
            { step: "Read the Graver file and identify the three lessees", status: "done" },
            { step: "Draft the demand letter to Acme Holdings", status: "done" },
            {
                step: "Draft the demand letter to Borden Equipment",
                status: "dropped",
                reason: "Borden's lease was assigned away in 2024",
            },
        ]);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.restored).toEqual([]);
        expect(outstandingSteps(result.steps)).toEqual([]);
    });

    it("refuses a step dropped with no reason", () => {
        const result = normalizeTaskList(THREE_LETTERS, [
            { step: "Read the Graver file and identify the three lessees", status: "done" },
            { step: "Draft the demand letter to Acme Holdings", status: "done" },
            { step: "Draft the demand letter to Borden Equipment", status: "dropped" },
        ]);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toMatch(/reason/i);
    });

    it("keeps finished steps that fell off, without reporting them", () => {
        const result = normalizeTaskList(THREE_LETTERS, [
            { step: "Draft the demand letter to Acme Holdings", status: "done" },
            { step: "Draft the demand letter to Borden Equipment", status: "done" },
        ]);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.restored).toEqual([]);
        expect(result.steps).toHaveLength(3);
    });
});

describe("normalising", () => {
    it("keeps at most one step in hand, first wins", () => {
        const result = normalizeTaskList([], [
            { step: "One", status: "doing" },
            { step: "Two", status: "doing" },
            { step: "Three", status: "doing" },
        ]);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.steps.map((s) => s.status)).toEqual([
            "doing",
            "pending",
            "pending",
        ]);
    });

    it("refuses a list of one step", () => {
        const result = normalizeTaskList([], [{ step: "Answer the question", status: "pending" }]);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error).toMatch(/single step/i);
    });

    it("treats an empty list as clearing the list", () => {
        const result = normalizeTaskList(THREE_LETTERS, []);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.cleared).toBe(true);
        expect(result.steps).toEqual([]);
    });

    it("caps the list and the length of each step", () => {
        const many = Array.from({ length: 40 }, (_, i) => ({
            step: `Step number ${i} ` + "x".repeat(400),
            status: "pending" as const,
        }));
        const result = normalizeTaskList([], many);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.steps).toHaveLength(MAX_STEPS);
        for (const step of result.steps) {
            expect(step.step.length).toBeLessThanOrEqual(MAX_STEP_CHARS);
        }
    });

    it("drops steps whose text repeats", () => {
        const result = normalizeTaskList([], [
            { step: "Draft the notice", status: "pending" },
            { step: "  draft   the NOTICE ", status: "pending" },
            { step: "Check the authorities", status: "pending" },
        ]);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.steps).toHaveLength(2);
    });

    it("refuses anything that is not a list of steps", () => {
        expect(normalizeTaskList([], "three letters").ok).toBe(false);
        expect(normalizeTaskList([], [{ status: "pending" }]).ok).toBe(false);
    });
});

describe("the tool result", () => {
    it("echoes the list the system recorded, including a step put back", () => {
        const state = newTaskListTurnState(THREE_LETTERS);
        const result = applyTaskListCall(state, [
            { step: "Read the Graver file and identify the three lessees", status: "done" },
            { step: "Draft the demand letter to Acme Holdings", status: "done" },
        ]);
        expect(result.error).toBeUndefined();
        expect(String(result.list)).toContain("Draft the demand letter to Borden Equipment");
        expect(result.put_back).toEqual(["Draft the demand letter to Borden Equipment"]);
        expect(state.dirty).toBe(true);
        expect(state.roundsSinceTouched).toBe(0);
    });

    it("leaves the stored list alone when the call is refused", () => {
        const state = newTaskListTurnState(THREE_LETTERS);
        const result = applyTaskListCall(state, [
            { step: "Read the Graver file and identify the three lessees", status: "done" },
            { step: "Draft the demand letter to Acme Holdings", status: "dropped" },
        ]);
        expect(result.error).toBeTruthy();
        expect(state.steps).toEqual(THREE_LETTERS);
        expect(state.dirty).toBe(false);
    });

    it("puts everything back when the model shrinks the list to one step", () => {
        const state = newTaskListTurnState(THREE_LETTERS);
        const result = applyTaskListCall(state, [{ step: "Only one", status: "doing" }]);
        expect(result.error).toBeUndefined();
        expect(state.steps).toHaveLength(4);
        expect(result.put_back).toEqual([
            "Draft the demand letter to Acme Holdings",
            "Draft the demand letter to Borden Equipment",
        ]);
    });
});

describe("the late-start nudge", () => {
    it("fires once at 12 rounds and not at 11", () => {
        const state = newTaskListTurnState();
        state.rounds = LATE_START_ROUNDS - 1;
        expect(lateStartNudge(state)).toBeNull();
        state.rounds = LATE_START_ROUNDS;
        expect(lateStartNudge(state)).toMatch(/task_list/);
        state.rounds = LATE_START_ROUNDS + 5;
        expect(lateStartNudge(state)).toBeNull();
    });

    it("never fires once a list exists", () => {
        const state = newTaskListTurnState(THREE_LETTERS);
        state.rounds = LATE_START_ROUNDS + 10;
        expect(lateStartNudge(state)).toBeNull();
    });
});

describe("the staleness reminder", () => {
    it("fires at 5 untouched rounds and not before", () => {
        const state = newTaskListTurnState(THREE_LETTERS);
        state.roundsSinceTouched = STALENESS_ROUNDS - 1;
        expect(stalenessReminder(state)).toBeNull();
        state.roundsSinceTouched = STALENESS_ROUNDS;
        const nudge = stalenessReminder(state);
        expect(nudge).toContain("Draft the demand letter to Acme Holdings");
        expect(state.roundsSinceTouched).toBe(0);
    });

    it("stays quiet when nothing is outstanding", () => {
        const state = newTaskListTurnState([
            { step: "One", status: "done" },
            { step: "Two", status: "done" },
        ]);
        state.roundsSinceTouched = STALENESS_ROUNDS + 3;
        expect(stalenessReminder(state)).toBeNull();
    });
});

describe("the completion gate", () => {
    it("sends the turn back while steps are outstanding", () => {
        const message = taskListContinuation({ steps: THREE_LETTERS, continuations: 0 });
        expect(message).toContain("Draft the demand letter to Acme Holdings");
        expect(message).toContain("task_list");
    });

    it("lets the turn finish once every step is done or dropped", () => {
        expect(
            taskListContinuation({
                steps: [
                    { step: "One", status: "done" },
                    { step: "Two", status: "dropped", reason: "not needed" },
                ],
                continuations: 0,
            }),
        ).toBeNull();
    });

    it("gives up after two continuations", () => {
        expect(taskListContinuation({ steps: THREE_LETTERS, continuations: 1 })).toBeTruthy();
        expect(taskListContinuation({ steps: THREE_LETTERS, continuations: 2 })).toBeNull();
    });

    it("never overrules a user who pressed stop, or a spent budget", () => {
        expect(
            taskListContinuation({ steps: THREE_LETTERS, continuations: 0, aborted: true }),
        ).toBeNull();
        expect(
            taskListContinuation({
                steps: THREE_LETTERS,
                continuations: 0,
                budgetExhausted: true,
            }),
        ).toBeNull();
    });

    it("has nothing to say when no list was ever written", () => {
        expect(taskListContinuation({ steps: [], continuations: 0 })).toBeNull();
    });
});

describe("what the reader and the next turn see", () => {
    it("summarises the list in one line", () => {
        expect(taskListSummary([
            { step: "One", status: "done" },
            { step: "Two", status: "done" },
        ])).toBe("2 steps — all done");
        expect(taskListSummary([
            { step: "One", status: "done" },
            { step: "Two", status: "dropped", reason: "moot" },
            { step: "Three", status: "pending" },
        ])).toBe("1 of 3 steps done, 1 dropped, 1 outstanding");
        // With nothing dropped the outstanding count only repeats the sum.
        expect(taskListSummary([
            { step: "One", status: "done" },
            { step: "Two", status: "pending" },
            { step: "Three", status: "pending" },
        ])).toBe("1 of 3 steps done");
    });

    it("names the outstanding steps in the trailing line and the wrap-up", () => {
        expect(outstandingNote(THREE_LETTERS)).toMatch(/^Still to do: /);
        expect(wrapUpOutstandingLine(THREE_LETTERS)).toMatch(/Still outstanding/);
        expect(outstandingNote([{ step: "One", status: "done" }])).toBeNull();
        expect(wrapUpOutstandingLine([{ step: "One", status: "done" }])).toBeNull();
    });

    it("carries the list into a condensed continuation unchanged", () => {
        const carried = taskListForContinuation(THREE_LETTERS);
        for (const step of THREE_LETTERS) {
            expect(carried).toContain(step.step);
        }
        expect(taskListForContinuation([])).toBeNull();
    });

    it("tells a later turn a list is already open", () => {
        expect(carriedListSection(THREE_LETTERS)).toContain("clear it");
        expect(carriedListSection([])).toBeNull();
    });

    it("renders each status for the model", () => {
        const rendered = renderTaskListForModel([
            { step: "One", status: "done" },
            { step: "Two", status: "doing" },
            { step: "Three", status: "pending" },
            { step: "Four", status: "dropped", reason: "moot" },
        ]);
        expect(rendered).toContain("1. [done] One");
        expect(rendered).toContain("2. [doing] Two");
        expect(rendered).toContain("3. [to do] Three");
        expect(rendered).toContain("4. [dropped: moot] Four");
    });
});

describe("what is stored on the chat", () => {
    it("reads back a stored list and ignores rubbish in it", () => {
        const steps = readStoredTaskList({
            steps: [
                { step: "One", status: "done" },
                { step: "Two", status: "nonsense" },
                { step: "", status: "pending" },
                { step: "Four", status: "dropped" },
                { step: "Five", status: "pending" },
            ],
        });
        expect(steps.map((s) => s.step)).toEqual(["One", "Five"]);
        expect(readStoredTaskList(null)).toEqual([]);
        expect(readStoredTaskList("[]")).toEqual([]);
    });

    it("knows when a list is finished and can be cleared", () => {
        expect(isFinished([])).toBe(false);
        expect(isFinished(THREE_LETTERS)).toBe(false);
        expect(isFinished([
            { step: "One", status: "done" },
            { step: "Two", status: "dropped", reason: "moot" },
        ])).toBe(true);
    });
});
