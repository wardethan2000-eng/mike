import { describe, it, expect } from "vitest";
import {
    asksForCitationCheck,
    buildChecklistNote,
    coveredAuthorityKeys,
    extractAuthorities,
    isCovered,
    latestRequestText,
    newAuthorityChecklistState,
    recordDocumentAuthorities,
} from "../chat/authorityChecklist";

// A memo of the shape this feature exists for: a handful of cases and
// statutes cited in running prose, some repeated.
const MEMO = `
MEMORANDUM

Under K.S.A. 60-206(a), the time is computed from the day after the event.
See also K.S.A. § 60-1507, which the court applied in Brown v. Board,
347 U.S. 483 (1954), and again in State v. Smith, 284 Kan. 402 (2007).
The federal standard comes from Ashcroft v. Iqbal, 556 U.S. 662 (2009) and
Bell Atlantic Corp. v. Twombly, 550 U.S. 544 (2007). Missouri's counterpart
is § 407.020, RSMo, discussed in Doe v. Roe, 999 S.W.2d 1 (Mo. 1999).
A related decision is Kansas v. Jones, 12 P.3d 345 (Kan. 2000).
K.S.A. 60-206(a) is cited a second time here and must not count twice.
`;

describe("extractAuthorities", () => {
    it("finds every case and statute in a memo, once each", () => {
        const found = extractAuthorities(MEMO);
        const displays = found.map((a) => a.display);
        expect(displays).toContain("347 U.S. 483");
        expect(displays).toContain("556 U.S. 662");
        expect(displays).toContain("550 U.S. 544");
        expect(displays).toContain("284 Kan. 402");
        expect(displays).toContain("12 P.3d 345");
        expect(displays).toContain("K.S.A. 60-206(a)");
        expect(displays).toContain("K.S.A. § 60-1507");
        expect(displays.some((d) => d.includes("407.020"))).toBe(true);
        // Repeated citations collapse to one entry.
        expect(displays.filter((d) => d.startsWith("K.S.A. 60-206")).length).toBe(1);
        expect(found.length).toBeGreaterThanOrEqual(8);
    });

    it("returns nothing for text with no authorities", () => {
        expect(extractAuthorities("Please send the signed contract by Friday.")).toEqual([]);
        expect(extractAuthorities("")).toEqual([]);
    });

    it("matches a statute however it is written", () => {
        const covered = coveredAuthorityKeys({
            caseCitations: [],
            legislationIds: ["K.S.A. 60-206", "60-206", "RSMO 407.020", "407.020"],
        });
        const [ksa] = extractAuthorities("K.S.A. § 60-206(a)");
        expect(isCovered(ksa, covered)).toBe(true);
        const [rsmo] = extractAuthorities("§ 407.020, RSMo");
        expect(isCovered(rsmo, covered)).toBe(true);
        const [other] = extractAuthorities("K.S.A. 58-2540");
        expect(isCovered(other, covered)).toBe(false);
    });

    it("counts a pulled case as covered by any of its citations", () => {
        const covered = coveredAuthorityKeys({
            caseCitations: ["347 U.S. 483", "74 S. Ct. 686"],
            legislationIds: [],
        });
        const [brown] = extractAuthorities("Brown v. Board, 347 U.S. 483 (1954)");
        expect(isCovered(brown, covered)).toBe(true);
    });
});

describe("asksForCitationCheck", () => {
    it("fires on a request to check a document's citations", () => {
        expect(
            asksForCitationCheck(
                "review the attached memo, pull all the cases and statutes, check them for accuracy",
            ),
        ).toBe(true);
        expect(asksForCitationCheck("Please verify the citations in this brief.")).toBe(true);
        expect(asksForCitationCheck("Are these authorities accurate?")).toBe(true);
    });

    it("stays quiet on drafting and summarising", () => {
        expect(asksForCitationCheck("Draft a demand letter for the Graver matter.")).toBe(false);
        expect(asksForCitationCheck("Summarise the deposition transcript.")).toBe(false);
        expect(asksForCitationCheck("What cases discuss adverse possession in Kansas?")).toBe(false);
        expect(asksForCitationCheck("")).toBe(false);
    });
});

describe("latestRequestText", () => {
    it("skips a continuation message and uses the real request", () => {
        expect(
            latestRequestText([
                "Check the citations in the memo.",
                "Keep going",
            ]),
        ).toBe("Check the citations in the memo.");
        expect(
            latestRequestText([
                "Check the citations in the memo.",
                "Carry on from those notes. You have a fresh budget of research steps.",
            ]),
        ).toBe("Check the citations in the memo.");
    });

    it("uses the last message when it is a real request", () => {
        expect(latestRequestText(["Hello", "Draft a letter."])).toBe("Draft a letter.");
        expect(latestRequestText([])).toBe("");
    });
});

describe("the checklist note", () => {
    const stateWithMemo = () => {
        const state = newAuthorityChecklistState();
        recordDocumentAuthorities(state, "Graver memo.docx", MEMO);
        return state;
    };

    it("says nothing when every authority was pulled", () => {
        const state = stateWithMemo();
        const all = [...state.byDocument.values()].flatMap((d) => d.authorities);
        const covered = new Set(all.flatMap((a) => a.keys));
        expect(buildChecklistNote({ state, covered })).toBeNull();
    });

    it("names the authorities that were left unchecked", () => {
        const state = stateWithMemo();
        const covered = coveredAuthorityKeys({
            caseCitations: ["347 U.S. 483", "556 U.S. 662"],
            legislationIds: [],
        });
        const note = buildChecklistNote({ state, covered });
        expect(note).toBeTruthy();
        expect(note).toContain("Graver memo.docx");
        expect(note).toContain("2 of");
        expect(note).toContain("550 U.S. 544");
        expect(note).not.toContain("347 U.S. 483");
    });

    it("caps a long list and counts the rest", () => {
        const state = newAuthorityChecklistState();
        const many = Array.from(
            { length: 12 },
            (_, i) => `Case ${i} v. State, ${100 + i} U.S. ${200 + i} (1990).`,
        ).join("\n");
        recordDocumentAuthorities(state, "long.pdf", many);
        const note = buildChecklistNote({ state, covered: new Set<string>() });
        expect(note).toContain("0 of 12 authorities");
        expect(note).toContain("and 4 more");
    });

    it("does not repeat what the answer's own diligence note already named", () => {
        const state = stateWithMemo();
        const covered = coveredAuthorityKeys({
            caseCitations: ["347 U.S. 483"],
            legislationIds: [],
        });
        const all = [...state.byDocument.values()].flatMap((d) => d.authorities);
        const everythingMissing = new Set(
            all.filter((a) => !isCovered(a, covered)).flatMap((a) => a.keys),
        );
        // The diligence note named every outstanding authority, so there is
        // nothing left for the checklist to add.
        expect(
            buildChecklistNote({ state, covered, alreadyReported: everythingMissing }),
        ).toBeNull();
    });

    it("names only the authorities the answer never mentioned", () => {
        const state = stateWithMemo();
        const covered = coveredAuthorityKeys({
            caseCitations: ["347 U.S. 483"],
            legislationIds: [],
        });
        const [twombly] = extractAuthorities("550 U.S. 544");
        const note = buildChecklistNote({
            state,
            covered,
            alreadyReported: new Set(twombly.keys),
        });
        expect(note).toBeTruthy();
        expect(note).toContain("Also not yet checked");
        expect(note).not.toContain("550 U.S. 544");
        expect(note).toContain("556 U.S. 662");
    });

    it("says nothing for a document with only a stray citation", () => {
        const state = newAuthorityChecklistState();
        recordDocumentAuthorities(state, "letter.docx", "See 410 U.S. 113.");
        expect(buildChecklistNote({ state, covered: new Set<string>() })).toBeNull();
    });

    it("does not double-count a document read twice", () => {
        const state = newAuthorityChecklistState();
        recordDocumentAuthorities(state, "memo.docx", MEMO);
        recordDocumentAuthorities(state, "memo.docx", MEMO);
        expect(state.byDocument.size).toBe(1);
    });
});
