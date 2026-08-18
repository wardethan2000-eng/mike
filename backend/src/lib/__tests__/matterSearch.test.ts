import { describe, expect, it } from "vitest";
import {
    type MatterSearchHit,
    formatForAssistant,
    hitLocation,
} from "../matterSearch";

const hit = (over: Partial<MatterSearchHit> = {}): MatterSearchHit => ({
    documentId: "doc-1",
    filename: "Summons.pdf",
    page: 2,
    content: "You are hereby summoned to appear.",
    fromOcr: false,
    matchedBy: "words",
    rank: 0.5,
    ...over,
});

describe("hitLocation", () => {
    it("reads like a citation with a page", () => {
        expect(hitLocation(hit())).toBe("Summons.pdf, page 2");
    });
    it("drops the page when there is none", () => {
        expect(hitLocation(hit({ page: null }))).toBe("Summons.pdf");
    });
});

describe("formatForAssistant", () => {
    it("says plainly when nothing matched", () => {
        const text = formatForAssistant("indemnity", []);
        expect(text).toMatch(/no passages/i);
        expect(text).toContain("indemnity");
    });

    it("groups passages under their document and cites the page", () => {
        const text = formatForAssistant("summons", [
            hit({ page: 2, content: "first mention" }),
            hit({ page: 5, content: "second mention" }),
        ]);
        expect(text).toContain("Summons.pdf:");
        expect(text).toContain("page 2");
        expect(text).toContain("page 5");
        // A document heading appears once even with several passages.
        expect(text.match(/Summons\.pdf:/g)).toHaveLength(1);
    });

    it("orders a document's passages by page", () => {
        const text = formatForAssistant("x", [
            hit({ page: 9, content: "later" }),
            hit({ page: 1, content: "earlier" }),
        ]);
        expect(text.indexOf("earlier")).toBeLessThan(text.indexOf("later"));
    });

    it("warns when a passage came from a scan", () => {
        const text = formatForAssistant("fee", [
            hit({ fromOcr: true, content: "the fee is $12,500.00" }),
        ]);
        expect(text).toMatch(/from a scan/i);
    });

    it("marks an approximate (fuzzy) match", () => {
        const text = formatForAssistant("summins", [
            hit({ matchedBy: "similar" }),
        ]);
        expect(text).toMatch(/approximate match/i);
    });

    it("collapses the whitespace of a passage onto one line", () => {
        const text = formatForAssistant("x", [
            hit({ content: "line one\n\n   line two\t\tword" }),
        ]);
        expect(text).toContain("line one line two word");
    });

    it("keeps two documents apart", () => {
        const text = formatForAssistant("summons", [
            hit({ documentId: "a", filename: "A.pdf" }),
            hit({ documentId: "b", filename: "B.pdf" }),
        ]);
        expect(text).toContain("A.pdf:");
        expect(text).toContain("B.pdf:");
    });
});
