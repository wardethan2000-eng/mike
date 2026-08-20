/**
 * Project / document access helpers.
 *
 * A matter can be opened by three sorts of person: the attorney responsible
 * for it, anyone named on it by email, and — when the matter is the firm's
 * rather than private — anyone still working at the firm. These helpers hold
 * that rule once so every route asks the same question instead of
 * re-implementing the join.
 *
 * The same rule is written once more in SQL, as `public.can_access_project`,
 * for the list queries that run entirely in the database. Change one, change
 * the other.
 *
 * Returned `isOwner` lets callers gate operations that should stay with the
 * responsible attorney (delete, rename, changing who can see it). Firm
 * administrators are allowed past those gates separately, by asking
 * `isFirmAdmin`.
 */

import type { createServerSupabase } from "./supabase";
import { getActiveFirmId } from "./firm";

type Db = ReturnType<typeof createServerSupabase>;

export type ProjectAccess =
    | {
          ok: true;
          isOwner: boolean;
          project: {
              id: string;
              user_id: string;
              shared_with: string[] | null;
              visibility?: string | null;
              firm_id?: string | null;
          };
      }
    | { ok: false };

/** Does this matter's own record put it in reach of everyone at the firm? */
export function isFirmVisible(project: {
    visibility?: string | null;
    firm_id?: string | null;
}): boolean {
    return project.visibility === "firm" && !!project.firm_id;
}

export async function checkProjectAccess(
    projectId: string,
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<ProjectAccess> {
    const { data: project } = await db
        .from("projects")
        .select("id, user_id, shared_with, visibility, firm_id")
        .eq("id", projectId)
        .single();
    if (!project) return { ok: false };
    const proj = project as {
        id: string;
        user_id: string;
        shared_with: string[] | null;
        visibility: string | null;
        firm_id: string | null;
    };
    if (proj.user_id === userId) {
        return { ok: true, isOwner: true, project: proj };
    }
    const sharedWith = Array.isArray(proj.shared_with) ? proj.shared_with : [];
    const email = (userEmail ?? "").trim().toLowerCase();
    if (
        email &&
        sharedWith.some((e) => (e ?? "").toLowerCase() === email)
    ) {
        return { ok: true, isOwner: false, project: proj };
    }
    if (isFirmVisible(proj)) {
        const firmId = await getActiveFirmId(db, userId);
        if (firmId && firmId === proj.firm_id) {
            return { ok: true, isOwner: false, project: proj };
        }
    }
    return { ok: false };
}

/**
 * Check whether the current user can access a document the caller has
 * already loaded (saves a round-trip vs. having the helper re-fetch).
 * Owner-of-doc passes immediately; otherwise we fall through to a
 * project-membership check via `shared_with`.
 */
export async function ensureDocAccess(
    doc: { user_id: string; project_id: string | null },
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<{ ok: true; isOwner: boolean } | { ok: false }> {
    if (doc.user_id === userId) return { ok: true, isOwner: true };
    if (!doc.project_id) return { ok: false };
    const access = await checkProjectAccess(
        doc.project_id,
        userId,
        userEmail,
        db,
    );
    if (access.ok) return { ok: true, isOwner: false };
    return { ok: false };
}

/**
 * Reading a document, which reaches one step further than `ensureDocAccess`:
 * anything on the firm's library shelves can be opened, previewed and
 * downloaded by everyone still working at the firm.
 *
 * Deliberately separate from `ensureDocAccess`, which the routes that *change*
 * a document use. Being able to read the firm's letterhead is not permission
 * to write over it — that stays with administrators and the people they give
 * the job to, through the library routes.
 */
export async function ensureDocReadAccess(
    doc: { id?: string; user_id: string; project_id: string | null },
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<{ ok: true; isOwner: boolean } | { ok: false }> {
    const access = await ensureDocAccess(doc, userId, userEmail, db);
    if (access.ok) return access;
    if (doc.project_id || !doc.id) return { ok: false };

    const firmId = await getActiveFirmId(db, userId);
    if (!firmId) return { ok: false };
    const { data } = await db
        .from("documents")
        .select("firm_id")
        .eq("id", doc.id)
        .maybeSingle();
    const onTheFirmsShelves =
        (data as { firm_id: string | null } | null)?.firm_id === firmId;
    return onTheFirmsShelves ? { ok: true, isOwner: false } : { ok: false };
}

/**
 * Same shape as `ensureDocAccess`, for tabular_reviews. A review can be
 * shared in two ways:
 *   1. Indirectly — if `project_id` is set, everyone with project access
 *      can read/operate on it.
 *   2. Directly — `tabular_reviews.shared_with` is a per-review email list
 *      so standalone reviews (project_id null) can also be shared.
 * The owner (review.user_id) always has access.
 */
export async function ensureReviewAccess(
    review: {
        user_id: string;
        project_id: string | null;
        shared_with?: string[] | null;
    },
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<{ ok: true; isOwner: boolean } | { ok: false }> {
    if (review.user_id === userId) return { ok: true, isOwner: true };
    const email = (userEmail ?? "").toLowerCase();
    if (email && Array.isArray(review.shared_with)) {
        if (review.shared_with.some((e) => (e ?? "").toLowerCase() === email)) {
            return { ok: true, isOwner: false };
        }
    }
    if (!review.project_id) return { ok: false };
    const access = await checkProjectAccess(
        review.project_id,
        userId,
        userEmail,
        db,
    );
    if (access.ok) return { ok: true, isOwner: false };
    return { ok: false };
}

/**
 * Filter user-supplied document IDs down to documents the caller can read.
 *
 * Three sorts of document pass: your own, anything in a matter you can open,
 * and anything on the firm's library shelves. That last one is why this helper
 * exists rather than a plain "is it mine" check — a firm template handed to a
 * chat by a colleague has to stay readable, or it silently disappears from the
 * conversation.
 *
 * Tabular review routes accept document IDs from request bodies. Without this
 * check, a caller with access to any review could attach arbitrary document
 * UUIDs and later cause /generate or /regenerate-cell to extract those bytes.
 */
export async function filterAccessibleDocumentIds(
    documentIds: string[],
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<string[]> {
    if (documentIds.length === 0) return [];
    const { data: docs } = await db
        .from("documents")
        .select("id, user_id, project_id, firm_id")
        .in("id", documentIds);
    const rows = (docs ?? []) as {
        id: string;
        user_id: string;
        project_id: string | null;
        firm_id?: string | null;
    }[];
    if (rows.length === 0) return [];

    const [accessibleProjectIds, firmId] = await Promise.all([
        listAccessibleProjectIds(userId, userEmail, db).then(
            (ids) => new Set(ids),
        ),
        getActiveFirmId(db, userId),
    ]);
    const allowed: string[] = [];
    for (const doc of rows) {
        if (doc.user_id === userId) {
            allowed.push(doc.id);
        } else if (
            doc.project_id &&
            accessibleProjectIds.has(doc.project_id)
        ) {
            allowed.push(doc.id);
        } else if (!doc.project_id && firmId && doc.firm_id === firmId) {
            allowed.push(doc.id);
        }
    }
    return allowed;
}

/**
 * Returns the set of project IDs the user can access — their own matters,
 * any matter naming their email, and every matter the firm shares with them.
 * Used to scope chat lists and similar collection queries.
 */
export async function listAccessibleProjectIds(
    userId: string,
    userEmail: string | null | undefined,
    db: Db,
): Promise<string[]> {
    const normalizedEmail = userEmail?.trim().toLowerCase() ?? "";
    const firmId = await getActiveFirmId(db, userId);
    const [{ data: own }, { data: shared }, { data: firmWide }] =
        await Promise.all([
            db.from("projects").select("id").eq("user_id", userId),
            normalizedEmail
                ? db
                      .from("projects")
                      .select("id")
                      .filter(
                          "shared_with",
                          "cs",
                          JSON.stringify([normalizedEmail]),
                      )
                      .neq("user_id", userId)
                : Promise.resolve({ data: [] as { id: string }[] }),
            firmId
                ? db
                      .from("projects")
                      .select("id")
                      .eq("firm_id", firmId)
                      .eq("visibility", "firm")
                      .neq("user_id", userId)
                : Promise.resolve({ data: [] as { id: string }[] }),
        ]);
    const ids = new Set<string>();
    for (const p of (own ?? []) as { id: string }[]) ids.add(p.id);
    for (const p of (shared ?? []) as { id: string }[]) ids.add(p.id);
    for (const p of (firmWide ?? []) as { id: string }[]) ids.add(p.id);
    return [...ids];
}
