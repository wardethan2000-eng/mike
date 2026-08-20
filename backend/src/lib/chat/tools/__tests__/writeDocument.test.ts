import { describe, it, expect, beforeEach, vi } from "vitest";
import JSZip from "jszip";

const uploads = new Map<string, Buffer>();
let sourceBytes: Buffer;

vi.mock("../../../storage", () => ({
    uploadFile: vi.fn(async (key: string, body: ArrayBuffer | Buffer) => {
        uploads.set(key, Buffer.from(body as ArrayBuffer));
    }),
    downloadFile: vi.fn(async () => sourceBytes),
    generatedDocKey: (userId: string, id: string) => `generated/${userId}/${id}`,
}));

vi.mock("../../../downloadTokens", () => ({
    buildDownloadUrl: (path: string) => `/download/${path}`,
}));

import {
    runWriteDocument,
    inlineEditRuns,
    redlineEditsForRewrite,
    writeBlockToParagraph,
} from "../documentOps";
import { extractDocxBodyParagraphs } from "../../../docxTrackedChanges";

const W_NS =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

const para = (text: string) =>
    `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;

async function makeDocx(bodyXml: string): Promise<Buffer> {
    const zip = new JSZip();
    zip.file(
        "word/document.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
            `<w:document ${W_NS}><w:body>${bodyXml}</w:body></w:document>`,
    );
    return zip.generateAsync({ type: "nodebuffer" });
}

type Row = Record<string, unknown>;

function makeDb(tables: Record<string, Row[]>) {
    const db = {
        from(table: string) {
            let rows = [...(tables[table] ?? [])];
            const query: any = {
                select: () => query,
                eq: (column: string, value: unknown) => {
                    rows = rows.filter((row) => row[column] === value);
                    return query;
                },
                is: (column: string, value: unknown) => {
                    rows = rows.filter((row) => (row[column] ?? null) === value);
                    return query;
                },
                in: (column: string, values: unknown[]) => {
                    rows = rows.filter((row) => values.includes(row[column]));
                    return query;
                },
                order: () => query,
                limit: () => query,
                single: async () => ({ data: rows[0] ?? null, error: null }),
                maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
                insert: (payload: Row | Row[]) => {
                    const list = Array.isArray(payload) ? payload : [payload];
                    const stored = list.map((r, i) => ({
                        id: `${table}-new-${i}`,
                        ...r,
                    }));
                    tables[table] = [...(tables[table] ?? []), ...stored];
                    rows = stored;
                    return query;
                },
                update: (patch: Row) => {
                    rows.forEach((row) => Object.assign(row, patch));
                    return query;
                },
                then: (
                    resolve: (value: { data: Row[]; error: null }) => unknown,
                    reject?: (reason: unknown) => unknown,
                ) =>
                    Promise.resolve({ data: rows, error: null }).then(
                        resolve,
                        reject,
                    ),
            };
            return query;
        },
    };
    return db as any;
}

function fixtureTables() {
    return {
        documents: [
            { id: "doc-1", is_replica: true, current_version_id: "ver-1" },
        ],
        document_versions: [
            {
                id: "ver-1",
                document_id: "doc-1",
                storage_path: "documents/u/doc-1/source.docx",
                pdf_storage_path: null,
                source: "upload",
                version_number: 1,
                filename: "Agreement.docx",
                file_type: "docx",
                deleted_at: null,
            },
        ],
        document_edits: [],
    };
}

beforeEach(async () => {
    uploads.clear();
    sourceBytes = await makeDocx(
        para("SERVICES AGREEMENT") +
            para("Cooks Guttering & Repairs LLC") +
            para("Cooks will clean the gutters.") +
            para("Signed: ____________"),
    );
});

describe("inlineEditRuns", () => {
    it("turns the inline markers into runs", () => {
        expect(inlineEditRuns("**Scope.** Central will spray *foam*.")).toEqual([
            { text: "Scope.", bold: true },
            { text: " Central will spray " },
            { text: "foam", italic: true },
            { text: "." },
        ]);
    });

    it("leaves a plain line as one run", () => {
        expect(inlineEditRuns("Plain line.")).toEqual([{ text: "Plain line." }]);
    });
});

describe("runWriteDocument", () => {
    it("writes the whole document in one call", async () => {
        const db = makeDb(fixtureTables());
        const result = await runWriteDocument({
            documentId: "doc-1",
            userId: "user-1",
            paragraphs: [
                "SERVICES AGREEMENT",
                "Central Spray Foam and Cement Lifting, LLC",
                "Central will install spray foam insulation.",
                "Signed: ____________",
            ],
            db,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.paragraph_count).toBe(4);
        expect(result.version_number).toBe(2);

        const saved = uploads.get(result.storage_path)!;
        await expect(extractDocxBodyParagraphs(saved)).resolves.toEqual([
            "SERVICES AGREEMENT",
            "Central Spray Foam and Cement Lifting, LLC",
            "Central will install spray foam insulation.",
            "Signed: ____________",
        ]);
        // Nothing to accept or reject: the document is simply written.
        const xml = await (await JSZip.loadAsync(saved))
            .file("word/document.xml")!
            .async("string");
        expect(xml).not.toMatch(/<w:ins|<w:del/);
    });

    it("keeps a table's text inside its table", async () => {
        sourceBytes = await makeDocx(
            para("Exhibit A") +
                `<w:tbl><w:tr><w:tc>${para("Materials")}</w:tc><w:tc>${para("Price")}</w:tc></w:tr></w:tbl>` +
                para("End of exhibit."),
        );
        const db = makeDb(fixtureTables());
        const result = await runWriteDocument({
            documentId: "doc-1",
            userId: "user-1",
            paragraphs: ["Exhibit A", "Foam type", "Price", "End of exhibit."],
            db,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const saved = uploads.get(result.storage_path)!;
        await expect(extractDocxBodyParagraphs(saved)).resolves.toEqual([
            "Exhibit A",
            "Foam type",
            "Price",
            "End of exhibit.",
        ]);
    });

    it("keeps the document's own clause numbering and headings", async () => {
        const numbered =
            '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>' +
            '<w:r><w:t xml:space="preserve">Terms</w:t></w:r></w:p>' +
            '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr></w:pPr>' +
            '<w:r><w:t xml:space="preserve">Cooks will clean the gutters.</w:t></w:r></w:p>';
        sourceBytes = await makeDocx(numbered);
        const db = makeDb(fixtureTables());

        const result = await runWriteDocument({
            documentId: "doc-1",
            userId: "user-1",
            paragraphs: ["Terms", "Central will install spray foam."],
            db,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const xml = await (
            await JSZip.loadAsync(uploads.get(result.storage_path)!)
        )
            .file("word/document.xml")!
            .async("string");
        // The rewritten clause is still numbered, and the heading is still a
        // heading — the writer supplies words, not layout.
        expect(xml).toMatch(/<w:numId w:val="3"/);
        expect(xml).toMatch(/Heading1/);
        expect(xml).toContain("Central will install spray foam.");
    });

    it("refuses an empty document", async () => {
        const db = makeDb(fixtureTables());
        const result = await runWriteDocument({
            documentId: "doc-1",
            userId: "user-1",
            paragraphs: [],
            db,
        });
        expect(result.ok).toBe(false);
    });
});

describe("writeBlockToParagraph", () => {
    it("keeps a plain line's look by saying nothing about it", () => {
        const p = writeBlockToParagraph("Scope of Work.");
        expect(p.heading).toBeUndefined();
        expect(p.list).toBeUndefined();
        expect(p.align).toBeUndefined();
    });

    it("carries the structure asked for", () => {
        const p = writeBlockToParagraph({
            text: "Signed: ______",
            list: "none",
            style: "none",
            align: "right",
            page_break: true,
        });
        expect(p).toMatchObject({
            list: null,
            heading: null,
            align: "right",
            pageBreak: true,
        });
    });

    it("passes a table through", () => {
        const p = writeBlockToParagraph({
            table: { rows: [["Item", "Price"], ["Foam", "$1"]] },
        });
        expect(p.table?.rows).toHaveLength(2);
    });
});

describe("redlineEditsForRewrite", () => {
    const baseline = ["Scope of Work.", "Payment.", "Warranty."];

    it("turns a reworded paragraph into one substitution", () => {
        const edits = redlineEditsForRewrite(baseline, [
            { text: "Scope of Work.", runs: [] },
            { text: "Payment is due in 15 days.", runs: [] },
            { text: "Warranty.", runs: [] },
        ]);
        expect(edits).toHaveLength(1);
        expect(edits[0]).toMatchObject({
            find: "Payment.",
            replace: "Payment is due in 15 days.",
        });
        expect(edits[0].context_before).toContain("Scope of Work.");
    });

    it("turns a dropped paragraph into a deletion", () => {
        const edits = redlineEditsForRewrite(baseline, [
            { text: "Scope of Work.", runs: [] },
            { text: "Warranty.", runs: [] },
        ]);
        expect(edits).toEqual([
            expect.objectContaining({ find: "Payment.", replace: "" }),
        ]);
    });

    it("turns an added provision into an insertion", () => {
        const edits = redlineEditsForRewrite(baseline, [
            { text: "Scope of Work.", runs: [] },
            { text: "Payment.", runs: [] },
            { text: "Insurance.", runs: [] },
            { text: "Warranty.", runs: [] },
        ]);
        expect(edits).toHaveLength(1);
        expect(edits[0].find).toBe("");
        expect(edits[0].replace).toContain("Insurance.");
    });

    it("says nothing when the document already reads that way", () => {
        expect(
            redlineEditsForRewrite(
                baseline,
                baseline.map((text) => ({ text, runs: [] })),
            ),
        ).toEqual([]);
    });
});
