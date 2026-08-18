// Stores passages for documents that were uploaded before search existed.
//
//   docker compose exec backend node dist/scripts/backfillPassages.js        # report only
//   docker compose exec backend node dist/scripts/backfillPassages.js --apply
//   docker compose exec backend node dist/scripts/backfillPassages.js --apply --all
//
// Without --all, documents that already have passages are left alone, so this
// is cheap to re-run after adding a few files. With --all, everything is read
// again — use it after changing how passages are cut.
import { indexVersion } from "../lib/passageIndex";
import { createServerSupabase } from "../lib/supabase";

async function main() {
  const apply = process.argv.includes("--apply");
  const redoAll = process.argv.includes("--all");
  const db = createServerSupabase();

  const { data: docs, error: docsErr } = await db
    .from("documents")
    .select("id, user_id, project_id, current_version_id")
    .not("current_version_id", "is", null);
  if (docsErr) throw new Error(docsErr.message);

  const versionIds = (docs ?? [])
    .map((d) => d.current_version_id as string)
    .filter(Boolean);
  if (versionIds.length === 0) {
    console.log("No documents to index.");
    return;
  }

  const { data: versions, error: verErr } = await db
    .from("document_versions")
    .select("id, document_id, storage_path, pdf_storage_path, file_type, filename")
    .in("id", versionIds)
    .is("deleted_at", null);
  if (verErr) throw new Error(verErr.message);

  const { data: existing } = await db
    .from("document_passages")
    .select("version_id")
    .in("version_id", versionIds);
  const alreadyIndexed = new Set(
    (existing ?? []).map((row) => row.version_id as string),
  );

  const byDocument = new Map(
    (docs ?? []).map((d) => [
      d.current_version_id as string,
      { userId: d.user_id as string, projectId: (d.project_id as string) ?? null },
    ]),
  );

  const todo = (versions ?? []).filter(
    (v) => redoAll || !alreadyIndexed.has(v.id as string),
  );

  console.log(
    `${versions?.length ?? 0} documents, ${todo.length} to index.` +
      (apply ? "" : " Reporting only — pass --apply to store them."),
  );

  let stored = 0;
  let empty = 0;
  let failed = 0;

  for (const version of todo) {
    const owner = byDocument.get(version.id as string);
    const label = (version.filename as string) ?? (version.document_id as string);
    if (!owner) continue;

    if (!apply) {
      console.log(`  ${label}: would be indexed`);
      continue;
    }

    const started = Date.now();
    const result = await indexVersion(db, {
      version: version as Parameters<typeof indexVersion>[1]["version"],
      userId: owner.userId,
      projectId: owner.projectId,
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(1);

    if (result.passages > 0) {
      stored += 1;
      console.log(`  ${label}: ${result.passages} passages (${seconds}s)`);
    } else if (result.reason === "no text found") {
      empty += 1;
      console.log(`  ${label}: no text to store`);
    } else {
      failed += 1;
      console.log(`  ${label}: failed — ${result.reason ?? "unknown"}`);
    }
  }

  if (apply) {
    console.log(
      `\nDone. ${stored} indexed, ${empty} had no text, ${failed} failed.`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
