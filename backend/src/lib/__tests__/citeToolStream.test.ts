// The checking of a cite_sources call is unit-tested next door. This covers the
// wiring around it: that an answer which files its citations ends there with
// them attached, and that a bad filing is sent back to be corrected instead of
// being lost or breaking the answer.
import { describe, it, expect, vi, beforeEach } from "vitest";

const { streamChatWithTools } = vi.hoisted(() => ({
    streamChatWithTools: vi.fn(),
}));

vi.mock("../chat/../llm", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        streamChatWithTools: (...args: unknown[]) =>
            streamChatWithTools(...args),
    };
});

vi.mock("../mcpConnectors", () => ({
    buildUserMcpTools: async () => [],
}));

vi.mock("../chat/tools/toolDispatcher", () => ({
    runToolCalls: async () => ({
        toolResults: [],
        docsRead: [],
        docsFound: [],
        docsCreated: [],
        docsReplicated: [],
        workflowsApplied: [],
        docsEdited: [],
        askInputsEvents: [],
        courtlistenerEvents: [],
        caseCitationEvents: [],
        mcpEvents: [],
    }),
}));

vi.mock("../chat/verifyCitations", async (importOriginal) => {
    const actual = (await importOriginal()) as Record<string, unknown>;
    return {
        ...actual,
        // Quote checking reads the stored file, which this test has no use for.
        verifyCitations: async (annotations: unknown[]) => annotations,
    };
});

import { runLLMStream } from "../chat/streaming";

const docIndex = {
    "doc-0": { document_id: "uuid-0", filename: "Emails 1.pdf" },
};

function runWith(behaviour: (turn: Record<string, any>) => Promise<void>) {
    streamChatWithTools.mockImplementation(async (args: any) => {
        await behaviour({ ...args.callbacks, runTools: args.runTools });
        return { stopReason: "complete", resumeState: null, stats: {} };
    });
    return runLLMStream({
        apiMessages: [
            { role: "system", content: "system" },
            { role: "user", content: "what does the letter say?" },
        ],
        docStore: new Map() as any,
        docIndex,
        userId: "user-1",
        db: {} as any,
        write: () => {},
        includeResearchTools: false,
        model: "claude-opus-4-8",
    });
}

describe("cite_sources in a running turn", () => {
    beforeEach(() => {
        streamChatWithTools.mockReset();
    });

    it("attaches the filed citations and ends the turn there", async () => {
        const result = await runWith(async (callbacks) => {
            callbacks.onContentDelta("The letter sets the limit [1].");
            await callbacks.runTools([
                {
                    id: "call-1",
                    name: "cite_sources",
                    input: {
                        citations: [
                            {
                                ref: 1,
                                doc_id: "doc-0",
                                quotes: [{ page: "3", quote: "the limit is $50,000" }],
                            },
                        ],
                    },
                },
            ]);
            throw new Error("the turn should have ended when citations were filed");
        });

        expect(result.citations).toHaveLength(1);
        expect(result.citations[0]).toMatchObject({
            kind: "document",
            ref: 1,
            filename: "Emails 1.pdf",
        });
        expect(result.fullText).toContain("[1]");
    });

    it("sends a bad filing back instead of accepting it", async () => {
        let firstResult: { tool_use_id: string; content: string }[] = [];
        const result = await runWith(async (callbacks) => {
            callbacks.onContentDelta("A claim [1].");
            firstResult = await callbacks.runTools([
                {
                    id: "call-1",
                    name: "cite_sources",
                    input: {
                        citations: [
                            {
                                ref: 1,
                                doc_id: "doc-7",
                                quotes: [{ quote: "not in this conversation" }],
                            },
                        ],
                    },
                },
            ]);
        });

        const reply = JSON.parse(firstResult[0].content);
        expect(reply.filed).toBe(false);
        expect(String(reply.problems)).toContain("doc-7");
        // Nothing was accepted, and the answer itself is untouched.
        expect(result.citations).toEqual([]);
        expect(result.fullText).toContain("A claim [1].");
    });

    it("keeps the good entries when the second attempt is still imperfect", async () => {
        const result = await runWith(async (callbacks) => {
            callbacks.onContentDelta("First [1]. Second [2].");
            await callbacks.runTools([
                {
                    id: "call-1",
                    name: "cite_sources",
                    input: { citations: [] },
                },
            ]);
            await callbacks.runTools([
                {
                    id: "call-2",
                    name: "cite_sources",
                    input: {
                        citations: [
                            {
                                ref: 1,
                                doc_id: "doc-0",
                                quotes: [{ page: "1", quote: "first passage" }],
                            },
                        ],
                    },
                },
            ]);
            throw new Error("the turn should have ended on the second filing");
        });

        expect(result.citations).toHaveLength(1);
        expect(result.citations[0]).toMatchObject({ ref: 1 });
    });
});
