// Answers are supposed to cite with numbered markers and a machine-readable
// block at the end, which is what makes a citation openable, checkable and
// filable. Sometimes a model writes the reference out in the prose instead —
// "[doc-3, p. 1]" — and skips the block. The reader is then left with a
// reference that looks like a citation, names a document they cannot open, and
// does nothing when clicked.
//
// Rather than lose those, read them back out of the prose: the label says which
// document, the page says where, and the quoted words just before it say what
// was relied on. That is everything a citation needs, so build real ones and
// renumber the prose to match.
import { resolveDoc, type DocIndex } from "./types";
import type { ParsedDocumentCitation } from "./citations";

/** A whole reference as written, e.g. "[doc-3, p. 1]" or "(doc-0, pp. 4-5)". */
const MARKER_RE = /[[(]\s*doc-\d+[^\])]{0,120}[\])]/gi;

/** One document inside such a reference. Several may be separated by ";". */
const SEGMENT_RE =
  /^doc-(\d+)(?:\s*[,:]?\s*(?:pp?\.?|pages?|page)\s*(\d+(?:\s*[-–]\s*\d+)?))?\.?$/i;

/**
 * How far back from a reference the quoted words may end and still be taken as
 * what it is citing. Enough for `" [doc-3, p. 1]` and a word or two of lead-in,
 * not enough to reach a quotation from an earlier sentence.
 */
const QUOTE_GAP_CHARS = 60;

/** How far back to read looking for that quotation at all. */
const QUOTE_WINDOW_CHARS = 600;

/** Quoted material shorter than this is a word choice, not evidence. */
const QUOTE_MIN_CHARS = 12;

/** The most quotes one citation entry may carry, matching the parser's cap. */
const MAX_QUOTES_PER_CITATION = 3;

/** Straight and curly quotation marks, as either end of a quotation. */
const QUOTED_RE = /["“]([^"“”]+)["”]/g;

export type MarkerRewrite = {
  /** The reference exactly as the answer wrote it. */
  find: string;
  /** What to put in its place, such as "[1]" or "[1][2]". */
  replace: string;
};

export type ProseCitationResult = {
  citations: ParsedDocumentCitation[];
  rewrites: MarkerRewrite[];
};

/**
 * The words this reference is citing: the last quotation that ends just before
 * it. Empty when the sentence quotes nothing — the citation then opens the page
 * without highlighting anything, which is honest about what is known.
 */
function quoteBefore(prose: string, markerStart: number): string {
  const from = Math.max(0, markerStart - QUOTE_WINDOW_CHARS);
  const window = prose.slice(from, markerStart);
  let best = "";
  let bestEnd = -1;
  QUOTED_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = QUOTED_RE.exec(window)) !== null) {
    const text = match[1].trim();
    if (text.length < QUOTE_MIN_CHARS) continue;
    best = text;
    bestEnd = match.index + match[0].length;
  }
  if (!best) return "";
  // Anything after the quotation and before the reference should be no more
  // than the punctuation and few words that normally sit between them.
  return window.length - bestEnd <= QUOTE_GAP_CHARS ? best : "";
}

function normalizePage(raw: string | undefined): number | string {
  if (!raw) return 1;
  const page = raw.replace(/\s+/g, "").replace("–", "-");
  const asNumber = Number(page);
  return Number.isFinite(asNumber) ? asNumber : page;
}

/**
 * Read the document references an answer wrote into its prose and turn them
 * into citations, along with the rewrites that renumber the prose to match.
 *
 * Returns nothing when there is nothing to do, so a properly cited answer is
 * left completely alone.
 */
export function extractProseCitations(
  prose: string,
  docIndex: DocIndex,
): ProseCitationResult {
  const citations: ParsedDocumentCitation[] = [];
  // One entry per document and page, so the same source cited twice keeps one
  // number and gathers both quotes.
  const byTarget = new Map<string, ParsedDocumentCitation>();
  const replacementByMarker = new Map<string, string>();

  MARKER_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MARKER_RE.exec(prose)) !== null) {
    const marker = match[0];
    const parts = marker
      .slice(1, -1)
      .trim()
      .split(";")
      .map((segment) => segment.trim().match(SEGMENT_RE));
    // Every part must be a document reference. A bracket that merely mentions
    // one, such as "[see doc-2 and the letter]", is left as it was written.
    const segments: RegExpMatchArray[] = [];
    for (const part of parts) {
      if (part) segments.push(part);
    }
    if (segments.length !== parts.length) continue;

    // A label this conversation does not know cannot be opened, so leave the
    // whole reference as it was written rather than promise a document that is
    // not there. Checked before anything is built, so a half-known reference
    // does not use up a number.
    if (segments.some((segment) => !resolveDoc(`doc-${segment[1]}`, docIndex))) {
      continue;
    }

    const quote = quoteBefore(prose, match.index);
    const markers: string[] = [];
    for (const segment of segments) {
      const docId = `doc-${segment[1]}`;
      const page = normalizePage(segment[2]);
      const key = `${docId}|${page}`;
      const existing = byTarget.get(key);
      if (existing) {
        if (
          quote &&
          existing.quotes.length < MAX_QUOTES_PER_CITATION &&
          !existing.quotes.some((q) => q.quote === quote)
        ) {
          existing.quotes.push({ page, quote });
          if (!existing.quote) existing.quote = quote;
        }
        markers.push(`[${existing.ref}]`);
        continue;
      }
      const citation: ParsedDocumentCitation = {
        kind: "document",
        ref: byTarget.size + 1,
        doc_id: docId,
        page,
        quote,
        quotes: quote ? [{ page, quote }] : [],
      };
      byTarget.set(key, citation);
      citations.push(citation);
      markers.push(`[${citation.ref}]`);
    }
    if (!markers.length) continue;
    if (!replacementByMarker.has(marker)) {
      replacementByMarker.set(marker, markers.join(""));
    }
  }

  if (!citations.length) return { citations: [], rewrites: [] };

  const rewrites: MarkerRewrite[] = [];
  for (const [find, replace] of replacementByMarker) {
    rewrites.push({ find, replace });
  }
  return { citations, rewrites };
}

/** Put the renumbered markers into a piece of text. */
export function applyMarkerRewrites(
  text: string,
  rewrites: MarkerRewrite[],
): string {
  let out = text;
  for (const rewrite of rewrites) {
    out = out.split(rewrite.find).join(rewrite.replace);
  }
  return out;
}
