import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Response } from "express";
import { startSseHeartbeat, openAssistantSse } from "../routeStreaming";

/** The little of express's Response that the SSE helpers touch. */
function makeRes() {
    const written: string[] = [];
    const listeners: Record<string, (() => void)[]> = {};
    const res = {
        written,
        writableEnded: false,
        destroyed: false,
        headers: {} as Record<string, string>,
        setHeader(name: string, value: string) {
            this.headers[name] = value;
        },
        flushHeaders() {},
        write(line: string) {
            written.push(line);
            return true;
        },
        end() {
            this.writableEnded = true;
        },
        on(event: string, handler: () => void) {
            (listeners[event] ??= []).push(handler);
            return this;
        },
        emit(event: string) {
            (listeners[event] ?? []).forEach((handler) => handler());
        },
    };
    return res as unknown as Response & {
        written: string[];
        writableEnded: boolean;
        emit: (event: string) => void;
    };
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("startSseHeartbeat", () => {
    it("writes a comment line while the answer is quiet", () => {
        const res = makeRes();
        startSseHeartbeat(res, 1000);

        vi.advanceTimersByTime(3000);

        expect(res.written).toEqual([
            ": keep-alive\n\n",
            ": keep-alive\n\n",
            ": keep-alive\n\n",
        ]);
        // Comments carry no data, so a reader that only looks at "data:" lines
        // sees nothing at all.
        expect(res.written.some((line) => line.startsWith("data:"))).toBe(false);
    });

    it("stops when told to", () => {
        const res = makeRes();
        const stop = startSseHeartbeat(res, 1000);

        vi.advanceTimersByTime(1000);
        stop();
        vi.advanceTimersByTime(5000);

        expect(res.written).toHaveLength(1);
    });

    it("stops when the connection closes", () => {
        const res = makeRes();
        startSseHeartbeat(res, 1000);

        res.emit("close");
        vi.advanceTimersByTime(5000);

        expect(res.written).toEqual([]);
    });

    it("writes nothing once the response has ended", () => {
        const res = makeRes();
        startSseHeartbeat(res, 1000);

        res.end();
        vi.advanceTimersByTime(5000);

        expect(res.written).toEqual([]);
    });
});

describe("openAssistantSse", () => {
    it("keeps the stream alive until it finishes", () => {
        const res = makeRes();
        const stream = openAssistantSse(res);

        vi.advanceTimersByTime(30_000);
        const beforeFinish = res.written.length;
        stream.finish();
        vi.advanceTimersByTime(60_000);

        expect(beforeFinish).toBeGreaterThan(0);
        expect(res.written).toHaveLength(beforeFinish);
        expect(res.writableEnded).toBe(true);
    });
});
