// Citations used to be asked for as a block of JSON at the very end of the
// answer. Nothing checked it while it was being written, so a long answer could
// simply not produce one, or produce one that did not parse, and the reader was
// left with references that opened nothing.
//
// Filing them as a tool call instead means the shape is checked before it is
// accepted: an entry naming a document that is not in this conversation, or a
// marker with no entry, comes back as a problem to fix rather than passing
// silently. The answer is only finished once its citations are in order.
import { normalizeCitation, type ParsedCitation } from "./citations";
import { normalizeLegId } from "./tools/legislationTurnState";
import { resolveDoc, type DocIndex } from "./types";

/** How many times a turn may be sent back to correct its citations. */
export const MAX_CITE_ATTEMPTS = 2;

/** Marker numbers as they appear in the answer: [1], [2], [3]. */
export function markersInProse(prose: string): number[] {
  const found = new Set<number>();
  const re = /\[(\d{1,2})\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(prose)) !== null) {
    const ref = Number(match[1]);
    if (ref > 0) found.add(ref);
  }
  return [...found].sort((a, b) => a - b);
}

export type CiteContext = {
  /** The answer as written so far, which is what the markers live in. */
  prose: string;
  docIndex: DocIndex;
  /** Cases actually fetched in this turn. */
  knownClusterIds: Set<number>;
  /** Statutes actually looked up in this turn. */
  knownLegIds: Set<string>;
};

export type CiteOutcome = {
  /** The entries that are usable, whether or not everything checked out. */
  citations: ParsedCitation[];
  /**
   * What is wrong, in words meant for the model to act on. Empty means the
   * citations are in order and the answer can finish.
   */
  problems: string[];
};

function listLabels(docIndex: DocIndex): string {
  const labels = Object.keys(docIndex);
  if (!labels.length) return "none";
  return labels.slice(0, 40).join(", ");
}

/**
 * Read a cite_sources call and say whether it can be accepted.
 *
 * Nothing here trusts the call: an entry that names a document, case or statute
 * this conversation has not seen is dropped and reported, so a citation can
 * never point somewhere the reader cannot follow.
 */
export function readCiteCall(rawArgs: unknown, ctx: CiteContext): CiteOutcome {
  const problems: string[] = [];
  const args =
    rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs)
      ? (rawArgs as Record<string, unknown>)
      : {};
  const entries = Array.isArray(args.citations) ? args.citations : [];
  if (!entries.length) {
    return {
      citations: [],
      problems: [
        "The call carried no citations. Send one entry for each [N] marker in the answer.",
      ],
    };
  }

  const citations: ParsedCitation[] = [];
  const seenRefs = new Set<number>();
  for (const raw of entries) {
    const citation = normalizeCitation(raw);
    if (!citation) {
      problems.push(
        "An entry could not be read. Each entry needs a ref, one of doc_id / cluster_id / leg_id, and at least one quote.",
      );
      continue;
    }
    if (seenRefs.has(citation.ref)) {
      problems.push(
        `Two entries both use ref ${citation.ref}. Give each marker one entry.`,
      );
      continue;
    }
    if (citation.kind === "document") {
      if (!resolveDoc(citation.doc_id, ctx.docIndex)) {
        problems.push(
          `Entry ${citation.ref} names "${citation.doc_id}", which is not a document in this conversation. Available: ${listLabels(ctx.docIndex)}.`,
        );
        continue;
      }
    } else if (citation.kind === "case") {
      if (!ctx.knownClusterIds.has(citation.cluster_id)) {
        problems.push(
          `Entry ${citation.ref} cites case ${citation.cluster_id}, which was not retrieved in this conversation. Fetch the case first, or drop the entry and its marker.`,
        );
        continue;
      }
    } else if (!ctx.knownLegIds.has(normalizeLegId(citation.leg_id))) {
      problems.push(
        `Entry ${citation.ref} cites "${citation.leg_id}", which was not looked up in this conversation. Look the statute up first, or drop the entry and its marker.`,
      );
      continue;
    }
    seenRefs.add(citation.ref);
    citations.push(citation);
  }

  // Every marker needs an entry, and every entry needs a marker. Either way
  // round leaves the reader with something that does not work: a marker that
  // opens nothing, or a source that is never pointed at.
  const markers = markersInProse(ctx.prose);
  const missing = markers.filter((ref) => !seenRefs.has(ref));
  if (missing.length) {
    problems.push(
      `The answer has ${missing.length === 1 ? "a marker" : "markers"} ${missing
        .map((ref) => `[${ref}]`)
        .join(", ")} with no entry. Send one entry for each.`,
    );
  }
  const unused = [...seenRefs].filter((ref) => !markers.includes(ref));
  if (unused.length && markers.length) {
    problems.push(
      `Entries ${unused
        .map((ref) => `[${ref}]`)
        .join(", ")} have no marker in the answer. Put the marker where the claim is, or drop the entry.`,
    );
  }
  if (!markers.length) {
    problems.push(
      "The answer has no [N] markers. Put a marker where each cited claim appears, then call this again.",
    );
  }

  return { citations, problems };
}
