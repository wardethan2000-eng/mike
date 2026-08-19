"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { updateProject } from "@/app/lib/mikeApi";

/**
 * The case overview: what the people on a matter want the assistant to know
 * every time, without having to say it again in each chat — who they act for,
 * what they are trying to achieve, the court and case number, how the firm
 * likes documents laid out.
 *
 * It is sent with every question asked inside the matter and is used when
 * drafting as well as when answering, so it is capped at about two pages.
 *
 * Typing saves on its own a moment after you stop. Only the matter's owner can
 * change it; anyone it is shared with can read it.
 */

/** Matches the cap the server enforces when the overview is saved. */
export const OVERVIEW_MAX_CHARS = 4000;

/** How long to wait after the last keystroke before saving. */
const SAVE_DELAY_MS = 900;

const PLACEHOLDER = `What should the assistant know every time it works on this matter?

For example:
- We act for the landlord, Acme Holdings LLC. The tenant is J. Rivera.
- District Court of Johnson County, Kansas, case 26-CV-1184.
- Goal is possession by 1 November without a contested hearing.
- Opposing counsel is D. Shaw at Shaw & Bell; serve by email.
- Draft in the firm's house style: Times New Roman 12pt, no numbered clauses on filings.`;

type SaveState = "idle" | "saving" | "saved" | "error";

export function CaseOverviewPanel({
    projectId,
    overview,
    canEdit,
    onSaved,
}: {
    projectId: string;
    /** The saved overview, or null. Undefined while the matter is loading. */
    overview: string | null | undefined;
    canEdit: boolean;
    /** Keeps the rest of the page in step with what was just saved. */
    onSaved?: (overview: string | null) => void;
}) {
    const [draft, setDraft] = useState("");
    const [saveState, setSaveState] = useState<SaveState>("idle");
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

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
                await updateProject(projectId, {
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
                        : "The overview could not be saved.",
                );
            }
        },
        [onSaved, projectId],
    );

    // Save a moment after the typing stops, and again on the way out so a
    // half-written line is not lost by closing the panel.
    useEffect(() => {
        if (!editedHereRef.current || !canEdit) return;
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
    }, [canEdit, draft, save]);

    const remaining = OVERVIEW_MAX_CHARS - draft.length;
    const nearLimit = remaining <= 300;

    return (
        <div className="flex h-full min-h-0 flex-col">
            <div className="px-3 pt-3 pb-2 text-xs text-gray-500 leading-relaxed">
                Sent with every question asked in this matter, and used when
                drafting.
            </div>

            <div className="flex-1 min-h-0 px-3 pb-2">
                <textarea
                    value={draft}
                    readOnly={!canEdit}
                    maxLength={OVERVIEW_MAX_CHARS}
                    onChange={(e) => {
                        editedHereRef.current = true;
                        setDraft(e.target.value);
                        setSaveState("idle");
                    }}
                    onBlur={() => {
                        if (!canEdit || !editedHereRef.current) return;
                        if (saveTimerRef.current !== null) {
                            window.clearTimeout(saveTimerRef.current);
                            saveTimerRef.current = null;
                        }
                        void save(draft);
                    }}
                    placeholder={canEdit ? PLACEHOLDER : ""}
                    spellCheck
                    className={`h-full w-full resize-none rounded border border-gray-200 p-3 text-sm leading-relaxed text-gray-800 outline-none placeholder:text-gray-400 focus:border-gray-400 ${
                        canEdit ? "bg-white" : "bg-gray-50"
                    }`}
                />
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-gray-100 px-3 py-2 text-xs">
                <span className="min-w-0 truncate text-gray-500">
                    {!canEdit
                        ? "Only the matter's owner can change this."
                        : saveState === "saving"
                          ? "Saving…"
                          : saveState === "saved"
                            ? "Saved"
                            : saveState === "error"
                              ? (errorMessage ?? "Not saved")
                              : draft.trim()
                                ? "Saves as you type"
                                : "Nothing written yet"}
                </span>
                {canEdit && (
                    <span
                        className={`shrink-0 tabular-nums ${
                            nearLimit ? "text-amber-600" : "text-gray-400"
                        }`}
                    >
                        {draft.length}/{OVERVIEW_MAX_CHARS}
                    </span>
                )}
            </div>

            {saveState === "error" && canEdit && (
                <div className="border-t border-red-100 bg-red-50 px-3 py-2 text-xs text-red-700">
                    <button
                        onClick={() => void save(draft)}
                        className="underline underline-offset-2"
                    >
                        Try saving again
                    </button>
                </div>
            )}
        </div>
    );
}
