// Re-reads documents that were uploaded before Mike could read scans.
//
// A scan uploaded earlier has no text layer, so the assistant sees page
// numbers and nothing else. This walks stored documents, finds the ones whose
// text is missing, gives them one, and points the document at the readable
// copy. Documents that already have text are left untouched.
//
//   docker compose exec backend node dist/scripts/backfillOcr.js          # report only
//   docker compose exec backend node dist/scripts/backfillOcr.js --apply  # make the change
//
// Safe to re-run: it never edits the file the user uploaded, only adds a
// readable copy alongside it.
import {
  completeRendition,
  prepareRendition,
} from "../lib/documentRendition";
import { isImageDocumentType } from "../lib/documentTypes";
import { downloadFile } from "../lib/storage";
import { createServerSupabase } from "../lib/supabase";

type VersionRow = {
  id: string;
  document_id: string;
  storage_path: string | null;
  pdf_storage_path: string | null;
  file_type: string | null;
  filename: string | null;
  page_count: number | null;
};

async function main() {
  const apply = process.argv.includes("--apply");
  const db = createServerSupabase();

  const { data: docs, error: docsErr } = await db
    .from("documents")
    .select("id, user_id, current_version_id")
    .not("current_version_id", "is", null);
  if (docsErr) throw new Error(docsErr.message);

  const versionIds = (docs ?? [])
    .map((d) => d.current_version_id as string)
    .filter(Boolean);
  if (versionIds.length === 0) {
    console.log("No documents to check.");
    return;
  }

  const { data: versions, error: verErr } = await db
    .from("document_versions")
    .select(
      "id, document_id, storage_path, pdf_storage_path, file_type, filename, page_count",
    )
    .in("id", versionIds)
    .is("deleted_at", null);
  if (verErr) throw new Error(verErr.message);

  const ownerOf = new Map(
    (docs ?? []).map((d) => [d.id as string, d.user_id as string]),
  );

  // A version needs re-reading when it is a picture with no readable copy, or
  // a PDF that is still standing in as its own readable copy (i.e. nothing has
  // ever checked whether it actually contains text).
  const candidates = ((versions ?? []) as VersionRow[]).filter((v) => {
    const fileType = (v.file_type ?? "").toLowerCase();
    if (!v.storage_path) return false;
    if (isImageDocumentType(fileType)) return !v.pdf_storage_path;
    return fileType === "pdf" && v.pdf_storage_path === v.storage_path;
  });

  console.log(
    `${versions?.length ?? 0} documents, ${candidates.length} to check.` +
      (apply ? "" : " Reporting only — pass --apply to make changes."),
  );

  let read = 0;
  let alreadyFine = 0;
  let failed = 0;

  for (const version of candidates) {
    const label = version.filename ?? version.document_id;
    const userId = ownerOf.get(version.document_id);
    if (!userId || !version.storage_path) continue;

    const raw = await downloadFile(version.storage_path);
    if (!raw) {
      console.log(`  ${label}: file missing from storage, skipped`);
      failed += 1;
      continue;
    }

    const fileType = (version.file_type ?? "").toLowerCase();
    const target = {
      content: Buffer.from(raw),
      suffix: fileType,
      userId,
      docId: version.document_id,
      storagePath: version.storage_path,
      pdfKey: `converted-pdfs/${userId}/${version.document_id}/${version.id}.pdf`,
      pageCount: version.page_count,
      label: "backfill",
    };

    const prepared = await prepareRendition(target);
    if (!prepared.ocrPending) {
      console.log(`  ${label}: already has text, left alone`);
      alreadyFine += 1;
      continue;
    }
    if (!apply) {
      read += 1;
      console.log(
        `  ${label}: would be read` +
          (prepared.warning ? ` — ${prepared.warning}` : ""),
      );
      continue;
    }

    const started = Date.now();
    const finished = await completeRendition(target);
    const seconds = Math.round((Date.now() - started) / 1000);
    if (!finished.pdfStoragePath) {
      console.log(`  ${label}: could not be read (gave up after ${seconds}s)`);
      failed += 1;
      continue;
    }

    const { error } = await db
      .from("document_versions")
      .update({
        pdf_storage_path: finished.pdfStoragePath,
        page_count: version.page_count ?? finished.pageCount,
      })
      .eq("id", version.id);
    if (error) {
      console.log(`  ${label}: could not be updated — ${error.message}`);
      failed += 1;
      continue;
    }
    await db
      .from("documents")
      .update({ status: "ready" })
      .eq("id", version.document_id);

    read += 1;
    console.log(
      `  ${label}: now readable (${seconds}s)` +
        (prepared.warning ? ` — ${prepared.warning}` : ""),
    );
  }

  console.log(
    `\nDone. ${read} ${apply ? "read" : "would be read"}, ` +
      `${alreadyFine} already had text, ${failed} could not be read.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
