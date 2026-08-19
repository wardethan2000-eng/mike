"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
    Bold,
    Italic,
    Underline,
    AlignLeft,
    AlignCenter,
    AlignRight,
    List,
    ListOrdered,
    Undo2,
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
    color?: string; // 6-hex, no '#'
    size?: number; // points
}
interface EditParagraph {
    text: string;
    align?: "left" | "center" | "right" | "justify" | null;
    heading?: number | null;
    list?: "bullet" | "number" | null;
    runs: EditRun[];
}

const FONT_SIZES = [9, 10, 11, 12, 14, 16, 18, 24];
const COLORS: { label: string; hex: string }[] = [
    { label: "Black", hex: "000000" },
    { label: "Dark red", hex: "C00000" },
    { label: "Red", hex: "FF0000" },
    { label: "Blue", hex: "0070C0" },
    { label: "Dark blue", hex: "002060" },
    { label: "Green", hex: "008000" },
    { label: "Grey", hex: "7F7F7F" },
];

/** rgb()/rgba() or #hex -> 6-hex uppercase, or null if not parseable. */
function toHex(css: string): string | null {
    const m = /^rgba?\(([^)]+)\)$/.exec(css.trim());
    if (m) {
        const parts = m[1].split(",").map((v) => parseFloat(v));
        if (parts.length < 3 || parts.some((v) => Number.isNaN(v))) return null;
        const [r, g, b] = parts;
        return [r, g, b]
            .map((v) => Math.max(0, Math.min(255, Math.round(v)))
                .toString(16)
                .padStart(2, "0"))
            .join("")
            .toUpperCase();
    }
    const h = /^#([0-9a-fA-F]{6})$/.exec(css.trim());
    return h ? h[1].toUpperCase() : null;
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
    const [undoError, setUndoError] = useState<string | null>(null);
    // Bumped after an undo so the document is re-fetched and re-rendered.
    const [reloadKey, setReloadKey] = useState(0);

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
                fmt: {
                    bold: boolean;
                    italic: boolean;
                    underline: boolean;
                    color?: string;
                    size?: number;
                },
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
                            !!last.underline === fmt.underline &&
                            last.color === fmt.color &&
                            last.size === fmt.size
                        ) {
                            last.text += t;
                        } else {
                            runs.push({
                                text: t,
                                bold: fmt.bold || undefined,
                                italic: fmt.italic || undefined,
                                underline: fmt.underline || undefined,
                                color: fmt.color,
                                size: fmt.size,
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
                        // Colour and size are only taken from runs the toolbar
                        // marked. Reading them off computed style for every
                        // element would rewrite untouched text with the
                        // renderer's pixel values.
                        const markedColor = el.dataset?.mikeColor;
                        const markedSize = el.dataset?.mikeSize;
                        walk(el, {
                            bold: fmt.bold || weight >= 600,
                            italic: fmt.italic || cs.fontStyle === "italic",
                            underline:
                                fmt.underline ||
                                cs.textDecorationLine.includes("underline"),
                            color: markedColor
                                ? markedColor.toUpperCase()
                                : fmt.color,
                            size: markedSize ? Number(markedSize) : fmt.size,
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
            // docx-preview renders a Heading-styled paragraph with a class
            // like "docx_Heading1"; a paragraph we just marked carries
            // data-mike-heading.
            let heading = 0;
            const marked = p.dataset?.mikeHeading;
            if (marked !== undefined) {
                heading = Number(marked) || 0;
            } else {
                const cls = p.className || "";
                const hm = /(?:^|[\s_-])(?:docx_)?[Hh]eading\s?([1-9])/.exec(cls);
                if (hm) heading = Number(hm[1]);
            }
            // A list item is either one we just marked, or one docx-preview
            // rendered inside a <ul>/<ol> (or with a list-ish class) from the
            // document's own numbering.
            let list: "bullet" | "number" | null = null;
            const markedList = p.dataset?.mikeList;
            if (markedList === "bullet" || markedList === "number") {
                list = markedList;
            } else if (markedList === "none") {
                list = null;
            } else {
                const li = p.closest("li");
                if (li) {
                    list = li.closest("ol") ? "number" : "bullet";
                } else if (/docx-num|list-paragraph|ListParagraph/i.test(p.className || "")) {
                    list = "bullet";
                }
            }
            paras.push({ text, align, heading, list, runs });
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

    /**
     * Wrap the current selection in a span tagged with the chosen colour or
     * size. The tag is what the serializer reads, so only text the user
     * actually styled is sent with colour/size — everything else keeps the
     * document's own formatting.
     */
    const applyRunStyle = useCallback(
        (kind: "color" | "size", value: string) => {
            const sel = window.getSelection();
            if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
            const range = sel.getRangeAt(0);
            const root = containerRef.current;
            if (!root || !root.contains(range.commonAncestorContainer)) return;

            const span = document.createElement("span");
            if (kind === "color") {
                span.dataset.mikeColor = value;
                span.style.color = `#${value}`;
            } else {
                span.dataset.mikeSize = value;
                span.style.fontSize = `${value}pt`;
            }
            try {
                range.surroundContents(span);
            } catch {
                // Selection crosses element boundaries — fall back to
                // extracting and re-inserting the fragment.
                const frag = range.extractContents();
                span.appendChild(frag);
                range.insertNode(span);
            }
            sel.removeAllRanges();
            containerRef.current?.focus();
            scheduleSave();
        },
        [scheduleSave],
    );

    /** Mark the paragraph(s) in the selection as a bullet/numbered item. */
    const applyList = useCallback(
        (kind: "bullet" | "number") => {
            const sel = window.getSelection();
            const root = containerRef.current;
            if (!sel || sel.rangeCount === 0 || !root) return;
            const range = sel.getRangeAt(0);
            const paras = Array.from(
                root.querySelectorAll<HTMLElement>("article p"),
            ).filter(
                (p) => !p.closest("header, footer") && range.intersectsNode(p),
            );
            if (paras.length === 0) return;
            // Toggle: if every selected paragraph is already this kind, clear it.
            const allSame = paras.every((p) => p.dataset.mikeList === kind);
            for (const p of paras) {
                if (allSame) {
                    p.dataset.mikeList = "none";
                    p.style.removeProperty("list-style-type");
                    p.style.removeProperty("display");
                    p.style.removeProperty("margin-left");
                } else {
                    p.dataset.mikeList = kind;
                    // Show it as a list straight away.
                    p.style.display = "list-item";
                    p.style.listStyleType = kind === "bullet" ? "disc" : "decimal";
                    p.style.marginLeft = "2em";
                }
            }
            containerRef.current?.focus();
            scheduleSave();
        },
        [scheduleSave],
    );

    /** Step the document back to how it was before the last save. */
    const undoLastSave = useCallback(async () => {
        if (savingRef.current) return;
        setSaveState("saving");
        try {
            const headers = await authHeaders();
            const resp = await fetch(
                `${apiBase}/single-documents/${documentId}/undo-edit`,
                { method: "POST", headers },
            );
            if (!resp.ok) {
                const body = (await resp.json().catch(() => null)) as {
                    detail?: string;
                } | null;
                setUndoError(body?.detail ?? "Couldn't undo.");
                setSaveState("idle");
                return;
            }
            const data = (await resp.json()) as { id?: string };
            if (data.id) {
                savedVersionRef.current = data.id;
                onSaved?.(data.id);
            }
            setUndoError(null);
            // Re-render the restored document.
            setReloadKey((n) => n + 1);
            setSaveState("idle");
        } catch (e) {
            console.error("[RichDocxEditor] undo failed", e);
            setUndoError("Couldn't undo.");
            setSaveState("idle");
        }
    }, [documentId, onSaved]);

    /** Mark the paragraph(s) in the selection as a heading (0 = body text). */
    const applyHeading = useCallback(
        (level: number) => {
            const sel = window.getSelection();
            const root = containerRef.current;
            if (!sel || sel.rangeCount === 0 || !root) return;
            const range = sel.getRangeAt(0);
            const paras = Array.from(
                root.querySelectorAll<HTMLElement>("article p"),
            ).filter(
                (p) => !p.closest("header, footer") && range.intersectsNode(p),
            );
            if (paras.length === 0) return;
            for (const p of paras) {
                p.dataset.mikeHeading = String(level);
                // Reflect it on screen straight away.
                p.style.fontWeight = level ? "700" : "";
                p.style.fontSize = level
                    ? `${[0, 16, 14, 13][level] ?? 13}pt`
                    : "";
            }
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
    }, [documentId, bodyParagraphEls, reloadKey]);

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
                <div className="mx-1 h-5 w-px bg-gray-200" />
                <ToolbarButton
                    onClick={() => applyList("bullet")}
                    title="Bulleted list"
                >
                    <List className="h-4 w-4" />
                </ToolbarButton>
                <ToolbarButton
                    onClick={() => applyList("number")}
                    title="Numbered list"
                >
                    <ListOrdered className="h-4 w-4" />
                </ToolbarButton>
                <div className="mx-1 h-5 w-px bg-gray-200" />
                <select
                    aria-label="Paragraph style"
                    title="Paragraph style"
                    defaultValue="0"
                    onMouseDown={(e) => e.stopPropagation()}
                    onChange={(e) => {
                        applyHeading(Number(e.target.value));
                        e.target.selectedIndex = 0;
                    }}
                    className="h-7 rounded border border-gray-200 bg-white px-1 text-xs text-gray-600"
                >
                    <option value="0">Body text</option>
                    <option value="1">Heading 1</option>
                    <option value="2">Heading 2</option>
                    <option value="3">Heading 3</option>
                </select>
                <select
                    aria-label="Font size"
                    title="Font size (applies to the selected text)"
                    defaultValue=""
                    onMouseDown={(e) => e.stopPropagation()}
                    onChange={(e) => {
                        if (e.target.value) applyRunStyle("size", e.target.value);
                        e.target.selectedIndex = 0;
                    }}
                    className="h-7 rounded border border-gray-200 bg-white px-1 text-xs text-gray-600"
                >
                    <option value="">Size</option>
                    {FONT_SIZES.map((sz) => (
                        <option key={sz} value={String(sz)}>
                            {sz}
                        </option>
                    ))}
                </select>
                <select
                    aria-label="Text colour"
                    title="Text colour (applies to the selected text)"
                    defaultValue=""
                    onMouseDown={(e) => e.stopPropagation()}
                    onChange={(e) => {
                        if (e.target.value) applyRunStyle("color", e.target.value);
                        e.target.selectedIndex = 0;
                    }}
                    className="h-7 rounded border border-gray-200 bg-white px-1 text-xs text-gray-600"
                >
                    <option value="">Colour</option>
                    {COLORS.map((c) => (
                        <option key={c.hex} value={c.hex}>
                            {c.label}
                        </option>
                    ))}
                </select>
                <div className="mx-1 h-5 w-px bg-gray-200" />
                <ToolbarButton
                    onClick={() => void undoLastSave()}
                    title="Undo the last saved change"
                >
                    <Undo2 className="h-4 w-4" />
                </ToolbarButton>
                {undoError && (
                    <span className="flex items-center gap-1 rounded bg-amber-50 px-1.5 py-0.5 text-[11px] text-amber-800">
                        {undoError}
                        <button
                            type="button"
                            onClick={() => setUndoError(null)}
                            aria-label="Dismiss"
                            className="text-amber-600 hover:text-amber-900"
                        >
                            ×
                        </button>
                    </span>
                )}
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
