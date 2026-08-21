// Per-turn budget for the tool-calling loop.
//
// A research question can legitimately need dozens of tool rounds (read the
// memo, pull each cited case, verify each citation). What it must never do is
// run forever, blow past the model's context window, or leave the user with a
// spinner and no answer. Every provider loop shares this budget so the three
// stop conditions — and the wrap-up behaviour when one trips — are identical
// no matter which model the user picked.

import { wrapUpOutstandingLine, type TaskStep } from "../chat/taskList";

export type RunStopReason =
    | "complete"
    | "iterations"
    | "time"
    | "context"
    | "loop";

export type RunStats = {
    /** Tool rounds actually used, including any carried over from a resume. */
    iterations: number;
    elapsedMs: number;
    /** Rough size of the working transcript, in characters. */
    contextChars: number;
};

export type RunBudgetLimits = {
    maxIterations: number;
    maxDurationMs: number;
    maxContextChars: number;
    /** How many times the same tool+arguments may be repeated before we stop. */
    maxRepeats: number;
};

function envInt(name: string, fallback: number): number {
    const raw = process.env[name];
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function defaultRunBudgetLimits(): RunBudgetLimits {
    return {
        // Drafting is not research: writing two contracts means reading both
        // models, copying them, writing each one out and checking the result,
        // and a local model takes minutes per step. The old ceilings (30
        // rounds, 7 minutes) stopped that work halfway through, so they are
        // set high enough that only genuinely stuck work trips them.
        maxIterations: envInt("CHAT_MAX_TOOL_ROUNDS", 120),
        maxDurationMs: envInt("CHAT_MAX_TOOL_SECONDS", 2_400) * 1000,
        maxContextChars: envInt("CHAT_MAX_CONTEXT_CHARS", 700_000),
        maxRepeats: envInt("CHAT_MAX_TOOL_REPEATS", 4),
    };
}

/** Budget for one assistant turn. A resumed turn gets a fresh one. */
export class RunBudget {
    readonly limits: RunBudgetLimits;
    /** Rounds used in this run only — excludes rounds carried over. */
    private used = 0;
    private readonly carried: number;
    private readonly startedAt = Date.now();
    private readonly repeats = new Map<string, number>();
    private contextChars = 0;
    private loopedTool: string | null = null;

    constructor(limits?: Partial<RunBudgetLimits>, carriedIterations = 0) {
        this.limits = { ...defaultRunBudgetLimits(), ...(limits ?? {}) };
        this.carried = carriedIterations;
    }

    /**
     * Called before each round. Returns the reason to stop calling tools, or
     * null to carry on. `transcript` is the provider-native message array; its
     * serialized size is the context estimate.
     */
    checkBeforeRound(transcript: unknown): Exclude<RunStopReason, "complete"> | null {
        this.contextChars = estimateChars(transcript);
        if (this.loopedTool) return "loop";
        if (this.used >= this.limits.maxIterations) return "iterations";
        if (Date.now() - this.startedAt >= this.limits.maxDurationMs) return "time";
        if (this.contextChars >= this.limits.maxContextChars) return "context";
        return null;
    }

    /** Called once a round is actually started with tools enabled. */
    startRound(): void {
        this.used += 1;
    }

    /**
     * Record the tool calls a round produced. A model that asks for the exact
     * same call over and over is stuck; after `maxRepeats` we stop feeding it.
     */
    noteToolCalls(calls: { name: string; input: unknown }[]): void {
        for (const call of calls) {
            const signature = `${call.name}:${stableStringify(call.input)}`;
            const seen = (this.repeats.get(signature) ?? 0) + 1;
            this.repeats.set(signature, seen);
            if (seen >= this.limits.maxRepeats) this.loopedTool = call.name;
        }
    }

    /** Name of the tool that tripped loop detection, for the user-facing note. */
    get repeatedToolName(): string | null {
        return this.loopedTool;
    }

    stats(): RunStats {
        return {
            iterations: this.carried + this.used,
            elapsedMs: Date.now() - this.startedAt,
            contextChars: this.contextChars,
        };
    }
}

function stableStringify(value: unknown): string {
    if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "";
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    const entries = Object.entries(value as Record<string, unknown>).sort(
        (a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
    );
    return `{${entries.map(([k, v]) => `${k}:${stableStringify(v)}`).join(",")}}`;
}

function estimateChars(transcript: unknown): number {
    try {
        return JSON.stringify(transcript)?.length ?? 0;
    } catch {
        return 0;
    }
}

/**
 * What we tell the model when its budget runs out. It gets one more turn with
 * the tools switched off, so the user always ends up with an answer rather
 * than a chat that stops mid-search.
 */
export function wrapUpInstruction(
    reason: Exclude<RunStopReason, "complete">,
    repeatedToolName?: string | null,
    researchNotesFilename?: string | null,
    /** The turn's job list, if it kept one. Replaces a wrap-up list written
     * from memory with the steps that are actually outstanding. */
    taskListSteps?: TaskStep[] | null,
): string {
    const why =
        reason === "iterations"
            ? "You have used all of this turn's research steps."
            : reason === "time"
              ? "This turn has been running too long."
              : reason === "context"
                ? "This turn has collected as much material as fits in one go."
                : `You have called ${repeatedToolName ?? "the same tool"} repeatedly with the same arguments and are not making progress.`;
    const lines = [
        `[System] ${why}`,
        "Do not call any more tools. Answer now, using what you have already found.",
        "Be explicit about which points you verified and which you did not.",
        "End with a short list of what still needs checking, so the work can be picked up again.",
    ];
    const outstandingLine = taskListSteps
        ? wrapUpOutstandingLine(taskListSteps)
        : null;
    if (outstandingLine) lines.push(outstandingLine);
    if (researchNotesFilename) {
        lines.push(
            `Your entry-by-entry record is in "${researchNotesFilename}" in this matter; say so, and keep your answer to a summary of it rather than repeating every entry.`,
        );
    }
    return lines.join(" ");
}

/** What we tell the model when the user presses "Keep going". */
export const RESUME_INSTRUCTION =
    "[System] The user asked you to keep going. You have a fresh budget of research steps. Do not repeat searches you have already run — pick up from what you have and finish the job, then give your complete answer.";

/** Plain-English label for why a turn paused. Shown to the user. */
export function stopReasonLabel(
    reason: Exclude<RunStopReason, "complete">,
    stats: RunStats,
    /** "3 of 7 steps done", when the turn kept a list. */
    taskListSummary?: string | null,
): string {
    const base =
        reason === "iterations"
            ? `Paused after ${stats.iterations} research steps.`
            : reason === "time"
              ? `Paused after ${Math.round(stats.elapsedMs / 60000)} minutes of research.`
              : reason === "context"
                ? "Paused — this answer has gathered as much material as fits at once."
                : "Paused — the same search kept repeating without making progress.";
    if (!taskListSummary) return base;
    return `${base.replace(/\.$/, "")} — ${taskListSummary}.`;
}
