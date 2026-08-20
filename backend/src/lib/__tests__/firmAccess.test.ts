import { beforeEach, describe, expect, it } from "vitest";
import { checkProjectAccess, listAccessibleProjectIds } from "../access";
import { clearFirmCaches } from "../firm";

type Row = Record<string, unknown>;

/**
 * Same shape of stand-in database as access.test.ts, with `maybeSingle` added
 * because looking up who someone works for asks for one row that may not be
 * there.
 */
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
                maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
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
    } as any;
}

const FIRM = "firm-1";

function db() {
    return makeDb({
        firms: [{ id: FIRM, name: "Test Firm" }],
        firm_members: [
            { firm_id: FIRM, user_id: "owner", role: "attorney", status: "active" },
            {
                firm_id: FIRM,
                user_id: "colleague",
                role: "attorney",
                status: "active",
            },
            {
                firm_id: FIRM,
                user_id: "departed",
                role: "attorney",
                status: "deactivated",
            },
            {
                firm_id: "other-firm",
                user_id: "stranger",
                role: "attorney",
                status: "active",
            },
        ],
        projects: [
            {
                id: "firm-matter",
                user_id: "owner",
                shared_with: [],
                visibility: "firm",
                firm_id: FIRM,
            },
            {
                id: "private-matter",
                user_id: "owner",
                shared_with: [],
                visibility: "private",
                firm_id: FIRM,
            },
            {
                id: "named-matter",
                user_id: "owner",
                shared_with: ["colleague@example.com"],
                visibility: "private",
                firm_id: FIRM,
            },
        ],
    });
}

describe("who can open a matter", () => {
    beforeEach(() => {
        clearFirmCaches();
    });

    it("lets a colleague at the firm open a firm matter", async () => {
        await expect(
            checkProjectAccess(
                "firm-matter",
                "colleague",
                "colleague@example.com",
                db(),
            ),
        ).resolves.toMatchObject({ ok: true, isOwner: false });
    });

    it("keeps a private matter private, even from the same firm", async () => {
        await expect(
            checkProjectAccess(
                "private-matter",
                "colleague",
                "colleague@example.com",
                db(),
            ),
        ).resolves.toEqual({ ok: false });
    });

    it("still lets someone named on a private matter open it", async () => {
        await expect(
            checkProjectAccess(
                "named-matter",
                "colleague",
                "colleague@example.com",
                db(),
            ),
        ).resolves.toMatchObject({ ok: true, isOwner: false });
    });

    it("shuts out somebody who has left the firm", async () => {
        await expect(
            checkProjectAccess(
                "firm-matter",
                "departed",
                "departed@example.com",
                db(),
            ),
        ).resolves.toEqual({ ok: false });
    });

    it("shuts out somebody from a different firm", async () => {
        await expect(
            checkProjectAccess(
                "firm-matter",
                "stranger",
                "stranger@example.com",
                db(),
            ),
        ).resolves.toEqual({ ok: false });
    });

    it("shuts out somebody who belongs to no firm at all", async () => {
        await expect(
            checkProjectAccess(
                "firm-matter",
                "nobody",
                "nobody@example.com",
                db(),
            ),
        ).resolves.toEqual({ ok: false });
    });

    it("still marks the responsible attorney as the owner", async () => {
        await expect(
            checkProjectAccess("firm-matter", "owner", "owner@example.com", db()),
        ).resolves.toMatchObject({ ok: true, isOwner: true });
    });

    it("lists firm matters alongside one's own and those shared by name", async () => {
        const ids = await listAccessibleProjectIds(
            "colleague",
            "colleague@example.com",
            db(),
        );
        expect(ids.sort()).toEqual(["firm-matter", "named-matter"]);
    });

    it("lists nothing extra for someone who has left", async () => {
        const ids = await listAccessibleProjectIds(
            "departed",
            "departed@example.com",
            db(),
        );
        expect(ids).toEqual([]);
    });
});
