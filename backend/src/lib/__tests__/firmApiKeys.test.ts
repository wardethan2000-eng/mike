import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "crypto";
import { getUserApiKeys, getUserApiKeyStatus } from "../userApiKeys";
import { clearFirmCaches } from "../firm";

/**
 * Which key gets used: your own first, then the firm's, then whatever the
 * server was started with. Everything below encrypts its rows the same way the
 * real code does, so the decryption path is exercised rather than stubbed.
 */

const SECRET = "test-secret-for-firm-keys";

function encrypt(value: string) {
    const key = crypto.scryptSync(SECRET, "mike-user-api-keys-v1", 32);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
    ]);
    return {
        encrypted_key: encrypted.toString("base64"),
        iv: iv.toString("base64"),
        auth_tag: cipher.getAuthTag().toString("base64"),
    };
}

type Row = Record<string, unknown>;

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
                maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
                single: async () => ({ data: rows[0] ?? null, error: null }),
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

function db(options: { mine?: string; firm?: string } = {}) {
    return makeDb({
        firms: [{ id: FIRM, name: "Test Firm" }],
        firm_members: [
            { firm_id: FIRM, user_id: "me", role: "attorney", status: "active" },
        ],
        user_api_keys: options.mine
            ? [{ user_id: "me", provider: "claude", ...encrypt(options.mine) }]
            : [],
        firm_api_keys: options.firm
            ? [{ firm_id: FIRM, provider: "claude", ...encrypt(options.firm) }]
            : [],
    });
}

describe("which key gets used", () => {
    beforeEach(() => {
        clearFirmCaches();
        process.env.USER_API_KEYS_ENCRYPTION_SECRET = SECRET;
        delete process.env.ANTHROPIC_API_KEY;
        delete process.env.CLAUDE_API_KEY;
    });

    afterEach(() => {
        delete process.env.USER_API_KEYS_ENCRYPTION_SECRET;
        delete process.env.ANTHROPIC_API_KEY;
        clearFirmCaches();
    });

    it("uses your own key when you have one", async () => {
        process.env.ANTHROPIC_API_KEY = "from-the-server";
        const keys = await getUserApiKeys(
            "me",
            db({ mine: "my-own-key", firm: "the-firms-key" }),
        );
        expect(keys.claude).toBe("my-own-key");
    });

    it("falls back to the firm's key when you have none", async () => {
        process.env.ANTHROPIC_API_KEY = "from-the-server";
        const keys = await getUserApiKeys("me", db({ firm: "the-firms-key" }));
        expect(keys.claude).toBe("the-firms-key");
    });

    it("falls back to the server's own setting when neither is set", async () => {
        process.env.ANTHROPIC_API_KEY = "from-the-server";
        const keys = await getUserApiKeys("me", db());
        expect(keys.claude).toBe("from-the-server");
    });

    it("comes back empty when nothing anywhere has a key", async () => {
        const keys = await getUserApiKeys("me", db());
        expect(keys.claude).toBeNull();
    });

    it("does not hand somebody outside the firm the firm's key", async () => {
        const keys = await getUserApiKeys(
            "stranger",
            db({ firm: "the-firms-key" }),
        );
        expect(keys.claude).toBeNull();
    });

    it("says where each key is coming from", async () => {
        process.env.ANTHROPIC_API_KEY = "from-the-server";
        const status = await getUserApiKeyStatus(
            "me",
            db({ firm: "the-firms-key" }),
        );
        expect(status.claude).toBe(true);
        expect(status.sources.claude).toBe("firm");
    });

    it("says it is yours when it is yours", async () => {
        const status = await getUserApiKeyStatus(
            "me",
            db({ mine: "my-own-key", firm: "the-firms-key" }),
        );
        expect(status.sources.claude).toBe("user");
    });

    it("says it is the server's when that is all there is", async () => {
        process.env.ANTHROPIC_API_KEY = "from-the-server";
        const status = await getUserApiKeyStatus("me", db());
        expect(status.sources.claude).toBe("env");
    });
});
