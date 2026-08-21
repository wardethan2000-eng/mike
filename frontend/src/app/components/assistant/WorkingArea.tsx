"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/**
 * Where everything the assistant does before its answer lives.
 *
 * A long job used to grow the page for minutes on end — seven "Completed in N
 * steps" blocks and the paragraphs between them. The commentary is worth
 * keeping; the scroll is not. So while the turn runs this box stays about five
 * lines tall and keeps its newest line in view, and when the turn ends it
 * folds to a single line that expands again if the reader wants it.
 *
 * The paragraph the assistant is writing right now is not in here: a content
 * run followed by tool activity is working, and the run with nothing after it
 * is the answer. That rule needs no signal from the backend.
 */
export function WorkingArea({
    children,
    isStreaming,
    stepCount,
    elapsedLabel,
}: {
    children: ReactNode;
    isStreaming: boolean;
    stepCount: number;
    elapsedLabel?: string | null;
}) {
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const [userToggled, setUserToggled] = useState(false);
    const [isOpen, setIsOpen] = useState(true);

    useEffect(() => {
        if (userToggled) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- follows the turn's own state until the reader takes over
        setIsOpen(isStreaming);
    }, [isStreaming, userToggled]);

    // Keep the newest line in view. Runs on every render while streaming
    // because the content grows a few characters at a time.
    useEffect(() => {
        if (!isStreaming || !isOpen) return;
        const node = scrollRef.current;
        if (!node) return;
        node.scrollTop = node.scrollHeight;
    });

    const word = stepCount === 1 ? "step" : "steps";
    const label = isStreaming
        ? "Working"
        : elapsedLabel
          ? `Worked for ${elapsedLabel} · ${stepCount} ${word}`
          : `Worked through ${stepCount} ${word}`;

    return (
        <div className="my-2">
            <button
                type="button"
                onClick={() => {
                    setUserToggled(true);
                    setIsOpen((value) => !value);
                }}
                aria-expanded={isOpen}
                className="flex w-full items-center justify-between px-1 py-1 font-serif text-sm text-gray-500 transition-colors hover:text-gray-700"
            >
                <span className="flex min-w-0 items-baseline">
                    <span className="truncate">{label}</span>
                    {isStreaming && (
                        <span
                            className="ml-1 inline-flex shrink-0 items-baseline"
                            aria-hidden
                        >
                            <span className="mr-0.5 h-0.5 w-0.5 rounded-full bg-gray-400 animate-[bounce_1.4s_infinite_0s]" />
                            <span className="mr-0.5 h-0.5 w-0.5 rounded-full bg-gray-400 animate-[bounce_1.4s_infinite_0.2s]" />
                            <span className="h-0.5 w-0.5 rounded-full bg-gray-400 animate-[bounce_1.4s_infinite_0.4s]" />
                        </span>
                    )}
                </span>
                <ChevronDown
                    aria-hidden
                    className={`relative top-px ml-2 h-3 w-3 shrink-0 transition-transform duration-200 ${isOpen ? "" : "-rotate-90"}`}
                />
            </button>

            {isOpen && (
                <div
                    ref={scrollRef}
                    data-testid="working-area-scroll"
                    className={
                        isStreaming
                            ? "mask-fade-top max-h-[8.5rem] overflow-y-auto rounded-lg border border-gray-200/60 bg-gray-50/40 px-2 py-1.5 text-[0.95em] opacity-80"
                            : "rounded-lg border border-gray-200/60 bg-gray-50/40 px-2 py-1.5"
                    }
                >
                    {children}
                </div>
            )}
        </div>
    );
}
