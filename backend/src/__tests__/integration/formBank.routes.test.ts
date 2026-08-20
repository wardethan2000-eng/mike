import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// The firm's form bank, as the routes actually answer it: who may change it,
// what may go in it, and what happens to the document when an entry is taken
// off the list.
//
// Same stand-in database as the other route tests — each test seeds the rows a
// table should return, and every write is recorded so we can check what the
// route did.
// ---------------------------------------------------------------------------

type QueryResult = { data: unknown; error: unknown };

let supabaseState: {
    tables: Record<string, QueryResult>;
    inserts: { table: string; payload: unknown }[];
    updates: { table: string; payload: unknown }[];
    deletes: string[];
};

function resetSupabaseState() {
    supabaseState = { tables: {}, inserts: [], updates: [], deletes: [] };
}
resetSupabaseState();

function resultForTable(table: string): QueryResult {
    return supabaseState.tables[table] ?? { data: null, error: null };
}

function makeQuery(table: string) {
    const q: Record<string, unknown> = {};
    for (const method of [
        "select",
        "upsert",
        "eq",
        "neq",
        "in",
        "is",
        "or",
        "not",
        "filter",
        "order",
        "limit",
        "range",
        "contains",
    ]) {
        q[method] = vi.fn(() => q);
    }
    q.insert = vi.fn((payload: unknown) => {
        supabaseState.inserts.push({ table, payload });
        return q;
    });
    q.update = vi.fn((payload: unknown) => {
        supabaseState.updates.push({ table, payload });
        return q;
    });
    q.delete = vi.fn(() => {
        supabaseState.deletes.push(table);
        return q;
    });
    q.single = vi.fn(() => Promise.resolve(resultForTable(table)));
    q.maybeSingle = vi.fn(() => Promise.resolve(resultForTable(table)));
    q.then = (
        resolve: (value: unknown) => unknown,
        reject?: (error: unknown) => unknown,
    ) => Promise.resolve(resultForTable(table)).then(resolve, reject);
    return q;
}

vi.mock("../../lib/supabase", () => ({
    createServerSupabase: vi.fn(() => ({
        from: vi.fn((table: string) => makeQuery(table)),
        rpc: vi.fn(() => Promise.resolve({ data: [], error: null })),
        auth: {
            getUser: () =>
                Promise.resolve({ data: { user: { id: "u1" } }, error: null }),
        },
    })),
}));

vi.mock("../../middleware/auth", () => ({
    requireAuth: (
        _req: unknown,
        res: { locals: Record<string, unknown> },
        next: () => void,
    ) => {
        res.locals.userId = "u1";
        res.locals.userEmail = "u1@test.local";
        next();
    },
    requireMfaIfEnrolled: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
}));

const { recommendFormNotes } = vi.hoisted(() => ({
    recommendFormNotes: vi.fn(),
}));
vi.mock("../../lib/formBankAnalyze", () => ({ recommendFormNotes }));

import { app } from "../../app";
import { clearFirmCaches } from "../../lib/firm";

const AUTH = ["Authorization", "Bearer test"] as const;
const FIRM = "firm-1";

/** Seed who the caller is at the firm. */
function memberIs(
    role: "admin" | "attorney" | "paralegal" | null,
    options: { canEditFirmLibrary?: boolean; status?: string } = {},
) {
    supabaseState.tables.firm_members = {
        data: role
            ? {
                  firm_id: FIRM,
                  user_id: "u1",
                  role,
                  status: options.status ?? "active",
                  can_edit_firm_library: options.canEditFirmLibrary ?? false,
              }
            : null,
        error: null,
    };
}

/** Seed the document an entry would point at. */
function documentIs(overrides: Record<string, unknown> = {}) {
    supabaseState.tables.documents = {
        data: {
            id: "d1",
            firm_id: FIRM,
            project_id: null,
            library_kind: "template",
            current_version_id: null,
            ...overrides,
        },
        error: null,
    };
}

function savedForm(overrides: Record<string, unknown> = {}) {
    supabaseState.tables.firm_forms = {
        data: {
            id: "f1",
            firm_id: FIRM,
            document_id: "d1",
            title: "Operating agreement — two members",
            document_type: "operating-agreement",
            usage_mode: "precedent",
            variant_notes: "member-managed, two individual members",
            practice: null,
            jurisdictions: ["Kansas"],
            description: null,
            drafting_guidance: null,
            required_fields: [],
            status: "draft",
            created_by: "u1",
            ...overrides,
        },
        error: null,
    };
}

describe("the firm's form bank", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetSupabaseState();
        clearFirmCaches();
    });

    describe("who may change it", () => {
        it("turns away an ordinary attorney", async () => {
            memberIs("attorney");
            const res = await request(app).get("/admin/forms").set(...AUTH);
            expect(res.status).toBe(403);
        });

        it("turns away somebody who does not work at the firm", async () => {
            memberIs(null);
            const res = await request(app).get("/admin/forms").set(...AUTH);
            expect(res.status).toBe(403);
        });

        it("turns away somebody who has left, even an administrator", async () => {
            memberIs("admin", { status: "deactivated" });
            const res = await request(app).get("/admin/forms").set(...AUTH);
            expect(res.status).toBe(403);
        });

        it("lets an administrator in", async () => {
            memberIs("admin");
            supabaseState.tables.firm_forms = { data: [], error: null };
            const res = await request(app).get("/admin/forms").set(...AUTH);
            expect(res.status).toBe(200);
            expect(res.body.forms).toEqual([]);
        });

        it("lets whoever looks after the firm library in", async () => {
            memberIs("paralegal", { canEditFirmLibrary: true });
            supabaseState.tables.firm_forms = { data: [], error: null };
            const res = await request(app).get("/admin/forms").set(...AUTH);
            expect(res.status).toBe(200);
        });
    });

    describe("adding an entry", () => {
        it("refuses a document that is not on the firm's shelves", async () => {
            memberIs("admin");
            documentIs({ firm_id: "another-firm" });
            const res = await request(app)
                .post("/admin/forms")
                .set(...AUTH)
                .send({ document_id: "d1", document_type: "operating-agreement" });
            expect(res.status).toBe(400);
            expect(supabaseState.inserts).toHaveLength(0);
        });

        it("refuses a document that lives inside a matter", async () => {
            memberIs("admin");
            documentIs({ project_id: "p1" });
            const res = await request(app)
                .post("/admin/forms")
                .set(...AUTH)
                .send({ document_id: "d1", document_type: "operating-agreement" });
            expect(res.status).toBe(400);
        });

        it("refuses an ordinary file that is not a template", async () => {
            memberIs("admin");
            documentIs({ library_kind: "file" });
            const res = await request(app)
                .post("/admin/forms")
                .set(...AUTH)
                .send({ document_id: "d1", document_type: "operating-agreement" });
            expect(res.status).toBe(400);
        });

        it("insists on being told what kind of document it is", async () => {
            memberIs("admin");
            documentIs();
            const res = await request(app)
                .post("/admin/forms")
                .set(...AUTH)
                .send({ document_id: "d1", title: "Operating agreement" });
            expect(res.status).toBe(400);
        });

        it("saves a new entry as a draft, on the caller's own firm", async () => {
            memberIs("admin");
            documentIs();
            savedForm();
            const res = await request(app)
                .post("/admin/forms")
                .set(...AUTH)
                .send({
                    document_id: "d1",
                    title: "Operating agreement — two members",
                    document_type: "Operating Agreement",
                    usage_mode: "precedent",
                });
            expect(res.status).toBe(201);
            const written = supabaseState.inserts.find(
                (row) => row.table === "firm_forms",
            )?.payload as Record<string, unknown>;
            expect(written).toMatchObject({
                firm_id: FIRM,
                document_id: "d1",
                // Written however it was typed, stored as one kind of document
                // so its versions sit together.
                document_type: "operating-agreement",
            });
            expect(res.body.status).toBe("draft");
        });

        it("refuses a kind of entry that is neither a precedent nor a form", async () => {
            memberIs("admin");
            documentIs();
            const res = await request(app)
                .post("/admin/forms")
                .set(...AUTH)
                .send({
                    document_id: "d1",
                    document_type: "operating-agreement",
                    usage_mode: "something-else",
                });
            expect(res.status).toBe(400);
        });
    });

    describe("changing an entry", () => {
        it("approves one", async () => {
            memberIs("admin");
            savedForm({ status: "approved" });
            const res = await request(app)
                .patch("/admin/forms/f1")
                .set(...AUTH)
                .send({ status: "approved" });
            expect(res.status).toBe(200);
            expect(res.body.status).toBe("approved");
            expect(
                supabaseState.updates.find((row) => row.table === "firm_forms")
                    ?.payload,
            ).toMatchObject({ status: "approved" });
        });

        it("refuses a state that is neither a draft nor approved", async () => {
            memberIs("admin");
            const res = await request(app)
                .patch("/admin/forms/f1")
                .set(...AUTH)
                .send({ status: "live" });
            expect(res.status).toBe(400);
        });

        it("says so when the entry is not there", async () => {
            memberIs("admin");
            supabaseState.tables.firm_forms = { data: null, error: null };
            const res = await request(app)
                .patch("/admin/forms/f1")
                .set(...AUTH)
                .send({ status: "approved" });
            expect(res.status).toBe(404);
        });

        it("does not let an ordinary attorney approve anything", async () => {
            memberIs("attorney");
            const res = await request(app)
                .patch("/admin/forms/f1")
                .set(...AUTH)
                .send({ status: "approved" });
            expect(res.status).toBe(403);
        });
    });

    describe("taking an entry off the list", () => {
        it("removes the notes and leaves the document alone", async () => {
            memberIs("admin");
            supabaseState.tables.firm_forms = {
                data: { id: "f1", title: "Operating agreement", document_id: "d1" },
                error: null,
            };
            const res = await request(app)
                .delete("/admin/forms/f1")
                .set(...AUTH);
            expect(res.status).toBe(200);
            expect(supabaseState.deletes).toEqual(["firm_forms"]);
            expect(supabaseState.deletes).not.toContain("documents");
        });

        it("does not let an ordinary attorney do it", async () => {
            memberIs("attorney");
            const res = await request(app)
                .delete("/admin/forms/f1")
                .set(...AUTH);
            expect(res.status).toBe(403);
        });
    });

    describe("suggesting the notes", () => {
        it("hands back a suggestion without saving anything", async () => {
            memberIs("admin");
            documentIs();
            recommendFormNotes.mockResolvedValue({
                title: "Operating agreement — two members",
                document_type: "operating-agreement",
                usage_mode: "precedent",
                variant_notes: "member-managed, two individual members",
                description: "",
                drafting_guidance: "",
                practice: "Business",
                jurisdictions: ["Kansas"],
                required_fields: [],
            });
            const res = await request(app)
                .post("/admin/forms/analyze")
                .set(...AUTH)
                .send({ document_id: "d1" });
            expect(res.status).toBe(200);
            expect(res.body.document_type).toBe("operating-agreement");
            expect(
                supabaseState.inserts.filter((row) => row.table === "firm_forms"),
            ).toHaveLength(0);
        });

        it("says plainly when it could not read the document", async () => {
            memberIs("admin");
            documentIs();
            recommendFormNotes.mockResolvedValue(null);
            const res = await request(app)
                .post("/admin/forms/analyze")
                .set(...AUTH)
                .send({ document_id: "d1" });
            expect(res.status).toBe(502);
        });

        it("does not let an ordinary attorney run it", async () => {
            memberIs("attorney");
            const res = await request(app)
                .post("/admin/forms/analyze")
                .set(...AUTH)
                .send({ document_id: "d1" });
            expect(res.status).toBe(403);
            expect(recommendFormNotes).not.toHaveBeenCalled();
        });
    });
});
