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

/** The last thing the answer put in quotation marks before this point. */
function lastQuotedText(context: string): string | null {
  const quoted = [...context.matchAll(/[“"]([^“”"]{12,600})[”"]/g)];
  const last = quoted.at(-1);
  return last ? last[1].trim() : null;
}

function withoutExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/** The claim the citation is backing up: the sentence just before it. */
function lastSentence(context: string): string {
  const trimmed = context.trim();
  const sentences = trimmed.split(/(?<=[.!?:])\s+/).filter(Boolean);
  const last = sentences.at(-1) ?? trimmed;
  // A very short tail ("and", "see") says nothing; take a little more with it.
  if (last.length < 25 && sentences.length > 1) {
    return `${sentences.at(-2)} ${last}`;
  }
  return last;
}

/** The words worth comparing on: dates and figures count for more. */
function keyTerms(text: string): Map<string, number> {
  const terms = new Map<string, number>();
  for (const word of text.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ")) {
    if (!word) continue;
    const isNumber = /\d/.test(word);
    if (!isNumber && word.length < 5) continue;
    terms.set(word, isNumber ? 4 : 1);
  }
  return terms;
}

function sentencesOf(passage: string): string[] {
  return passage
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** How much of the claim a stretch of a document repeats. */
function overlap(terms: Map<string, number>, text: string): number {
  const haystack = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  let score = 0;
  for (const [term, weight] of terms) {
    if (haystack.includes(` ${term} `)) score += weight;
  }
  return score;
}

type ChosenSource = { hit: MatterSearchHit; quote: string };

/**
 * Which passage of a document the citation really points at, and which words in
 * it to mark. A file usually gives several passages and a page number rarely
 * separates them, so the claim the answer just made decides it: the passage
 * whose own sentence repeats that claim most closely wins, and that sentence is
 * what gets highlighted rather than the whole surrounding passage.
 */
function chooseSource(
  hits: MatterSearchHit[],
  context: string,
  quotedText: string | null,
): ChosenSource {
  // The answer quoted the document outright: nothing beats matching that.
  if (quotedText) {
    const quotedKey = normalize(quotedText).slice(0, 40);
    if (quotedKey.length >= 12) {
      const exact = hits.find((hit) => normalize(hit.content).includes(quotedKey));
      if (exact) return { hit: exact, quote: quotedText };
    }
  }

  const terms = keyTerms(lastSentence(context));
  let best: ChosenSource = { hit: hits[0], quote: hits[0].content };
  let bestScore = -1;

  for (const hit of hits) {
    for (const sentence of sentencesOf(hit.content)) {
      const score = overlap(terms, sentence);
      if (score > bestScore) {
        bestScore = score;
        best = { hit, quote: sentence };
      }
    }
  }

  // Nothing in the claim shows up in any passage: mark the whole passage the
  // search returned first rather than an arbitrary sentence.
  if (bestScore <= 0) return { hit: hits[0], quote: hits[0].content };
  return best;
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
    // What the answer said just before the citation. This is what decides
    // which passage of a document the citation belongs to.
    const context = answer.slice(
      Math.max(0, (parenthetical.index ?? 0) - 500),
      parenthetical.index ?? 0,
    );
    const quotedText = lastQuotedText(context);

    for (const rawSegment of inner.split(/\s*;\s*/)) {
      const segment = rawSegment.trim();
      if (!segment) continue;
      const { label, page } = splitLabelAndPage(segment);
      const hits = findHits(label);
      if (!hits) continue;
      const onPage = page != null ? hits.filter((h) => h.page === page) : [];
      const { hit, quote } = chooseSource(
        onPage.length > 0 ? onPage : hits,
        context,
        quotedText,
      );
      if (seen.has(segment)) continue;
      seen.add(segment);
      citations.push({
        text: segment,
        documentId: hit.documentId,
        filename: hit.filename,
        page: page ?? hit.page,
        quote,
      });
    }
  }

  return citations;
}
