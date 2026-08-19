// What the assistant is told about a matter before anyone asks it anything:
// the case overview, and the facts the matter has remembered along the way.
//
// The overview is standing instructions a lawyer writes once — who they act
// for, what they are trying to achieve, how they want work done. The case
// memory is the short facts the matter picks up as work goes on.
//
// Both are loaded here in one place so the assistant chat and the "ask the
// matter" answers say the same thing about the case, rather than each route
// growing its own copy.
import { spotlightCaseOverview } from "./chat/contextBuilders";
import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

/** Matches the cap the projects route enforces when the overview is saved. */
export const PROJECT_OVERVIEW_MAX_CHARS = 4000;

/** A remembered fact is a line or two. Anything longer belongs in a document. */
export const MEMORY_BODY_MAX_CHARS = 500;

/**
 * The groups a remembered fact can sit in. They are deliberately few and plain,
 * so a list of thirty facts still reads at a glance.
 */
export const MEMORY_CATEGORIES = [
  "parties",
  "dates",
  "position",
  "decisions",
  "questions",
  "drafting",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/** How each group is headed when the facts are read out to the assistant. */
const MEMORY_CATEGORY_HEADINGS: Record<MemoryCategory, string> = {
  parties: "Parties and roles",
  dates: "Key dates",
  position: "Our position and strategy",
  decisions: "Decisions made",
  questions: "Open questions",
  drafting: "How they want things drafted",
};

/**
 * How many facts travel with a question. Well past what a matter normally has;
 * beyond it, pinned facts and the most recent ones go and the rest are left
 * behind, which the assistant is told about rather than left to guess.
 */
const MEMORY_PROMPT_LIMIT = 80;

export type ProjectMemory = {
  id: string;
  category: MemoryCategory;
  body: string;
  pinned: boolean;
  source_document_id: string | null;
  source_page: number | null;
};

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
 * The facts in force for a matter — everything accepted that has not been
 * replaced by a newer wording. Facts Mike has suggested but nobody has looked
 * at yet are deliberately left out: a suggestion is not a fact until someone
 * says it is. Pinned facts come first so that, if a very long list has to be
 * cut, the ones marked as always-relevant are the ones that survive.
 */
export async function loadProjectMemories(
  db: Db,
  projectId: string | null | undefined,
): Promise<ProjectMemory[]> {
  if (!projectId) return [];
  try {
    const { data, error } = await db
      .from("project_memories")
      .select("id, category, body, pinned, source_document_id, source_page")
      .eq("project_id", projectId)
      .eq("status", "accepted")
      .is("superseded_by", null)
      .order("pinned", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(MEMORY_PROMPT_LIMIT);
    if (error || !data) return [];
    return data as ProjectMemory[];
  } catch {
    return [];
  }
}

/** Both halves of what the assistant is told, loaded together. */
export async function loadProjectContext(
  db: Db,
  projectId: string | null | undefined,
): Promise<{ overview: string | null; memories: ProjectMemory[] }> {
  const [overview, memories] = await Promise.all([
    loadProjectOverview(db, projectId),
    loadProjectMemories(db, projectId),
  ]);
  return { overview, memories };
}

/** The remembered facts as plain text, grouped and headed. */
function formatMemories(memories: ProjectMemory[]): string {
  if (memories.length === 0) return "";
  const lines: string[] = [];
  for (const category of MEMORY_CATEGORIES) {
    const inGroup = memories.filter((m) => m.category === category);
    if (inGroup.length === 0) continue;
    lines.push(`${MEMORY_CATEGORY_HEADINGS[category]}:`);
    for (const memory of inGroup) {
      const body = memory.body.replace(/\s*\n\s*/g, " ").trim();
      lines.push(`- ${body}`);
    }
  }
  return lines.join("\n");
}

/**
 * The overview and the remembered facts as they appear in the assistant's
 * system prompt, fenced so the model can tell the lawyers' own standing
 * instructions apart from document text. Returns an empty string when the
 * matter has neither, so callers can append it unconditionally.
 */
export function caseOverviewPromptSection(
  overview: string | null,
  nonce: string,
  memories: ProjectMemory[] = [],
): string {
  const facts = formatMemories(memories);
  if (!overview && !facts) return "";

  const parts: string[] = [];
  if (overview) parts.push(overview);
  if (facts) {
    parts.push(
      `${overview ? "\n" : ""}FACTS REMEMBERED ON THIS MATTER:\n${facts}`,
    );
  }

  const truncated = memories.length >= MEMORY_PROMPT_LIMIT;
  return (
    "\n\nCASE OVERVIEW:\n" +
    "Standing instructions for this matter, and the facts it has remembered so far, " +
    "written and approved by the lawyers working on it. Follow them throughout, " +
    "including when drafting. They are background, not evidence: never cite them as " +
    "a document, and where a remembered fact and an actual document disagree, the " +
    "document wins and you should say so.\n" +
    (truncated
      ? "This matter has more remembered facts than fit here; the ones shown are " +
        "the pinned and the most recent. Say so if the answer turns on something " +
        "that may not be listed.\n"
      : "") +
    spotlightCaseOverview(parts.join("\n"), nonce)
  );
}

/**
 * The overview and remembered facts as plain background for the matter-wide
 * answer, which reads only from passages found in the documents and must not
 * start treating either as one of them.
 */
export function caseOverviewBackground(
  overview: string | null,
  memories: ProjectMemory[] = [],
): string {
  const facts = formatMemories(memories);
  if (!overview && !facts) return "";
  const parts: string[] = [];
  if (overview) parts.push(overview);
  if (facts) parts.push(`Facts remembered on this matter:\n${facts}`);
  return (
    "Background on this matter, written by the lawyers working on it. Use it to " +
    "understand who the parties are and what the reader is trying to achieve. It " +
    "is not one of the passages and must never be cited as a document:\n" +
    `${parts.join("\n\n")}\n\n`
  );
}
