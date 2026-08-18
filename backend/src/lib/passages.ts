// Cutting a document's text into passages.
//
// A passage is the unit a search returns and a citation points at, so two
// things matter more than anything else here: a passage never spans two pages,
// so its page number is unambiguous; and passages overlap slightly, so a clause
// that straddles a boundary is still found whole.
//
// This file is deliberately pure — no database, no storage, no network — so the
// splitting rules can be tested directly.

/** Characters aimed at per passage. About a third of a printed page. */
export const TARGET_CHARS = 1200;

/** A passage shorter than this is merged into its neighbour rather than kept. */
export const MIN_CHARS = 200;

/** Characters repeated from the end of one passage at the start of the next. */
export const OVERLAP_CHARS = 150;

/** Hard ceiling, so a page with no paragraph breaks still gets cut up. */
export const MAX_CHARS = 2000;

export type Passage = {
  /** Page the text came from, or null when the document has no pages. */
  page: number | null;
  /** Position within the document, from zero. */
  ordinal: number;
  content: string;
};

export type PageText = { page: number | null; text: string };

/**
 * Splits text laid out with the `[Page N]` markers that the PDF reader emits
 * into one entry per page. Text before any marker is treated as page-less.
 */
export function splitByPage(text: string): PageText[] {
  const pattern = /\[Page (\d+)\]/g;
  const pages: PageText[] = [];
  let match: RegExpExecArray | null;
  let lastPage: number | null = null;
  let lastIndex = 0;

  while ((match = pattern.exec(text)) !== null) {
    const body = text.slice(lastIndex, match.index);
    if (body.trim()) pages.push({ page: lastPage, text: body });
    lastPage = Number(match[1]);
    lastIndex = match.index + match[0].length;
  }
  const tail = text.slice(lastIndex);
  if (tail.trim()) pages.push({ page: lastPage, text: tail });
  return pages;
}

/** Collapses the runs of whitespace that PDF extraction leaves behind. */
function tidy(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Breaks a page into pieces at the best available boundary: a blank line first,
 * then the end of a sentence, then a line end. Falls back to a hard cut so a
 * page of unbroken text still yields usable passages.
 */
function breakUp(pageText: string): string[] {
  const text = tidy(pageText);
  if (!text) return [];
  if (text.length <= MAX_CHARS) return [text];

  const paragraphs = text.split(/\n{2,}/).filter((p) => p.trim());
  const pieces: string[] = [];
  let current = "";

  const flush = () => {
    if (current.trim()) pieces.push(current.trim());
    current = "";
  };

  for (const paragraph of paragraphs) {
    for (const part of hardSplit(paragraph)) {
      if (!current) {
        current = part;
      } else if (current.length + part.length + 2 <= TARGET_CHARS) {
        current = `${current}\n\n${part}`;
      } else {
        flush();
        current = part;
      }
    }
  }
  flush();
  return pieces;
}

/** Cuts a single over-long paragraph at sentence ends, then anywhere. */
function hardSplit(paragraph: string): string[] {
  if (paragraph.length <= MAX_CHARS) return [paragraph];

  const sentences = paragraph.match(/[^.!?\n]+[.!?]*\s*/g) ?? [paragraph];
  const parts: string[] = [];
  let current = "";

  for (const sentence of sentences) {
    if (sentence.length > MAX_CHARS) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      for (let i = 0; i < sentence.length; i += TARGET_CHARS) {
        parts.push(sentence.slice(i, i + TARGET_CHARS).trim());
      }
      continue;
    }
    if (current.length + sentence.length <= TARGET_CHARS) {
      current += sentence;
    } else {
      if (current.trim()) parts.push(current.trim());
      current = sentence;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts.filter(Boolean);
}

/** Repeats the tail of the previous passage, cut at a word boundary. */
function overlapFrom(previous: string): string {
  if (previous.length <= OVERLAP_CHARS) return previous;
  const tail = previous.slice(-OVERLAP_CHARS);
  const space = tail.indexOf(" ");
  return space === -1 ? tail : tail.slice(space + 1);
}

/**
 * Turns a document's page-labelled text into passages, numbered in order.
 * Passages never span a page, so every one can cite its page with confidence.
 */
export function toPassages(text: string): Passage[] {
  const passages: Passage[] = [];
  let ordinal = 0;

  for (const { page, text: pageText } of splitByPage(text)) {
    const pieces = breakUp(pageText);

    // A stray fragment is folded into its neighbour rather than stored as a
    // passage of its own — a lone page number is not worth a row.
    const merged: string[] = [];
    for (const piece of pieces) {
      const previous = merged[merged.length - 1];
      if (piece.length < MIN_CHARS && previous && previous.length + piece.length <= MAX_CHARS) {
        merged[merged.length - 1] = `${previous}\n\n${piece}`;
      } else {
        merged.push(piece);
      }
    }

    merged.forEach((piece, index) => {
      const previous = index > 0 ? merged[index - 1] : null;
      const content = previous ? `${overlapFrom(previous)} ${piece}` : piece;
      passages.push({ page, ordinal: ordinal++, content });
    });
  }

  // A single fragment for the whole document is still worth keeping; nothing
  // else is dropped either, but empty documents produce nothing.
  return passages.filter((p) => p.content.trim().length > 0);
}
