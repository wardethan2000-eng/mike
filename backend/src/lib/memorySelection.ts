// Choosing which of a matter's remembered facts to send with a question.
//
// A matter with a dozen facts should simply send all of them: it is cheap, and
// nothing is more reliable than having everything to hand. The picking here
// only starts once a matter has collected more facts than fit comfortably in
// every single question.
//
// Past that point the split is deliberate. Some facts describe the case
// itself — who the parties are, what this side is arguing for, how the firm
// wants documents laid out — and are just as relevant to a question about a
// deadline as to anything else. Those always go, along with anything pinned.
// The facts that grow without limit as a matter runs on — dates, decisions,
// open questions — are the ones picked by how closely they bear on what was
// actually asked.
//
// Whatever is left out is counted, and the assistant is told, so it can say it
// may not have the whole picture instead of quietly assuming it does.
import type { MemoryCategory } from "./memoryCategories";

export type SelectableMemory = {
  id: string;
  category: MemoryCategory;
  body: string;
  pinned: boolean;
  /** null until the fact has been fingerprinted, or if the model was down. */
  embedding: number[] | null;
};

/**
 * At or below this many facts, everything goes. Chosen so an ordinary matter
 * never has facts withheld from it at all.
 */
export const SEND_EVERYTHING_BELOW = 30;

/** The most facts that will ever travel with one question. */
export const MAX_FACTS_IN_PROMPT = 60;

/**
 * Facts about the case rather than about one question. These go every time,
 * because leaving out "we act for the landlord" to make room for a date would
 * be a far worse answer than the other way round.
 */
const ALWAYS_SEND_CATEGORIES: ReadonlySet<MemoryCategory> = new Set<MemoryCategory>([
  "parties",
  "position",
  "drafting",
]);

/** Words too common to say anything about what a question is about. */
const STOP_WORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "been", "but", "by",
  "can", "did", "do", "does", "for", "from", "had", "has", "have", "how", "i",
  "if", "in", "into", "is", "it", "its", "me", "my", "no", "not", "of", "on",
  "or", "our", "please", "shall", "should", "so", "than", "that", "the",
  "their", "them", "then", "there", "these", "they", "this", "to", "us", "was",
  "we", "were", "what", "when", "where", "which", "who", "why", "will", "with",
  "would", "you", "your",
]);

function contentWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

/**
 * How much of the question's substance appears in the fact. Used on its own for
 * a fact that has not been fingerprinted yet, and alongside the fingerprint
 * otherwise, so a party name or a docket number still pulls its fact in even
 * where the meanings are not especially close.
 */
function wordOverlap(queryWords: string[], body: string): number {
  if (queryWords.length === 0) return 0;
  const inBody = new Set(contentWords(body));
  let hits = 0;
  for (const word of queryWords) if (inBody.has(word)) hits += 1;
  return hits / queryWords.length;
}

/** Both vectors come out of the model already normalised, so this is cosine. */
function dot(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let total = 0;
  for (let i = 0; i < a.length; i++) total += a[i] * b[i];
  return total;
}

export type MemorySelection<T extends SelectableMemory> = {
  /** The facts to send, in the order they were given. */
  chosen: T[];
  /** How many accepted facts were left behind. */
  omitted: number;
};

/**
 * Pick the facts to send with one question.
 *
 * `queryEmbedding` may be null — because the matter is small enough that it is
 * not needed, or because the model was unavailable — in which case the picking
 * falls back to shared words, and failing that to the most recent facts. It
 * never returns nothing when there is something to send.
 */
export function selectMemoriesForQuery<T extends SelectableMemory>(
  memories: T[],
  query: string,
  queryEmbedding: number[] | null,
): MemorySelection<T> {
  if (memories.length <= SEND_EVERYTHING_BELOW) {
    return { chosen: memories, omitted: 0 };
  }

  const alwaysSend: T[] = [];
  const candidates: T[] = [];
  for (const memory of memories) {
    if (memory.pinned || ALWAYS_SEND_CATEGORIES.has(memory.category)) {
      alwaysSend.push(memory);
    } else {
      candidates.push(memory);
    }
  }

  // A matter with more standing facts than the whole budget is unusual, but it
  // must still send something rather than overflow. Pinned first, then the
  // most recent, which is the order these arrive in.
  if (alwaysSend.length >= MAX_FACTS_IN_PROMPT) {
    const chosen = alwaysSend.slice(0, MAX_FACTS_IN_PROMPT);
    return { chosen, omitted: memories.length - chosen.length };
  }

  const room = MAX_FACTS_IN_PROMPT - alwaysSend.length;
  const queryWords = contentWords(query);

  const ranked = candidates
    .map((memory) => {
      const byWords = wordOverlap(queryWords, memory.body);
      const byMeaning =
        queryEmbedding && memory.embedding
          ? dot(queryEmbedding, memory.embedding)
          : 0;
      // Whichever way the fact is relevant is the way it counts: a fact that
      // shares the question's words wins on that, one that only shares its
      // sense wins on that, and neither is held against the other.
      return { memory, score: Math.max(byWords, byMeaning) };
    })
    .sort((a, b) => b.score - a.score);

  const picked = new Set(ranked.slice(0, room).map((item) => item.memory.id));
  const chosen = memories.filter(
    (memory) =>
      memory.pinned ||
      ALWAYS_SEND_CATEGORIES.has(memory.category) ||
      picked.has(memory.id),
  );
  return { chosen, omitted: memories.length - chosen.length };
}

/**
 * A fingerprint as it comes back from the database: pgvector hands it over as
 * the text "[0.1,0.2,…]", though a driver may already have made an array of it.
 */
export function parseEmbedding(value: unknown): number[] | null {
  if (Array.isArray(value)) {
    return value.every((n) => typeof n === "number") ? (value as number[]) : null;
  }
  if (typeof value !== "string") return null;
  const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!inner) return null;
  const parsed = inner.split(",").map(Number);
  return parsed.every((n) => Number.isFinite(n)) ? parsed : null;
}
