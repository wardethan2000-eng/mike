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

    it("picks the passage the answer actually quoted, not the first one", () => {
        const found = linkAnswerCitations(
            'The letter says "All three sets were served via first-class mail and electronic mail on July 17, 2026." (Golden Rule Letter.docx)',
            [
                hit({
                    documentId: "doc-9",
                    filename: "Golden Rule Letter.docx",
                    page: null,
                    content:
                        "the party whose conduct necessitated the motion must pay the reasonable expenses, including attorney fees.",
                }),
                hit({
                    documentId: "doc-9",
                    filename: "Golden Rule Letter.docx",
                    page: null,
                    content:
                        "All three sets were served via first-class mail and electronic mail on July 17, 2026. Despite the passage of the statutory response deadlines, no responses have been received.",
                }),
            ],
        );
        expect(found).toHaveLength(1);
        // The words the answer quoted are what gets marked in the document.
        expect(found[0].quote).toBe(
            "All three sets were served via first-class mail and electronic mail on July 17, 2026.",
        );
    });

    it("uses the words around the citation when nothing was quoted", () => {
        const found = linkAnswerCitations(
            "The pretrial conference is scheduled before Judge Commer in Division 28 (Golden Rule Letter.docx).",
            [
                hit({
                    documentId: "doc-9",
                    filename: "Golden Rule Letter.docx",
                    page: null,
                    content: "All three sets were served via first-class mail.",
                }),
                hit({
                    documentId: "doc-9",
                    filename: "Golden Rule Letter.docx",
                    page: null,
                    content:
                        "The upcoming Pretrial Conference is scheduled for August 27, 2026, before Judge Commer in Division 28.",
                }),
            ],
        );
        expect(found[0].quote).toContain("Judge Commer");
    });

    it("marks the sentence that carries the fact, not the whole letter", () => {
        const found = linkAnswerCitations(
            "Discovery was served on July 17, 2026 (Golden Rule Letter.docx).",
            [
                hit({
                    documentId: "doc-9",
                    filename: "Golden Rule Letter.docx",
                    page: null,
                    content:
                        "This letter is a good faith attempt to obtain responses from Plaintiff before seeking the Court's intervention. If Plaintiff chooses not to respond, we will file a motion to compel and ask the Court to intervene, including an award of reasonable expenses caused by the failure to respond to the discovery requests.",
                }),
                hit({
                    documentId: "doc-9",
                    filename: "Golden Rule Letter.docx",
                    page: null,
                    content:
                        "Ms. Hartung, On July 17, 2026, Defendant Amani LLC served three sets of discovery requests upon you as counsel for Plaintiff. All three sets were served by first-class mail and electronic mail.",
                }),
            ],
        );
        expect(found).toHaveLength(1);
        expect(found[0].quote).toContain(
            "On July 17, 2026, Defendant Amani LLC served three sets of discovery requests",
        );
        // Not the paragraph about motions to compel further down the letter.
        expect(found[0].quote).not.toContain("motion to compel");
    });

    it("returns nothing when there are no passages", () => {
        expect(linkAnswerCitations("Anything (Lease.pdf, page 1).", [])).toEqual([]);
    });
});
