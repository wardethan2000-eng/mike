import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Opening one of the firm's banked documents from inside a chat.
//
// The stand-in database here actually applies the filters the code asks for,
// so a test can prove that a draft entry, or another firm's entry, really is
// out of reach rather than merely not seeded.
// ---------------------------------------------------------------------------

import { runToolCalls } from "../chat/tools/toolDispatcher";
import { FORM_BANK_TOOLS } from "../chat/tools/toolSchemas";
import { clearFirmCaches } from "../firm";
import type { DocIndex, DocStore } from "../chat/types";

type Row = Record<string, unknown>;

const FIRM = "firm-1";

const PRECEDENT: Row = {
    id: "form-1",
    firm_id: FIRM,
    document_id: "doc-a",
    title: "Operating agreement — two members",
    document_type: "operating-agreement",
    usage_mode: "precedent",
    variant_notes: "member-managed, two individual members",
    practice: "Business",
    jurisdictions: ["Kansas"],
    description: null,
    drafting_guidance: "Paragraph 12 is the firm's standard wording.",
    required_fields: [],
    status: "approved",
    created_by: null,
};

const SIBLING: Row = {
    ...PRECEDENT,
    id: "form-2",
    document_id: "doc-b",
    title: "Operating agreement — manager-managed",
    variant_notes: "manager-managed, one entity member",
};

const DRAFT: Row = {
    ...PRECEDENT,
    id: "form-3",
    document_id: "doc-c",
    title: "Operating agreement — not written up yet",
    status: "draft",
};

/** A table that honours the eq/in filters the code puts on it. */
function table(rows: Row[]) {
    const build = (current: Row[]) => {
        const q: Record<string, unknown> = {
            select: () => build(current),
            order: () => build(current),
            limit: (n: number) => build(current.slice(0, n)),
            or: () => build(current),
            eq: (column: string, value: unknown) =>
                build(current.filter((row) => row[column] === value)),
            is: (column: string, value: unknown) =>
                build(current.filter((row) => (row[column] ?? null) === value)),
            in: (column: string, values: unknown[]) =>
                build(current.filter((row) => values.includes(row[column]))),
            insert: () => build(current),
            single: () =>
                Promise.resolve({ data: current[0] ?? null, error: null }),
            maybeSingle: () =>
                Promise.resolve({ data: current[0] ?? null, error: null }),
            then: (
                resolve: (value: unknown) => unknown,
                reject?: (error: unknown) => unknown,
            ) =>
                Promise.resolve({ data: current, error: null }).then(
                    resolve,
                    reject,
                ),
        };
        return q;
    };
    return build(rows);
}

function makeDb(options: { status?: string } = {}) {
    const audits: Row[] = [];
    const db = {
        from(name: string) {
            if (name === "firm_members") {
                return table([
                    {
                        firm_id: FIRM,
                        user_id: "u1",
                        role: "attorney",
                        status: options.status ?? "active",
                        can_edit_firm_library: false,
                    },
                ]);
            }
            if (name === "firm_forms") return table([PRECEDENT, SIBLING, DRAFT]);
            if (name === "documents") {
                return table([
                    { id: "doc-a", current_version_id: "v-a" },
                    { id: "doc-b", current_version_id: "v-b" },
                ]);
            }
            if (name === "document_versions") {
                return table([
                    {
                        id: "v-a",
                        document_id: "doc-a",
                        storage_path: "firm-library/doc-a/source.docx",
                        pdf_storage_path: null,
                        version_number: 1,
                        filename: "Operating Agreement (2 members).docx",
                        source: "upload",
                        file_type: "docx",
                        size_bytes: 10,
                        page_count: 3,
                        deleted_at: null,
                    },
                ]);
            }
            if (name === "audit_events") {
                return {
                    insert: (payload: Row) => {
                        audits.push(payload);
                        return Promise.resolve({ data: null, error: null });
                    },
                };
            }
            throw new Error(`Unexpected table: ${name}`);
        },
    };
    return { db, audits };
}

function call(name: string, args: Record<string, unknown>) {
    return [
        {
            id: "call-1",
            type: "function" as const,
            function: { name, arguments: JSON.stringify(args) },
        },
    ];
}

async function run(
    name: string,
    args: Record<string, unknown>,
    options: { status?: string } = {},
) {
    const { db, audits } = makeDb(options);
    const docStore: DocStore = new Map();
    const docIndex: DocIndex = {};
    const result = await runToolCalls(
        call(name, args) as never,
        docStore,
        "u1",
        db as never,
        () => {},
        undefined,
        undefined,
        docIndex,
    );
    const payload = JSON.parse(
        (result.toolResults[0] as { content: string }).content,
    );
    return { payload, docStore, docIndex, audits };
}

describe("the form bank tools", () => {
    beforeEach(() => {
        clearFirmCaches();
        vi.clearAllMocks();
    });

    it("are offered to every chat", () => {
        expect(FORM_BANK_TOOLS.map((tool) => tool.function.name)).toEqual([
            "open_firm_form",
            "find_firm_form",
        ]);
    });

    describe("comparing versions", () => {
        it("returns every approved version of one kind without opening any", async () => {
            const { payload, docStore } = await run("open_firm_form", {
                document_type: "operating-agreement",
            });
            expect(payload.ok).toBe(true);
            expect(payload.forms.map((form: Row) => form.form_id)).toEqual([
                "form-1",
                "form-2",
            ]);
            // Nothing was loaded — comparing is meant to be cheap.
            expect(docStore.size).toBe(0);
        });

        it("never offers one that has not been approved", async () => {
            const { payload } = await run("open_firm_form", {
                document_type: "operating-agreement",
            });
            expect(
                payload.forms.some((form: Row) => form.form_id === "form-3"),
            ).toBe(false);
        });

        it("says so when the firm banks nothing of that kind", async () => {
            const { payload } = await run("open_firm_form", {
                document_type: "lease",
            });
            expect(payload.ok).toBe(false);
        });

        it("asks for one of the two things it needs", async () => {
            const { payload } = await run("open_firm_form", {});
            expect(payload.ok).toBe(false);
        });
    });

    describe("opening one", () => {
        it("makes the document available and hands over the firm's notes", async () => {
            const { payload, docStore, docIndex } = await run("open_firm_form", {
                form_id: "form-1",
            });
            expect(payload.ok).toBe(true);
            expect(payload.title).toBe("Operating agreement — two members");
            expect(payload.drafting_guidance).toContain("standard wording");
            expect(docIndex[payload.doc_id].document_id).toBe("doc-a");
            expect(docStore.get(payload.doc_id)?.filename).toBe(
                "Operating Agreement (2 members).docx",
            );
        });

        it("marks it as one of the firm's own, which must be copied first", async () => {
            const { payload, docStore } = await run("open_firm_form", {
                form_id: "form-1",
            });
            expect(docStore.get(payload.doc_id)?.source_kind).toBe(
                "library_template",
            );
            expect(payload.next_step).toContain("replicate_document");
        });

        it("records that one of the firm's documents was used", async () => {
            const { audits } = await run("open_firm_form", {
                form_id: "form-1",
            });
            expect(audits[0]).toMatchObject({
                action: "form_used",
                document_id: "doc-a",
            });
        });

        it("will not open one that has not been approved", async () => {
            const { payload, docStore } = await run("open_firm_form", {
                form_id: "form-3",
            });
            expect(payload.ok).toBe(false);
            expect(docStore.size).toBe(0);
        });

        it("gives somebody who has left the firm nothing", async () => {
            const { payload, docStore } = await run(
                "open_firm_form",
                { form_id: "form-1" },
                { status: "deactivated" },
            );
            expect(payload.ok).toBe(false);
            expect(docStore.size).toBe(0);
        });
    });

    describe("searching", () => {
        it("turns away somebody who has left the firm", async () => {
            const { payload } = await run(
                "find_firm_form",
                { query: "operating" },
                { status: "deactivated" },
            );
            expect(payload.ok).toBe(false);
        });

        it("returns notes only, never a document", async () => {
            const { payload, docStore } = await run("find_firm_form", {
                query: "operating",
            });
            expect(payload.ok).toBe(true);
            expect(docStore.size).toBe(0);
        });
    });
});
