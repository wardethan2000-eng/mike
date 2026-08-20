import { describe, it, expect, beforeEach } from "vitest";
import {
    cancellationNote,
    isStoppingForRestart,
    liveAnswerCount,
    registerLiveAnswer,
    resetLiveAnswers,
    stopLiveAnswersForRestart,
    waitForLiveAnswers,
} from "../chat/liveAnswers";
import { appendCancelledAssistantEvent } from "../chat/contextBuilders";

describe("answers in progress", () => {
    beforeEach(() => resetLiveAnswers());

    it("counts them while they are being written and forgets them after", () => {
        expect(liveAnswerCount()).toBe(0);
        const done = registerLiveAnswer(() => {});
        const alsoDone = registerLiveAnswer(() => {});
        expect(liveAnswerCount()).toBe(2);
        done();
        expect(liveAnswerCount()).toBe(1);
        alsoDone();
        expect(liveAnswerCount()).toBe(0);
    });

    it("stops every one of them on the way down", () => {
        const stopped: string[] = [];
        registerLiveAnswer(() => stopped.push("first"));
        registerLiveAnswer(() => stopped.push("second"));
        stopLiveAnswersForRestart();
        expect(stopped).toEqual(["first", "second"]);
        expect(isStoppingForRestart()).toBe(true);
    });

    it("carries on when one of them will not stop", () => {
        const stopped: string[] = [];
        registerLiveAnswer(() => {
            throw new Error("stuck");
        });
        registerLiveAnswer(() => stopped.push("second"));
        expect(() => stopLiveAnswersForRestart()).not.toThrow();
        expect(stopped).toEqual(["second"]);
    });

    it("waits for them to save, and says so when they have", async () => {
        const done = registerLiveAnswer(() => {});
        setTimeout(done, 50);
        expect(await waitForLiveAnswers(2000)).toBe(0);
    });

    it("gives up waiting rather than hanging the shutdown", async () => {
        registerLiveAnswer(() => {});
        expect(await waitForLiveAnswers(300)).toBe(1);
    });

    it("tells the reader why the answer stops there", () => {
        expect(cancellationNote()).toBe("Cancelled by user.");
        expect(appendCancelledAssistantEvent([]).at(-1)).toEqual({
            type: "content",
            text: "Cancelled by user.",
        });

        stopLiveAnswersForRestart();
        expect(cancellationNote()).toContain("Mike was restarted");
        expect(
            (appendCancelledAssistantEvent([]).at(-1) as { text: string }).text,
        ).toContain("Ask again");
    });
});
