"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Pencil } from "lucide-react";
import { useFetchDocxBytes } from "@/app/hooks/useFetchDocxBytes";
import { supabase } from "@/app/lib/supabase";
import {
    clearDocxQuoteHighlights,
    highlightDocxQuote,
} from "./highlightDocxQuote";
import type { CitationQuote } from "../types";

interface Props {
    documentId: string;
    versionId?: string | null;
    /**
     * Called once the document has been rendered to the DOM. Handy for
     * scrolling to a particular tracked change after a re-render.
     */
    onReady?: () => void;
    /**
     * Tracked-change to scroll to + briefly flash after each render. The
     * `key` is used to re-trigger scrolling when the same edit is clicked
     * twice in a row.
     */
    highlightEdit?: {
        key: string;
        inserted_text?: string;
        deleted_text?: string;
        /**
         * Numeric w:id values of the <w:ins>/<w:del> wrappers in
         * document.xml. Preferred over text matching — uniquely identifies
         * the right DOM element even when multiple edits share identical
         * inserted/deleted text. `docx-preview` drops these during parsing,
         * so we re-tag each rendered <ins>/<del> with data-w-id after load.
         */
        ins_w_id?: string | null;
        del_w_id?: string | null;
    } | null;
    /**
     * Forces a byte re-fetch when it changes, even if documentId/versionId
     * are stable. Used after accept/reject: the backend overwrites bytes at
     * the same storage path (no new version row), so the hook has no other
     * signal that the file changed.
     */
    refetchKey?: number;
    /**
     * Citation quotes to highlight in the rendered output. The first match
     * is scrolled into view. Page numbers are ignored — DOCX has no explicit
     * pagination the renderer can match against.
     */
    quotes?: CitationQuote[];
    /** Changes when the parent wants the current quote re-focused. */
    quoteFocusKey?: string | number;
    /**
     * Warning banner copy rendered in the top-left of the viewer. Used
     * for non-blocking errors (e.g. "Accept failed — reverted").
     */
    warning?: string | null;
    /**
     * Called when the user dismisses the warning banner.
     */
    onWarningDismiss?: () => void;
    /**
     * Scroll position to restore after the first render — used by parents
     * that track per-tab scroll and want to re-enter at the same spot.
     * Null/undefined means "no override" (preserve the pre-render scroll).
     */
    initialScrollTop?: number | null;
    /**
     * Fires on scroll (throttled by rAF) so the parent can persist the
     * current scrollTop against its tab state.
     */
    onScrollChange?: (scrollTop: number) => void;
    rounded?: boolean;
    /** Show an Edit button that opens the inline paragraph editor. */
    editable?: boolean;
    /**
     * Called after a successful inline save with the new version id, so the
     * parent can refresh the version badge / metadata.
     */
    onSaved?: (versionId: string) => void;
}

function findEditElement(
    root: HTMLElement,
    tag: "ins" | "del",
    opts: { w_id?: string | null; text?: string },
): HTMLElement | null {
    if (opts.w_id) {
        const byId = root.querySelector(
            `${tag}[data-w-id="${CSS.escape(opts.w_id)}"]`,
        ) as HTMLElement | null;
        if (byId) return byId;
    }
    const text = opts.text ?? "";
    const normalize = (s: string) => s.replace(/\s+/g, " ").trim();
    const target = normalize(text);
    if (!target) return null;
    const candidates = Array.from(root.querySelectorAll(tag)) as HTMLElement[];
    return (
        candidates.find((el) => normalize(el.textContent ?? "") === target) ??
        candidates.find((el) =>
            normalize(el.textContent ?? "").includes(target),
        ) ??
        null
    );
}

function scrollToHighlight(
    container: HTMLElement,
    scrollEl: HTMLElement,
    edit: {
        inserted_text?: string;
        deleted_text?: string;
        ins_w_id?: string | null;
        del_w_id?: string | null;
    },
) {
    const insEl = findEditElement(container, "ins", {
        w_id: edit.ins_w_id,
        text: edit.inserted_text,
    });
    const delEl = findEditElement(container, "del", {
        w_id: edit.del_w_id,
        text: edit.deleted_text,
    });
    const anchor = insEl ?? delEl;
    if (!anchor) return;

    const scrollRect = scrollEl.getBoundingClientRect();
    const targetRect = anchor.getBoundingClientRect();
    const offset = targetRect.top - scrollRect.top + scrollEl.scrollTop - 80;
    scrollEl.scrollTo({ top: Math.max(0, offset), behavior: "smooth" });

    const flashed = [insEl, delEl].filter((el): el is HTMLElement => !!el);
    flashed.forEach((el) => el.classList.add("docx-edit-flash"));
    window.setTimeout(() => {
        flashed.forEach((el) => el.classList.remove("docx-edit-flash"));
    }, 2000);
}

/**
 * Fetch the ordered list of w:ids for every w:ins/w:del in the current
 * version and tag each rendered <ins>/<del> with data-w-id. The backend
 * returns ids in document order, and docx-preview emits <ins>/<del>
 * in the same order, so we can align by index.
 */
async function tagWIdsOnRenderedDom(
    container: HTMLElement,
    documentId: string,
    versionId: string | null | undefined,
): Promise<void> {
    try {
        const {
            data: { session },
        } = await supabase.auth.getSession();
        const token = session?.access_token;
        const apiBase =
            process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
        const qs = versionId
            ? `?version_id=${encodeURIComponent(versionId)}`
            : "";
        const resp = await fetch(
            `${apiBase}/single-documents/${documentId}/tracked-change-ids${qs}`,
            { headers: token ? { Authorization: `Bearer ${token}` } : {} },
        );
        if (!resp.ok) {
            console.warn(
                "[DocxView] tracked-change-ids fetch failed",
                resp.status,
            );
            return;
        }
        const data = (await resp.json()) as {
            ids: { kind: "ins" | "del"; w_id: string }[];
        };
        const domEls = Array.from(
            container.querySelectorAll("ins, del"),
        ) as HTMLElement[];
        const ids = data.ids ?? [];
        let tagged = 0;
        let mismatched = 0;
        for (let i = 0; i < Math.min(domEls.length, ids.length); i++) {
            const el = domEls[i];
            const info = ids[i];
            if (el.tagName.toLowerCase() !== info.kind) {
                mismatched++;
                continue;
            }
            el.setAttribute("data-w-id", info.w_id);
            tagged++;
        }
    } catch (e) {
        console.warn("[DocxView] tagWIdsOnRenderedDom failed", e);
    }
}

/**
 * Renders a .docx in the browser using `docx-preview`. Tracked changes
 * (`w:ins` / `w:del`) show up automatically with coloured strike/underline
 * styling. Scroll position is preserved across re-renders so Accept/Reject
 * doesn't jump the user back to the top.
 */
export function DocxView({
    documentId,
    versionId,
    onReady,
    highlightEdit,
    refetchKey,
    quotes,
    quoteFocusKey,
    warning,
    onWarningDismiss,
    initialScrollTop,
    onScrollChange,
    rounded = true,
    editable = false,
    onSaved,
}: Props) {
    const scrollRef = useRef<HTMLDivElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const lastScrollTopRef = useRef(0);
    const renderKeyRef = useRef(0);
    // Ref-stabilize onReady and highlightEdit so the render effect only
    // re-fires when `bytes` actually change. Without this, any parent
    // re-render (e.g. clicking a new highlight) creates a new onReady
    // identity, triggers a full re-render, and snaps scroll back to top.
    const onReadyRef = useRef(onReady);
    onReadyRef.current = onReady;
    const highlightEditRef = useRef(highlightEdit);
    highlightEditRef.current = highlightEdit;
    const quotesRef = useRef(quotes);
    quotesRef.current = quotes;
    const initialScrollTopRef = useRef(initialScrollTop ?? null);
    initialScrollTopRef.current = initialScrollTop ?? null;
    const onScrollChangeRef = useRef(onScrollChange);
    onScrollChangeRef.current = onScrollChange;

    // Inline editing state. After a save we pin the new version id so the
    // viewer re-renders the saved content even though the parent may still
    // hold the version it opened with.
    const [editing, setEditing] = useState(false);
    const [savedVersionId, setSavedVersionId] = useState<string | null>(null);
    const [baseline, setBaseline] = useState<string[] | null>(null);
    const [editLoading, setEditLoading] = useState(false);
    const [saving, setSaving] = useState(false);
    const [editError, setEditError] = useState<string | null>(null);
    const [localRefetch, setLocalRefetch] = useState(0);
    const effectiveVersionId = savedVersionId ?? versionId;

    const authHeaders = useCallback(async (): Promise<HeadersInit> => {
        const {
            data: { session },
        } = await supabase.auth.getSession();
        const token = session?.access_token;
        return token ? { Authorization: `Bearer ${token}` } : {};
    }, []);

    const apiBase =
        process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

    // --- In-place editing on the rendered document -----------------------
    //
    // docx-preview renders the body paragraphs as <p> inside
    // `section.docx > article`, with the letterhead header/footer as sibling
    // <header>/<footer> elements. Making each <article> contentEditable lets
    // the user click and type straight in the letter while the header, footer
    // and formatting stay put. On save we read the paragraph text back and let
    // the server reconcile it against the real document.

    const getArticles = useCallback((): HTMLElement[] => {
        const root = containerRef.current;
        if (!root) return [];
        const arts = Array.from(root.querySelectorAll<HTMLElement>("article"));
        return arts.length
            ? arts
            : Array.from(root.querySelectorAll<HTMLElement>("section.docx"));
    }, []);

    const readParagraphs = useCallback((): string[] => {
        const out: string[] = [];
        for (const article of getArticles()) {
            for (const pEl of Array.from(
                article.querySelectorAll<HTMLElement>("p"),
            )) {
                // Never treat letterhead header/footer text as body.
                if (pEl.closest("header, footer")) continue;
                // Turn soft line breaks into \n, drop tab glyphs, so the text
                // matches how the server flattens a paragraph.
                const clone = pEl.cloneNode(true) as HTMLElement;
                clone.querySelectorAll("br").forEach((br) =>
                    br.replaceWith(document.createTextNode("\n")),
                );
                out.push((clone.textContent ?? "").replace(/\t/g, ""));
            }
        }
        return out;
    }, [getArticles]);

    const setDomEditable = useCallback(
        (on: boolean) => {
            if (on) {
                try {
                    document.execCommand(
                        "defaultParagraphSeparator",
                        false,
                        "p",
                    );
                } catch {
                    /* not supported — Enter still creates a block */
                }
            }
            for (const article of getArticles()) {
                article.contentEditable = on ? "true" : "false";
                if (on) {
                    article.spellcheck = true;
                    article.style.outline = "none";
                    article
                        .querySelectorAll<HTMLElement>("header, footer")
                        .forEach((hf) => {
                            hf.contentEditable = "false";
                        });
                } else {
                    article.removeAttribute("contenteditable");
                }
            }
        },
        [getArticles],
    );

    const startEditing = useCallback(async () => {
        setEditError(null);
        setEditLoading(true);
        try {
            const headers = await authHeaders();
            const qs = effectiveVersionId
                ? `?version_id=${encodeURIComponent(effectiveVersionId)}`
                : "";
            const resp = await fetch(
                `${apiBase}/single-documents/${documentId}/paragraphs${qs}`,
                { headers },
            );
            if (!resp.ok) throw new Error(`load failed (${resp.status})`);
            const data = (await resp.json()) as {
                paragraphs?: string[];
                editable?: boolean;
            };
            if (!data.editable || !Array.isArray(data.paragraphs)) {
                throw new Error("This document can't be edited inline.");
            }
            // The rendered text must match the server's body exactly before we
            // let anyone type, so a save can never write to the wrong place or
            // silently rewrite content the renderer shows differently (e.g.
            // links or field codes). If it doesn't line up, fall back to the
            // download / re-upload route rather than risk the document.
            const dom = readParagraphs();
            const server = data.paragraphs;
            const matches =
                dom.length === server.length &&
                dom.every((t, i) => t === server[i]);
            if (!matches) {
                throw new Error(
                    "This document can't be edited inline. You can download it, edit in Word and re-upload as a new version.",
                );
            }
            setBaseline(data.paragraphs);
            setDomEditable(true);
            setEditing(true);
        } catch (e) {
            setEditError(
                e instanceof Error ? e.message : "Could not start editing.",
            );
        } finally {
            setEditLoading(false);
        }
    }, [
        apiBase,
        authHeaders,
        documentId,
        effectiveVersionId,
        readParagraphs,
        setDomEditable,
    ]);

    const saveEdits = useCallback(async () => {
        if (!baseline) return;
        setSaving(true);
        setEditError(null);
        try {
            const paragraphs = readParagraphs();
            const headers = await authHeaders();
            const resp = await fetch(
                `${apiBase}/single-documents/${documentId}/inline-edit`,
                {
                    method: "POST",
                    headers: { ...headers, "Content-Type": "application/json" },
                    body: JSON.stringify({ baseline, paragraphs }),
                },
            );
            if (resp.status === 409) {
                setEditError(
                    "The document changed since you started editing. Cancel and reopen it.",
                );
                return;
            }
            if (!resp.ok) throw new Error(`save failed (${resp.status})`);
            const data = (await resp.json()) as {
                id?: string;
                changed?: boolean;
            };
            setDomEditable(false);
            if (data.id) {
                setSavedVersionId(data.id);
                onSaved?.(data.id);
            }
            setLocalRefetch((n) => n + 1); // re-render the saved (clean) bytes
            setEditing(false);
            setBaseline(null);
        } catch (e) {
            setEditError(
                e instanceof Error ? e.message : "Could not save your edits.",
            );
        } finally {
            setSaving(false);
        }
    }, [
        apiBase,
        authHeaders,
        baseline,
        documentId,
        onSaved,
        readParagraphs,
        setDomEditable,
    ]);

    const cancelEditing = useCallback(() => {
        setDomEditable(false);
        setEditing(false);
        setBaseline(null);
        setEditError(null);
        setLocalRefetch((n) => n + 1); // discard DOM edits by re-rendering
    }, [setDomEditable]);

    // Stable key for the quote list so the re-highlight effect re-fires
    // only when the actual text/order of quotes changes.
    const quoteKey = useMemo(
        () => (quotes ?? []).map((q) => q.quote).join("||"),
        [quotes],
    );

    const { bytes, loading, error } = useFetchDocxBytes(
        documentId,
        effectiveVersionId,
        (refetchKey ?? 0) + localRefetch,
    );

    /**
     * Highlight every quote in `list` inside the rendered DOM and scroll
     * the first match into view. Returns true if any match was found.
     */
    const applyQuoteHighlights = (
        containerEl: HTMLElement,
        scrollEl: HTMLElement,
        list: CitationQuote[] | undefined,
    ): boolean => {
        clearDocxQuoteHighlights(containerEl);
        if (!list || list.length === 0) return false;

        let firstMatch: HTMLElement | null = null;
        for (const q of list) {
            const match = highlightDocxQuote(containerEl, q.quote);
            if (match && !firstMatch) firstMatch = match;
        }
        if (!firstMatch) return false;

        const scrollRect = scrollEl.getBoundingClientRect();
        const targetRect = firstMatch.getBoundingClientRect();
        const offset =
            targetRect.top -
            scrollRect.top +
            scrollEl.scrollTop -
            scrollEl.clientHeight / 2 +
            targetRect.height / 2;
        scrollEl.scrollTo({
            top: Math.max(0, offset),
            behavior: "instant" as ScrollBehavior,
        });
        return true;
    };

    /**
     * docx-preview renders pages at their natural Word page width (e.g.
     * ~816px for US Letter). When the side-panel is narrower than that,
     * the page overflows horizontally. Apply CSS `zoom` on each
     * section.docx so the document shrinks to fit — `zoom` (unlike
     * `transform: scale`) also shrinks the layout box, so the scroll
     * container's scrollHeight adapts. We zoom each page rather than the
     * wrapper because docx-preview injects flex styles on `.docx-wrapper`
     * that can interfere with wrapper-level zoom.
     */
    const applyDocxScale = () => {
        const containerEl = containerRef.current;
        const scrollEl = scrollRef.current;
        if (!containerEl || !scrollEl) return;
        const wrapper = containerEl.querySelector<HTMLElement>(".docx-wrapper");
        if (!wrapper) return;
        const sections = Array.from(
            wrapper.querySelectorAll<HTMLElement>("section.docx"),
        );
        if (sections.length === 0) return;
        // Reset zoom on every page before measuring so offsetWidth reports
        // each page's natural width (pages can have different widths — e.g.
        // mixed portrait/landscape sections).
        sections.forEach((s) => {
            s.style.zoom = "1";
        });
        // Use the scroll container's content box (clientWidth - padding)
        // as the available width.
        const styles = window.getComputedStyle(scrollEl);
        const padX =
            (parseFloat(styles.paddingLeft) || 0) +
            (parseFloat(styles.paddingRight) || 0);
        const available = scrollEl.clientWidth - padX;
        if (available <= 0) return;
        // Scale each page independently against its own natural width so
        // landscape/custom-size pages still fit without distorting the
        // page dividers.
        sections.forEach((s) => {
            const w = s.offsetWidth;
            if (!w) return;
            const scale = Math.min(1, available / w);
            s.style.zoom = String(scale);
        });
    };

    // Observe the scroll container (which tracks the side panel's width)
    // and re-scale whenever it resizes. Also observe the docx container so
    // we re-scale once docx-preview finishes inserting pages.
    useEffect(() => {
        const scrollEl = scrollRef.current;
        const containerEl = containerRef.current;
        if (!scrollEl || !containerEl) return;
        let raf = 0;
        const schedule = () => {
            if (raf) cancelAnimationFrame(raf);
            raf = requestAnimationFrame(() => applyDocxScale());
        };
        const ro = new ResizeObserver(schedule);
        ro.observe(scrollEl);
        ro.observe(containerEl);
        return () => {
            if (raf) cancelAnimationFrame(raf);
            ro.disconnect();
        };
    }, []);

    useEffect(() => {
        let cancelled = false;
        if (!bytes || !containerRef.current || !scrollRef.current) return;

        const scrollEl = scrollRef.current;
        const containerEl = containerRef.current;

        // Remember scroll position across re-renders so Accept/Reject stays put.
        lastScrollTopRef.current = scrollEl.scrollTop;
        const thisRender = ++renderKeyRef.current;

        (async () => {
            try {
                const { renderAsync } = await import("docx-preview");
                if (cancelled) return;
                containerEl.innerHTML = "";
                await renderAsync(bytes, containerEl, undefined, {
                    inWrapper: true,
                    ignoreWidth: false,
                    ignoreHeight: false,
                    renderChanges: true,
                    experimental: true,
                });
                if (cancelled) return;
                await tagWIdsOnRenderedDom(
                    containerEl,
                    documentId,
                    effectiveVersionId ?? null,
                );
                if (cancelled) return;
                // Scale to fit before scrolling so offsets are computed
                // against the post-zoom layout.
                applyDocxScale();
                requestAnimationFrame(() => {
                    if (
                        !scrollRef.current ||
                        thisRender !== renderKeyRef.current
                    )
                        return;
                    const pendingHighlight = highlightEditRef.current;
                    const pendingQuotes = quotesRef.current;
                    const pendingInitialScroll = initialScrollTopRef.current;
                    if (pendingHighlight) {
                        scrollToHighlight(
                            containerEl,
                            scrollRef.current,
                            pendingHighlight,
                        );
                        // Highlight quotes too, but don't override the edit scroll
                        if (pendingQuotes?.length) {
                            for (const q of pendingQuotes)
                                highlightDocxQuote(containerEl, q.quote);
                        }
                    } else if (
                        pendingQuotes &&
                        applyQuoteHighlights(
                            containerEl,
                            scrollRef.current,
                            pendingQuotes,
                        )
                    ) {
                        // scrolled inside applyQuoteHighlights
                    } else if (typeof pendingInitialScroll === "number") {
                        scrollRef.current.scrollTop = pendingInitialScroll;
                    } else {
                        scrollRef.current.scrollTop = lastScrollTopRef.current;
                    }
                    onReadyRef.current?.();
                });
            } catch (e) {
                console.error("docx-preview render failed", e);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [bytes]);

    // Re-scroll/highlight if the target edit changes without a re-render
    // (e.g. same doc, different edit clicked).
    useEffect(() => {
        if (!highlightEdit || !containerRef.current || !scrollRef.current)
            return;
        scrollToHighlight(
            containerRef.current,
            scrollRef.current,
            highlightEdit,
        );
    }, [highlightEdit?.key]); // eslint-disable-line react-hooks/exhaustive-deps

    // Re-apply quote highlights when the quote list changes without a full
    // re-render (e.g. clicking a different citation on the same doc).
    useEffect(() => {
        if (!containerRef.current || !scrollRef.current) return;
        applyQuoteHighlights(
            containerRef.current,
            scrollRef.current,
            quotesRef.current,
        );
    }, [quoteKey, quoteFocusKey]); // eslint-disable-line react-hooks/exhaustive-deps

    // Fire onScrollChange (rAF-throttled) so parents can persist scroll
    // per-tab. We still maintain lastScrollTopRef locally for same-mount
    // re-renders (Accept/Reject preserving scroll within one view).
    useEffect(() => {
        const el = scrollRef.current;
        if (!el) return;
        let scheduled = false;
        const onScroll = () => {
            lastScrollTopRef.current = el.scrollTop;
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => {
                scheduled = false;
                onScrollChangeRef.current?.(el.scrollTop);
            });
        };
        el.addEventListener("scroll", onScroll, { passive: true });
        return () => el.removeEventListener("scroll", onScroll);
    }, []);

    return (
        <div
            className={`relative flex flex-col flex-1 overflow-hidden bg-gray-100 ${rounded ? "rounded-lg" : ""}`}
        >
            {editing ? (
                <div className="flex items-center justify-between border-b border-gray-200 bg-white px-3 py-2">
                    <span className="min-w-0 truncate text-xs text-gray-500">
                        Click anywhere in the document to edit. Enter starts a
                        new paragraph, Shift+Enter a line break. Formatting,
                        letterhead and signature are kept.
                    </span>
                    <div className="flex shrink-0 items-center gap-2">
                        <button
                            type="button"
                            onClick={cancelEditing}
                            disabled={saving}
                            className="rounded-md border border-gray-200 bg-white px-3 py-1 text-xs font-medium text-gray-600 hover:bg-gray-50 disabled:opacity-50"
                        >
                            Cancel
                        </button>
                        <button
                            type="button"
                            onClick={saveEdits}
                            disabled={saving}
                            className="inline-flex items-center gap-1 rounded-md bg-blue-600 px-3 py-1 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                        >
                            {saving && (
                                <Loader2 className="h-3 w-3 animate-spin" />
                            )}
                            Save changes
                        </button>
                    </div>
                </div>
            ) : (
                editable && (
                    <div className="absolute top-2 right-2 z-10">
                        <button
                            type="button"
                            onClick={startEditing}
                            disabled={editLoading}
                            className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white/90 px-2 py-1 text-xs font-medium text-gray-700 shadow-sm backdrop-blur hover:bg-white disabled:opacity-50"
                        >
                            {editLoading ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                                <Pencil className="h-3.5 w-3.5" />
                            )}
                            Edit
                        </button>
                    </div>
                )
            )}
            {editError && (
                <div className="absolute top-12 left-2 z-10 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800 shadow-sm">
                    <span>{editError}</span>
                    <button
                        type="button"
                        onClick={() => setEditError(null)}
                        className="text-amber-600 hover:text-amber-900"
                        aria-label="Dismiss"
                    >
                        ×
                    </button>
                </div>
            )}
            {warning && (
                <div className="absolute top-2 left-2 z-10 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800 shadow-sm">
                    <span>{warning}</span>
                    <button
                        type="button"
                        onClick={() => onWarningDismiss?.()}
                        className="text-amber-600 hover:text-amber-900"
                        aria-label="Dismiss warning"
                    >
                        ×
                    </button>
                </div>
            )}
            <div
                ref={scrollRef}
                className="flex-1 overflow-auto px-5 pt-5 pb-3 docx-view-scroll"
                data-document-id={documentId}
                data-version-id={versionId ?? ""}
            >
                {loading && !bytes && (
                    <div className="flex h-full items-center justify-center">
                        <Loader2 className="h-7 w-7 animate-spin text-gray-400" />
                    </div>
                )}
                {error && (
                    <div className="flex h-full items-center justify-center">
                        <p className="text-sm text-red-500">{error}</p>
                    </div>
                )}
                <div ref={containerRef} className="docx-view-container" />
            </div>
        </div>
    );
}
