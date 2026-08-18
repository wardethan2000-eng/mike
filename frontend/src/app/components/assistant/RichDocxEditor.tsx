"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
    Bold,
    Italic,
    Underline,
    AlignLeft,
    AlignCenter,
    AlignRight,
    Loader2,
} from "lucide-react";
import { supabase } from "@/app/lib/supabase";

const apiBase =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

async function authHeaders(): Promise<HeadersInit> {
    const {
        data: { session },
    } = await supabase.auth.getSession();
    const token = session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
}

interface EditRun {
    text: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
}
interface EditParagraph {
    text: string;
    align?: "left" | "center" | "right" | "justify" | null;
    runs: EditRun[];
}

type SaveState = "idle" | "saving" | "saved" | "error";

/**
 * An always-on editor rendered directly on the Word document. The body is
 * editable in place (click and type), a toolbar applies bold / italic /
 * underline and alignment, and changes autosave a moment after you stop
 * typing. Formatting is written back into the .docx; the letterhead, header,
 * footer and fonts are preserved.
 */
export function RichDocxEditor({
    documentId,
    versionId,
    onSaved,
}: {
    documentId: string;
    versionId?: string | null;
    onSaved?: (versionId: string) => void;
}) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const baselineRef = useRef<string[] | null>(null);
    const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const savingRef = useRef(false);
    const pendingRef = useRef(false);
    const savedVersionRef = useRef<string | null>(null);

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [saveState, setSaveState] = useState<SaveState>("idle");

    // --- serialize the rendered body into formatted paragraphs -------------

    const bodyParagraphEls = useCallback((): HTMLElement[] => {
        const root = containerRef.current;
        if (!root) return [];
        return Array.from(root.querySelectorAll<HTMLElement>("article p")).filter(
            (p) => !p.closest("header, footer"),
        );
    }, []);

    const serialize = useCallback((): EditParagraph[] => {
        const paras: EditParagraph[] = [];
        for (const p of bodyParagraphEls()) {
            const runs: EditRun[] = [];
            let text = "";
            const walk = (
                node: Node,
                fmt: { bold: boolean; italic: boolean; underline: boolean },
            ) => {
                for (const child of Array.from(node.childNodes)) {
                    if (child.nodeType === Node.TEXT_NODE) {
                        const t = (child.textContent ?? "").replace(/\t/g, "");
                        if (!t) continue;
                        text += t;
                        const last = runs[runs.length - 1];
                        if (
                            last &&
                            !!last.bold === fmt.bold &&
                            !!last.italic === fmt.italic &&
                            !!last.underline === fmt.underline
                        ) {
                            last.text += t;
                        } else {
                            runs.push({
                                text: t,
                                bold: fmt.bold || undefined,
                                italic: fmt.italic || undefined,
                                underline: fmt.underline || undefined,
                            });
                        }
                    } else if (child.nodeType === Node.ELEMENT_NODE) {
                        const el = child as HTMLElement;
                        if (el.tagName === "BR") {
                            text += "\n";
                            const last = runs[runs.length - 1];
                            if (last) last.text += "\n";
                            continue;
                        }
                        const cs = window.getComputedStyle(el);
                        const weight = parseInt(cs.fontWeight, 10);
                        walk(el, {
                            bold: fmt.bold || weight >= 600,
                            italic: fmt.italic || cs.fontStyle === "italic",
                            underline:
                                fmt.underline ||
                                cs.textDecorationLine.includes("underline"),
                        });
                    }
                }
            };
            walk(p, { bold: false, italic: false, underline: false });
            const ta = window.getComputedStyle(p).textAlign;
            const align =
                ta === "center"
                    ? "center"
                    : ta === "right"
                      ? "right"
                      : ta === "justify"
                        ? "justify"
                        : null;
            paras.push({ text, align, runs });
        }
        return paras;
    }, [bodyParagraphEls]);

    // --- autosave ----------------------------------------------------------

    const doSave = useCallback(async () => {
        if (!baselineRef.current) return;
        if (savingRef.current) {
            pendingRef.current = true;
            return;
        }
        savingRef.current = true;
        setSaveState("saving");
        try {
            const paragraphs = serialize();
            const headers = await authHeaders();
            const resp = await fetch(
                `${apiBase}/single-documents/${documentId}/formatted-edit`,
                {
                    method: "POST",
                    headers: { ...headers, "Content-Type": "application/json" },
                    body: JSON.stringify({
                        baseline: baselineRef.current,
                        paragraphs,
                    }),
                },
            );
            if (resp.status === 409) {
                setSaveState("error");
                return;
            }
            if (!resp.ok) throw new Error(`save failed (${resp.status})`);
            const data = (await resp.json()) as { id?: string };
            if (data.id && data.id !== savedVersionRef.current) {
                savedVersionRef.current = data.id;
                onSaved?.(data.id);
            }
            // The document's own text is unchanged by formatting, so the
            // baseline stays valid across saves within this session.
            baselineRef.current = serialize().map((p) => p.text);
            setSaveState("saved");
        } catch (e) {
            console.error("[RichDocxEditor] autosave failed", e);
            setSaveState("error");
        } finally {
            savingRef.current = false;
            if (pendingRef.current) {
                pendingRef.current = false;
                void doSave();
            }
        }
    }, [documentId, onSaved, serialize]);

    const scheduleSave = useCallback(() => {
        setSaveState("saving");
        if (saveTimer.current) clearTimeout(saveTimer.current);
        saveTimer.current = setTimeout(() => void doSave(), 1200);
    }, [doSave]);

    // --- toolbar -----------------------------------------------------------

    const exec = useCallback(
        (command: string, value?: string) => {
            document.execCommand(command, false, value);
            containerRef.current?.focus();
            scheduleSave();
        },
        [scheduleSave],
    );

    // --- render docx-preview, then make the body editable ------------------

    useEffect(() => {
        let cancelled = false;
        const scrollEl = scrollRef.current;
        const containerEl = containerRef.current;
        if (!scrollEl || !containerEl) return;

        (async () => {
            setLoading(true);
            setError(null);
            try {
                const headers = await authHeaders();
                // Always edit the current version so the rendered document, its
                // baseline, and the save target are the same file. A pinned
                // versionId can lag behind after an edit and cause the save to
                // be rejected as stale.
                const qs = "";
                const resp = await fetch(
                    `${apiBase}/single-documents/${documentId}/docx${qs}`,
                    { headers },
                );
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const bytes = await resp.arrayBuffer();
                if (cancelled) return;

                const { renderAsync } = await import("docx-preview");
                if (cancelled) return;
                containerEl.innerHTML = "";
                await renderAsync(bytes, containerEl, undefined, {
                    inWrapper: true,
                    ignoreWidth: false,
                    ignoreHeight: false,
                    renderChanges: false,
                    experimental: true,
                });
                if (cancelled) return;

                // Fit each page to the panel width.
                const wrapper =
                    containerEl.querySelector<HTMLElement>(".docx-wrapper");
                if (wrapper) {
                    const avail = scrollEl.clientWidth - 40;
                    wrapper
                        .querySelectorAll<HTMLElement>("section.docx")
                        .forEach((s) => {
                            const w = s.offsetWidth;
                            if (w) s.style.zoom = String(Math.min(1, avail / w));
                        });
                }

                // Make the body editable (header/footer stay locked).
                try {
                    document.execCommand(
                        "defaultParagraphSeparator",
                        false,
                        "p",
                    );
                } catch {
                    /* ignore */
                }
                const articles = Array.from(
                    containerEl.querySelectorAll<HTMLElement>("article"),
                );
                for (const a of articles) {
                    a.contentEditable = "true";
                    a.spellcheck = true;
                    a.style.outline = "none";
                    a.querySelectorAll<HTMLElement>("header, footer").forEach(
                        (hf) => {
                            hf.contentEditable = "false";
                        },
                    );
                }
                // Use the server's own paragraph text as the baseline so a
                // save is reconciled against exactly what the server holds —
                // docx-preview can render text slightly differently than the
                // server flattens it, and a DOM-derived baseline would make
                // every save fail the staleness check.
                try {
                    const pResp = await fetch(
                        `${apiBase}/single-documents/${documentId}/paragraphs${qs}`,
                        { headers },
                    );
                    if (pResp.ok) {
                        const pData = (await pResp.json()) as {
                            paragraphs?: string[];
                        };
                        baselineRef.current = Array.isArray(pData.paragraphs)
                            ? pData.paragraphs
                            : bodyParagraphEls().map((p) =>
                                  (p.textContent ?? "").replace(/\t/g, ""),
                              );
                    } else {
                        baselineRef.current = bodyParagraphEls().map((p) =>
                            (p.textContent ?? "").replace(/\t/g, ""),
                        );
                    }
                } catch {
                    baselineRef.current = bodyParagraphEls().map((p) =>
                        (p.textContent ?? "").replace(/\t/g, ""),
                    );
                }
                setLoading(false);
            } catch (e) {
                if (cancelled) return;
                console.error("[RichDocxEditor] load failed", e);
                setError(
                    e instanceof Error ? e.message : "Could not open the document.",
                );
                setLoading(false);
            }
        })();

        return () => {
            cancelled = true;
            if (saveTimer.current) clearTimeout(saveTimer.current);
        };
    }, [documentId, bodyParagraphEls]);

    const ToolbarButton = ({
        onClick,
        title,
        children,
    }: {
        onClick: () => void;
        title: string;
        children: React.ReactNode;
    }) => (
        <button
            type="button"
            // Keep the editor selection when clicking a toolbar button.
            onMouseDown={(e) => e.preventDefault()}
            onClick={onClick}
            title={title}
            className="flex h-7 w-7 items-center justify-center rounded text-gray-600 hover:bg-gray-100"
        >
            {children}
        </button>
    );

    return (
        <div className="relative flex flex-1 min-h-0 flex-col bg-gray-100">
            <div className="flex items-center gap-0.5 border-b border-gray-200 bg-white px-2 py-1">
                <ToolbarButton onClick={() => exec("bold")} title="Bold">
                    <Bold className="h-4 w-4" />
                </ToolbarButton>
                <ToolbarButton onClick={() => exec("italic")} title="Italic">
                    <Italic className="h-4 w-4" />
                </ToolbarButton>
                <ToolbarButton
                    onClick={() => exec("underline")}
                    title="Underline"
                >
                    <Underline className="h-4 w-4" />
                </ToolbarButton>
                <div className="mx-1 h-5 w-px bg-gray-200" />
                <ToolbarButton
                    onClick={() => exec("justifyLeft")}
                    title="Align left"
                >
                    <AlignLeft className="h-4 w-4" />
                </ToolbarButton>
                <ToolbarButton
                    onClick={() => exec("justifyCenter")}
                    title="Center"
                >
                    <AlignCenter className="h-4 w-4" />
                </ToolbarButton>
                <ToolbarButton
                    onClick={() => exec("justifyRight")}
                    title="Align right"
                >
                    <AlignRight className="h-4 w-4" />
                </ToolbarButton>
                <span className="ml-auto pr-1 text-xs text-gray-400">
                    {saveState === "saving"
                        ? "Saving…"
                        : saveState === "saved"
                          ? "Saved"
                          : saveState === "error"
                            ? "Couldn't save"
                            : ""}
                </span>
            </div>
            <div
                ref={scrollRef}
                className="relative flex-1 overflow-auto px-5 pt-4 pb-3"
                data-document-id={documentId}
            >
                {loading && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-100">
                        <Loader2 className="h-7 w-7 animate-spin text-gray-400" />
                    </div>
                )}
                {error && (
                    <div className="absolute inset-0 z-10 flex items-center justify-center bg-gray-100">
                        <p className="text-sm text-red-500">{error}</p>
                    </div>
                )}
                <div
                    ref={containerRef}
                    className="docx-view-container"
                    onInput={scheduleSave}
                />
            </div>
        </div>
    );
}
