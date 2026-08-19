"use client";

import { useEffect, useState, type RefObject } from "react";
import { MessageSquarePlus } from "lucide-react";

interface Props {
    /** The element the text has to be inside for the button to appear. */
    containerRef: RefObject<HTMLElement | null>;
    /** Called with the highlighted words when the button is clicked. */
    onQuote: (text: string) => void;
    label?: string;
}

/**
 * A small "Ask about this" button that appears next to text the user has
 * highlighted in a document. Clicking it hands the highlighted words to the
 * chat box so they can say what they want done with that passage.
 */
export function SelectionQuoteButton({
    containerRef,
    onQuote,
    label = "Ask about this",
}: Props) {
    const [spot, setSpot] = useState<{
        text: string;
        top: number;
        left: number;
    } | null>(null);

    useEffect(() => {
        const read = () => {
            const root = containerRef.current;
            const selection = window.getSelection();
            if (
                !root ||
                !selection ||
                selection.isCollapsed ||
                selection.rangeCount === 0
            ) {
                setSpot(null);
                return;
            }
            const range = selection.getRangeAt(0);
            if (!root.contains(range.commonAncestorContainer)) {
                setSpot(null);
                return;
            }
            const text = selection.toString().replace(/\s+/g, " ").trim();
            if (text.length < 2) {
                setSpot(null);
                return;
            }
            const rect = range.getBoundingClientRect();
            if (!rect.width && !rect.height) {
                setSpot(null);
                return;
            }
            setSpot({
                text,
                top: Math.max(8, rect.top - 38),
                left: rect.left + rect.width / 2,
            });
        };
        // Read after the browser has finished settling the selection.
        const later = () => window.setTimeout(read, 0);
        const clear = () => setSpot(null);

        document.addEventListener("mouseup", later);
        document.addEventListener("keyup", later);
        document.addEventListener("mousedown", clear);
        window.addEventListener("scroll", clear, true);
        window.addEventListener("resize", clear);
        return () => {
            document.removeEventListener("mouseup", later);
            document.removeEventListener("keyup", later);
            document.removeEventListener("mousedown", clear);
            window.removeEventListener("scroll", clear, true);
            window.removeEventListener("resize", clear);
        };
    }, [containerRef]);

    if (!spot) return null;

    return (
        <button
            type="button"
            // Keep the highlight alive while the button is being clicked.
            onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
            }}
            onMouseUp={(e) => e.stopPropagation()}
            onClick={() => {
                onQuote(spot.text);
                setSpot(null);
                window.getSelection()?.removeAllRanges();
            }}
            style={{
                position: "fixed",
                top: spot.top,
                left: spot.left,
                transform: "translateX(-50%)",
                zIndex: 60,
            }}
            className="inline-flex items-center gap-1 rounded-full border border-gray-200 bg-white px-2.5 py-1 text-xs font-medium text-gray-700 shadow-md hover:bg-gray-50"
        >
            <MessageSquarePlus className="h-3.5 w-3.5" />
            {label}
        </button>
    );
}
