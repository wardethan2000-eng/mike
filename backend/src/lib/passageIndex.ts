// Storing a document's passages so a matter can be searched as a whole.
//
// Called after a document is stored — and, for a scan, after it has been read,
// since before that there is no text to store. Runs detached from the request:
// a document that could not be indexed is still a document you can open, so
// nothing here is allowed to fail an upload.
import { isOcrDerived } from "./documentRendition";
import {
  isPresentationDocumentType,
  isSpreadsheetDocumentType,
  isTextDocumentType,
  isWordDocumentType,
} from "./documentTypes";
import { extractPresentationText } from "./officeText";
import { toPassages } from "./passages";
import { spreadsheetToLLMText } from "./spreadsheet";
import { downloadFile } from "./storage";
import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

export type IndexableVersion = {
  id: string;
  document_id: string;
  storage_path: string | null;
  pdf_storage_path: string | null;
  file_type: string | null;
};

/** Rows are written in batches so one enormous document cannot stall the write. */
const INSERT_BATCH = 200;

/**
 * Reads a PDF page by page, labelling each page the way the assistant's reader
 * does, so passages can be tied back to a page number.
 */
async function pdfPageText(buf: Buffer): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
  const pdf = await (
    pdfjsLib as unknown as {
      getDocument: (opts: unknown) => {
        promise: Promise<{
          numPages: number;
          getPage: (n: number) => Promise<{
            getTextContent: () => Promise<{ items: { str?: string }[] }>;
          }>;
        }>;
      };
    }
  ).getDocument({
    data: new Uint8Array(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    ),
  }).promise;

  const parts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    parts.push(`[Page ${i}]\n${content.items.map((it) => it.str ?? "").join(" ")}`);
  }
  return parts.join("\n\n");
}

/**
 * The text of a stored version.
 *
 * The PDF rendition is preferred whenever one exists — for a scan or photograph
 * it is the only copy with text, and for a Word, PowerPoint or text file it
 * carries page numbers the original does not, so citations line up with what is
 * shown on screen. This also covers an ordinary PDF, whose rendition is itself.
 *
 * Only when there is no rendition — a conversion that failed at upload, an image
 * whose OCR failed — does it fall back to the original, and then it reads with a
 * reader that suits the type. It never parses non-PDF bytes as a PDF, which is
 * how a Word file with no rendition used to fail.
 */
async function versionText(version: IndexableVersion): Promise<string> {
  const fileType = (version.file_type ?? "").toLowerCase();

  if (version.pdf_storage_path) {
    const raw = await downloadFile(version.pdf_storage_path);
    if (raw) return pdfPageText(Buffer.from(raw));
  }

  if (!version.storage_path) return "";
  const raw = await downloadFile(version.storage_path);
  if (!raw) return "";
  const buf = Buffer.from(raw);

  if (fileType === "pdf") return pdfPageText(buf);
  if (isSpreadsheetDocumentType(fileType)) return spreadsheetToLLMText(buf);
  if (isWordDocumentType(fileType)) {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer: buf });
    return result.value ?? "";
  }
  if (isPresentationDocumentType(fileType)) return extractPresentationText(buf);
  if (isTextDocumentType(fileType)) return buf.toString("utf8");
  // An image whose OCR produced no rendition has no text to store.
  return "";
}

export type IndexResult = {
  passages: number;
  /** Set when nothing could be stored, in words worth logging. */
  reason?: string;
};

/**
 * Stores the passages for one version, replacing anything stored for it before.
 * Safe to re-run: re-indexing a document never touches the rest of the matter.
 */
export async function indexVersion(
  db: Db,
  params: {
    version: IndexableVersion;
    userId: string;
    projectId: string | null;
  },
): Promise<IndexResult> {
  const { version, userId, projectId } = params;

  let text = "";
  try {
    text = await versionText(version);
  } catch (err) {
    return { passages: 0, reason: `could not be read: ${String(err)}` };
  }

  const passages = toPassages(text);
  if (passages.length === 0) {
    // Not an error. A picture of a wall has no text in it either.
    await db.from("document_passages").delete().eq("version_id", version.id);
    return { passages: 0, reason: "no text found" };
  }

  const fromOcr = isOcrDerived(version);
  const rows = passages.map((passage) => ({
    document_id: version.document_id,
    version_id: version.id,
    user_id: userId,
    project_id: projectId,
    page: passage.page,
    ordinal: passage.ordinal,
    content: passage.content,
    from_ocr: fromOcr,
  }));

  // Replace rather than add to, so re-indexing cannot leave stale passages
  // behind and duplicate a document in the results.
  const { error: clearErr } = await db
    .from("document_passages")
    .delete()
    .eq("version_id", version.id);
  if (clearErr) {
    return { passages: 0, reason: `could not clear old passages: ${clearErr.message}` };
  }

  for (let i = 0; i < rows.length; i += INSERT_BATCH) {
    const { error } = await db
      .from("document_passages")
      .insert(rows.slice(i, i + INSERT_BATCH));
    if (error) {
      return { passages: 0, reason: `could not store passages: ${error.message}` };
    }
  }

  return { passages: rows.length };
}

/**
 * Stores passages after the response has gone out. Errors are logged and
 * swallowed: failing to index must never fail an upload.
 */
export function indexInBackground(
  db: Db,
  params: {
    version: IndexableVersion;
    userId: string;
    projectId: string | null;
    label?: string;
  },
): void {
  const label = params.label ?? "index";
  void (async () => {
    try {
      const started = Date.now();
      const result = await indexVersion(db, params);
      const seconds = ((Date.now() - started) / 1000).toFixed(1);
      if (result.passages > 0) {
        console.log(
          `[${label}] stored ${result.passages} passages for document ${params.version.document_id} in ${seconds}s`,
        );
      } else {
        console.log(
          `[${label}] no passages for document ${params.version.document_id} — ${result.reason ?? "unknown"}`,
        );
      }
    } catch (err) {
      console.error(`[${label}] indexing failed:`, err);
    }
  })();
}
