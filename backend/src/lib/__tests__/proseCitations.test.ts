import { describe, it, expect } from "vitest";
import {
    applyMarkerRewrites,
    extractProseCitations,
} from "../chat/proseCitations";
import type { DocIndex } from "../chat/types";

const docIndex: DocIndex = {
    "doc-0": { document_id: "uuid-0", filename: "Emails 1.pdf" },
    "doc-3": { document_id: "uuid-3", filename: "KCAMP letter.pdf" },
};

describe("extractProseCitations", () => {
    it("turns a written-out reference into a citation and renumbers the prose", () => {
        const prose =
            'The letter says the limit applies to "property damage sustained from the nonperformance of sanitary sewers" [doc-3, p. 1].';
        const { citations, rewrites } = extractProseCitations(prose, docIndex);

        expect(citations).toHaveLength(1);
        expect(citations[0]).toMatchObject({
            kind: "document",
            ref: 1,
            doc_id: "doc-3",
            page: 1,
        });
        expect(citations[0].quotes[0].quote).toBe(
            "property damage sustained from the nonperformance of sanitary sewers",
        );
        expect(applyMarkerRewrites(prose, rewrites)).toContain(
            'sanitary sewers" [1].',
        );
    });

    it("numbers each document and page once, in the order they appear", () => {
        const prose =
            "The cause of loss was a water meter failure [doc-0, p. 10]. " +
            "The coverage letter sets the limit [doc-3, p. 1]. " +
            "The emails say the same [doc-0, p. 10].";
        const { citations, rewrites } = extractProseCitations(prose, docIndex);

        expect(citations.map((c) => [c.doc_id, c.page, c.ref])).toEqual([
            ["doc-0", 10, 1],
            ["doc-3", 1, 2],
        ]);
        const rewritten = applyMarkerRewrites(prose, rewrites);
        expect(rewritten).toContain("water meter failure [1].");
        expect(rewritten).toContain("sets the limit [2].");
        expect(rewritten).toContain("say the same [1].");
    });

    it("still cites the page when the sentence quotes nothing", () => {
        const { citations } = extractProseCitations(
            "The cause of loss was a municipal water meter failure [doc-0, p. 10].",
            docIndex,
        );
        expect(citations).toHaveLength(1);
        expect(citations[0].quote).toBe("");
        expect(citations[0].quotes).toEqual([]);
    });

    it("does not take a quotation from an earlier sentence", () => {
        const { citations } = extractProseCitations(
            'She wrote "I could not pay for the funeral". That is the whole of ' +
                "the hardship evidence, and it runs through the correspondence " +
                "as a theme rather than a single passage [doc-0, p. 2].",
            docIndex,
        );
        expect(citations[0].quote).toBe("");
    });

    it("reads a page range and a reference in brackets or parentheses", () => {
        const { citations } = extractProseCitations(
            "First (doc-3, pp. 4-5). Second [doc-0, page 2].",
            docIndex,
        );
        expect(citations.map((c) => c.page)).toEqual(["4-5", 2]);
    });

    it("assumes page 1 when no page is given", () => {
        const { citations } = extractProseCitations(
            "The release is signed [doc-3].",
            docIndex,
        );
        expect(citations[0].page).toBe(1);
    });

    it("handles several documents inside one reference", () => {
        const { rewrites, citations } = extractProseCitations(
            "Both files agree [doc-0, p. 1; doc-3, p. 2].",
            docIndex,
        );
        expect(citations).toHaveLength(2);
        expect(rewrites[0].replace).toBe("[1][2]");
    });

    it("leaves alone a label this conversation does not know", () => {
        expect(
            extractProseCitations("Something else [doc-9, p. 1].", docIndex),
        ).toEqual({ citations: [], rewrites: [] });
    });

    it("leaves alone a bracket that only mentions a document", () => {
        expect(
            extractProseCitations("[see doc-3 and the letter]", docIndex),
        ).toEqual({ citations: [], rewrites: [] });
    });

    it("finds nothing in an answer with no written-out references", () => {
        expect(extractProseCitations("A plain answer [1].", docIndex)).toEqual({
            citations: [],
            rewrites: [],
        });
    });
});
