"use client";

import type { AssistantEvent } from "../../shared/types";
import { EventBlock } from "./EventBlocks";

/**
 * Shown when an answer stopped searching before it was finished — it used up
 * its research steps, its time, or the room it had to work in. The answer
 * above is the best the model could give with what it had; these buttons pick
 * the same piece of work back up.
 */
export function PausedBlock({
    event,
    showConnector,
    onContinue,
    isContinuing,
    disabled,
}: {
    event: Extract<AssistantEvent, { type: "paused" }>;
    showConnector?: boolean;
    onContinue?: (args: { token: string; condense: boolean }) => void;
    isContinuing?: boolean;
    disabled?: boolean;
}) {
    const busy = !!isContinuing;
    const blocked = busy || !!disabled || !onContinue;
    const buttonClass =
        "rounded-md border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 transition hover:border-gray-400 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50";

    return (
        <EventBlock showConnector={showConnector} dotColor="gray">
            <p className="font-medium text-gray-600">{event.message}</p>
            <p className="mt-1 text-gray-500">
                The answer above uses everything found so far. You can carry on
                from where it stopped.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
                <button
                    type="button"
                    className={buttonClass}
                    disabled={blocked}
                    onClick={() =>
                        onContinue?.({
                            token: event.resume_token,
                            condense: false,
                        })
                    }
                >
                    {busy ? "Continuing…" : "Keep going"}
                </button>
                <button
                    type="button"
                    className={buttonClass}
                    disabled={blocked}
                    onClick={() =>
                        onContinue?.({
                            token: event.resume_token,
                            condense: true,
                        })
                    }
                    title="Sum up what has been found so far, then carry on with more room to work in."
                >
                    Condense and keep going
                </button>
            </div>
            {event.reason === "context" && (
                <p className="mt-1.5 text-xs text-gray-500">
                    This one has gathered a lot of material — condensing first
                    will give it room to finish.
                </p>
            )}
        </EventBlock>
    );
}
