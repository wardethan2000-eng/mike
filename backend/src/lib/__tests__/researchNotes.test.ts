import { describe, it, expect, vi, beforeEach } from "vitest";

// Download links are signed; the real signer needs a secret.
process.env.DOWNLOAD_SIGNING_SECRET ||= "test-download-signing-secret";

// In-memory stand-in for object storage, so an append can read back what the
// previous call wrote.
const stored = new Map<string, Buffer>();

vi.mock("../storage", async () => {
    const actual = await vi.importActual<typeof import("../storage")>("../storage");
    return {
        ...actual,
        uploadFile: vi.fn(async (key: string, bytes: ArrayBuffer) => {
            stored.set(key, Buffer.from(bytes));
        }),
        downloadFile: vi.fn(async (key: string) => {
            const found = stored.get(key);
            return found
                ? (found.buffer.slice(
                      found.byteOffset,
                      found.byteOffset + found.byteLength,
                  ) as ArrayBuffer)
                : null;
        }),
    };
});
vi.mock("../documentRendition", () => ({
    prepareRendition: vi.fn(async () => ({
        pdfStoragePath: "converted-pdfs/u1/doc.pdf",
        pageCount: 1,
        warning: null,
        ocrPending: false,
    })),
    readInBackground: vi.fn(() => {}),
}));
vi.mock("../passageIndex", () => ({ indexInBackground: vi.fn(() => {}) }));

import { indexInBackground } from "../passageIndex";
import {
    appendResearchNotes,
    composeNotes,
    researchNotesFilename,
    researchNotesFilenameForChat,
    RESEARCH_NOTES_HEADER_LINE,
} from "../chat/researchNotes";
import {
    newAuthorityChecklistState,
    recordDocumentAuthorities,
} from "../chat/authorityChecklist";

type Row = Record<string, unknown>;

/** The same stateful Supabase stand-in shape the other lib tests use. */
function makeDb() {
    const tables: Record<string, Row[]> = { documents: [], document_versions: [] };
    let nextId = 1;
    const db = {
        from(table: string) {
            const rowsOf = () => tables[table] ?? (tables[table] = []);
            let predicate: (row: Row) => boolean = () => true;
            let mode: "select" | "insert" | "update" | "delete" = "select";
            let inserted: Row[] = [];
            let patch: Row = {};
            let limit: number | null = null;
            let sortColumn: string | null = null;
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
                let hit = rowsOf().filter(predicate).map((row) => ({ ...row }));
                if (sortColumn) {
                    const column = sortColumn;
                    hit = hit.sort(
                        (a, b) => Number(b[column] ?? 0) - Number(a[column] ?? 0),
                    );
                }
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
                in: (column: string, values: unknown[]) => {
                    narrow((row) => values.includes(row[column]));
                    return query;
                },
                order: (column: string) => {
                    sortColumn = column;
                    return query;
                },
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
    return { db: db as never, tables };
}

const write = (db: never, entry: string, topic?: string) =>
    appendResearchNotes({
        db,
        userId: "u1",
        projectId: "p1",
        chatId: "chat-1",
        entry,
        topic,
    });

/** The text of the document as it now stands. */
function currentText(tables: Record<string, Row[]>): string {
    const doc = tables.documents[0];
    const version = tables.document_versions.find(
        (row) => row.id === doc.current_version_id,
    )!;
    return stored.get(version.storage_path as string)!.toString("utf8");
}

beforeEach(() => {
    stored.clear();
    vi.clearAllMocks();
});

describe("composeNotes", () => {
    it("opens a new document with a heading and the first entry", () => {
        const { text } = composeNotes({
            existing: "",
            entry: "Checked 347 U.S. 483 — pin cite correct.",
            topic: "Graver memo",
            now: new Date("2026-08-20T14:30:00Z"),
        });
        expect(text).toContain("Research Notes — Graver memo");
        expect(text).toContain("[2026-08-20 14:30 UTC]");
        expect(text).toContain("pin cite correct");
    });

    it("keeps what is already there and separates the new entry", () => {
        const first = composeNotes({ existing: "", entry: "First finding." }).text;
        const { text } = composeNotes({ existing: first, entry: "Second finding." });
        expect(text).toContain("First finding.");
        expect(text).toContain("Second finding.");
        expect(text.indexOf("First finding.")).toBeLessThan(
            text.indexOf("Second finding."),
        );
        expect(text).toContain("---");
    });

    it("drops the oldest entries rather than growing without limit", () => {
        const huge = "x".repeat(500_000);
        const { text, truncated } = composeNotes({ existing: huge, entry: "New." });
        expect(truncated).toBe(true);
        expect(text).toContain("Earlier entries were dropped");
        expect(text).toContain("New.");
        expect(text.length).toBeLessThan(500_000);
    });
});

describe("researchNotesFilename", () => {
    it("names the document after the topic", () => {
        expect(researchNotesFilename("Graver lease dispute")).toBe(
            "Research Notes — Graver lease dispute.txt",
        );
    });

    it("falls back and strips characters a filename cannot carry", () => {
        expect(researchNotesFilename(null)).toBe("Research Notes.txt");
        expect(researchNotesFilename("a/b:c*d")).toBe("Research Notes — a b c d.txt");
    });
});

describe("appendResearchNotes", () => {
    it("creates the document on the first call and appends on the next", async () => {
        const { db, tables } = makeDb();
        const first = await write(db, "Checked 347 U.S. 483.", "Graver memo");
        expect("error" in first).toBe(false);
        if ("error" in first) return;
        expect(first.status).toBe("created");
        expect(first.filename).toBe("Research Notes — Graver memo.txt");
        expect(first.versionNumber).toBe(1);
        expect(first.downloadUrl).toMatch(/^\/download\//);
        expect(tables.documents.length).toBe(1);
        expect(tables.documents[0].source_kind).toBe("research_notes");
        expect(tables.documents[0].source_ref).toBe("chat-1");

        const second = await write(db, "Checked 556 U.S. 662.");
        expect("error" in second).toBe(false);
        if ("error" in second) return;
        expect(second.status).toBe("appended");
        expect(second.versionNumber).toBe(2);
        // Still one document; the notes grew rather than a second one appearing.
        expect(tables.documents.length).toBe(1);
        expect(tables.document_versions.length).toBe(2);

        const text = currentText(tables);
        expect(text).toContain("Checked 347 U.S. 483.");
        expect(text).toContain("Checked 556 U.S. 662.");
    });

    it("keeps the newest version searchable", async () => {
        const { db } = makeDb();
        await write(db, "One.", "Topic");
        await write(db, "Two.");
        expect(vi.mocked(indexInBackground)).toHaveBeenCalledTimes(2);
    });

    it("refuses an empty entry without touching the matter", async () => {
        const { db, tables } = makeDb();
        const result = await write(db, "   ");
        expect(result).toHaveProperty("error");
        expect(tables.documents.length).toBe(0);
    });

    it("reports this chat's notes document by name, and nothing for a chat without one", async () => {
        const { db } = makeDb();
        expect(
            await researchNotesFilenameForChat({ db, projectId: "p1", chatId: "chat-1" }),
        ).toBeNull();
        await write(db, "One.", "Topic");
        expect(
            await researchNotesFilenameForChat({ db, projectId: "p1", chatId: "chat-1" }),
        ).toBe("Research Notes — Topic.txt");
        expect(
            await researchNotesFilenameForChat({ db, projectId: "p1", chatId: "other" }),
        ).toBeNull();
        expect(
            await researchNotesFilenameForChat({ db, projectId: null, chatId: "chat-1" }),
        ).toBeNull();
    });
});

describe("the notes document and the citation checklist", () => {
    it("is not itself treated as a document under review", () => {
        // The checklist keeps its own copy of this line so it can stay free of
        // storage imports. If the two ever drift, reading the notes back would
        // start accusing the assistant of skipping its own findings.
        const { text } = composeNotes({
            existing: "",
            entry: "Checked 347 U.S. 483 and 556 U.S. 662; both correct.",
            topic: "Graver",
        });
        expect(text).toContain(RESEARCH_NOTES_HEADER_LINE);
        const state = newAuthorityChecklistState();
        recordDocumentAuthorities(state, "Research Notes — Graver.txt", text);
        expect(state.byDocument.size).toBe(0);
    });
});
