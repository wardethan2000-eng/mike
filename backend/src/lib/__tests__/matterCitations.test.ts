import { describe, expect, it } from "vitest";
import { linkAnswerCitations } from "../matterCitations";
import type { MatterSearchHit } from "../matterSearch";

const hit = (over: Partial<MatterSearchHit> = {}): MatterSearchHit => ({
    documentId: "doc-1",
    filename: "Hamilton Lease.pdf",
    page: 4,
    content: "Rent is payable on the first day of each month.",
    fromOcr: false,
    fromFilename: false,
    matchedBy: "words",
    rank: 0.5,
    ...over,
});

describe("linkAnswerCitations", () => {
    it("ties a citation back to the passage it came from", () => {
        const found = linkAnswerCitations(
            "Rent falls due monthly (Hamilton Lease.pdf, page 4).",
            [hit()],
        );
        expect(found).toEqual([
            {
                text: "Hamilton Lease.pdf, page 4",
                documentId: "doc-1",
                filename: "Hamilton Lease.pdf",
                page: 4,
                quote: "Rent is payable on the first day of each month.",
            },
        ]);
    });

    it("picks the passage on the page that was cited", () => {
        const found = linkAnswerCitations("See (Hamilton Lease.pdf, page 9).", [
            hit(),
            hit({ page: 9, content: "The tenant may not sublet." }),
        ]);
        expect(found[0].quote).toBe("The tenant may not sublet.");
    });

    it("reads several citations inside one bracket", () => {
        const found = linkAnswerCitations(
            "Both agree (Hamilton Lease.pdf, page 4; Notice.pdf, page 2).",
            [hit(), hit({ documentId: "doc-2", filename: "Notice.pdf", page: 2 })],
        );
        expect(found.map((c) => c.documentId)).toEqual(["doc-1", "doc-2"]);
        expect(found[1].text).toBe("Notice.pdf, page 2");
    });

    it("still matches when the file extension is left off", () => {
        const found = linkAnswerCitations("As set out (Hamilton Lease, p. 4).", [
            hit(),
        ]);
        expect(found).toHaveLength(1);
        expect(found[0].documentId).toBe("doc-1");
    });

    it("handles a citation with no page", () => {
        const found = linkAnswerCitations("It is signed (Hamilton Lease.pdf).", [
            hit({ page: null }),
        ]);
        expect(found[0].page).toBeNull();
    });

    it("leaves ordinary brackets alone", () => {
        expect(
            linkAnswerCitations("The rent (which is monthly) is due.", [hit()]),
        ).toEqual([]);
    });

    it("returns nothing when there are no passages", () => {
        expect(linkAnswerCitations("Anything (Lease.pdf, page 1).", [])).toEqual([]);
    });
});
