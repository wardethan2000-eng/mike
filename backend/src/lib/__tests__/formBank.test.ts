import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// The notes the firm keeps about its own model documents, and the short list
// of them that goes into every chat.
// ---------------------------------------------------------------------------

import {
    CATALOGUE_LIMIT,
    documentTypeLabel,
    formBankCatalogue,
    formMetadataForModel,
    groupFormsByType,
    normalizeDocumentType,
    normalizeJurisdictions,
    normalizeRequiredFields,
    rowToForm,
    type FirmForm,
} from "../formBank";

function form(overrides: Partial<FirmForm> = {}): FirmForm {
    return {
        id: "form-1",
        firm_id: "firm-1",
        document_id: "doc-1",
        title: "Operating agreement — two members",
        document_type: "operating-agreement",
        usage_mode: "precedent",
        variant_notes: "member-managed, two individual members, Kansas",
        practice: "Business",
        jurisdictions: ["Kansas"],
        description: null,
        drafting_guidance: null,
        required_fields: [],
        status: "approved",
        created_by: null,
        ...overrides,
    };
}

describe("what kind of document an entry is", () => {
    it("treats the same kind written two ways as one kind", () => {
        expect(normalizeDocumentType("Operating Agreement")).toBe(
            "operating-agreement",
        );
        expect(normalizeDocumentType("operating   agreement ")).toBe(
            "operating-agreement",
        );
    });

    it("refuses a name with nothing in it", () => {
        expect(normalizeDocumentType("   ")).toBeNull();
        expect(normalizeDocumentType(42)).toBeNull();
    });

    it("reads back as words for a heading", () => {
        expect(documentTypeLabel("operating-agreement")).toBe(
            "Operating agreement",
        );
    });
});

describe("where a document is written for", () => {
    it("keeps each place once", () => {
        expect(normalizeJurisdictions(["Kansas", "kansas", "Missouri"])).toEqual(
            ["Kansas", "Missouri"],
        );
    });

    it("drops anything that is not a place", () => {
        expect(normalizeJurisdictions(["Kansas", 7, "", null])).toEqual([
            "Kansas",
        ]);
    });
});

describe("the blanks on a fill-in form", () => {
    it("gives every blank a name of its own", () => {
        const fields = normalizeRequiredFields([
            { label: "Client full name", source: "matter" },
            { label: "Flat fee", source: "ask", hint: "Agreed at the meeting" },
        ]);
        expect(fields.map((field) => field.key)).toEqual([
            "client_full_name",
            "flat_fee",
        ]);
        expect(fields[1].hint).toBe("Agreed at the meeting");
    });

    it("falls back to asking when the source makes no sense", () => {
        const fields = normalizeRequiredFields([
            { label: "Fee", source: "guess" },
        ]);
        expect(fields[0].source).toBe("ask");
    });

    it("drops a blank with no label, because nobody could answer it", () => {
        expect(normalizeRequiredFields([{ source: "matter" }])).toEqual([]);
    });

    it("keeps one blank when the same one is listed twice", () => {
        const fields = normalizeRequiredFields([
            { label: "Client name" },
            { label: "Client Name" },
        ]);
        expect(fields).toHaveLength(1);
    });
});

describe("reading a saved entry", () => {
    it("falls back to safe values when the row is odd", () => {
        const read = rowToForm({
            id: "f1",
            firm_id: "firm-1",
            document_id: "d1",
            title: "Engagement letter",
            document_type: "engagement-letter",
            usage_mode: "something-else",
            status: "something-else",
            required_fields: "not a list",
        });
        expect(read.usage_mode).toBe("precedent");
        expect(read.status).toBe("draft");
        expect(read.required_fields).toEqual([]);
    });
});

describe("the list of banked documents sent to Mike", () => {
    it("says nothing at all when the firm banks nothing", () => {
        expect(formBankCatalogue([])).toBe("");
    });

    it("puts several versions of one kind together and counts them", () => {
        const catalogue = formBankCatalogue([
            form({ id: "a", title: "Two members" }),
            form({ id: "b", title: "Manager-managed" }),
        ]);
        expect(catalogue).toContain("the firm keeps 2 versions");
        expect(catalogue).toContain("Two members");
        expect(catalogue).toContain("Manager-managed");
    });

    it("does not count when there is only one of a kind", () => {
        const catalogue = formBankCatalogue([form()]);
        expect(catalogue).toContain("Operating agreement:");
        expect(catalogue).not.toContain("the firm keeps 1 version");
    });

    it("gives Mike each entry's id, so it can open one", () => {
        expect(formBankCatalogue([form({ id: "abc-123" })])).toContain(
            "id abc-123",
        );
    });

    it("says which are precedents and which are fill-in forms", () => {
        const catalogue = formBankCatalogue([
            form({ id: "a" }),
            form({
                id: "b",
                document_type: "engagement-letter",
                usage_mode: "fill",
                title: "Engagement letter",
            }),
        ]);
        expect(catalogue).toContain("precedent");
        expect(catalogue).toContain("fill-in form");
    });

    it("carries the drafting rules for both kinds", () => {
        const catalogue = formBankCatalogue([form()]);
        expect(catalogue).toContain("WHEN THE ENTRY IS A PRECEDENT");
        expect(catalogue).toContain("WHEN THE ENTRY IS A FILL-IN FORM");
    });

    it("stops at a sensible length and says to search instead", () => {
        const many = Array.from({ length: CATALOGUE_LIMIT + 10 }, (_, index) =>
            form({
                id: `form-${index}`,
                title: `Version ${index}`,
                document_type: `kind-${index}`,
            }),
        );
        const catalogue = formBankCatalogue(many);
        expect(catalogue).toContain("find_firm_form");
        expect(catalogue).toContain("Version 0");
        expect(catalogue).not.toContain("Version 59");
    });
});

describe("grouping", () => {
    it("keeps each kind's versions in one group", () => {
        const groups = groupFormsByType([
            form({ id: "a" }),
            form({ id: "b", document_type: "engagement-letter" }),
            form({ id: "c" }),
        ]);
        expect(groups.get("operating-agreement")).toHaveLength(2);
        expect(groups.get("engagement-letter")).toHaveLength(1);
    });
});

describe("the notes handed back when an entry is opened", () => {
    it("leaves the blanks out of a precedent, which has none", () => {
        const notes = formMetadataForModel(form());
        expect(notes.required_fields).toBeUndefined();
        expect(notes.usage_mode).toBe("precedent");
    });

    it("includes the blanks on a fill-in form", () => {
        const notes = formMetadataForModel(
            form({
                usage_mode: "fill",
                required_fields: [
                    { key: "fee", label: "Flat fee", source: "ask" },
                ],
            }),
        );
        expect(notes.required_fields).toHaveLength(1);
    });
});
