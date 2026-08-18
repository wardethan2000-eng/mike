// One place that decides what PDF rendition a stored document gets.
//
// Three upload paths need identical behaviour (a new document, a document
// added to a project, and a replacement version), so the rule lives here:
//
//   Word/PowerPoint/text  -> LibreOffice renders a PDF for preview
//   images                -> the picture becomes a PDF, then OCR adds the text
//   PDFs that are scans   -> a searchable copy is made and used for reading
//   PDFs that have text   -> the file is its own rendition, nothing to do
//   spreadsheets          -> no rendition; the frontend draws them as a grid
//
// The work is split in two because reading a scan is slow — roughly eight
// seconds a page, so minutes for a long bundle, far too long to hold a web
// request open. `prepareRendition` does the quick part and returns; the
// document is stored and previewable immediately. `completeRendition` does the
// reading afterwards and the caller saves the result.
//
// A failure never fails the upload — the document is still stored, it just has
// no text layer, and the caller is told so it can say as much.
import { convertedPdfKey, docxToPdf } from "./convert";
import {
  isImageDocumentType,
  isTextDocumentType,
  shouldConvertToPdf,
} from "./documentTypes";
import { ocrPdf, pdfFromImage, pdfHasTextLayer } from "./ocr";
import { downloadFile, uploadFile } from "./storage";
import type { createServerSupabase } from "./supabase";

export type PreparedRendition = {
  /** Storage key of the PDF to preview and read from, if there is one. */
  pdfStoragePath: string | null;
  /** Page count of the rendition, when the original did not have one. */
  pageCount: number | null;
  /** Plain-language warning for the user, e.g. a low-resolution scan. */
  warning: string | null;
  /** True when the document still needs reading; call completeRendition next. */
  ocrPending: boolean;
};

export type CompletedRendition = {
  /** Storage key of the searchable PDF, or null if reading failed. */
  pdfStoragePath: string | null;
  pageCount: number | null;
};

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}

async function countPages(buf: Buffer): Promise<number | null> {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    const pdf = await (
      pdfjsLib as unknown as {
        getDocument: (opts: unknown) => {
          promise: Promise<{ numPages: number }>;
        };
      }
    ).getDocument({ data: new Uint8Array(toArrayBuffer(buf)) }).promise;
    return pdf.numPages;
  } catch {
    return null;
  }
}

export type RenditionTarget = {
  content: Buffer;
  suffix: string;
  userId: string;
  docId: string;
  /** Storage key the original file was written to. */
  storagePath: string;
  /** Key to write the rendition to. Defaults to the per-document key. */
  pdfKey?: string;
  /** Page count of the original, when already known. */
  pageCount?: number | null;
  /** Prefix for log lines, e.g. "upload". */
  label?: string;
};

function renditionKey(target: RenditionTarget): string {
  return target.pdfKey ?? convertedPdfKey(target.userId, target.docId);
}

/** The quick part: everything that can be done while the user waits. */
export async function prepareRendition(
  target: RenditionTarget,
): Promise<PreparedRendition> {
  const { content, suffix, storagePath, pageCount = null, label = "rendition" } =
    target;
  const pdfKey = renditionKey(target);
  const nothing: PreparedRendition = {
    pdfStoragePath: null,
    pageCount: null,
    warning: null,
    ocrPending: false,
  };

  const store = async (pdf: Buffer) => {
    await uploadFile(pdfKey, toArrayBuffer(pdf), "application/pdf");
    return pdfKey;
  };

  if (shouldConvertToPdf(suffix)) {
    try {
      const pdfBuf = await docxToPdf(content);
      return {
        pdfStoragePath: await store(pdfBuf),
        pageCount: await countPages(pdfBuf),
        warning: null,
        ocrPending: false,
      };
    } catch (err) {
      console.error(`[${label}] PDF conversion failed for ${suffix}:`, err);
      return nothing;
    }
  }

  if (isImageDocumentType(suffix)) {
    // Store the picture as a PDF now so it can be previewed, and read it after
    // the upload has been answered.
    const { pdf, warning } = await pdfFromImage(content, suffix);
    if (!pdf) {
      return {
        ...nothing,
        warning:
          warning ??
          "This image could not be read, so its text is not searchable. It is still stored and can be downloaded.",
      };
    }
    try {
      return {
        pdfStoragePath: await store(pdf),
        pageCount: await countPages(pdf),
        warning,
        ocrPending: true,
      };
    } catch (err) {
      console.error(`[${label}] storing the image rendition failed:`, err);
      return { ...nothing, warning };
    }
  }

  if (suffix === "pdf") {
    // Checking for a text layer takes about a second, so it is worth doing
    // here: an ordinary PDF is then finished and never marked as processing.
    const hasText = await pdfHasTextLayer(content, pageCount);
    return {
      pdfStoragePath: storagePath,
      pageCount: null,
      warning: null,
      ocrPending: hasText === false,
    };
  }

  return nothing;
}

/**
 * The slow part: reading the document. Safe to run in the background, and safe
 * to re-run. Returns the key of the searchable PDF, or null if reading failed.
 */
export async function completeRendition(
  target: RenditionTarget,
): Promise<CompletedRendition> {
  const { suffix, storagePath, label = "rendition" } = target;
  const pdfKey = renditionKey(target);
  const failed: CompletedRendition = { pdfStoragePath: null, pageCount: null };

  try {
    let source: Buffer | null = null;
    let oversample = false;

    if (isImageDocumentType(suffix)) {
      // Read back the one-page PDF prepared a moment ago. A single page is
      // cheap enough to oversample, which helps a coarse photograph.
      const stored = await downloadFile(pdfKey);
      source = stored ? Buffer.from(stored) : null;
      oversample = true;
    } else if (suffix === "pdf") {
      source = target.content;
    }
    if (!source) {
      console.error(`[${label}] nothing to read for ${suffix}`);
      return failed;
    }

    const searchable = await ocrPdf(source, { oversample });
    if (!searchable) return failed;

    await uploadFile(pdfKey, toArrayBuffer(searchable), "application/pdf");
    return {
      pdfStoragePath: pdfKey,
      pageCount: await countPages(searchable),
    };
  } catch (err) {
    console.error(`[${label}] reading the document failed:`, err);
    return failed;
  } finally {
    // The original upload is never touched, so a failure here leaves the
    // document exactly as it was: stored, previewable, just not searchable.
    void storagePath;
  }
}

/**
 * True when this version's readable PDF is a separate, OCR'd copy rather than
 * the file the user uploaded — i.e. the text came from character recognition
 * and should be quoted with care.
 */
export function isOcrDerived(version: {
  file_type?: string | null;
  storage_path?: string | null;
  pdf_storage_path?: string | null;
}): boolean {
  if (!version.pdf_storage_path) return false;
  if (isImageDocumentType(version.file_type)) return true;
  return (
    (version.file_type ?? "").toLowerCase() === "pdf" &&
    version.pdf_storage_path !== version.storage_path
  );
}

/**
 * True when a version should be read from its PDF rendition rather than the
 * uploaded bytes: pictures and scans, whose text only exists in the OCR copy,
 * and plain-text files, whose rendition carries the page numbers used in
 * citations. Word files are excluded — they have their own reader that
 * understands tracked changes.
 */
export function shouldReadFromRendition(
  version:
    | {
        file_type?: string | null;
        storage_path?: string | null;
        pdf_storage_path?: string | null;
      }
    | null
    | undefined,
): boolean {
  if (!version?.pdf_storage_path) return false;
  const fileType = (version.file_type ?? "").toLowerCase();
  if (isImageDocumentType(fileType) || isTextDocumentType(fileType)) return true;
  return fileType === "pdf" && version.pdf_storage_path !== version.storage_path;
}

/**
 * Reads a document after its upload has been answered, then saves the result
 * and marks the document ready. Errors are swallowed deliberately: this runs
 * detached from any request, and a document that could not be read is still a
 * document the user can open and download.
 */
export function readInBackground(
  db: ReturnType<typeof createServerSupabase>,
  params: { documentId: string; versionId: string; target: RenditionTarget },
): void {
  const { documentId, versionId, target } = params;
  void (async () => {
    const started = Date.now();
    const result = await completeRendition(target);
    const seconds = Math.round((Date.now() - started) / 1000);
    try {
      if (result.pdfStoragePath) {
        const values: Record<string, unknown> = {
          pdf_storage_path: result.pdfStoragePath,
        };
        if (result.pageCount) values.page_count = result.pageCount;
        await db.from("document_versions").update(values).eq("id", versionId);
        console.log(
          `[ocr] read ${target.suffix} document ${documentId} in ${seconds}s`,
        );
      } else {
        console.error(
          `[ocr] could not read ${target.suffix} document ${documentId} after ${seconds}s`,
        );
      }
      // Ready either way — the document is usable, with or without its text.
      await db
        .from("documents")
        .update({ status: "ready", updated_at: new Date().toISOString() })
        .eq("id", documentId);
    } catch (err) {
      console.error(`[ocr] saving the result for ${documentId} failed:`, err);
    }
  })();
}
