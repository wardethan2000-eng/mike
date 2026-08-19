import { describe, it, expect, beforeEach, vi } from "vitest";
import JSZip from "jszip";

// Storage is faked so the test never touches S3: uploads are captured in
// memory and the download always returns the fixture document.
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

import { runEditDocument } from "../documentOps";
import { extractDocxBodyText } from "../../../docxTrackedChanges";

const W_NS =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

async function makeDocx(text: string): Promise<Buffer> {
    const zip = new JSZip();
    zip.file(
        "word/document.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
            `<w:document ${W_NS}><w:body>` +
            `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>` +
            `</w:body></w:document>`,
    );
    return zip.generateAsync({ type: "nodebuffer" });
}

type Row = Record<string, unknown>;

/**
 * Supabase mock covering the chains runEditDocument uses: select/eq/in/neq
 * with single(), maybeSingle(), head counts, insert().select() and update().
 * Inserted rows are kept so the test can assert what was recorded.
 */
function makeDb(tables: Record<string, Row[]>) {
    const inserted: Record<string, Row[]> = {};
    const db = {
        inserted,
        from(table: string) {
            let rows = [...(tables[table] ?? [])];
            let headCount = false;
            const query: any = {
                select: (_cols?: string, opts?: { head?: boolean }) => {
                    if (opts?.head) headCount = true;
                    return query;
                },
                eq: (column: string, value: unknown) => {
                    rows = rows.filter((row) => row[column] === value);
                    return query;
                },
                neq: (column: string, value: unknown) => {
                    rows = rows.filter((row) => row[column] !== value);
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
                    inserted[table] = [...(inserted[table] ?? []), ...stored];
                    tables[table] = [...(tables[table] ?? []), ...stored];
                    rows = stored;
                    return query;
                },
                update: (patch: Row) => {
                    rows.forEach((row) => Object.assign(row, patch));
                    return query;
                },
                then: (
                    resolve: (value: {
                        data: Row[];
                        error: null;
                        count?: number;
                    }) => unknown,
                    reject?: (reason: unknown) => unknown,
                ) =>
                    Promise.resolve({
                        data: headCount ? [] : rows,
                        error: null,
                        count: rows.length,
                    }).then(resolve, reject),
            };
            return query;
        },
    };
    return db as any;
}

function fixtureTables(docPatch: Row = {}) {
    return {
        documents: [
            {
                id: "doc-1",
                is_replica: false,
                current_version_id: "ver-1",
                ...docPatch,
            },
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

const EDITS = [
    {
        find: "Cooks Guttering",
        replace: "Central Spray Foam",
        context_before: "between ",
        context_after: ", a Kansas",
    },
];

beforeEach(async () => {
    uploads.clear();
    sourceBytes = await makeDocx(
        "This Agreement is entered into between Cooks Guttering, a Kansas company.",
    );
});

describe("runEditDocument edit mode", () => {
    it("writes the changes straight into an unedited copy", async () => {
        const db = makeDb(fixtureTables({ is_replica: true }));
        const result = await runEditDocument({
            documentId: "doc-1",
            userId: "user-1",
            edits: EDITS,
            db,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.tracked).toBe(false);
        expect(result.applied_count).toBe(1);
        // Nothing to accept or reject, so no cards and no edit rows.
        expect(result.annotations).toEqual([]);
        expect(db.inserted.document_edits ?? []).toEqual([]);

        const saved = uploads.get(result.storage_path)!;
        const xml = await (await JSZip.loadAsync(saved))
            .file("word/document.xml")!
            .async("string");
        expect(xml).not.toMatch(/<w:ins|<w:del/);
        await expect(extractDocxBodyText(saved)).resolves.toBe(
            "This Agreement is entered into between Central Spray Foam, a Kansas company.",
        );
    });

    it("keeps tracked changes on the user's own document", async () => {
        const db = makeDb(fixtureTables());
        const result = await runEditDocument({
            documentId: "doc-1",
            userId: "user-1",
            edits: EDITS,
            db,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.tracked).toBe(true);
        expect(result.annotations).toHaveLength(1);
        expect(result.annotations[0].status).toBe("pending");
        expect(db.inserted.document_edits).toHaveLength(1);

        const saved = uploads.get(result.storage_path)!;
        const xml = await (await JSZip.loadAsync(saved))
            .file("word/document.xml")!
            .async("string");
        expect(xml).toMatch(/<w:ins/);
        expect(xml).toMatch(/<w:del/);
    });

    it("still tracks changes on a copy when asked to", async () => {
        const db = makeDb(fixtureTables({ is_replica: true }));
        const result = await runEditDocument({
            documentId: "doc-1",
            userId: "user-1",
            edits: EDITS,
            db,
            trackChanges: true,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.tracked).toBe(true);
        expect(result.annotations).toHaveLength(1);
    });

    it("writes straight in when asked to, on any document", async () => {
        const db = makeDb(fixtureTables());
        const result = await runEditDocument({
            documentId: "doc-1",
            userId: "user-1",
            edits: EDITS,
            db,
            trackChanges: false,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.tracked).toBe(false);
        expect(result.annotations).toEqual([]);
    });

    it("goes back to tracked changes once a copy has been filled in", async () => {
        const tables = fixtureTables({ is_replica: true });
        tables.document_versions.push({
            id: "ver-2",
            document_id: "doc-1",
            storage_path: "documents/u/doc-1/edits/ver-2.docx",
            pdf_storage_path: null,
            source: "assistant_edit",
            version_number: 2,
            filename: "Agreement.docx",
            file_type: "docx",
            deleted_at: null,
        });
        tables.documents[0].current_version_id = "ver-2";
        const db = makeDb(tables);

        const result = await runEditDocument({
            documentId: "doc-1",
            userId: "user-1",
            edits: EDITS,
            db,
        });

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.tracked).toBe(true);
    });
});
