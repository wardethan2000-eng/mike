import { describe, it, expect, vi } from "vitest";
import { buildTrailingNotesBlock } from "../chat/streaming";
import { condenseForContinuation } from "../chat/runResume";
import type { TaskStep } from "../chat/taskList";

vi.mock("../llm", async () => {
    const actual = await vi.importActual<Record<string, unknown>>("../llm");
    return {
        ...actual,
        // The summariser is not what is under test here, and the list must
        // never go through it anyway.
        completeText: vi.fn(async () => "Condensed notes about the leases."),
    };
});

const LIST: TaskStep[] = [
    { step: "Draft the demand letter to Acme Holdings", status: "done" },
    { step: "Draft the demand letter to Borden Equipment", status: "doing" },
    { step: "Check every authority cited across the letters", status: "pending" },
];

describe("the small print under an answer", () => {
    it("puts every note in one italic block", () => {
        const block = buildTrailingNotesBlock([
            "Not retrieved in this conversation: K.S.A. 58-2540.",
            "Checklist: 2 of 4 authorities addressed.",
            "Still to do: draft the notice to Chen.",
        ]);
        expect(block.startsWith("\n\n")).toBe(true);
        expect(block.split("\n").filter((line) => line.trim()).length).toBe(3);
        expect(block).toContain("*Still to do: draft the notice to Chen.*");
    });

    it("never runs to more than three lines", () => {
        const block = buildTrailingNotesBlock(["one", "two", "three", "four"]);
        expect(block.split("\n").filter((line) => line.trim()).length).toBe(3);
        expect(block).not.toContain("four");
    });

    it("says nothing when there is nothing to say", () => {
        expect(buildTrailingNotesBlock([])).toBe("");
        expect(buildTrailingNotesBlock(["", "   "])).toBe("");
    });
});

describe("picking a paused turn back up", () => {
    it("carries the list through the condensing unchanged", async () => {
        const messages = await condenseForContinuation({
            state: {
                provider: "ollama",
                model: "glm-5.2",
                baseMessages: [{ role: "user", content: "Draft the three letters." }],
                transcript: [{ role: "assistant", content: "read the lease" }],
                iterationsUsed: 40,
            },
            taskListSteps: LIST,
        });
        const carried = messages.find((m) => m.content.includes("unchanged"));
        expect(carried).toBeDefined();
        for (const step of LIST) {
            expect(carried!.content).toContain(step.step);
        }
        // Above the condensed notes, not inside them.
        const listIdx = messages.findIndex((m) => m === carried);
        const notesIdx = messages.findIndex((m) =>
            m.content.includes("Condensed research notes"),
        );
        expect(notesIdx).toBeGreaterThan(listIdx);
    });

    it("leaves the continuation alone when there is no list", async () => {
        const messages = await condenseForContinuation({
            state: {
                provider: "ollama",
                model: "glm-5.2",
                baseMessages: [{ role: "user", content: "Draft the three letters." }],
                transcript: [{ role: "assistant", content: "read the lease" }],
                iterationsUsed: 40,
            },
        });
        expect(messages.some((m) => m.content.includes("unchanged"))).toBe(false);
    });
});
