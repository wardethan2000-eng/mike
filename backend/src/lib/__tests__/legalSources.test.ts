import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../storage", () => ({
    uploadFile: vi.fn(async () => {}),
    storageKey: (userId: string, docId: string, filename: string) =>
        `uploads/${userId}/${docId}/${filename}`,
}));
vi.mock("../documentRendition", () => ({
    prepareRendition: vi.fn(async () => ({
        pdfStoragePath: "converted-pdfs/u1/doc.pdf",
        pageCount: 3,
        warning: null,
        ocrPending: false,
    })),
    readInBackground: vi.fn(() => {}),
}));
vi.mock("../passageIndex", () => ({ indexInBackground: vi.fn(() => {}) }));
vi.mock("../audit", () => ({ recordAudit: vi.fn(async () => {}) }));
vi.mock("../courtlistener", () => ({
    getCourtlistenerCaseOpinions: vi.fn(async () => ({})),
}));

import { uploadFile } from "../storage";
import { prepareRendition, readInBackground } from "../documentRendition";
import { indexInBackground } from "../passageIndex";
import { getCourtlistenerCaseOpinions } from "../courtlistener";
import { saveLegalSourceToProject } from "../legalSources";

const uploadFileMock = vi.mocked(uploadFile);
const prepareRenditionMock = vi.mocked(prepareRendition);
const readInBackgroundMock = vi.mocked(readInBackground);
const indexInBackgroundMock = vi.mocked(indexInBackground);
const caseFetchMock = vi.mocked(getCourtlistenerCaseOpinions);

type Row = Record<string, unknown>;

/**
 * Stateful Supabase stand-in covering the chains legalSources.ts uses:
 * select/insert/update/delete with eq/is/not/order/limit and
 * single/maybeSingle.
 */
function makeDb(initial: Record<string, Row[]>) {
    const tables: Record<string, Row[]> = {};
    for (const [name, rows] of Object.entries(initial)) {
        tables[name] = rows.map((row) => ({ ...row }));
    }
    let nextId = 1;
    const db = {
        from(table: string) {
            const rowsOf = () => tables[table] ?? (tables[table] = []);
            let predicate: (row: Row) => boolean = () => true;
            let mode: "select" | "insert" | "update" | "delete" = "select";
            let inserted: Row[] = [];
            let patch: Row = {};
            let limit: number | null = null;
            const narrow = (next: (row: Row) => boolean) => {
                const prev = predicate;
                predicate = (row) => prev(row) && next(row);
            };
            const run = (): { data: Row[]; error: unknown } => {
                if (mode === "insert") return { data: inserted, error: null };
                if (mode === "update") {
                    const hit = rowsOf().filter(predicate);
                    for (const row of hit) Object.assign(row, patch);
                    return { data: hit, error: null };
                }
                if (mode === "delete") {
                    tables[table] = rowsOf().filter((row) => !predicate(row));
                    return { data: [], error: null };
                }
                const hit = rowsOf()
                    .filter(predicate)
                    .map((row) => ({ ...row }));
                return { data: limit ? hit.slice(0, limit) : hit, error: null };
            };
            const query: any = {
                select: () => query,
                insert: (value: Row | Row[]) => {
                    mode = "insert";
                    const rows = (Array.isArray(value) ? value : [value]).map(
                        (row) => ({ id: `${table}-${nextId++}`, ...row }),
                    );
                    rowsOf().push(...rows);
                    inserted = rows.map((row) => ({ ...row }));
                    return query;
                },
                update: (value: Row) => {
                    mode = "update";
                    patch = value;
                    return query;
                },
                delete: () => {
                    mode = "delete";
                    return query;
                },
                eq: (column: string, value: unknown) => {
                    narrow((row) => row[column] === value);
                    return query;
                },
                is: (column: string, value: unknown) => {
                    narrow((row) => (row[column] ?? null) === value);
                    return query;
                },
                not: (column: string) => {
                    narrow((row) => row[column] != null);
                    return query;
                },
                order: () => query,
                limit: (value: number) => {
                    limit = value;
                    return query;
                },
                single: () => {
                    const { data, error } = run();
                    return Promise.resolve({
                        data: data[0] ?? null,
                        error: data[0] ? error : { message: "no rows" },
                    });
                },
                maybeSingle: () => {
                    const { data, error } = run();
                    return Promise.resolve({ data: data[0] ?? null, error });
                },
                then: (resolve: (value: unknown) => unknown) =>
                    Promise.resolve(run()).then(resolve),
            };
            return query;
        },
    };
    return { db: db as any, tables };
}

const PROJECTS = [{ id: "p1", user_id: "u1", shared_with: [] }];

function save(db: unknown, input: any) {
    return saveLegalSourceToProject({
        db: db as never,
        userId: "u1",
        userEmail: "u1@example.com",
        projectId: "p1",
        input,
    });
}

const pdfBytes = () => Buffer.from("%PDF-1.7\nfake court pdf\n");

function mockPdfDownload(bytes = pdfBytes(), url?: string) {
    const response = {
        ok: true,
        url: url ?? "https://storage.courtlistener.com/opinion.pdf",
        headers: { get: () => String(bytes.byteLength) },
        arrayBuffer: async () =>
            bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength,
            ),
    };
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => response as never),
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    prepareRenditionMock.mockResolvedValue({
        pdfStoragePath: "converted-pdfs/u1/doc.pdf",
        pageCount: 3,
        warning: null,
        ocrPending: false,
    } as never);
});

const uploadedFilename = () =>
    String(uploadFileMock.mock.calls[0]?.[0] ?? "").split("/").pop() ?? "";

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

describe("saving a case", () => {
    it("stores the court's own PDF in a new Law folder", async () => {
        caseFetchMock.mockResolvedValue({
            caseName: "Smith v. Jones",
            citations: ["123 Kan. 45"],
            dateFiled: "1999-04-01",
            url: "https://www.courtlistener.com/opinion/9/smith/",
            pdfUrl: "https://storage.courtlistener.com/opinion.pdf",
            opinions: [{ type: "lead", text: "Body of the opinion." }],
        } as never);
        mockPdfDownload();
        const { db, tables } = makeDb({ projects: PROJECTS });

        const result = await save(db, { kind: "case", clusterId: 9 });

        expect(result).toMatchObject({ status: "saved" });
        expect(uploadedFilename()).toBe("Smith v. Jones, 123 Kan. 45.pdf");
        const folder = tables.project_subfolders[0];
        expect(folder).toMatchObject({ name: "Law", project_id: "p1" });
        expect(tables.documents[0]).toMatchObject({
            project_id: "p1",
            folder_id: folder.id,
            source_kind: "case",
            source_ref: "9",
            status: "ready",
        });
        expect(tables.document_versions[0]).toMatchObject({
            file_type: "pdf",
            filename: "Smith v. Jones, 123 Kan. 45.pdf",
        });
        expect(indexInBackgroundMock).toHaveBeenCalledTimes(1);
    });

    it("falls back to a Word document of the opinions when there is no PDF", async () => {
        caseFetchMock.mockResolvedValue({
            caseName: "Smith v. Jones",
            citations: [],
            opinions: [
                { type: "lead", author: "Kelly, J.", text: "First opinion." },
                { type: "dissent", text: "Second opinion." },
            ],
        } as never);
        const { db, tables } = makeDb({ projects: PROJECTS });

        const result = await save(db, { kind: "case", clusterId: 9 });

        expect(result).toMatchObject({ status: "saved" });
        expect(uploadedFilename()).toBe("Smith v. Jones.docx");
        expect(tables.document_versions[0]).toMatchObject({ file_type: "docx" });
        // A real Word file is a zip.
        const bytes = Buffer.from(uploadFileMock.mock.calls[0][1] as ArrayBuffer);
        expect(bytes.subarray(0, 2).toString()).toBe("PK");
    });

    it("ignores a PDF link that points off CourtListener", async () => {
        caseFetchMock.mockResolvedValue({
            caseName: "Smith v. Jones",
            opinions: [{ type: "lead", text: "Body." }],
        } as never);
        const fetchSpy = vi.fn();
        vi.stubGlobal("fetch", fetchSpy);
        const { db } = makeDb({ projects: PROJECTS });

        await save(db, {
            kind: "case",
            clusterId: 9,
            pdfUrl: "https://example.com/not-a-court.pdf",
        });

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(uploadedFilename()).toBe("Smith v. Jones.docx");
    });

    it("reads a scanned court PDF in the background", async () => {
        caseFetchMock.mockResolvedValue({
            caseName: "Smith v. Jones",
            pdfUrl: "https://storage.courtlistener.com/opinion.pdf",
            opinions: [],
        } as never);
        mockPdfDownload();
        prepareRenditionMock.mockResolvedValue({
            pdfStoragePath: "uploads/u1/doc.pdf",
            pageCount: null,
            warning: null,
            ocrPending: true,
        } as never);
        const { db, tables } = makeDb({ projects: PROJECTS });

        await save(db, { kind: "case", clusterId: 9 });

        expect(readInBackgroundMock).toHaveBeenCalledTimes(1);
        expect(indexInBackgroundMock).not.toHaveBeenCalled();
        expect(tables.documents[0].status).toBe("processing");
    });

    it("says so when CourtListener has no text and no PDF", async () => {
        caseFetchMock.mockResolvedValue({ opinions: [] } as never);
        const { db, tables } = makeDb({ projects: PROJECTS });

        const result = await save(db, { kind: "case", clusterId: 9 });

        expect(result).toMatchObject({ status: 502 });
        expect(tables.documents ?? []).toHaveLength(0);
    });

    it("hands back the copy already filed instead of making a second one", async () => {
        caseFetchMock.mockResolvedValue({
            caseName: "Smith v. Jones",
            opinions: [{ type: "lead", text: "Body." }],
        } as never);
        const { db, tables } = makeDb({ projects: PROJECTS });

        const first = await save(db, { kind: "case", clusterId: 9 });
        const second = await save(db, { kind: "case", clusterId: 9 });

        expect(first.status).toBe("saved");
        expect(second).toMatchObject({
            status: "exists",
            documentId: (first as { documentId: string }).documentId,
        });
        expect(tables.documents).toHaveLength(1);
        expect(tables.project_subfolders).toHaveLength(1);
    });

    it("puts the file in a Law folder that already exists", async () => {
        caseFetchMock.mockResolvedValue({
            caseName: "Smith v. Jones",
            opinions: [{ type: "lead", text: "Body." }],
        } as never);
        const { db, tables } = makeDb({
            projects: PROJECTS,
            project_subfolders: [
                {
                    id: "f-law",
                    project_id: "p1",
                    name: "law",
                    parent_folder_id: null,
                },
            ],
        });

        await save(db, { kind: "case", clusterId: 9 });

        expect(tables.project_subfolders).toHaveLength(1);
        expect(tables.documents[0].folder_id).toBe("f-law");
    });

    it("refuses a matter the user cannot see", async () => {
        const { db } = makeDb({
            projects: [{ id: "p1", user_id: "someone-else", shared_with: [] }],
        });

        expect(await save(db, { kind: "case", clusterId: 9 })).toMatchObject({
            status: 404,
        });
    });
});

// ---------------------------------------------------------------------------
// Statutes
// ---------------------------------------------------------------------------

const statuteChat = {
    chats: [{ id: "c1", user_id: "u1", project_id: "p1" }],
    chat_messages: [
        {
            id: "m1",
            chat_id: "c1",
            created_at: "2026-08-19T00:00:00Z",
            citations: [
                {
                    kind: "legislation",
                    leg_id: "K.S.A. 58-2540",
                    title: "K.S.A. 58-2540",
                    url: "https://ksrevisor.org/58-2540",
                    document: {
                        subdocuments: [
                            { text: "The statute text.\n\nSecond paragraph." },
                        ],
                    },
                },
            ],
        },
    ],
};

describe("saving a statute", () => {
    it("writes the statute text from the answer that quoted it", async () => {
        const { db, tables } = makeDb({ projects: PROJECTS, ...statuteChat });

        const result = await save(db, {
            kind: "legislation",
            legId: "K.S.A. 58-2540",
            chatId: "c1",
        });

        expect(result).toMatchObject({ status: "saved" });
        expect(uploadedFilename()).toBe("K.S.A. 58-2540.docx");
        expect(tables.documents[0]).toMatchObject({
            source_kind: "legislation",
            source_url: "https://ksrevisor.org/58-2540",
        });
    });

    it("explains itself when the statute text is no longer to hand", async () => {
        const { db } = makeDb({ projects: PROJECTS, ...statuteChat });

        const result = await save(db, {
            kind: "legislation",
            legId: "K.S.A. 60-206",
            chatId: "c1",
        });

        expect(result).toMatchObject({ status: 502 });
        expect(String((result as { error: string }).error)).toContain(
            "no longer to hand",
        );
    });

    it("will not read a statute out of someone else's conversation", async () => {
        const { db } = makeDb({
            projects: PROJECTS,
            chats: [{ id: "c1", user_id: "u2", project_id: null }],
            chat_messages: statuteChat.chat_messages,
        });

        const result = await save(db, {
            kind: "legislation",
            legId: "K.S.A. 58-2540",
            chatId: "c1",
        });

        expect(result).toMatchObject({ status: 502 });
    });
});
