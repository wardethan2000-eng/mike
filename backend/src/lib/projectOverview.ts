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
//
// A matter that has collected more facts than fit comfortably in every question
// sends the ones that bear on what was asked, plus the ones that describe the
// case itself. What is left out is counted and the assistant is told, so it can
// say it may not have the whole picture. See memorySelection.ts.
import { spotlightCaseOverview } from "./chat/contextBuilders";
import { embedQuery } from "./embeddings";
import { backfillMemoryFingerprints } from "./memoryEmbedding";
import {
  MEMORY_CATEGORIES,
  MEMORY_CATEGORY_HEADINGS,
  type MemoryCategory,
} from "./memoryCategories";
import {
  parseEmbedding,
  selectMemoriesForQuery,
  SEND_EVERYTHING_BELOW,
} from "./memorySelection";
import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

export {
  MEMORY_CATEGORIES,
  MEMORY_BODY_MAX_CHARS,
  type MemoryCategory,
} from "./memoryCategories";

/** Matches the cap the projects route enforces when the overview is saved. */
export const PROJECT_OVERVIEW_MAX_CHARS = 4000;

/**
 * The most facts read out of the database for one question. Well past what any
 * matter is likely to hold; the picking then narrows this to what actually
 * travels with the question.
 */
const MEMORY_READ_LIMIT = 400;

export type ProjectMemory = {
  id: string;
  category: MemoryCategory;
  body: string;
  pinned: boolean;
  source_document_id: string | null;
  source_page: number | null;
  embedding: number[] | null;
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
 * The facts to send with this question: everything the matter holds while it
 * holds few, and the ones that bear on the question once it holds many.
 *
 * Facts Mike has suggested but nobody has looked at yet are deliberately left
 * out: a suggestion is not a fact until someone says it is.
 */
export async function loadProjectMemories(
  db: Db,
  projectId: string | null | undefined,
  query = "",
): Promise<{ memories: ProjectMemory[]; omitted: number }> {
  if (!projectId) return { memories: [], omitted: 0 };
  try {
    const { data, error } = await db
      .from("project_memories")
      .select(
        "id, category, body, pinned, source_document_id, source_page, embedding",
      )
      .eq("project_id", projectId)
      .eq("status", "accepted")
      .is("superseded_by", null)
      .order("pinned", { ascending: false })
      .order("created_at", { ascending: false })
      .limit(MEMORY_READ_LIMIT);
    if (error || !data) return { memories: [], omitted: 0 };

    const rows = (data as unknown as (Omit<ProjectMemory, "embedding"> & {
      embedding: unknown;
    })[]).map((row) => ({
      ...row,
      embedding: parseEmbedding(row.embedding),
    }));

    // Small matters send everything, so there is nothing to pick and no reason
    // to spend anything working out what is relevant.
    if (rows.length <= SEND_EVERYTHING_BELOW) {
      return { memories: rows, omitted: 0 };
    }

    // Facts written before fingerprints existed, or while the model was down,
    // are filled in behind this answer rather than holding it up.
    const missing = rows
      .filter((row) => !row.embedding)
      .map((row) => ({ id: row.id, body: row.body }));
    if (missing.length > 0) void backfillMemoryFingerprints(db, missing);

    const queryEmbedding = query.trim() ? await embedQuery(query) : null;
    const { chosen, omitted } = selectMemoriesForQuery(
      rows,
      query,
      queryEmbedding,
    );
    return { memories: chosen, omitted };
  } catch {
    return { memories: [], omitted: 0 };
  }
}

/**
 * Both halves of what the assistant is told, loaded together. `query` is what
 * was just asked, and is used only to decide which facts are worth sending on a
 * matter that has more than fit.
 */
export async function loadProjectContext(
  db: Db,
  projectId: string | null | undefined,
  query = "",
): Promise<{
  overview: string | null;
  memories: ProjectMemory[];
  omitted: number;
}> {
  const [overview, facts] = await Promise.all([
    loadProjectOverview(db, projectId),
    loadProjectMemories(db, projectId, query),
  ]);
  return { overview, memories: facts.memories, omitted: facts.omitted };
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

/** Said plainly, so the assistant does not assume it has been told everything. */
function omittedNote(omitted: number): string {
  if (omitted <= 0) return "";
  return (
    `This matter holds ${omitted} further remembered fact${omitted === 1 ? "" : "s"} ` +
    "that are not shown here, because only the ones bearing on this question were " +
    "sent. If the answer turns on something that may be among them, say so rather " +
    "than assuming the list is complete.\n"
  );
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
  omitted = 0,
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

  return (
    "\n\nCASE OVERVIEW:\n" +
    "Standing instructions for this matter, and the facts it has remembered so far, " +
    "written and approved by the lawyers working on it. Follow them throughout, " +
    "including when drafting. They are background, not evidence: never cite them as " +
    "a document, and where a remembered fact and an actual document disagree, the " +
    "document wins and you should say so.\n" +
    omittedNote(omitted) +
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
  omitted = 0,
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
    `${parts.join("\n\n")}\n\n` +
    omittedNote(omitted)
  );
}
