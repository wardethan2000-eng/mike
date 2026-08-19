import { afterEach, describe, expect, it, vi } from "vitest";
import { streamOllama } from "../llm/ollama";
import type { NormalizedToolCall } from "../llm/types";

// Each fetch call returns one streamed model turn. `turns` is consumed in
// order; the last entry repeats if the loop asks for more.
function mockOllama(turns: { text?: string; toolName?: string; args?: unknown }[]) {
    const bodies: Record<string, unknown>[] = [];
    let index = 0;
    const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
        const body = JSON.parse(init.body) as Record<string, unknown>;
        bodies.push(body);
        const turn = turns[Math.min(index, turns.length - 1)];
        index += 1;
        const lines: string[] = [];
        if (turn.text) {
            lines.push(
                `data: ${JSON.stringify({ choices: [{ delta: { content: turn.text } }] })}`,
            );
        }
        if (turn.toolName) {
            lines.push(
                `data: ${JSON.stringify({
                    choices: [
                        {
                            delta: {
                                tool_calls: [
                                    {
                                        index: 0,
                                        id: `call-${index}`,
                                        function: {
                                            name: turn.toolName,
                                            arguments: JSON.stringify(turn.args ?? {}),
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                })}`,
            );
        }
        lines.push("data: [DONE]");
        const payload = `${lines.join("\n")}\n`;
        return new Response(payload, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    return { bodies, fetchMock };
}

const runTools = async (calls: NormalizedToolCall[]) =>
    calls.map((call) => ({ tool_use_id: call.id, content: "tool result" }));

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("tool-loop budget", () => {
    it("stops calling tools at the round limit and still writes an answer", async () => {
        const { bodies } = mockOllama([
            { toolName: "search_case_law", args: { q: "a" } },
            { toolName: "search_case_law", args: { q: "b" } },
            { text: "Here is what I found so far." },
        ]);

        const result = await streamOllama({
            model: "ollama/test",
            systemPrompt: "system",
            messages: [{ role: "user", content: "research this" }],
            tools: [
                {
                    type: "function",
                    function: {
                        name: "search_case_law",
                        description: "",
                        parameters: {},
                    },
                },
            ],
            runTools,
            budget: { maxIterations: 2 },
        });

        // Two rounds with tools, then one wrap-up round without them.
        expect(bodies).toHaveLength(3);
        expect(bodies[0].tools).toBeDefined();
        expect(bodies[1].tools).toBeDefined();
        expect(bodies[2].tools).toBeUndefined();

        expect(result.stopReason).toBe("iterations");
        expect(result.fullText).toContain("Here is what I found so far.");
        expect(result.resumeState).toBeTruthy();
        expect(result.stats.iterations).toBe(2);
    });

    it("finishes normally when the model stops asking for tools", async () => {
        mockOllama([{ text: "Done." }]);
        const result = await streamOllama({
            model: "ollama/test",
            systemPrompt: "system",
            messages: [{ role: "user", content: "hello" }],
            tools: [],
            runTools,
        });
        expect(result.stopReason).toBe("complete");
        expect(result.resumeState).toBeUndefined();
    });

    it("stops a model that keeps repeating the same search", async () => {
        const { bodies } = mockOllama([
            { toolName: "search_case_law", args: { q: "same" } },
            { toolName: "search_case_law", args: { q: "same" } },
            { toolName: "search_case_law", args: { q: "same" } },
            { text: "I could not get any further." },
        ]);

        const result = await streamOllama({
            model: "ollama/test",
            systemPrompt: "system",
            messages: [{ role: "user", content: "research this" }],
            tools: [
                {
                    type: "function",
                    function: {
                        name: "search_case_law",
                        description: "",
                        parameters: {},
                    },
                },
            ],
            runTools,
            budget: { maxIterations: 50, maxRepeats: 3 },
        });

        expect(result.stopReason).toBe("loop");
        // Three identical calls, then the wrap-up round.
        expect(bodies).toHaveLength(4);
        expect(bodies[3].tools).toBeUndefined();
        expect(result.fullText).toContain("I could not get any further.");
    });

    it("picks a paused turn back up with everything it had collected", async () => {
        mockOllama([
            { toolName: "search_case_law", args: { q: "a" } },
            { text: "Partial answer." },
        ]);
        const paused = await streamOllama({
            model: "ollama/test",
            systemPrompt: "system",
            messages: [{ role: "user", content: "research this" }],
            tools: [
                {
                    type: "function",
                    function: {
                        name: "search_case_law",
                        description: "",
                        parameters: {},
                    },
                },
            ],
            runTools,
            budget: { maxIterations: 1 },
        });
        expect(paused.stopReason).toBe("iterations");
        vi.unstubAllGlobals();

        const { bodies } = mockOllama([{ text: "Full answer." }]);
        const resumed = await streamOllama({
            model: "ollama/test",
            systemPrompt: "system",
            messages: [{ role: "user", content: "research this" }],
            tools: [],
            runTools,
            resumeState: paused.resumeState,
        });

        const sent = bodies[0].messages as { role: string; content: string }[];
        // The earlier tool result is still there, and the model is told to
        // carry on rather than start again.
        expect(sent.some((m) => m.role === "tool" && m.content === "tool result")).toBe(true);
        expect(
            sent.some((m) => typeof m.content === "string" && m.content.includes("keep going")),
        ).toBe(true);
        expect(resumed.stopReason).toBe("complete");
        expect(resumed.fullText).toBe("Full answer.");
        // The resumed turn reports the total spent across both runs.
        expect(resumed.stats.iterations).toBeGreaterThanOrEqual(1);
    });
});
