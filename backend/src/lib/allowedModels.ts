/**
 * Which AI models the firm lets people use.
 *
 * The firm can name a shortlist; anything not on it stops being offered and
 * stops being accepted. An empty setting means all of them, which is how every
 * firm starts and how it stays unless somebody deliberately narrows it.
 *
 * The shortlist applies to everyone, administrators included — a rule the
 * person setting it can step around is not a rule.
 */

import type { createServerSupabase } from "./supabase";
import { getFirm } from "./firm";

type Db = ReturnType<typeof createServerSupabase>;

/** Tidy a list of model ids coming in from the Administration screen. */
export function normalizeAllowedModels(value: unknown): string[] | null {
    if (value === null || value === undefined) return null;
    if (!Array.isArray(value)) return null;
    const ids = value
        .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
        .filter((entry) => entry.length > 0 && entry.length <= 120);
    const unique = [...new Set(ids)].slice(0, 100);
    // An empty shortlist would lock everybody out of every model, which is
    // never what somebody means by clearing the box. It means "all of them".
    return unique.length ? unique : null;
}

/** The firm's shortlist, or null when it has not named one. */
export async function allowedModelsForFirm(db: Db): Promise<string[] | null> {
    const firm = await getFirm(db);
    const raw = firm?.allowed_models;
    if (!Array.isArray(raw)) return null;
    return normalizeAllowedModels(raw);
}

/**
 * Whether one model may be used. Matching is exact on the whole id, so a local
 * model has to be listed with its `ollama/` prefix, the same way it is written
 * everywhere else.
 */
export function isModelAllowed(
    model: string | null | undefined,
    allowed: string[] | null,
): boolean {
    if (!allowed) return true;
    if (!model) return true;
    return allowed.includes(model);
}

/** Keep only the models the firm allows. */
export function filterAllowedModels<T extends { id: string }>(
    models: T[],
    allowed: string[] | null,
): T[] {
    if (!allowed) return models;
    return models.filter((model) => allowed.includes(model.id));
}

export const MODEL_NOT_ALLOWED_DETAIL =
    "Your firm does not allow that model. Pick one of the models offered.";
