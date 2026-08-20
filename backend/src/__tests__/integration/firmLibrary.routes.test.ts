import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---------------------------------------------------------------------------
// The firm's half of the library, as the routes actually answer it: who may
// read it, who may change it, and who may put something on it.
//
// Same stand-in database as the other route tests — each test seeds the rows a
// table should return, and every insert is recorded so we can check what the
// route wrote.
// ---------------------------------------------------------------------------

type QueryResult = { data: unknown; error: unknown };

let supabaseState: {
    rpc: QueryResult;
    tables: Record<string, QueryResult>;
    inserts: { table: string; payload: unknown }[];
};

function resetSupabaseState() {
    supabaseState = { rpc: { data: [], error: null }, tables: {}, inserts: [] };
}
resetSupabaseState();

function resultForTable(table: string): QueryResult {
    return supabaseState.tables[table] ?? { data: null, error: null };
}

function makeQuery(table: string) {
    const q: Record<string, unknown> = {};
    for (const method of [
        "select",
        "update",
        "delete",
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
        rpc: vi.fn(() => Promise.resolve(supabaseState.rpc)),
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

vi.mock("../../lib/access", () => ({
    checkProjectAccess: vi.fn(async () => ({ ok: false })),
    ensureDocAccess: vi.fn(async () => ({ ok: true, isOwner: true })),
    ensureDocReadAccess: vi.fn(async () => ({ ok: true, isOwner: true })),
    ensureReviewAccess: vi.fn(async () => ({ ok: true, isOwner: true })),
    filterAccessibleDocumentIds: vi.fn(async (ids: string[]) => ids),
    listAccessibleProjectIds: vi.fn(async () => []),
}));

vi.mock("../../lib/documentVersions", () => ({
    attachActiveVersionPaths: vi.fn(async () => {}),
    attachLatestVersionNumbers: vi.fn(async () => {}),
    contentSha256: vi.fn(() => "0".repeat(64)),
    loadActiveVersion: vi.fn(async () => null),
}));

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

describe("the firm library", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetSupabaseState();
        clearFirmCaches();
    });

    describe("reading it", () => {
        it("lets an attorney at the firm see what is on the shelves", async () => {
            memberIs("attorney");
            supabaseState.tables.documents = { data: [], error: null };
            supabaseState.tables.library_folders = { data: [], error: null };

            const res = await request(app)
                .get("/library/templates?scope=firm")
                .set(...AUTH);

            expect(res.status).toBe(200);
        });

        it("marks what comes back as the firm's", async () => {
            memberIs("attorney");
            supabaseState.tables.documents = {
                data: [{ id: "d1", library_folder_id: null }],
                error: null,
            };
            supabaseState.tables.library_folders = { data: [], error: null };

            const res = await request(app)
                .get("/library/templates?scope=firm")
                .set(...AUTH);

            expect(res.body.documents[0].scope).toBe("firm");
        });

        it("marks your own shelves as your own", async () => {
            memberIs("attorney");
            supabaseState.tables.documents = {
                data: [{ id: "d1", library_folder_id: null }],
                error: null,
            };
            supabaseState.tables.library_folders = { data: [], error: null };

            const res = await request(app)
                .get("/library/templates")
                .set(...AUTH);

            expect(res.body.documents[0].scope).toBe("personal");
        });

        it("turns away somebody who does not work at the firm", async () => {
            memberIs(null);

            const res = await request(app)
                .get("/library/templates?scope=firm")
                .set(...AUTH);

            expect(res.status).toBe(403);
        });

        it("turns away somebody who has left", async () => {
            memberIs("admin", { status: "deactivated" });

            const res = await request(app)
                .get("/library/templates?scope=firm")
                .set(...AUTH);

            expect(res.status).toBe(403);
        });
    });

    describe("changing it", () => {
        it("does not let an ordinary attorney add a folder", async () => {
            memberIs("attorney");

            const res = await request(app)
                .post("/library/templates/folders")
                .set(...AUTH)
                .send({ name: "Letterhead", scope: "firm" });

            expect(res.status).toBe(403);
        });

        it("lets an administrator add one", async () => {
            memberIs("admin");
            supabaseState.tables.library_folders = {
                data: { id: "f1", name: "Letterhead" },
                error: null,
            };

            const res = await request(app)
                .post("/library/templates/folders")
                .set(...AUTH)
                .send({ name: "Letterhead", scope: "firm" });

            expect(res.status).toBe(201);
            expect(res.body.scope).toBe("firm");
            expect(supabaseState.inserts[0].payload).toMatchObject({
                firm_id: FIRM,
                library_kind: "template",
            });
        });

        it("lets somebody given the job add one", async () => {
            memberIs("paralegal", { canEditFirmLibrary: true });
            supabaseState.tables.library_folders = {
                data: { id: "f1", name: "Letterhead" },
                error: null,
            };

            const res = await request(app)
                .post("/library/templates/folders")
                .set(...AUTH)
                .send({ name: "Letterhead", scope: "firm" });

            expect(res.status).toBe(201);
        });

        it("leaves a personal folder with no firm on it", async () => {
            memberIs("attorney");
            supabaseState.tables.library_folders = {
                data: { id: "f1", name: "Mine" },
                error: null,
            };

            const res = await request(app)
                .post("/library/templates/folders")
                .set(...AUTH)
                .send({ name: "Mine" });

            expect(res.status).toBe(201);
            expect(supabaseState.inserts[0].payload).toMatchObject({
                firm_id: null,
            });
        });

        it("does not let an ordinary attorney delete from the firm shelves", async () => {
            memberIs("attorney");

            const res = await request(app)
                .post("/library/templates/documents/bulk-delete")
                .set(...AUTH)
                .send({ ids: ["d1"], scope: "firm" });

            expect(res.status).toBe(403);
        });
    });

    describe("putting something on the shelves", () => {
        it("turns away somebody who does not work at the firm", async () => {
            memberIs(null);

            const res = await request(app)
                .post("/library/documents/d1/publish")
                .set(...AUTH)
                .send({});

            expect(res.status).toBe(403);
        });

        it("says nothing about a document the person cannot read", async () => {
            memberIs("attorney");
            supabaseState.tables.documents = {
                data: {
                    id: "d1",
                    user_id: "someone-else",
                    project_id: null,
                    firm_id: null,
                },
                error: null,
            };

            const res = await request(app)
                .post("/library/documents/d1/publish")
                .set(...AUTH)
                .send({});

            expect(res.status).toBe(404);
        });

        it("refuses to publish what is already the firm's", async () => {
            memberIs("attorney");
            supabaseState.tables.documents = {
                data: {
                    id: "d1",
                    user_id: "u1",
                    project_id: null,
                    firm_id: FIRM,
                },
                error: null,
            };

            const res = await request(app)
                .post("/library/documents/d1/publish")
                .set(...AUTH)
                .send({});

            expect(res.status).toBe(409);
        });
    });
});
