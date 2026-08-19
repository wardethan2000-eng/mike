import { createServerSupabase } from "./supabase";

/**
 * Small personal display settings — how someone has arranged the panels in a
 * project conversation, and anything similar added later. Kept per user so the
 * setting follows them to another computer instead of living in one browser.
 *
 * The shape of the value is the frontend's business; this only stores it.
 */
export type UiPreferences = Record<string, unknown>;

export async function getUiPreferences(
    userId: string,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UiPreferences> {
    const client = db ?? createServerSupabase();
    const { data, error } = await client
        .from("user_ui_preferences")
        .select("preferences")
        .eq("user_id", userId)
        .maybeSingle();

    // A missing table (migration not applied yet) must not break the page —
    // the browser falls back to its own copy of the arrangement.
    if (error) return {};
    const stored = (data as { preferences?: unknown } | null)?.preferences;
    return stored && typeof stored === "object" && !Array.isArray(stored)
        ? (stored as UiPreferences)
        : {};
}

/**
 * Merges the given keys into what is already stored, so one screen saving its
 * own setting never wipes another's.
 */
export async function saveUiPreferences(
    userId: string,
    changes: UiPreferences,
    db?: ReturnType<typeof createServerSupabase>,
): Promise<UiPreferences> {
    const client = db ?? createServerSupabase();
    const current = await getUiPreferences(userId, client);
    const preferences = { ...current, ...changes };

    const { error } = await client
        .from("user_ui_preferences")
        .upsert(
            { user_id: userId, preferences, updated_at: new Date().toISOString() },
            { onConflict: "user_id" },
        );
    if (error) throw new Error(error.message);
    return preferences;
}
