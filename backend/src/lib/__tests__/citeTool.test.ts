import { describe, it, expect } from "vitest";
import { readCiteCall, markersInProse } from "../chat/citeTool";
import type { DocIndex } from "../chat/types";

const docIndex: DocIndex = {
    "doc-0": { document_id: "uuid-0", filename: "Emails 1.pdf" },
    "doc-1": { document_id: "uuid-1", filename: "KCAMP letter.pdf" },
};

function ctx(prose: string, extra?: Partial<Parameters<typeof readCiteCall>[1]>) {
    return {
        prose,
        docIndex,
        knownClusterIds: new Set<number>(),
        knownLegIds: new Set<string>(),
        ...extra,
    };
}

describe("markersInProse", () => {
    it("finds each marker once, in order", () => {
        expect(markersInProse("a [2] b [1] c [2]")).toEqual([1, 2]);
    });
    it("ignores bracketed text that is not a marker", () => {
        expect(markersInProse("see [Exhibit A] and [doc-1, p. 2]")).toEqual([]);
    });
});

describe("readCiteCall", () => {
    it("accepts a call that matches the answer's markers", () => {
        const outcome = readCiteCall(
            {
                citations: [
                    {
                        ref: 1,
                        doc_id: "doc-0",
                        quotes: [{ page: "3", quote: "could not pay for the funeral" }],
                    },
                ],
            },
            ctx("She said so [1]."),
        );
        expect(outcome.problems).toEqual([]);
        expect(outcome.citations).toHaveLength(1);
        expect(outcome.citations[0]).toMatchObject({ ref: 1, kind: "document" });
    });

    it("refuses a document this conversation never opened", () => {
        const outcome = readCiteCall(
            {
                citations: [
                    { ref: 1, doc_id: "doc-9", quotes: [{ quote: "something" }] },
                ],
            },
            ctx("A claim [1]."),
        );
        expect(outcome.citations).toEqual([]);
        expect(outcome.problems.join(" ")).toContain("doc-9");
        expect(outcome.problems.join(" ")).toContain("doc-0");
    });

    it("refuses a case that was never retrieved, and accepts one that was", () => {
        const refused = readCiteCall(
            { citations: [{ ref: 1, cluster_id: 42, quotes: [{ quote: "held that" }] }] },
            ctx("A holding [1]."),
        );
        expect(refused.citations).toEqual([]);
        expect(refused.problems.join(" ")).toContain("42");

        const accepted = readCiteCall(
            { citations: [{ ref: 1, cluster_id: 42, quotes: [{ quote: "held that" }] }] },
            ctx("A holding [1].", { knownClusterIds: new Set([42]) }),
        );
        expect(accepted.problems).toEqual([]);
        expect(accepted.citations[0]).toMatchObject({ kind: "case", cluster_id: 42 });
    });

    it("refuses a statute that was never looked up", () => {
        const outcome = readCiteCall(
            {
                citations: [
                    {
                        ref: 1,
                        leg_id: "K.S.A. 58-2540",
                        quotes: [{ quote: "the lien attaches" }],
                    },
                ],
            },
            ctx("The statute says [1]."),
        );
        expect(outcome.citations).toEqual([]);
        expect(outcome.problems.join(" ")).toContain("K.S.A. 58-2540");
    });

    it("reports a marker with no entry", () => {
        const outcome = readCiteCall(
            {
                citations: [
                    { ref: 1, doc_id: "doc-0", quotes: [{ quote: "first point" }] },
                ],
            },
            ctx("First [1]. Second [2]."),
        );
        expect(outcome.problems.join(" ")).toContain("[2]");
    });

    it("reports an entry with no marker", () => {
        const outcome = readCiteCall(
            {
                citations: [
                    { ref: 1, doc_id: "doc-0", quotes: [{ quote: "first point" }] },
                    { ref: 2, doc_id: "doc-1", quotes: [{ quote: "second point" }] },
                ],
            },
            ctx("Only one marker [1]."),
        );
        expect(outcome.problems.join(" ")).toContain("[2]");
    });

    it("reports an answer that filed citations without any markers", () => {
        const outcome = readCiteCall(
            {
                citations: [
                    { ref: 1, doc_id: "doc-0", quotes: [{ quote: "a passage" }] },
                ],
            },
            ctx("An answer with no markers at all."),
        );
        expect(outcome.problems.join(" ")).toContain("no [N] markers");
    });

    it("reports two entries sharing one ref", () => {
        const outcome = readCiteCall(
            {
                citations: [
                    { ref: 1, doc_id: "doc-0", quotes: [{ quote: "one passage" }] },
                    { ref: 1, doc_id: "doc-1", quotes: [{ quote: "another passage" }] },
                ],
            },
            ctx("A claim [1]."),
        );
        expect(outcome.problems.join(" ")).toContain("ref 1");
        expect(outcome.citations).toHaveLength(1);
    });

    it("reports an empty call", () => {
        const outcome = readCiteCall({ citations: [] }, ctx("A claim [1]."));
        expect(outcome.citations).toEqual([]);
        expect(outcome.problems).toHaveLength(1);
    });

    it("reports an entry that cannot be read at all", () => {
        const outcome = readCiteCall(
            { citations: [{ ref: 1, doc_id: "doc-0" }] },
            ctx("A claim [1]."),
        );
        expect(outcome.citations).toEqual([]);
        expect(outcome.problems.join(" ")).toContain("could not be read");
    });
});
