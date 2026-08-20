"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Loader2, X } from "lucide-react";
import { Modal } from "./Modal";

/** Turn a note title into a safe .txt filename. */
export function textNoteFilename(title: string): string {
    const cleaned = title
        .trim()
        .replace(/[/\\]/g, "-")
        .slice(0, 120);
    return `${cleaned || "Note"}.txt`;
}

interface Props {
    open: boolean;
    onClose: () => void;
    mode: "add" | "edit";
    /** Shown as the title. In edit mode the title is fixed — renaming the
     * document already exists elsewhere, and keeping the two apart avoids
     * the list and the file disagreeing about the name. */
    initialTitle?: string;
    /** The existing text in edit mode. Pass null while it is still loading. */
    initialText?: string | null;
    onSave: (title: string, text: string) => Promise<void>;
}

/**
 * Type or paste text that should live with the matter — notes, background,
 * client emails. Saved as a plain-text document, so the assistant reads it,
 * search finds it, and it can be cited like anything else that was uploaded.
 */
export function TextNoteModal({
    open,
    onClose,
    mode,
    initialTitle,
    initialText,
    onSave,
}: Props) {
    const [title, setTitle] = useState("");
    const [text, setText] = useState("");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    // In edit mode the text arrives after a fetch; seed it once it lands
    // (and only if the user has not started typing over the placeholder).
    const seededRef = useRef(false);

    useEffect(() => {
        if (!open) {
            seededRef.current = false;
            return;
        }
        setTitle(initialTitle ?? "");
        setError(null);
        setSaving(false);
        if (mode === "add") {
            setText("");
            seededRef.current = true;
        } else {
            setText(initialText ?? "");
            seededRef.current = initialText != null;
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    useEffect(() => {
        if (!open || mode !== "edit" || seededRef.current) return;
        if (initialText != null) {
            setText(initialText);
            seededRef.current = true;
        }
    }, [open, mode, initialText]);

    const loadingText = mode === "edit" && !seededRef.current;

    async function handleSave() {
        if (saving || loadingText) return;
        const trimmed = text.trim();
        if (!trimmed) return;
        setSaving(true);
        setError(null);
        try {
            await onSave(title.trim() || "Note", text);
            onClose();
        } catch (e) {
            console.error("Saving text failed:", e);
            setError("Could not save. Please try again.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <Modal
            open={open}
            onClose={onClose}
            breadcrumbs={[mode === "add" ? "Add text" : "Edit text"]}
            primaryAction={{
                label: saving ? "Saving…" : "Save",
                icon: saving ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : undefined,
                onClick: () => void handleSave(),
                disabled: saving || loadingText || !text.trim(),
            }}
        >
            <div className="flex min-h-0 flex-1 flex-col gap-2">
                {error && (
                    <div className="flex items-center gap-2 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-xs text-gray-900">
                        <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-600" />
                        <span className="min-w-0 flex-1">{error}</span>
                        <button
                            type="button"
                            onClick={() => setError(null)}
                            className="shrink-0 rounded p-0.5 text-black hover:bg-gray-100"
                            aria-label="Dismiss error"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    </div>
                )}
                {mode === "add" ? (
                    <input
                        type="text"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        placeholder="Title"
                        maxLength={120}
                        className="w-full rounded-lg border border-gray-200 bg-app-surface px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-300 focus:outline-none"
                    />
                ) : (
                    <div className="truncate px-1 text-sm font-medium text-gray-700">
                        {initialTitle}
                    </div>
                )}
                {loadingText ? (
                    <div className="flex flex-1 items-center justify-center text-gray-400">
                        <Loader2 className="h-5 w-5 animate-spin" />
                    </div>
                ) : (
                    <textarea
                        value={text}
                        onChange={(e) => setText(e.target.value)}
                        placeholder="Type or paste notes, background, emails — anything that should live with this matter. It is saved with the matter's files, so Mike reads it and search finds it."
                        className="min-h-0 w-full flex-1 resize-none rounded-lg border border-gray-200 bg-app-surface px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-300 focus:outline-none"
                    />
                )}
            </div>
        </Modal>
    );
}
