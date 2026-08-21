"use client";

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Circle, Dot } from "lucide-react";
import { GlassCardUI } from "@/shared/ui/GlassCardUI";
import type { AssistantEvent } from "@/app/components/shared/types";

type TaskStep = Extract<AssistantEvent, { type: "task_list" }>["steps"][number];

/** "5 steps — all done", "3 of 5 steps done, 1 dropped". */
export function taskListSummary(steps: TaskStep[]): string {
    if (steps.length === 0) return "No steps";
    const done = steps.filter((s) => s.status === "done").length;
    const dropped = steps.filter((s) => s.status === "dropped").length;
    const word = steps.length === 1 ? "step" : "steps";
    if (done === steps.length) return `${steps.length} ${word} — all done`;
    const parts = [`${done} of ${steps.length} ${word} done`];
    if (dropped) parts.push(`${dropped} dropped`);
    const outstanding = steps.length - done - dropped;
    if (dropped && outstanding) parts.push(`${outstanding} outstanding`);
    return parts.join(", ");
}

function StepMark({ status }: { status: TaskStep["status"] }) {
    if (status === "done")
        return <Check aria-hidden className="h-3.5 w-3.5 shrink-0 text-emerald-600" />;
    if (status === "doing")
        return (
            <Circle
                aria-hidden
                className="h-3 w-3 shrink-0 fill-blue-500 text-blue-500"
            />
        );
    if (status === "dropped")
        return <Dot aria-hidden className="h-3.5 w-3.5 shrink-0 text-gray-400" />;
    return <Dot aria-hidden className="h-3.5 w-3.5 shrink-0 text-gray-400" />;
}

/**
 * The steps the assistant wrote down for this job, ticking over as it works.
 *
 * One block per message. The stream carries an update every time the list
 * changes and this re-renders in place; the message keeps only the latest, so
 * a reloaded page shows one checklist rather than one per update.
 */
export function TaskChecklist({
    steps,
    isStreaming,
}: {
    steps: TaskStep[];
    isStreaming: boolean;
}) {
    const outstanding = steps.filter(
        (s) => s.status === "pending" || s.status === "doing",
    ).length;
    // Open while there is work left, folded away once there is not. A reader
    // who opens it keeps it open.
    const [userToggled, setUserToggled] = useState(false);
    const [isOpen, setIsOpen] = useState(true);
    const shouldBeOpen = isStreaming || outstanding > 0;
    useEffect(() => {
        if (userToggled) return;
        // eslint-disable-next-line react-hooks/set-state-in-effect -- follows the turn's own state until the reader takes over
        setIsOpen(shouldBeOpen);
    }, [shouldBeOpen, userToggled]);

    if (steps.length === 0) return null;

    return (
        <GlassCardUI>
            <button
                type="button"
                onClick={() => {
                    setUserToggled(true);
                    setIsOpen((value) => !value);
                }}
                aria-expanded={isOpen}
                className={`flex w-full items-center justify-between px-3 font-serif text-sm text-gray-500 transition-colors hover:text-gray-700 ${isOpen ? "pt-2" : "py-2"}`}
            >
                <span className="flex min-w-0 items-center gap-1.5">
                    {outstanding === 0 && (
                        <Check aria-hidden className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                    )}
                    <span className="truncate">{taskListSummary(steps)}</span>
                </span>
                <ChevronDown
                    aria-hidden
                    className={`relative top-px ml-2 h-3 w-3 shrink-0 transition-transform duration-200 ${isOpen ? "" : "-rotate-90"}`}
                />
            </button>

            {isOpen && (
                <ul className="mt-2 flex flex-col gap-1 px-3 pb-2">
                    {steps.map((step, i) => (
                        <li
                            key={`${i}-${step.step}`}
                            className="flex items-start gap-2 font-serif text-sm leading-snug"
                        >
                            <span className="mt-[3px]">
                                <StepMark status={step.status} />
                            </span>
                            <span
                                className={
                                    step.status === "done"
                                        ? "text-gray-400 line-through decoration-gray-300"
                                        : step.status === "dropped"
                                          ? "text-gray-400"
                                          : step.status === "doing"
                                            ? "text-gray-900"
                                            : "text-gray-600"
                                }
                            >
                                <span
                                    className={
                                        step.status === "dropped"
                                            ? "line-through decoration-gray-300"
                                            : undefined
                                    }
                                >
                                    {step.step}
                                </span>
                                {step.status === "dropped" && step.reason && (
                                    <span className="ml-1.5 text-gray-500">
                                        — {step.reason}
                                    </span>
                                )}
                            </span>
                        </li>
                    ))}
                </ul>
            )}
        </GlassCardUI>
    );
}

/**
 * How long the assistant has been working, measured while the answer streams.
 * A page reloaded later has no start time, so the summary line simply leaves
 * the duration out rather than inventing one.
 */
export function useElapsedLabel(isStreaming: boolean): string | null {
    const startedAt = useRef<number | null>(null);
    const [elapsedMs, setElapsedMs] = useState<number | null>(null);
    useEffect(() => {
        if (!isStreaming) return;
        if (startedAt.current === null) startedAt.current = Date.now();
        const tick = () => setElapsedMs(Date.now() - (startedAt.current ?? Date.now()));
        tick();
        const timer = setInterval(tick, 5000);
        return () => clearInterval(timer);
    }, [isStreaming]);
    if (elapsedMs === null) return null;
    const seconds = Math.round(elapsedMs / 1000);
    if (seconds < 90) return `${Math.max(seconds, 1)} seconds`;
    const minutes = Math.round(seconds / 60);
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
