/**
 * Firm membership — who belongs to the firm, and what they are allowed to do.
 *
 * Mike started as single-user accounts: everything was "mine", and sharing
 * meant naming someone's email on one matter. A firm needs the opposite
 * default, so every account now belongs to a firm with a role, and matters can
 * be visible to the whole firm.
 *
 * There is exactly one firm per installation. `getFirm` reflects that: it
 * returns the row rather than taking an id. Everything else keys off `firm_id`
 * already, so a second firm would be a data question rather than a rewrite.
 *
 * Membership is read on nearly every request, so both lookups are cached for a
 * few seconds. The cache is not a security boundary: shutting someone out
 * happens in the auth provider (the account is banned), which takes effect on
 * the next request regardless of what is cached here. Mutating routes still
 * call `clearMembershipCache` so the UI reflects a change immediately.
 */

import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

export const FIRM_ROLES = ["admin", "attorney", "paralegal"] as const;
export type FirmRole = (typeof FIRM_ROLES)[number];

export const FIRM_MEMBER_STATUSES = ["active", "deactivated"] as const;
export type FirmMemberStatus = (typeof FIRM_MEMBER_STATUSES)[number];

export type FirmMembership = {
    firmId: string;
    userId: string;
    role: FirmRole;
    status: FirmMemberStatus;
    canEditFirmLibrary: boolean;
};

export type Firm = {
    id: string;
    name: string;
    address_lines: string[] | null;
    phone: string | null;
    website: string | null;
    default_jurisdiction: string | null;
    citation_style: string | null;
    standing_instructions: string | null;
    drafting_defaults: Record<string, unknown> | null;
    allowed_models: string[] | null;
};

export function isFirmRole(value: unknown): value is FirmRole {
    return (
        typeof value === "string" && (FIRM_ROLES as readonly string[]).includes(value)
    );
}

export function isFirmMemberStatus(value: unknown): value is FirmMemberStatus {
    return (
        typeof value === "string" &&
        (FIRM_MEMBER_STATUSES as readonly string[]).includes(value)
    );
}

const CACHE_TTL_MS = 15_000;

type CacheEntry<T> = { value: T; expiresAt: number };

const membershipCache = new Map<string, CacheEntry<FirmMembership | null>>();
let firmCache: CacheEntry<Firm | null> | undefined;

export function clearMembershipCache(userId?: string): void {
    if (userId) membershipCache.delete(userId);
    else membershipCache.clear();
}

export function clearFirmCache(): void {
    firmCache = undefined;
}

/** Test seam — drops every cached lookup. */
export function clearFirmCaches(): void {
    clearMembershipCache();
    clearFirmCache();
}

const FIRM_COLUMNS =
    "id, name, address_lines, phone, website, default_jurisdiction, citation_style, standing_instructions, drafting_defaults, allowed_models";

/**
 * Both lookups answer "nobody" rather than failing when the firm tables cannot
 * be read — before the migration has run, or during a database hiccup. Nobody
 * is the safe answer: it costs a member sight of the firm's shared matters for
 * a moment, where the other direction would hand out access nobody has.
 */
export async function getFirm(db: Db): Promise<Firm | null> {
    const now = Date.now();
    if (firmCache && firmCache.expiresAt > now) return firmCache.value;

    let firm: Firm | null = null;
    try {
        const { data, error } = await db
            .from("firms")
            .select(FIRM_COLUMNS)
            .order("created_at", { ascending: true })
            .limit(1)
            .maybeSingle();
        firm = error ? null : ((data as Firm | null) ?? null);
    } catch {
        firm = null;
    }
    firmCache = { value: firm, expiresAt: now + CACHE_TTL_MS };
    return firm;
}

export async function getMembership(
    db: Db,
    userId: string,
): Promise<FirmMembership | null> {
    if (!userId) return null;
    const now = Date.now();
    const cached = membershipCache.get(userId);
    if (cached && cached.expiresAt > now) return cached.value;

    let membership: FirmMembership | null = null;
    try {
        const { data, error } = await db
            .from("firm_members")
            .select("firm_id, user_id, role, status, can_edit_firm_library")
            .eq("user_id", userId)
            .maybeSingle();

        if (!error && data) {
            const row = data as {
                firm_id: string;
                user_id: string;
                role: string;
                status: string;
                can_edit_firm_library: boolean | null;
            };
            membership = {
                firmId: row.firm_id,
                userId: row.user_id,
                role: isFirmRole(row.role) ? row.role : "attorney",
                status: isFirmMemberStatus(row.status) ? row.status : "active",
                canEditFirmLibrary: row.can_edit_firm_library === true,
            };
        }
    } catch {
        membership = null;
    }
    membershipCache.set(userId, {
        value: membership,
        expiresAt: now + CACHE_TTL_MS,
    });
    return membership;
}

export function isActiveMember(
    membership: FirmMembership | null,
): membership is FirmMembership {
    return !!membership && membership.status === "active";
}

export function isFirmAdmin(membership: FirmMembership | null): boolean {
    return isActiveMember(membership) && membership.role === "admin";
}

/**
 * The firm whose shared matters this user may see, or null when they are not
 * an active member. Deactivated members are deliberately treated as outsiders.
 */
export async function getActiveFirmId(
    db: Db,
    userId: string,
): Promise<string | null> {
    const membership = await getMembership(db, userId);
    return isActiveMember(membership) ? membership.firmId : null;
}

/**
 * Count of active admins, used to refuse the change that would leave the firm
 * with nobody who can administer it.
 */
export async function countActiveAdmins(db: Db, firmId: string): Promise<number> {
    const { count, error } = await db
        .from("firm_members")
        .select("user_id", { count: "exact", head: true })
        .eq("firm_id", firmId)
        .eq("role", "admin")
        .eq("status", "active");
    if (error) return 0;
    return count ?? 0;
}
