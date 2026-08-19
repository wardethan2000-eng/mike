"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * Panel arrangement for the project chat page.
 *
 * The page shows up to three panes — the chat, an open document, and the
 * matter's files. Each person can put them in whatever order they like and
 * size them however they like; the arrangement is remembered on their machine
 * the same way the selected model is (see useSelectedModel).
 *
 * Sizes are stored as weights rather than pixels so a pane keeps its share of
 * the window when the window is resized, when a pane is hidden, or on a
 * different-sized screen.
 */

export type PaneId = "chat" | "document" | "files";

export const PANE_LABELS: Record<PaneId, string> = {
    chat: "Assistant",
    document: "Document",
    files: "Files",
};

/** Smallest a pane may be dragged to, in pixels. */
const PANE_MIN_PX: Record<PaneId, number> = {
    chat: 320,
    document: 280,
    files: 180,
};

export type ProjectChatLayout = {
    /** Left to right. Always contains all three panes, hidden or not. */
    order: PaneId[];
    weights: Record<PaneId, number>;
    filesOpen: boolean;
};

const STORAGE_KEY = "mike.projectChatLayout.v1";

export const DEFAULT_LAYOUT: ProjectChatLayout = {
    order: ["chat", "document", "files"],
    weights: { chat: 1, document: 1.35, files: 0.5 },
    filesOpen: false,
};

const PANE_IDS: PaneId[] = ["chat", "document", "files"];

function isPaneId(value: unknown): value is PaneId {
    return typeof value === "string" && PANE_IDS.includes(value as PaneId);
}

/** Accepts anything; returns a layout that is safe to render. */
function normalize(raw: unknown): ProjectChatLayout {
    if (!raw || typeof raw !== "object") return DEFAULT_LAYOUT;
    const candidate = raw as Partial<ProjectChatLayout>;

    const order: PaneId[] = [];
    if (Array.isArray(candidate.order)) {
        for (const id of candidate.order) {
            if (isPaneId(id) && !order.includes(id)) order.push(id);
        }
    }
    for (const id of DEFAULT_LAYOUT.order) {
        if (!order.includes(id)) order.push(id);
    }

    const weights = { ...DEFAULT_LAYOUT.weights };
    for (const id of PANE_IDS) {
        const value = candidate.weights?.[id];
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
            weights[id] = value;
        }
    }

    return {
        order,
        weights,
        filesOpen:
            typeof candidate.filesOpen === "boolean"
                ? candidate.filesOpen
                : DEFAULT_LAYOUT.filesOpen,
    };
}

function readStored(): ProjectChatLayout {
    if (typeof window === "undefined") return DEFAULT_LAYOUT;
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return DEFAULT_LAYOUT;
        return normalize(JSON.parse(raw));
    } catch {
        return DEFAULT_LAYOUT;
    }
}

function writeStored(layout: ProjectChatLayout) {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
    } catch {
        // A full or blocked store just means the arrangement isn't remembered.
    }
}

/**
 * Dragging a panel by its handle onto another panel's strip swaps the two.
 * This follows the mouse directly rather than using the browser's own
 * drag-and-drop, which is unreliable inside scrolling panels.
 */
export function usePaneDrag(onDrop: (moved: PaneId, target: PaneId) => void) {
    const [draggingPane, setDraggingPane] = useState<PaneId | null>(null);
    const [hoverPane, setHoverPane] = useState<PaneId | null>(null);
    const draggingRef = useRef<PaneId | null>(null);
    const hoverRef = useRef<PaneId | null>(null);

    const startDrag = useCallback((pane: PaneId) => {
        draggingRef.current = pane;
        setDraggingPane(pane);
    }, []);

    useEffect(() => {
        if (!draggingPane) return;

        function paneUnder(x: number, y: number): PaneId | null {
            const element = document.elementFromPoint(x, y);
            const strip = element?.closest?.(
                "[data-pane-header]",
            ) as HTMLElement | null;
            const id = strip?.dataset.paneHeader;
            return isPaneId(id) ? id : null;
        }

        function onMove(e: MouseEvent) {
            const over = paneUnder(e.clientX, e.clientY);
            hoverRef.current =
                over && over !== draggingRef.current ? over : null;
            setHoverPane(hoverRef.current);
        }

        function onUp() {
            const moved = draggingRef.current;
            const target = hoverRef.current;
            draggingRef.current = null;
            hoverRef.current = null;
            setDraggingPane(null);
            setHoverPane(null);
            if (moved && target) onDrop(moved, target);
        }

        document.body.style.cursor = "grabbing";
        document.body.style.userSelect = "none";
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
        return () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        };
    }, [draggingPane, onDrop]);

    return { draggingPane, hoverPane, startDrag };
}

/**
 * `documentOpen` — the document panel only takes up room once a document has
 * been opened in it. The chat is always on screen; the files rail is on screen
 * when the reader has asked for it.
 */
export function useProjectChatLayout({
    documentOpen,
}: {
    documentOpen: boolean;
}) {
    const [layout, setLayout] = useState<ProjectChatLayout>(DEFAULT_LAYOUT);

    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- hydration-safe localStorage read; SSR must render the default arrangement
        setLayout(readStored());
    }, []);

    const update = useCallback(
        (change: (previous: ProjectChatLayout) => ProjectChatLayout) => {
            setLayout((previous) => {
                const next = change(previous);
                writeStored(next);
                return next;
            });
        },
        [],
    );

    /** The panes actually on screen, in the order the person arranged them. */
    const laidOut = useMemo(
        () =>
            layout.order.filter((id) => {
                if (id === "document") return documentOpen;
                if (id === "files") return layout.filesOpen;
                return true;
            }),
        [documentOpen, layout.filesOpen, layout.order],
    );

    const setFilesOpen = useCallback(
        (open: boolean) => update((prev) => ({ ...prev, filesOpen: open })),
        [update],
    );

    /** Put `moved` where `target` sits, sliding the others along. */
    const movePane = useCallback(
        (moved: PaneId, target: PaneId) => {
            if (moved === target) return;
            update((prev) => {
                const order = prev.order.filter((id) => id !== moved);
                const at = order.indexOf(target);
                if (at === -1) return prev;
                order.splice(at, 0, moved);
                return { ...prev, order };
            });
        },
        [update],
    );

    /**
     * Drag of the divider between two neighbouring panes. `dx` is how far the
     * mouse moved; `containerPx` is the width the panes share.
     */
    const resizePanes = useCallback(
        (left: PaneId, right: PaneId, dx: number, containerPx: number) => {
            if (!containerPx || left === right) return;
            update((prev) => {
                const shownTotal = laidOut.reduce(
                    (sum, id) => sum + prev.weights[id],
                    0,
                );
                if (shownTotal <= 0) return prev;
                const perPixel = shownTotal / containerPx;
                const minLeft = PANE_MIN_PX[left] * perPixel;
                const minRight = PANE_MIN_PX[right] * perPixel;
                const pair = prev.weights[left] + prev.weights[right];
                if (pair <= minLeft + minRight) return prev;

                const wanted = prev.weights[left] + dx * perPixel;
                const nextLeft = Math.min(
                    Math.max(wanted, minLeft),
                    pair - minRight,
                );
                return {
                    ...prev,
                    weights: {
                        ...prev.weights,
                        [left]: nextLeft,
                        [right]: pair - nextLeft,
                    },
                };
            });
        },
        [laidOut, update],
    );

    const resetLayout = useCallback(() => {
        update((prev) => ({ ...DEFAULT_LAYOUT, filesOpen: prev.filesOpen }));
    }, [update]);

    const isDefaultLayout =
        layout.order.join(",") === DEFAULT_LAYOUT.order.join(",") &&
        PANE_IDS.every(
            (id) =>
                Math.abs(layout.weights[id] - DEFAULT_LAYOUT.weights[id]) <
                0.001,
        );

    return {
        layout,
        laidOut,
        filesOpen: layout.filesOpen,
        setFilesOpen,
        movePane,
        resizePanes,
        resetLayout,
        isDefaultLayout,
    };
}
