// The case overview: standing instructions a lawyer writes once for a matter —
// who they act for, what they are trying to achieve, how they want work done —
// which then travels with every question asked inside that matter.
//
// It is loaded here in one place so the assistant chat and the "ask the matter"
// answers say the same thing about the case, rather than each route growing its
// own copy.
import { spotlightCaseOverview } from "./chat/contextBuilders";
import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

/** Matches the cap the projects route enforces when the overview is saved. */
export const PROJECT_OVERVIEW_MAX_CHARS = 4000;

/**
 * Reads a matter's overview. Access is checked by the caller, which has
 * already established that this person may work in the project.
 *
 * A missing project, an empty overview, or a database that is having a bad day
 * all come back the same way — nothing to add to the prompt. The question still
 * gets answered; it just answers without the background.
 */
export async function loadProjectOverview(
  db: Db,
  projectId: string | null | undefined,
): Promise<string | null> {
  if (!projectId) return null;
  try {
    const { data, error } = await db
      .from("projects")
      .select("overview")
      .eq("id", projectId)
      .maybeSingle();
    if (error || !data) return null;
    const overview =
      typeof data.overview === "string" ? data.overview.trim() : "";
    return overview ? overview.slice(0, PROJECT_OVERVIEW_MAX_CHARS) : null;
  } catch {
    return null;
  }
}

/**
 * The overview as it appears in the assistant's system prompt, fenced so the
 * model can tell the lawyer's standing instructions apart from document text.
 * Returns an empty string when the matter has no overview, so callers can
 * append it unconditionally.
 */
export function caseOverviewPromptSection(
  overview: string | null,
  nonce: string,
): string {
  if (!overview) return "";
  return (
    "\n\nCASE OVERVIEW:\n" +
    "Standing instructions for this matter, written by the lawyers working on it. " +
    "Follow them throughout, including when drafting. They are background, not " +
    "evidence: never cite them as a document.\n" +
    spotlightCaseOverview(overview, nonce)
  );
}

/**
 * The overview as plain background for the matter-wide answer, which reads only
 * from passages found in the documents and must not start treating the overview
 * as one of them.
 */
export function caseOverviewBackground(overview: string | null): string {
  if (!overview) return "";
  return (
    "Background on this matter, written by the lawyers working on it. Use it to " +
    "understand who the parties are and what the reader is trying to achieve. It " +
    "is not one of the passages and must never be cited as a document:\n" +
    `${overview}\n\n`
  );
}
