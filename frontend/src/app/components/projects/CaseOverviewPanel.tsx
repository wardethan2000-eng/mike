"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { updateCaseContext } from "@/app/lib/mikeApi";
import type { Document } from "@/app/components/shared/types";
import { CaseMemoryList, type SuggestionMode } from "./CaseMemoryList";

/**
 * What the assistant is told about a matter before anyone asks it anything.
 *
 * Two parts. The instructions are what the people on the matter want it to
 * know every time, without having to say it again in each chat — who they act
 * for, what they are trying to achieve, the court and case number, how the
 * firm likes documents laid out. Underneath are the facts the matter has
 * remembered as work went on.
 *
 * Both are sent with every question asked in the matter and are used when
 * drafting as well as when answering, so the instructions are capped at about
 * two pages and each remembered fact at a line or two.
 *
 * Typing saves on its own a moment after you stop. Anyone working the matter
 * can change any of this: it is the case's own work product, not one person's
 * notes, and having to find the owner to correct a party's name would be worse
 * than the risk of someone changing it.
 */

/** Matches the cap the server enforces when the instructions are saved. */
export const OVERVIEW_MAX_CHARS = 4000;

/** How long to wait after the last keystroke before saving. */
const SAVE_DELAY_MS = 900;

const PLACEHOLDER = `What should the assistant know every time it works on this matter?

For example:
- We act for the landlord, Acme Holdings LLC. The tenant is J. Rivera.
- District Court of Johnson County, Kansas, case 26-CV-1184.
- Goal is possession by 1 November without a contested hearing.
- Draft in the firm's house style: Times New Roman 12pt.`;

type SaveState = "idle" | "saving" | "saved" | "error";

export function CaseOverviewPanel({
    projectId,
    overview,
    documents = [],
    suggestionMode = "ask",
    onSaved,
    onSuggestionModeChange,
    onOpenDocument,
    onPendingCountChange,
    refreshSignal = 0,
}: {
    projectId: string;
    /** The saved instructions, or null. Undefined while the matter is loading. */
    overview: string | null | undefined;
    /** The matter's files, so a remembered fact can point at one. */
    documents?: Document[];
    /** How this matter handles what Mike finds. */
    suggestionMode?: SuggestionMode;
    /** Keeps the rest of the page in step with what was just saved. */
    onSaved?: (overview: string | null) => void;
    onSuggestionModeChange?: (mode: SuggestionMode) => Promise<void> | void;
    onOpenDocument?: (
        documentId: string,
        filename: string,
        page?: number | null,
    ) => void;
    /** So the page can mark the panel button when suggestions are waiting. */
    onPendingCountChange?: (pending: number) => void;
    /** Bumped when a chat answer finishes, so new suggestions are picked up. */
    refreshSignal?: number;
}) {
    const [draft, setDraft] = useState("");
    const [saveState, setSaveState] = useState<SaveState>("idle");
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [instructionsOpen, setInstructionsOpen] = useState(true);

    /** True once this person has typed, so a slow load can't wipe their work. */
    const editedHereRef = useRef(false);
    const saveTimerRef = useRef<number | null>(null);
    /** What the server currently holds, so we never save an unchanged value. */
    const savedValueRef = useRef<string>("");

    // Fill the box in when the matter arrives — but never on top of typing.
    useEffect(() => {
        if (overview === undefined) return;
        savedValueRef.current = overview ?? "";
        if (editedHereRef.current) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- first fill from the loaded matter
        setDraft(overview ?? "");
    }, [overview]);

    const save = useCallback(
        async (value: string) => {
            const trimmed = value.trim();
            if (trimmed === savedValueRef.current.trim()) {
                setSaveState("idle");
                return;
            }
            setSaveState("saving");
            setErrorMessage(null);
            try {
                await updateCaseContext(projectId, {
                    overview: trimmed ? trimmed : null,
                });
                savedValueRef.current = trimmed;
                setSaveState("saved");
                onSaved?.(trimmed ? trimmed : null);
            } catch (error) {
                setSaveState("error");
                setErrorMessage(
                    error instanceof Error && error.message
                        ? error.message
                        : "The instructions could not be saved.",
                );
            }
        },
        [onSaved, projectId],
    );

    // Save a moment after the typing stops, and again on the way out so a
    // half-written line is not lost by closing the panel.
    useEffect(() => {
        if (!editedHereRef.current) return;
        if (saveTimerRef.current !== null) {
            window.clearTimeout(saveTimerRef.current);
        }
        saveTimerRef.current = window.setTimeout(() => {
            saveTimerRef.current = null;
            void save(draft);
        }, SAVE_DELAY_MS);
        return () => {
            if (saveTimerRef.current !== null) {
                window.clearTimeout(saveTimerRef.current);
                saveTimerRef.current = null;
            }
        };
    }, [draft, save]);

    const remaining = OVERVIEW_MAX_CHARS - draft.length;
    const nearLimit = remaining <= 300;

    return (
        <div className="flex h-full min-h-0 flex-col divide-y divide-gray-100">
            <div className="flex shrink-0 flex-col">
                <button
                    type="button"
                    onClick={() => setInstructionsOpen((open) => !open)}
                    className="flex items-center gap-1 px-3 pt-3 pb-1 text-left text-xs font-medium text-gray-700"
                >
                    {instructionsOpen ? (
                        <ChevronDown className="h-3 w-3 text-gray-400" />
                    ) : (
                        <ChevronRight className="h-3 w-3 text-gray-400" />
                    )}
                    Instructions
                </button>

                {instructionsOpen ? (
                    <>
                        <p className="px-3 pb-2 text-xs leading-relaxed text-gray-500">
                            Sent with every question asked in this matter, and
                            used when drafting.
                        </p>
                        <div className="px-3">
                            <textarea
                                value={draft}
                                maxLength={OVERVIEW_MAX_CHARS}
                                rows={8}
                                onChange={(e) => {
                                    editedHereRef.current = true;
                                    setDraft(e.target.value);
                                    setSaveState("idle");
                                }}
                                onBlur={() => {
                                    if (!editedHereRef.current) return;
                                    if (saveTimerRef.current !== null) {
                                        window.clearTimeout(saveTimerRef.current);
                                        saveTimerRef.current = null;
                                    }
                                    void save(draft);
                                }}
                                placeholder={PLACEHOLDER}
                                spellCheck
                                className="w-full resize-y rounded border border-gray-200 bg-white p-3 text-sm leading-relaxed text-gray-800 outline-none placeholder:text-gray-400 focus:border-gray-400"
                            />
                        </div>

                        <div className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                            <span className="min-w-0 truncate text-gray-500">
                                {saveState === "saving"
                                    ? "Saving…"
                                    : saveState === "saved"
                                      ? "Saved"
                                      : saveState === "error"
                                        ? (errorMessage ?? "Not saved")
                                        : draft.trim()
                                          ? "Saves as you type"
                                          : "Nothing written yet"}
                            </span>
                            <div className="flex shrink-0 items-center gap-2">
                                {saveState === "error" && (
                                    <button
                                        type="button"
                                        onClick={() => void save(draft)}
                                        className="underline underline-offset-2 text-red-600"
                                    >
                                        Try again
                                    </button>
                                )}
                                <span
                                    className={`tabular-nums ${
                                        nearLimit
                                            ? "text-amber-600"
                                            : "text-gray-400"
                                    }`}
                                >
                                    {draft.length}/{OVERVIEW_MAX_CHARS}
                                </span>
                            </div>
                        </div>
                    </>
                ) : (
                    <p className="truncate px-3 pb-2 text-xs text-gray-400">
                        {draft.trim() || "Nothing written yet"}
                    </p>
                )}
            </div>

            <div className="min-h-0 flex-1">
                <CaseMemoryList
                    projectId={projectId}
                    documents={documents}
                    suggestionMode={suggestionMode}
                    onOpenDocument={onOpenDocument}
                    onSuggestionModeChange={onSuggestionModeChange}
                    onPendingCountChange={onPendingCountChange}
                    refreshSignal={refreshSignal}
                />
            </div>
        </div>
    );
}
