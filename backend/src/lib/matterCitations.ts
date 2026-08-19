// Turning the citations written inside an answer into things a reader can click.
//
// The model is told to cite as "(filename, page N)". This finds those citations
// in the finished answer and ties each one back to the passage it came from, so
// the app can open that document at that page with the passage highlighted.
// Anything that does not match a real passage is left alone as plain text.
import type { MatterSearchHit } from "./matterSearch";

export type AnswerCitation = {
  /** The exact run of text inside the answer that should become clickable. */
  text: string;
  documentId: string;
  filename: string;
  page: number | null;
  /** The passage to highlight once the document opens. */
  quote: string;
};

/** Letters and digits only, so punctuation and spacing never break a match. */
function normalize(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function withoutExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/** Split "Lease.pdf, page 4" into its file name and page, if it has one. */
function splitLabelAndPage(segment: string): { label: string; page: number | null } {
  const match = segment.match(
    /^(.*?)[,\s]+(?:at\s+)?(?:pages?|pgs?\.?|pp?\.?)\s*(\d{1,5})(?:\s*[-–—]\s*\d{1,5})?\s*$/i,
  );
  if (match) {
    return { label: match[1].trim(), page: parseInt(match[2], 10) };
  }
  return { label: segment.trim(), page: null };
}

/**
 * Finds every citation in an answer that names one of the passages given, in
 * the order they appear. The `text` of each is a verbatim slice of the answer,
 * so a caller can make exactly that run of words clickable.
 */
export function linkAnswerCitations(
  answer: string,
  sources: MatterSearchHit[],
): AnswerCitation[] {
  if (!answer.trim() || sources.length === 0) return [];

  // Every distinct document that could be cited, by its file name.
  const byNormalizedName = new Map<string, MatterSearchHit[]>();
  for (const hit of sources) {
    for (const key of [normalize(hit.filename), normalize(withoutExtension(hit.filename))]) {
      if (!key) continue;
      const list = byNormalizedName.get(key) ?? [];
      list.push(hit);
      byNormalizedName.set(key, list);
    }
  }

  function findHits(label: string): MatterSearchHit[] | null {
    const key = normalize(label);
    if (!key) return null;
    const exact = byNormalizedName.get(key);
    if (exact) return exact;
    // A shortened or slightly re-typed file name still counts, as long as it is
    // long enough to be unmistakable.
    if (key.length < 6) return null;
    const partial = [...byNormalizedName.entries()].filter(
      ([name]) => name.includes(key) || key.includes(name),
    );
    return partial.length > 0 ? partial[0][1] : null;
  }

  const citations: AnswerCitation[] = [];
  const seen = new Set<string>();

  for (const parenthetical of answer.matchAll(/\(([^()]{2,300})\)/g)) {
    const inner = parenthetical[1];
    for (const rawSegment of inner.split(/\s*;\s*/)) {
      const segment = rawSegment.trim();
      if (!segment) continue;
      const { label, page } = splitLabelAndPage(segment);
      const hits = findHits(label);
      if (!hits) continue;
      const hit = (page != null ? hits.find((h) => h.page === page) : null) ?? hits[0];
      if (seen.has(segment)) continue;
      seen.add(segment);
      citations.push({
        text: segment,
        documentId: hit.documentId,
        filename: hit.filename,
        page: page ?? hit.page,
        quote: hit.content,
      });
    }
  }

  return citations;
}
