import { describe, expect, it } from "vitest";
import {
    attorneyContextSection,
    normalizeBarAdmissions,
    EMPTY_PROFESSIONAL_DETAILS,
    type ProfessionalDetails,
} from "../draftingContext";

function details(overrides: Partial<ProfessionalDetails>): ProfessionalDetails {
    return { ...EMPTY_PROFESSIONAL_DETAILS, ...overrides };
}

describe("bar admissions", () => {
    it("keeps the states and numbers that are actually filled in", () => {
        expect(
            normalizeBarAdmissions([
                { state: " Kansas ", bar_number: " 12345 " },
                { state: "Missouri", bar_number: "67890", status: "inactive" },
            ]),
        ).toEqual([
            { state: "Kansas", bar_number: "12345" },
            { state: "Missouri", bar_number: "67890", status: "inactive" },
        ]);
    });

    it("drops half-filled rows rather than passing on a number with no state", () => {
        expect(
            normalizeBarAdmissions([
                { state: "Kansas" },
                { bar_number: "12345" },
                { state: "", bar_number: "" },
                "nonsense",
                null,
            ]),
        ).toEqual([]);
    });

    it("treats anything that is not a list as nothing", () => {
        expect(normalizeBarAdmissions(undefined)).toEqual([]);
        expect(normalizeBarAdmissions({ state: "Kansas" })).toEqual([]);
    });
});

describe("what the model is told about the person asking", () => {
    it("says nothing at all when nothing has been filled in", () => {
        expect(
            attorneyContextSection({ displayName: null }, EMPTY_PROFESSIONAL_DETAILS),
        ).toBe("");
    });

    it("gives the name with the title, and every admission", () => {
        const section = attorneyContextSection(
            { displayName: "Jane Roe", email: "jane@example.com" },
            details({
                prof_title: "Partner",
                prof_phone: "555-0100",
                bar_admissions: [
                    { state: "Kansas", bar_number: "12345" },
                    {
                        state: "Missouri",
                        bar_number: "67890",
                        status: "inactive",
                    },
                ],
            }),
        );
        expect(section).toContain("Name: Jane Roe, Partner");
        expect(section).toContain("Kansas #12345");
        expect(section).toContain("Missouri #67890 (inactive)");
        expect(section).toContain("555-0100");
        expect(section).toContain("jane@example.com");
    });

    it("reproduces a signature block verbatim, newlines and all", () => {
        const block = "Jane Roe\nRoe & Co.\n123 Main St\nTopeka, KS 66601";
        const section = attorneyContextSection(
            { displayName: "Jane Roe" },
            details({ signature_block: block }),
        );
        expect(section).toContain(block);
    });

    it("forbids inventing a bar number", () => {
        const section = attorneyContextSection(
            { displayName: "Jane Roe" },
            details({ bar_admissions: [{ state: "Kansas", bar_number: "1" }] }),
        );
        expect(section).toMatch(/[Nn]ever invent a bar number/);
    });

    it("gives a paralegal a signature block but no bar line", () => {
        const section = attorneyContextSection(
            { displayName: "Sam Clerk" },
            details({
                prof_title: "Paralegal",
                signature_block: "Sam Clerk\nParalegal",
            }),
        );
        expect(section).toContain("Name: Sam Clerk, Paralegal");
        expect(section).not.toContain("Admitted to practise");
    });
});
