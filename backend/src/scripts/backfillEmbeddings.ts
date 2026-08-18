// Fills in the meaning fingerprints for passages stored before meaning search
// existed. Reads the passage text straight from the table — no document is read
// again — so this is cheap and touches only the fingerprints.
//
//   docker compose exec backend node dist/scripts/backfillEmbeddings.js         # report only
//   docker compose exec backend node dist/scripts/backfillEmbeddings.js --apply
//   docker compose exec backend node dist/scripts/backfillEmbeddings.js --apply --all
//
// Without --all, only passages that have no fingerprint yet are done, so this is
// safe and cheap to re-run. With --all, every passage is fingerprinted again —
// use it after changing the model. One heavy job at a time: do not run this
// while a large scan is being read (see docs/plans/01-search-across-a-matter.md).
import { embedPassages, toVectorLiteral } from "../lib/embeddings";
import { createServerSupabase } from "../lib/supabase";

/** Passages fingerprinted per model call. Small, to keep memory flat. */
const BATCH = 16;

async function main() {
  const apply = process.argv.includes("--apply");
  const redoAll = process.argv.includes("--all");
  const db = createServerSupabase();

  // Page through the table so a large matter does not load all at once.
  const PAGE = 500;
  let from = 0;
  let seen = 0;
  let done = 0;
  let empty = 0;
  let failed = 0;

  for (;;) {
    let q = db
      .from("document_passages")
      .select("id, content, embedding")
      .order("id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (!redoAll) q = q.is("embedding", null);

    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    if (!rows || rows.length === 0) break;

    seen += rows.length;
    from += PAGE;

    if (!apply) continue;

    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      const vecs = await embedPassages(slice.map((r) => (r.content as string) ?? ""));
      for (let j = 0; j < slice.length; j++) {
        const vec = vecs[j];
        if (!vec) {
          empty += 1;
          continue;
        }
        const { error: upErr } = await db
          .from("document_passages")
          .update({ embedding: toVectorLiteral(vec) })
          .eq("id", slice[j].id as string);
        if (upErr) {
          failed += 1;
          console.error(`  ${slice[j].id}: ${upErr.message}`);
        } else {
          done += 1;
        }
      }
      console.log(`  fingerprinted ${done} so far...`);
    }
  }

  if (!apply) {
    console.log(
      `${seen} passages ${redoAll ? "in total" : "without a fingerprint"}. ` +
        "Reporting only — pass --apply to fingerprint them.",
    );
    return;
  }
  console.log(
    `\nDone. ${done} fingerprinted, ${empty} had no text, ${failed} failed.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
