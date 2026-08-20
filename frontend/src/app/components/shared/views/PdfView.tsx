"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, ZoomIn, ZoomOut } from "lucide-react";
import { useFetchSingleDoc } from "@/app/hooks/useFetchSingleDoc";
import type { CitationQuote } from "../types";
import {
    clearHighlights,
    getPdfJs,
    highlightQuote,
    STANDARD_FONT_DATA_URL,
} from "./highlightQuote";

interface Props {
    doc: { document_id: string; version_id?: string | null } | null;
    /** Preferred: one or more (page, quote) pairs to highlight. */
    quotes?: CitationQuote[];
    /** Changes when the parent wants the current quote re-focused. */
    quoteFocusKey?: string | number;
    /** Back-compat single-quote API. Ignored if `quotes` is provided. */
    quote?: string;
    fallbackPage?: number;
    /**
     * Open the file at this page. For pointing at a page without having any
     * words to mark on it — a remembered fact that names its source page, say.
     * Ignored when there are quotes, which find their own page.
     */
    openAtPage?: number;
    rounded?: boolean;
}

type QuoteEntry = { page?: number; quote: string };

const SIDE_PADDING = 20;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;
const ZOOM_STEP = 0.25;
// Pages are drawn with more detail than the screen strictly needs, so the small
// print stays crisp; capped so a very dense screen does not ask for pictures the
// browser cannot hold.
const MIN_PIXEL_RATIO = 2;
const MAX_PIXEL_RATIO = 3;
// How many pages keep their drawn picture in memory. Pages beyond this that the
// reader has scrolled away from are given back their blank placeholder, so a
// long file does not grow until the tab runs out of memory.
const MAX_DRAWN_PAGES = 16;
// Start drawing a page before it reaches the window, so scrolling feels ready.
const DRAW_AHEAD = "600px 0px";

/** One page of the file: always laid out, drawn only when it is needed. */
type PageSlot = {
    pageNumber: number;
    page: import("pdfjs-dist").PDFPageProxy;
    viewport: import("pdfjs-dist").PageViewport;
    wrapper: HTMLDivElement;
    canvas: HTMLCanvasElement | null;
    textLayerDiv: HTMLDivElement | null;
    textDivs: HTMLElement[] | null;
    drawing: Promise<void> | null;
    /** A page the reader was sent to; never given back its placeholder. */
    pinned: boolean;
};

/** Letters and digits only — the same rough comparison the highlighter uses. */
function lettersOnly(value: string): string {
    return value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

export function PdfView({
    doc,
    quotes,
    quoteFocusKey,
    quote,
    fallbackPage,
    openAtPage,
    rounded = true,
}: Props) {
    const containerRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const pdfDocRef = useRef<import("pdfjs-dist").PDFDocumentProxy | null>(
        null,
    );
    /** Every page of the open file, in order. */
    const slotsRef = useRef<PageSlot[]>([]);
    /** Page numbers in the order they were drawn, oldest first. */
    const drawOrderRef = useRef<number[]>([]);
    const observerRef = useRef<IntersectionObserver | null>(null);
    /** Guards against two runs of the drawing loop fighting over one view. */
    const renderGenerationRef = useRef(0);
    /** The panel width the pages were laid out for. */
    const renderedWidthRef = useRef(0);
    const quoteListRef = useRef<QuoteEntry[]>([]);
    const zoomRef = useRef(1.0);
    const currentPageRef = useRef(1);

    const quoteList: QuoteEntry[] = useMemo(() => {
        if (quotes?.length)
            return quotes.map((q) => ({ page: q.page, quote: q.quote }));
        if (quote) return [{ page: fallbackPage, quote }];
        return [];
    }, [quotes, quote, fallbackPage]);

    // Stable string key so effects can depend on quote-list identity
    const quoteKey = quoteList
        .map((q) => `${q.page ?? ""}:${q.quote}`)
        .join("|");

    const [containerWidth, setContainerWidth] = useState(0);
    const [zoom, setZoom] = useState(1.0);
    const [currentPage, setCurrentPage] = useState(1);
    const [numPages, setNumPages] = useState(0);

    const { result, loading, error } = useFetchSingleDoc(
        doc?.document_id ?? null,
        doc?.version_id ?? null,
    );

    useEffect(() => {
        const el = scrollContainerRef.current;
        if (!el) return;
        const ro = new ResizeObserver((entries) => {
            setContainerWidth(entries[0]?.contentRect.width ?? 0);
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // Track current page via scroll position
    useEffect(() => {
        const scrollEl = scrollContainerRef.current;
        if (!scrollEl) return;

        const handleScroll = () => {
            const slots = slotsRef.current;
            if (!slots.length) return;
            const scrollCenter = scrollEl.scrollTop + scrollEl.clientHeight / 2;
            let closest = 1;
            let closestDist = Infinity;
            slots.forEach((slot) => {
                const pageCenter =
                    slot.wrapper.offsetTop + slot.wrapper.clientHeight / 2;
                const dist = Math.abs(pageCenter - scrollCenter);
                if (dist < closestDist) {
                    closestDist = dist;
                    closest = slot.pageNumber;
                }
            });
            currentPageRef.current = closest;
            setCurrentPage(closest);
        };

        scrollEl.addEventListener("scroll", handleScroll, { passive: true });
        return () => scrollEl.removeEventListener("scroll", handleScroll);
    }, []);

    /** Hand a page back its blank placeholder and let go of the picture. */
    const releaseSlot = useCallback((slot: PageSlot) => {
        if (slot.canvas) {
            slot.canvas.width = 0;
            slot.canvas.height = 0;
            slot.canvas.remove();
            slot.canvas = null;
        }
        slot.textLayerDiv?.remove();
        slot.textLayerDiv = null;
        slot.textDivs = null;
        slot.drawing = null;
    }, []);

    /** Keep only a workable number of drawn pages in memory. */
    const trimDrawnPages = useCallback(() => {
        const slots = slotsRef.current;
        while (drawOrderRef.current.length > MAX_DRAWN_PAGES) {
            const index = drawOrderRef.current.findIndex((pageNumber) => {
                const slot = slots[pageNumber - 1];
                if (!slot || slot.pinned) return false;
                return Math.abs(pageNumber - currentPageRef.current) > 2;
            });
            if (index === -1) return;
            const [pageNumber] = drawOrderRef.current.splice(index, 1);
            const slot = slots[pageNumber - 1];
            if (slot) releaseSlot(slot);
        }
    }, [releaseSlot]);

    /** Draw one page: its picture and the text layer the highlighter needs. */
    const drawSlot = useCallback(
        async (slot: PageSlot, generation: number): Promise<void> => {
            if (slot.textDivs) return;
            if (slot.drawing) return slot.drawing;

            const work = (async () => {
                const lib = await getPdfJs();
                if (generation !== renderGenerationRef.current) return;

                const pixelRatio = Math.min(
                    MAX_PIXEL_RATIO,
                    Math.max(MIN_PIXEL_RATIO, window.devicePixelRatio || 1),
                );
                const canvas = document.createElement("canvas");
                canvas.width = Math.floor(slot.viewport.width * pixelRatio);
                canvas.height = Math.floor(slot.viewport.height * pixelRatio);
                canvas.style.width = `${slot.viewport.width}px`;
                canvas.style.height = `${slot.viewport.height}px`;
                canvas.style.display = "block";
                const ctx = canvas.getContext("2d");
                if (!ctx) return;
                slot.wrapper.appendChild(canvas);
                slot.canvas = canvas;

                try {
                    await slot.page.render({
                        canvasContext: ctx,
                        viewport: slot.viewport,
                        transform:
                            pixelRatio === 1
                                ? undefined
                                : [pixelRatio, 0, 0, pixelRatio, 0, 0],
                    }).promise;
                } catch (e: unknown) {
                    if (
                        (e as { name?: string })?.name !==
                        "RenderingCancelledException"
                    ) {
                        console.error("PDF render error", e);
                    }
                    return;
                }
                if (generation !== renderGenerationRef.current) return;

                const textLayerDiv = document.createElement("div");
                textLayerDiv.className = "pdf-text-layer";
                textLayerDiv.style.position = "absolute";
                textLayerDiv.style.left = "0";
                textLayerDiv.style.top = "0";
                textLayerDiv.style.width = `${slot.viewport.width}px`;
                textLayerDiv.style.height = `${slot.viewport.height}px`;
                textLayerDiv.style.setProperty(
                    "--scale-factor",
                    String(slot.viewport.scale),
                );
                slot.wrapper.appendChild(textLayerDiv);
                slot.textLayerDiv = textLayerDiv;

                const textLayer = new lib.TextLayer({
                    textContentSource: slot.page.streamTextContent(),
                    container: textLayerDiv,
                    viewport: slot.viewport,
                });
                await textLayer.render();
                if (generation !== renderGenerationRef.current) return;

                slot.textDivs = textLayer.textDivs;
                drawOrderRef.current.push(slot.pageNumber);
                trimDrawnPages();
            })();

            slot.drawing = work;
            await work;
            slot.drawing = null;
        },
        [trimDrawnPages],
    );

    /** The page whose text contains this quote, without drawing anything. */
    const findPageWithQuote = useCallback(
        async (text: string, generation: number): Promise<number | null> => {
            const needle = lettersOnly(text).slice(0, 30);
            if (needle.length < 8) return null;
            for (const slot of slotsRef.current) {
                if (generation !== renderGenerationRef.current) return null;
                const content = await slot.page.getTextContent();
                const pageText = lettersOnly(
                    content.items
                        .map((item) =>
                            "str" in item ? (item.str as string) : "",
                        )
                        .join(""),
                );
                if (pageText.includes(needle)) return slot.pageNumber;
            }
            return null;
        },
        [],
    );

    // Scroll so the first highlight on `pageNum` lands at the vertical center
    // of the viewer. We compute the scroll position explicitly on the scroll
    // container — calling `scrollIntoView` on a child of the absolutely-
    // positioned text layer can scroll just the overlay while leaving the
    // canvas untouched, which is why we don't use it here.
    const scrollToHighlightOnPage = useCallback((pageNum: number) => {
        const slot = slotsRef.current[pageNum - 1];
        const scrollEl = scrollContainerRef.current;
        if (!slot || !scrollEl) return;

        const highlightEl = slot.wrapper.querySelector<HTMLElement>(
            ".pdf-text-highlight",
        );
        if (highlightEl) {
            const containerRect = scrollEl.getBoundingClientRect();
            const highlightRect = highlightEl.getBoundingClientRect();
            const offsetWithinContainer = highlightRect.top - containerRect.top;
            const targetTop =
                scrollEl.scrollTop +
                offsetWithinContainer -
                scrollEl.clientHeight / 2 +
                highlightRect.height / 2;
            scrollEl.scrollTo({
                top: Math.max(0, targetTop),
                behavior: "instant" as ScrollBehavior,
            });
        } else {
            const wrapperRect = slot.wrapper.getBoundingClientRect();
            const containerRect = scrollEl.getBoundingClientRect();
            const targetTop =
                scrollEl.scrollTop + (wrapperRect.top - containerRect.top);
            scrollEl.scrollTo({
                top: Math.max(0, targetTop),
                behavior: "instant" as ScrollBehavior,
            });
        }
        currentPageRef.current = pageNum;
        setCurrentPage(pageNum);
    }, []);

    /**
     * Marks the quotes on the pages they belong to, drawing those pages first.
     * Returns the page of the first quote actually found, or null.
     */
    const showQuotes = useCallback(
        async (list: QuoteEntry[], generation: number) => {
            for (const slot of slotsRef.current) {
                if (slot.textDivs) clearHighlights(slot.textDivs);
            }
            if (!list.length) return null;

            let firstHitPage: number | null = null;
            for (const entry of list) {
                let pageNumber = entry.page ?? null;
                if (pageNumber) {
                    const slot = slotsRef.current[pageNumber - 1];
                    if (slot) {
                        slot.pinned = true;
                        await drawSlot(slot, generation);
                        if (generation !== renderGenerationRef.current)
                            return null;
                        const found =
                            !!slot.textDivs &&
                            (await highlightQuote(slot.textDivs, entry.quote));
                        if (!found) pageNumber = null;
                    } else {
                        pageNumber = null;
                    }
                }

                // No page given, or the words are not where the page said:
                // look through the file's text for them.
                if (!pageNumber) {
                    const foundPage = await findPageWithQuote(
                        entry.quote,
                        generation,
                    );
                    if (generation !== renderGenerationRef.current) return null;
                    if (!foundPage) continue;
                    const slot = slotsRef.current[foundPage - 1];
                    if (!slot) continue;
                    slot.pinned = true;
                    await drawSlot(slot, generation);
                    if (generation !== renderGenerationRef.current) return null;
                    if (
                        slot.textDivs &&
                        (await highlightQuote(slot.textDivs, entry.quote))
                    ) {
                        pageNumber = foundPage;
                    }
                }

                if (pageNumber && firstHitPage === null)
                    firstHitPage = pageNumber;
            }
            return firstHitPage;
        },
        [drawSlot, findPageWithQuote],
    );

    const renderPDF = useCallback(
        async (
            doc: import("pdfjs-dist").PDFDocumentProxy,
            list: QuoteEntry[],
            scrollToPage?: number,
        ) => {
            if (!containerRef.current) return;
            const generation = ++renderGenerationRef.current;
            const superseded = () => generation !== renderGenerationRef.current;

            observerRef.current?.disconnect();
            observerRef.current = null;
            slotsRef.current = [];
            drawOrderRef.current = [];
            containerRef.current.innerHTML = "";

            const lib = await getPdfJs();
            if (superseded()) return;
            lib.TextLayer.cleanup();

            setNumPages(doc.numPages);
            // Where this drawing is headed, recorded before any of the work
            // rather than after it. Opening the panel resizes it, which starts
            // another drawing that reads this to keep the reader's place — and
            // if it were still saying page one at that moment, the jump would
            // be thrown away.
            const startPage = scrollToPage && scrollToPage > 1 ? scrollToPage : 1;
            setCurrentPage(startPage);
            currentPageRef.current = startPage;

            const hasCitation = list.length > 0;
            if (hasCitation && scrollContainerRef.current) {
                scrollContainerRef.current.style.opacity = "0";
            }
            const reveal = () => {
                if (scrollContainerRef.current)
                    scrollContainerRef.current.style.opacity = "1";
            };

            const panelW = containerRef.current.clientWidth;
            renderedWidthRef.current = panelW;
            const firstPage = await doc.getPage(1);
            if (superseded()) return;
            const naturalWidth = firstPage.getViewport({ scale: 1 }).width;
            const baseScale = Math.max(
                0.5,
                (panelW - SIDE_PADDING) / naturalWidth,
            );
            const scale = baseScale * zoomRef.current;

            // Lay every page out at its true size first, so the file is the
            // right length straight away and the reader can move around it
            // while the pages themselves are drawn.
            for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
                const page =
                    pageNum === 1 ? firstPage : await doc.getPage(pageNum);
                if (superseded()) return;
                const viewport = page.getViewport({ scale });

                const wrapper = document.createElement("div");
                wrapper.style.position = "relative";
                wrapper.style.margin = "0 auto 8px";
                wrapper.style.width = `${viewport.width}px`;
                wrapper.style.height = `${viewport.height}px`;
                wrapper.style.background = "#fff";
                wrapper.className = "shadow-md";
                containerRef.current?.appendChild(wrapper);

                slotsRef.current.push({
                    pageNumber: pageNum,
                    page,
                    viewport,
                    wrapper,
                    canvas: null,
                    textLayerDiv: null,
                    textDivs: null,
                    drawing: null,
                    pinned: false,
                });
            }

            // Draw pages as they come into view.
            const observer = new IntersectionObserver(
                (entries) => {
                    for (const entry of entries) {
                        if (!entry.isIntersecting) continue;
                        const pageNumber = Number(
                            (entry.target as HTMLElement).dataset.pageNumber,
                        );
                        const slot = slotsRef.current[pageNumber - 1];
                        if (slot) void drawSlot(slot, generation);
                    }
                },
                { root: scrollContainerRef.current, rootMargin: DRAW_AHEAD },
            );
            observerRef.current = observer;
            for (const slot of slotsRef.current) {
                slot.wrapper.dataset.pageNumber = String(slot.pageNumber);
                observer.observe(slot.wrapper);
            }

            if (hasCitation) {
                const hitPage = await showQuotes(list, generation);
                if (superseded()) return;
                const target =
                    hitPage ?? list.find((entry) => entry.page)?.page ?? null;
                if (target) scrollToHighlightOnPage(target);
                reveal();
                return;
            }

            if (scrollToPage && scrollToPage > 1) {
                const slot = slotsRef.current[scrollToPage - 1];
                if (slot) {
                    await drawSlot(slot, generation);
                    if (superseded()) return;
                    scrollToHighlightOnPage(scrollToPage);
                }
            } else {
                const first = slotsRef.current[0];
                if (first) await drawSlot(first, generation);
            }
            reveal();
        },
        [drawSlot, scrollToHighlightOnPage, showQuotes],
    );

    const rehighlightQuotes = useCallback(
        async (list: QuoteEntry[]) => {
            const generation = renderGenerationRef.current;
            const hitPage = await showQuotes(list, generation);
            if (generation !== renderGenerationRef.current) return;
            const target =
                hitPage ?? list.find((entry) => entry.page)?.page ?? null;
            if (target) scrollToHighlightOnPage(target);
        },
        [scrollToHighlightOnPage, showQuotes],
    );

    // Trackpad pinch-to-zoom (wheel + ctrlKey)
    useEffect(() => {
        const el = scrollContainerRef.current;
        if (!el) return;
        let debounceTimer: ReturnType<typeof setTimeout> | null = null;

        const handleWheel = (e: WheelEvent) => {
            if (!e.ctrlKey) return;
            e.preventDefault();
            const delta = e.deltaMode === 0 ? e.deltaY / 300 : e.deltaY * 0.1;
            const next = Math.min(
                ZOOM_MAX,
                Math.max(
                    ZOOM_MIN,
                    Math.round(zoomRef.current * Math.exp(-delta) * 100) / 100,
                ),
            );
            if (next === zoomRef.current) return;
            zoomRef.current = next;
            setZoom(next);
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                if (pdfDocRef.current) {
                    renderPDF(
                        pdfDocRef.current,
                        quoteListRef.current,
                        currentPageRef.current,
                    );
                }
            }, 150);
        };

        el.addEventListener("wheel", handleWheel, { passive: false });
        return () => {
            el.removeEventListener("wheel", handleWheel);
            if (debounceTimer) clearTimeout(debounceTimer);
        };
    }, [renderPDF]);

    // Touch pinch-to-zoom
    useEffect(() => {
        const el = scrollContainerRef.current;
        if (!el) return;
        let initialDist = 0;
        let initialZoom = 1.0;

        function getTouchDist(touches: TouchList) {
            const dx = touches[0].clientX - touches[1].clientX;
            const dy = touches[0].clientY - touches[1].clientY;
            return Math.hypot(dx, dy);
        }

        const handleTouchStart = (e: TouchEvent) => {
            if (e.touches.length === 2) {
                initialDist = getTouchDist(e.touches);
                initialZoom = zoomRef.current;
            }
        };

        const handleTouchMove = (e: TouchEvent) => {
            if (e.touches.length !== 2 || initialDist === 0) return;
            e.preventDefault();
            const next = Math.min(
                ZOOM_MAX,
                Math.max(
                    ZOOM_MIN,
                    Math.round(
                        initialZoom *
                            (getTouchDist(e.touches) / initialDist) *
                            100,
                    ) / 100,
                ),
            );
            zoomRef.current = next;
            setZoom(next);
        };

        const handleTouchEnd = (e: TouchEvent) => {
            if (e.touches.length < 2 && initialDist > 0) {
                initialDist = 0;
                if (pdfDocRef.current) {
                    renderPDF(
                        pdfDocRef.current,
                        quoteListRef.current,
                        currentPageRef.current,
                    );
                }
            }
        };

        el.addEventListener("touchstart", handleTouchStart, { passive: true });
        el.addEventListener("touchmove", handleTouchMove, { passive: false });
        el.addEventListener("touchend", handleTouchEnd, { passive: true });
        return () => {
            el.removeEventListener("touchstart", handleTouchStart);
            el.removeEventListener("touchmove", handleTouchMove);
            el.removeEventListener("touchend", handleTouchEnd);
        };
    }, [renderPDF]);

    // Clean up PDF.js static font-measurement canvases on unmount
    useEffect(() => {
        return () => {
            observerRef.current?.disconnect();
            getPdfJs().then((lib) => lib.TextLayer.cleanup());
        };
    }, []);

    // Render PDF when fetch result arrives
    useEffect(() => {
        if (!result || result.type !== "pdf") return;
        pdfDocRef.current = null;
        quoteListRef.current = quoteList;
        zoomRef.current = 1.0;
        const list = quoteList;

        let cancelled = false;
        queueMicrotask(() => {
            if (cancelled) return;
            setZoom(1.0);
            setNumPages(0);
        });

        (async () => {
            const lib = await getPdfJs();
            if (cancelled) return;
            const pdfDoc = await lib.getDocument({
                data: new Uint8Array(result.buffer),
                standardFontDataUrl: STANDARD_FONT_DATA_URL,
            }).promise;
            if (cancelled) return;
            pdfDocRef.current = pdfDoc;
            await renderPDF(pdfDoc, list, openAtPage);
        })();
        return () => {
            cancelled = true;
        };
    }, [result, renderPDF]); // eslint-disable-line react-hooks/exhaustive-deps

    // Re-render at new scale when container is resized (debounced 150ms)
    useEffect(() => {
        if (!pdfDocRef.current) return;
        const timer = setTimeout(() => {
            if (!pdfDocRef.current) return;
            // Opening the panel takes the width from nothing to its real size;
            // redrawing for that would only repeat work already in hand.
            if (Math.abs(containerWidth - renderedWidthRef.current) < 2) return;
            // Keep the reader's place across a resize instead of sending them
            // back to page one.
            renderPDF(
                pdfDocRef.current,
                quoteListRef.current,
                currentPageRef.current,
            );
        }, 150);
        return () => clearTimeout(timer);
    }, [containerWidth, renderPDF]);

    // Asked to go to a page while the file is already open — clicking a second
    // remembered fact that points at the same document. The first visit is
    // handled when the file is drawn; this catches the ones after it.
    const didInitialRenderRef = useRef(false);
    useEffect(() => {
        if (!didInitialRenderRef.current) {
            didInitialRenderRef.current = true;
            return;
        }
        if (!openAtPage || quoteListRef.current.length) return;
        if (!pdfDocRef.current) return;
        void renderPDF(pdfDocRef.current, [], openAtPage);
    }, [openAtPage, renderPDF]);

    // Re-highlight when quotes change without full re-render
    useEffect(() => {
        if (!pdfDocRef.current) return;
        quoteListRef.current = quoteList;
        rehighlightQuotes(quoteList);
    }, [quoteKey, quoteFocusKey, rehighlightQuotes]); // eslint-disable-line react-hooks/exhaustive-deps

    function handleZoomIn() {
        const next = Math.min(
            ZOOM_MAX,
            Math.round((zoomRef.current + ZOOM_STEP) * 100) / 100,
        );
        zoomRef.current = next;
        setZoom(next);
        if (pdfDocRef.current) {
            renderPDF(
                pdfDocRef.current,
                quoteListRef.current,
                currentPageRef.current,
            );
        }
    }

    function handleZoomOut() {
        const next = Math.max(
            ZOOM_MIN,
            Math.round((zoomRef.current - ZOOM_STEP) * 100) / 100,
        );
        zoomRef.current = next;
        setZoom(next);
        if (pdfDocRef.current) {
            renderPDF(
                pdfDocRef.current,
                quoteListRef.current,
                currentPageRef.current,
            );
        }
    }

    return (
        <div
            className={`relative flex flex-col bg-gray-100 flex-1 overflow-hidden ${rounded ? "rounded-lg" : ""}`}
        >
            <div
                ref={scrollContainerRef}
                className="flex-1 overflow-auto px-3 pt-5 pb-3"
            >
                {loading && (
                    <div className="flex h-full items-center justify-center">
                        <Loader2 className="h-7 w-7 animate-spin text-gray-400" />
                    </div>
                )}
                {error && (
                    <div className="flex h-full items-center justify-center">
                        <p className="text-sm text-red-500">{error}</p>
                    </div>
                )}
                <div ref={containerRef} />
            </div>
            {numPages > 0 && (
                <>
                    {/* Page counter — bottom left */}
                    <div className="absolute bottom-4 left-4 pointer-events-none">
                        <span className="flex items-center px-3 py-1.5 rounded-full text-xs font-medium tabular-nums text-gray-700 bg-white/25 backdrop-blur-md border border-white/30 shadow-md">
                            {currentPage}/{numPages}
                        </span>
                    </div>

                    {/* Zoom controls — bottom right */}
                    <div className="absolute bottom-4 right-4 flex items-center gap-px rounded-full bg-white/25 backdrop-blur-md border border-white/30 shadow-md px-1 py-1">
                        <button
                            onClick={handleZoomOut}
                            disabled={zoom <= ZOOM_MIN}
                            className="flex items-center justify-center w-7 h-7 rounded-full text-gray-600 hover:bg-white/80 disabled:opacity-30 transition-colors"
                        >
                            <ZoomOut className="h-3.5 w-3.5" />
                        </button>
                        <span className="text-xs font-medium text-gray-600 tabular-nums w-9 text-center select-none">
                            {Math.round(zoom * 100)}%
                        </span>
                        <button
                            onClick={handleZoomIn}
                            disabled={zoom >= ZOOM_MAX}
                            className="flex items-center justify-center w-7 h-7 rounded-full text-gray-600 hover:bg-white/80 disabled:opacity-30 transition-colors"
                        >
                            <ZoomIn className="h-3.5 w-3.5" />
                        </button>
                    </div>
                </>
            )}
        </div>
    );
}
