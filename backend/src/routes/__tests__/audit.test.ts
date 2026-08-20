import { describe, it, expect } from "vitest";
import {
    csvCell,
    escapeLikePattern,
    parseQuery,
    queryEvents,
    accessibleProjectIds,
} from "../audit";

// ---------------------------------------------------------------------------
// csvCell — spreadsheet formula-injection escaping (F3)
// ---------------------------------------------------------------------------

describe("csvCell", () => {
    it("prefixes a single quote to values that begin with a formula trigger", () => {
        for (const trigger of ["=", "+", "-", "@", "\t", "\r"]) {
            const payload = `${trigger}HYPERLINK("http://evil","x")`;
            const cell = csvCell(payload);
            // Leading quote neutralizes evaluation; the whole value is then
            // quoted because it contains characters requiring CSV quoting.
            expect(cell.startsWith(`"'${trigger}`)).toBe(true);
        }
    });

    it("neutralizes a bare leading = even without other special chars", () => {
        expect(csvCell("=1")).toBe("'=1");
    });

    it("quotes and escapes embedded quotes, commas, and newlines", () => {
        expect(csvCell("a,b")).toBe('"a,b"');
        expect(csvCell('he said "hi"')).toBe('"he said ""hi"""');
        expect(csvCell("line1\r\nline2")).toBe('"line1\r\nline2"');
    });

    it("leaves ordinary values untouched and renders null as empty", () => {
        expect(csvCell("brief.docx")).toBe("brief.docx");
        expect(csvCell(null)).toBe("");
        expect(csvCell(undefined)).toBe("");
    });
});

// ---------------------------------------------------------------------------
// parseQuery — page clamping (F7) + date validation (F8)
// ---------------------------------------------------------------------------

describe("parseQuery", () => {
    it("clamps an absurd page so the offset can't overflow", () => {
        const result = parseQuery({ page: "99999999999999" }, 50);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.query.page).toBe(100_000);
            // offset stays well within Postgres' integer range.
            expect((result.query.page - 1) * result.query.limit).toBeLessThan(
                2_147_483_647,
            );
        }
    });

    it("floors non-positive or non-numeric pages to 1", () => {
        for (const page of ["0", "-5", "abc", ""]) {
            const result = parseQuery({ page }, 50);
            expect(result.ok && result.query.page).toBe(1);
        }
    });

    it("narrows to one matter when asked for", () => {
        const result = parseQuery(
            { project: "3f2504e0-4f89-11d3-9a0c-0305e82c3301" },
            50,
        );
        expect(result.ok && result.query.projectId).toBe(
            "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
        );
    });

    it("refuses a matter id that is not one", () => {
        // Passed straight through, Postgres would answer a malformed id with a
        // 500 rather than an honest "bad request".
        const result = parseQuery({ project: "not-a-matter" }, 50);
        expect(result.ok).toBe(false);
    });

    it("takes a precise instant as well as a bare day", () => {
        // The list has to be able to mean "up to the end of today where the
        // reader is sitting", which is not the end of the day in UTC.
        const result = parseQuery({ to: "2026-07-30T12:00:00Z" }, 50);
        expect(result.ok && result.query.to).toBe("2026-07-30T12:00:00Z");
        const withMillis = parseQuery({ to: "2026-07-30T23:59:59.999Z" }, 50);
        expect(withMillis.ok && withMillis.query.to).toBe(
            "2026-07-30T23:59:59.999Z",
        );
    });

    it("rejects from/to that are neither a day nor an instant", () => {
        // A half-formed value would be pasted into the comparison string and
        // blow up as a 500, so it has to be refused here.
        for (const bad of [
            "not-a-date",
            "2026-07-30T12:00:00",
            "2026-07-30T",
            "2026-7-3",
        ]) {
            expect(parseQuery({ from: bad }, 50)).toEqual({
                ok: false,
                error: expect.stringContaining("from"),
            });
            expect(parseQuery({ to: bad }, 50)).toEqual({
                ok: false,
                error: expect.stringContaining("to"),
            });
        }
    });

    it("accepts well-formed dates and trims free-text filters", () => {
        const result = parseQuery(
            {
                from: "2026-07-01",
                to: "2026-07-31",
                q: "  hello  ",
                action: " chat.message ",
                status: " completed ",
                surface: " project ",
                sort_by: "title",
                sort_dir: "asc",
            },
            50,
        );
        expect(result).toMatchObject({
            ok: true,
            query: {
                from: "2026-07-01",
                to: "2026-07-31",
                q: "hello",
                action: "chat.message",
                status: "completed",
                surface: "project",
                sortBy: "title",
                sortDirection: "asc",
            },
        });
    });

    it("rejects unsupported sort fields and directions", () => {
        expect(parseQuery({ sort_by: "detail" }, 50)).toEqual({
            ok: false,
            error: "Invalid audit sort field",
        });
        expect(parseQuery({ sort_dir: "sideways" }, 50)).toEqual({
            ok: false,
            error: "Invalid audit sort direction",
        });
    });
});

// ---------------------------------------------------------------------------
// queryEvents / accessibleProjectIds — visibility scoping
// ---------------------------------------------------------------------------

/**
 * Chainable Supabase mock. `projects` select responses are keyed by whether the
 * query filtered on the owner (owned) or on who is named on the matter
 * (shared). The audit_events builder records the .or / .eq filter it was given
 * so tests can assert scoping.
 *
 * Anything else — including the firm-membership lookup — falls through to the
 * audit builder, which cannot answer a single-row read, so these tests stand
 * for someone who belongs to no firm. Firm-wide visibility is covered in
 * lib/__tests__/firmAccess.test.ts.
 */
function makeDb(
    owned: string[],
    shared: string[],
    events: Record<string, unknown>[] = [],
    profiles: Record<string, unknown>[] = [],
) {
    const calls: {
        or?: string;
        eq: [string, unknown][];
        order?: [string, { ascending: boolean; nullsFirst: boolean }];
        ilike?: [string, string];
        profileUserIds?: string[];
    } = { eq: [] };

    function projectsBuilder() {
        let mode: "owned" | "shared" = "owned";
        const b: any = {
            select: () => b,
            eq: () => {
                mode = "owned";
                return b;
            },
            neq: () => b,
            contains: () => {
                mode = "shared";
                return b;
            },
            // How the shared-matter lookup is written today: a containment
            // filter on the list of people named on the matter.
            filter: (_column: string, operator: string) => {
                if (operator === "cs") mode = "shared";
                return b;
            },
            then: (resolve: (v: { data: { id: string }[] }) => unknown) =>
                Promise.resolve({
                    data: (mode === "owned" ? owned : shared).map((id) => ({
                        id,
                    })),
                }).then(resolve),
        };
        return b;
    }

    function auditBuilder() {
        const b: any = {
            select: () => b,
            or: (expr: string) => {
                calls.or = expr;
                return b;
            },
            eq: (col: string, val: unknown) => {
                calls.eq.push([col, val]);
                return b;
            },
            ilike: (column: string, pattern: string) => {
                calls.ilike = [column, pattern];
                return b;
            },
            gte: () => b,
            lte: () => b,
            order: (
                column: string,
                options: { ascending: boolean; nullsFirst: boolean },
            ) => {
                calls.order = [column, options];
                return b;
            },
            range: () =>
                Promise.resolve({
                    data: events,
                    error: null,
                    count: events.length,
                }),
        };
        return b;
    }

    function profilesBuilder() {
        const b: any = {
            select: () => b,
            in: (_column: string, userIds: string[]) => {
                calls.profileUserIds = userIds;
                return Promise.resolve({ data: profiles, error: null });
            },
        };
        return b;
    }

    // Nobody here belongs to a firm, so the only matters in play are one's own
    // and those one is named on. Firm-wide visibility has its own tests in
    // lib/__tests__/firmAccess.test.ts.
    function firmMembersBuilder() {
        const b: any = {
            select: () => b,
            eq: () => b,
            maybeSingle: async () => ({ data: null, error: null }),
        };
        return b;
    }

    const db = {
        from(table: string) {
            if (table === "projects") return projectsBuilder();
            if (table === "user_profiles") return profilesBuilder();
            if (table === "firm_members") return firmMembersBuilder();
            return auditBuilder();
        },
    };
    return { db: db as any, calls };
}

describe("queryEvents visibility scoping", () => {
    const query = {
        page: 1,
        limit: 50,
        sortBy: "created_at",
        sortDirection: "desc",
    } as const;

    it("scopes to own events OR accessible project events (owned + shared)", async () => {
        const { db, calls } = makeDb(["p-own"], ["p-shared"]);
        await queryEvents(db, "u1", "u1@example.com", query);
        expect(calls.or).toBe("user_id.eq.u1,project_id.in.(p-own,p-shared)");
        expect(calls.eq).toEqual([]);
    });

    it("falls back to own-events-only when no projects are accessible", async () => {
        const { db, calls } = makeDb([], []);
        await queryEvents(db, "u1", "u1@example.com", query);
        expect(calls.or).toBeUndefined();
        expect(calls.eq).toContainEqual(["user_id", "u1"]);
    });

    it("de-duplicates owned and shared project ids", async () => {
        const both = await accessibleProjectIds(
            makeDb(["p1", "p2"], ["p2", "p3"]).db,
            "u1",
            "u1@example.com",
        );
        expect([...both].sort()).toEqual(["p1", "p2", "p3"]);
    });

    it("applies categorical filters and the requested sort", async () => {
        const { db, calls } = makeDb([], []);
        await queryEvents(db, "u1", "u1@example.com", {
            ...query,
            action: "document.uploaded",
            status: "completed",
            surface: "project",
            q: "agreement\\draft_100%",
            sortBy: "title",
            sortDirection: "asc",
        });

        expect(calls.eq).toEqual(
            expect.arrayContaining([
                ["user_id", "u1"],
                ["action", "document.uploaded"],
                ["status", "completed"],
                ["surface", "project"],
            ]),
        );
        expect(calls.order).toEqual([
            "title",
            { ascending: true, nullsFirst: false },
        ]);
        expect(calls.ilike).toEqual([
            "title",
            "%agreement\\\\draft\\_100\\%%",
        ]);
    });

    it("resolves display names for only the users on the requested page", async () => {
        const events = [
            {
                id: "event-1",
                user_id: "u1",
                user_email: "one@example.com",
            },
            {
                id: "event-2",
                user_id: "u2",
                user_email: "two@example.com",
            },
        ];
        const { db, calls } = makeDb([], [], events, [
            { user_id: "u1", display_name: "  Alex Lawyer  " },
        ]);

        const result = await queryEvents(db, "u1", "one@example.com", query);

        expect(calls.profileUserIds).toEqual(["u1", "u2"]);
        expect(result.data).toEqual([
            {
                id: "event-1",
                user_email: "one@example.com",
                user_display_name: "Alex Lawyer",
            },
            {
                id: "event-2",
                user_email: "two@example.com",
                user_display_name: null,
            },
        ]);
    });

    it("can skip profile resolution for the larger export query", async () => {
        const { db, calls } = makeDb(
            [],
            [],
            [{ id: "event-1", user_id: "u1", user_email: "one@example.com" }],
        );

        const result = await queryEvents(
            db,
            "u1",
            "one@example.com",
            query,
            false,
        );

        expect(calls.profileUserIds).toBeUndefined();
        expect(result.data).toEqual([
            {
                id: "event-1",
                user_email: "one@example.com",
                user_display_name: null,
            },
        ]);
    });
});
