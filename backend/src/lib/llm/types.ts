import type { TaskStep } from "../chat/taskList";
import type {
    RunBudgetLimits,
    RunStats,
    RunStopReason,
} from "./runBudget";

export type { RunBudgetLimits, RunStats, RunStopReason };

// Shared types for the LLM provider adapter.
// Callers always speak OpenAI-style tools + { role, content } messages; each
// provider translates internally.

export type Provider = "claude" | "gemini" | "openai" | "ollama";

export type OpenAIToolSchema = {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
};

export type LlmMessage = {
    role: "user" | "assistant";
    content: string;
};

export type NormalizedToolCall = {
    id: string;
    name: string;
    input: Record<string, unknown>;
};

export type NormalizedToolResult = {
    tool_use_id: string;
    content: string;
};

export type StreamCallbacks = {
    onReasoningDelta?: (text: string) => void;
    onReasoningBlockEnd?: () => void;
    onContentDelta?: (text: string) => void;
    onToolCallStart?: (call: NormalizedToolCall) => void;
};

export type UserApiKeys = {
    claude?: string | null;
    gemini?: string | null;
    openai?: string | null;
    openrouter?: string | null;
    courtlistener?: string | null;
};

/**
 * Everything needed to pick a paused turn back up. Held in memory by
 * `lib/chat/runResume` and handed back to the same provider.
 */
export type ResumeState = {
    provider: Provider;
    model: string;
    /** The conversation as the caller sees it, before any tool rounds ran. */
    baseMessages: LlmMessage[];
    /** Provider-native working transcript, including every tool result. */
    transcript: unknown;
    /** Tool rounds already spent, so the pause card can report a true total. */
    iterationsUsed: number;
};

export type StreamChatParams = {
    model: string;
    systemPrompt: string;
    messages: LlmMessage[];
    tools?: OpenAIToolSchema[];
    callbacks?: StreamCallbacks;
    runTools?: (calls: NormalizedToolCall[]) => Promise<NormalizedToolResult[]>;
    apiKeys?: UserApiKeys;
    /**
     * Enable provider-side reasoning/thinking. Off by default — should only
     * be turned on for interactive chat surfaces where the user actually
     * benefits from seeing the thought stream. Bulk extraction jobs and
     * one-shot completions should leave this off to save tokens and latency.
     */
    enableThinking?: boolean;
    abortSignal?: AbortSignal;
    /** Per-turn stop conditions. Omitted fields fall back to the defaults. */
    budget?: Partial<RunBudgetLimits>;
    /** Set to pick up a turn that paused when its budget ran out. */
    resumeState?: ResumeState | null;
    /**
     * The running notes document this turn is keeping, if any. Read at
     * wrap-up time, so it is a live reference rather than a value: the
     * document may not exist yet when the run starts.
     */
    researchNotes?: { document: { filename: string } | null };
    /**
     * The job list this turn is working to. A live reference, like
     * `researchNotes`: the model writes the list part-way through the run, so
     * the value read at wrap-up time is not the one the run started with.
     */
    taskList?: { steps: TaskStep[] };
    /**
     * Called when the model stops calling tools and tries to finish. Return a
     * message to send it back with, or null to let it finish. One callback
     * rather than a copy of the rules in each provider loop: a checklist the
     * model can ignore is decoration, and this is what stops it ignoring it.
     */
    onBeforeFinish?: () => string | null;
};

export type StreamChatResult = {
    fullText: string;
    /** "complete" means the model finished on its own. */
    stopReason: RunStopReason;
    stats: RunStats;
    /** Present only when the turn paused, so the user can resume it. */
    resumeState?: ResumeState;
};
