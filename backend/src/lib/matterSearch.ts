// Searching a whole matter by word.
//
// A thin, typed wrapper over the search_document_passages database function
// (see migration 20260818_02). The database does the searching and ranking;
// this attaches each passage's filename and shapes the result for a caller —
// the assistant, or a search box later.
import { embedQuery, toVectorLiteral } from "./embeddings";
import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

export type MatterSearchHit = {
  documentId: string;
  filename: string;
  page: number | null;
  content: string;
  /** True when the passage's text came from character recognition. */
  fromOcr: boolean;
  /** True when the passage is the document's filename, not text inside it. */
  fromFilename: boolean;
  /** How the passage was found: exact words, meaning, or a fuzzy (typo-tolerant) match. */
  matchedBy: "words" | "meaning" | "similar";
  rank: number;
};

type RpcRow = {
  passage_id: string;
  document_id: string;
  page: number | null;
  ordinal: number;
  content: string;
  from_ocr: boolean;
  from_filename: boolean;
  rank: number;
  matched_by: "words" | "meaning" | "similar";
};

export type MatterSearchParams = {
  userId: string;
  /** Restrict to one matter, or null to search everything the user owns. */
  projectId?: string | null;
  query: string;
  limit?: number;
};

/**
 * Returns the passages that best match the query, each with its document and
 * page. Empty when the query is blank or nothing matches.
 */
export async function searchMatter(
  db: Db,
  params: MatterSearchParams,
): Promise<MatterSearchHit[]> {
  const query = params.query.trim();
  if (!query) return [];

  // The query's meaning fingerprint, computed locally. Null when the model is
  // unavailable, in which case the search falls back to words and fuzzy only.
  const embedding = await embedQuery(query);

  const { data, error } = await db.rpc("search_document_passages", {
    p_user_id: params.userId,
    p_project_id: params.projectId ?? null,
    p_query: query,
    p_limit: params.limit ?? 20,
    p_query_embedding: embedding ? toVectorLiteral(embedding) : null,
  });
  if (error) {
    console.error("[matter-search] search failed:", error.message);
    return [];
  }
  const rows = (data ?? []) as RpcRow[];
  if (rows.length === 0) return [];

  // Attach a human filename from each document's current version.
  const documentIds = [...new Set(rows.map((r) => r.document_id))];
  const { data: docs } = await db
    .from("documents")
    .select("id, current_version_id")
    .in("id", documentIds);
  const versionIds = (docs ?? [])
    .map((d) => d.current_version_id as string)
    .filter(Boolean);
  const { data: versions } = await db
    .from("document_versions")
    .select("id, filename")
    .in("id", versionIds);

  const filenameByVersion = new Map(
    (versions ?? []).map((v) => [v.id as string, (v.filename as string) ?? "Untitled document"]),
  );
  const filenameByDocument = new Map(
    (docs ?? []).map((d) => [
      d.id as string,
      filenameByVersion.get(d.current_version_id as string) ?? "Untitled document",
    ]),
  );

  return rows.map((r) => ({
    documentId: r.document_id,
    filename: filenameByDocument.get(r.document_id) ?? "Untitled document",
    page: r.page,
    content: r.content,
    fromOcr: r.from_ocr,
    fromFilename: r.from_filename,
    matchedBy: r.matched_by,
    rank: r.rank,
  }));
}

/** A short "document, page" label for a hit, the way a citation reads. */
export function hitLocation(hit: MatterSearchHit): string {
  return hit.page !== null ? `${hit.filename}, page ${hit.page}` : hit.filename;
}

/**
 * The result the assistant sees: the matching passages grouped by document,
 * each with its page, so the model can quote and cite without opening every
 * file. A note is added when a match came from a scan or from a fuzzy match,
 * so the model treats it with the right care.
 */
export function formatForAssistant(
  query: string,
  hits: MatterSearchHit[],
): string {
  if (hits.length === 0) {
    return `No passages in this matter match "${query}". The documents may not cover it, or a scanned document may have read poorly. Nothing here is a substitute for reading a document in full when it matters.`;
  }

  const byDocument = new Map<string, MatterSearchHit[]>();
  for (const hit of hits) {
    const list = byDocument.get(hit.documentId) ?? [];
    list.push(hit);
    byDocument.set(hit.documentId, list);
  }

  const blocks: string[] = [];
  for (const list of byDocument.values()) {
    const filename = list[0].filename;
    const lines = list
      .sort((a, b) => (a.page ?? 0) - (b.page ?? 0))
      .map((hit) => {
        const where = hit.page !== null ? `page ${hit.page}` : "no page number";
        const flags = [
          hit.fromFilename
            ? "matched on the file's name — the file itself has no readable text"
            : null,
          hit.fromOcr ? "from a scan — check figures against the original" : null,
          hit.matchedBy === "meaning" ? "matched on meaning, not the exact words" : null,
          hit.matchedBy === "similar" ? "approximate match" : null,
        ].filter(Boolean);
        const suffix = flags.length ? ` (${flags.join("; ")})` : "";
        const text = hit.content.replace(/\s+/g, " ").trim();
        return `  • ${where}${suffix}: ${text}`;
      });
    blocks.push(`${filename}:\n${lines.join("\n")}`);
  }

  return [
    `Passages matching "${query}", grouped by document. Cite the document and page. Open a document with read_document when you need its full text.`,
    "",
    ...blocks,
  ].join("\n");
}
