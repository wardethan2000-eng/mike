// Paused-turn storage.
//
// When a turn runs out of research budget the model writes its answer and the
// working transcript — every tool result it collected — is parked here so the
// user can press "Keep going" and carry on from exactly where it stopped.
// In memory on purpose: it is worth nothing after a restart (the button just
// falls back to a fresh run) and it is far too big to want in the database.

import { randomUUID } from "node:crypto";
import { completeText, type LlmMessage, type ResumeState, type UserApiKeys } from "../llm";

const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 40;

type Entry = {
    userId: string;
    chatId: string;
    state: ResumeState;
    createdAt: number;
};

const store = new Map<string, Entry>();

function evictStale() {
    const cutoff = Date.now() - TTL_MS;
    for (const [token, entry] of store) {
        if (entry.createdAt < cutoff) store.delete(token);
    }
    while (store.size > MAX_ENTRIES) {
        const oldest = store.keys().next();
        if (oldest.done) break;
        store.delete(oldest.value);
    }
}

/** Park a paused turn and return the token the client sends back to resume. */
export function rememberResumeState(args: {
    userId: string;
    chatId: string;
    state: ResumeState;
}): string {
    evictStale();
    const token = randomUUID();
    store.set(token, {
        userId: args.userId,
        chatId: args.chatId,
        state: args.state,
        createdAt: Date.now(),
    });
    return token;
}

/**
 * Hand back a parked turn, once. A resumed turn that pauses again is parked
 * under a fresh token, so consuming here keeps the store from growing.
 */
export function takeResumeState(args: {
    token: string;
    userId: string;
    chatId: string;
}): ResumeState | null {
    evictStale();
    const entry = store.get(args.token);
    if (!entry) return null;
    if (entry.userId !== args.userId || entry.chatId !== args.chatId) return null;
    store.delete(args.token);
    return entry.state;
}

const MAX_NOTES_HEAD = 60_000;
const MAX_NOTES_TAIL = 180_000;

/**
 * Pull the readable text out of a provider-native transcript. The shapes
 * differ per provider, so this walks the whole structure and keeps the string
 * values that carry content rather than trying to understand the layout.
 */
export function flattenTranscriptText(transcript: unknown): string {
    const parts: string[] = [];
    const keepKeys = new Set(["content", "text", "output", "arguments", "response"]);
    const walk = (node: unknown, keyHint?: string) => {
        if (node === null || node === undefined) return;
        if (typeof node === "string") {
            if (keyHint && keepKeys.has(keyHint) && node.trim()) parts.push(node);
            return;
        }
        if (Array.isArray(node)) {
            for (const item of node) walk(item, keyHint);
            return;
        }
        if (typeof node === "object") {
            for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
                walk(value, key);
            }
        }
    };
    walk(transcript);
    const joined = parts.join("\n\n");
    if (joined.length <= MAX_NOTES_HEAD + MAX_NOTES_TAIL) return joined;
    return [
        joined.slice(0, MAX_NOTES_HEAD),
        "\n\n[...middle of the working notes omitted...]\n\n",
        joined.slice(joined.length - MAX_NOTES_TAIL),
    ].join("");
}

const CONDENSE_SYSTEM = [
    "You are condensing the working notes of a legal research turn so the work can continue in a smaller space.",
    "Write a dense set of notes covering everything found so far.",
    "Keep every case name, full citation, statutory section and quoted passage that matters — those cannot be recovered later.",
    "Say plainly which points were verified against a source and which were not.",
    "Finish with a short list of what still needs doing.",
    "Do not add commentary, do not address the reader, and do not invent anything that is not in the notes.",
].join(" ");

/**
 * Replace a large working transcript with a written summary of it, so the turn
 * can carry on in a fraction of the space. Returns the conversation to run
 * instead — the original exchange, plus the notes.
 */
export async function condenseForContinuation(args: {
    state: ResumeState;
    apiKeys?: UserApiKeys;
}): Promise<LlmMessage[]> {
    const notes = flattenTranscriptText(args.state.transcript);
    let summary = "";
    if (notes.trim()) {
        summary = await completeText({
            model: args.state.model,
            systemPrompt: CONDENSE_SYSTEM,
            user: notes,
            maxTokens: 4000,
            apiKeys: args.apiKeys,
        });
    }
    const condensed: LlmMessage[] = [...args.state.baseMessages];
    if (summary.trim()) {
        condensed.push({
            role: "assistant",
            content: `[Condensed research notes from the earlier part of this answer]\n\n${summary}`,
        });
    }
    condensed.push({
        role: "user",
        content:
            "Carry on from those notes. You have a fresh budget of research steps. Do not repeat work the notes already cover — finish what is outstanding and then give your complete answer.",
    });
    return condensed;
}
