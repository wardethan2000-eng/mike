import { beforeEach, describe, expect, it } from "vitest";
import {
    applyLibraryScope,
    canEditFirmLibrary,
    parseLibraryScope,
    resolveLibraryScope,
} from "../firmLibrary";
import { filterAccessibleDocumentIds } from "../access";
import { clearFirmCaches } from "../firm";

type Row = Record<string, unknown>;

/** The same stand-in database used by the matter-access tests. */
function makeDb(tables: Record<string, Row[]>) {
    return {
        from(table: string) {
            let rows = [...(tables[table] ?? [])];
            const query = {
                select: () => query,
                order: () => query,
                limit: () => query,
                eq: (column: string, value: unknown) => {
                    rows = rows.filter((row) => row[column] === value);
                    return query;
                },
                neq: (column: string, value: unknown) => {
                    rows = rows.filter((row) => row[column] !== value);
                    return query;
                },
                is: (column: string, value: unknown) => {
                    rows = rows.filter(
                        (row) => (row[column] ?? null) === value,
                    );
                    return query;
                },
                in: (column: string, values: unknown[]) => {
                    rows = rows.filter((row) => values.includes(row[column]));
                    return query;
                },
                filter: (column: string, operator: string, value: string) => {
                    if (operator !== "cs") return query;
                    const expected = JSON.parse(value) as string[];
                    rows = rows.filter((row) => {
                        const actual = row[column];
                        return (
                            Array.isArray(actual) &&
                            expected.every((item) => actual.includes(item))
                        );
                    });
                    return query;
                },
                single: async () => ({ data: rows[0] ?? null, error: null }),
                maybeSingle: async () => ({
                    data: rows[0] ?? null,
                    error: null,
                }),
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
    } as never;
}

const FIRM = "firm-1";

function db() {
    return makeDb({
        firms: [{ id: FIRM, name: "Test Firm" }],
        firm_members: [
            {
                firm_id: FIRM,
                user_id: "boss",
                role: "admin",
                status: "active",
                can_edit_firm_library: false,
            },
            {
                firm_id: FIRM,
                user_id: "keeper",
                role: "paralegal",
                status: "active",
                can_edit_firm_library: true,
            },
            {
                firm_id: FIRM,
                user_id: "colleague",
                role: "attorney",
                status: "active",
                can_edit_firm_library: false,
            },
            {
                firm_id: FIRM,
                user_id: "departed",
                role: "attorney",
                status: "deactivated",
                can_edit_firm_library: true,
            },
            {
                firm_id: "other-firm",
                user_id: "stranger",
                role: "admin",
                status: "active",
                can_edit_firm_library: true,
            },
        ],
        projects: [],
        documents: [
            {
                id: "firm-letterhead",
                user_id: "boss",
                project_id: null,
                firm_id: FIRM,
            },
            {
                id: "someone-elses",
                user_id: "boss",
                project_id: null,
                firm_id: null,
            },
        ],
    });
}

describe("which half of the library a request is about", () => {
    beforeEach(() => {
        clearFirmCaches();
    });

    it("reads it as personal unless the firm is asked for", () => {
        expect(parseLibraryScope(undefined)).toBe("personal");
        expect(parseLibraryScope("personal")).toBe("personal");
        expect(parseLibraryScope("anything else")).toBe("personal");
        expect(parseLibraryScope("firm")).toBe("firm");
    });

    it("lets anyone read and write their own shelves", async () => {
        await expect(
            resolveLibraryScope(db(), "colleague", undefined),
        ).resolves.toEqual({ scope: "personal", firmId: null, canWrite: true });
    });

    it("lets an attorney read the firm's shelves but not change them", async () => {
        await expect(
            resolveLibraryScope(db(), "colleague", "firm"),
        ).resolves.toEqual({ scope: "firm", firmId: FIRM, canWrite: false });
    });

    it("lets an administrator change the firm's shelves", async () => {
        await expect(
            resolveLibraryScope(db(), "boss", "firm"),
        ).resolves.toMatchObject({ canWrite: true });
    });

    it("lets someone given the job change them too", async () => {
        await expect(
            resolveLibraryScope(db(), "keeper", "firm"),
        ).resolves.toMatchObject({ canWrite: true });
    });

    it("shuts out someone who has left the firm", async () => {
        await expect(
            resolveLibraryScope(db(), "departed", "firm"),
        ).resolves.toBeNull();
    });

    it("shuts out someone who belongs to no firm", async () => {
        await expect(
            resolveLibraryScope(db(), "nobody", "firm"),
        ).resolves.toBeNull();
    });

    it("says nobody outside the firm may edit it", () => {
        expect(canEditFirmLibrary(null)).toBe(false);
    });
});

describe("narrowing a query to one half of the library", () => {
    function recorder() {
        const calls: [string, unknown][] = [];
        const query = {
            eq(column: string, value: unknown) {
                calls.push([column, value]);
                return query;
            },
            is(column: string, value: unknown) {
                calls.push([column, value]);
                return query;
            },
        };
        return { calls, query };
    }

    it("asks for this person's own rows, and only ones with no firm on them", () => {
        const { calls, query } = recorder();
        applyLibraryScope(
            query,
            { scope: "personal", firmId: null, canWrite: true },
            "colleague",
        );
        expect(calls).toEqual([
            ["user_id", "colleague"],
            ["firm_id", null],
        ]);
    });

    it("asks for the firm's rows whoever is looking", () => {
        const { calls, query } = recorder();
        applyLibraryScope(
            query,
            { scope: "firm", firmId: FIRM, canWrite: false },
            "colleague",
        );
        expect(calls).toEqual([["firm_id", FIRM]]);
    });
});

describe("documents a chat is allowed to open", () => {
    beforeEach(() => {
        clearFirmCaches();
    });

    it("keeps a firm template attached by a colleague", async () => {
        await expect(
            filterAccessibleDocumentIds(
                ["firm-letterhead"],
                "colleague",
                "colleague@example.com",
                db(),
            ),
        ).resolves.toEqual(["firm-letterhead"]);
    });

    it("does not hand a firm template to somebody outside the firm", async () => {
        await expect(
            filterAccessibleDocumentIds(
                ["firm-letterhead"],
                "stranger",
                "stranger@example.com",
                db(),
            ),
        ).resolves.toEqual([]);
    });

    it("does not hand over somebody's private library file", async () => {
        await expect(
            filterAccessibleDocumentIds(
                ["someone-elses"],
                "colleague",
                "colleague@example.com",
                db(),
            ),
        ).resolves.toEqual([]);
    });

    it("still hands over your own", async () => {
        await expect(
            filterAccessibleDocumentIds(
                ["someone-elses"],
                "boss",
                "boss@example.com",
                db(),
            ),
        ).resolves.toEqual(["someone-elses"]);
    });
});
