// The few plain groups a remembered fact can sit in, kept on their own so both
// the picking of facts and the reading of them can use them without either
// having to import the other.

/** A remembered fact is a line or two. Anything longer belongs in a document. */
export const MEMORY_BODY_MAX_CHARS = 500;

/**
 * Deliberately few and plain, so a list of thirty facts still reads at a
 * glance. The first three describe the case itself and travel with every
 * question; the last three are the ones that grow as a matter runs on.
 */
export const MEMORY_CATEGORIES = [
  "parties",
  "position",
  "drafting",
  "dates",
  "decisions",
  "questions",
] as const;

export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

/** How each group is headed when the facts are read out to the assistant. */
export const MEMORY_CATEGORY_HEADINGS: Record<MemoryCategory, string> = {
  parties: "Parties and roles",
  position: "Our position and strategy",
  drafting: "How they want things drafted",
  dates: "Key dates",
  decisions: "Decisions made",
  questions: "Open questions",
};
