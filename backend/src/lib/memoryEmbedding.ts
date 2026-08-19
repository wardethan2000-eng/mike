// Keeping each remembered fact's fingerprint up to date.
//
// The fingerprint is what lets a long-running matter send the facts that bear
// on the question rather than the first sixty it happens to have. It is
// computed on our own machine and written after the fact itself is saved, so a
// slow or unavailable model never stops someone writing something down.
//
// A fact with no fingerprint is not lost: the picking falls back to shared
// words for it, and the fingerprint is filled in the next time the matter's
// facts are read.
import { embedPassages, toVectorLiteral } from "./embeddings";
import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

/** How many missing fingerprints to fill in on one pass. */
const BACKFILL_LIMIT = 32;

/**
 * Write the fingerprint for one fact. Safe to call without awaiting: it never
 * throws, and a failure simply leaves the fact to be picked up by the backfill.
 */
export async function fingerprintMemory(
  db: Db,
  memoryId: string,
  body: string,
): Promise<void> {
  try {
    const [vector] = await embedPassages([body]);
    if (!vector) return;
    await db
      .from("project_memories")
      .update({ embedding: toVectorLiteral(vector) })
      .eq("id", memoryId);
  } catch (error) {
    console.error("[memory-embedding] could not fingerprint a fact", error);
  }
}

/**
 * Fill in fingerprints for facts that have none — ones written before this
 * existed, or while the model was unavailable. Called without awaiting from the
 * read path, so a matter heals itself as it is used.
 */
export async function backfillMemoryFingerprints(
  db: Db,
  missing: { id: string; body: string }[],
): Promise<void> {
  const batch = missing.slice(0, BACKFILL_LIMIT);
  if (batch.length === 0) return;
  try {
    const vectors = await embedPassages(batch.map((row) => row.body));
    for (let i = 0; i < batch.length; i++) {
      const vector = vectors[i];
      if (!vector) continue;
      await db
        .from("project_memories")
        .update({ embedding: toVectorLiteral(vector) })
        .eq("id", batch[i].id);
    }
  } catch (error) {
    console.error("[memory-embedding] could not fill in fingerprints", error);
  }
}
