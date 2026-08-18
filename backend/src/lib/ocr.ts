// Optical character recognition for scans and photos.
//
// Mike reads the text layer inside a PDF. A scan or a photo has no text layer,
// so one is added here on upload: the image becomes a PDF, the PDF is run
// through ocrmypdf, and the searchable result is stored as the document's PDF
// rendition. Everything downstream — preview, page citations, search, tabular
// review — then works on it unchanged.
//
// This mirrors /usr/local/bin/make-searchable on the host, deliberately using
// the same flags so both routes produce the same quality of text.
//
// Nothing here is allowed to fail an upload. Every entry point returns null on
// error and logs; the document is still stored, just without a text layer.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// A PDF page with fewer than this many non-space characters is treated as an
// image of a page rather than a page of text. Scanned bundles often carry a
// stamped page number or a Bates label and nothing else, which is exactly the
// case this threshold is here to catch.
export const MIN_CHARS_PER_PAGE = 24;

// Below roughly 150 dpi character accuracy collapses (measured: 0.2% wrong
// characters at 150 dpi, 20.7% at 120 dpi on the same page). Warn rather than
// refuse — the user may still want a poor scan on file.
export const LOW_RESOLUTION_DPI = 150;

// Assumed length of a scanned page's long edge, in inches, when estimating
// resolution from pixel size. Letter (11") and A4 (11.7") are close enough at
// this precision.
const ASSUMED_PAGE_LENGTH_INCHES = 11;

const IMAGE_CONVERT_TIMEOUT_MS = 120_000;
// OCR runs at roughly 18 seconds a page, so a long bundle needs real headroom.
const OCR_TIMEOUT_MS = 20 * 60_000;

type RunResult = { ok: boolean; stdout: string; stderr: string };

function run(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      return resolve({ ok: false, stdout: "", stderr: String(err) });
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      stderr += `\n${cmd} timed out after ${timeoutMs}ms`;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      stderr += String(d);
    });
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok, stdout, stderr });
    };
    child.on("error", (err) => {
      stderr += String(err);
      finish(false);
    });
    child.on("close", (code) => finish(code === 0));
  });
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mike-ocr-"));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

let _toolsAvailable: boolean | null = null;

/** True when ocrmypdf is installed in this container. */
export async function ocrAvailable(): Promise<boolean> {
  if (_toolsAvailable !== null) return _toolsAvailable;
  const { ok } = await run("ocrmypdf", ["--version"], 30_000);
  if (!ok) {
    console.error(
      "[ocr] ocrmypdf is not available in this image — scans and photos will be stored without a text layer",
    );
  }
  _toolsAvailable = ok;
  return ok;
}

/**
 * Estimated resolution of a scan, in dots per inch.
 *
 * Two readings are taken and the better one wins. The density recorded inside
 * the file is right when it is there, but phones and many scanners write a
 * meaningless 72; the pixel size measured against a page's long edge is right
 * for a full page but reads low for a photo of part of one. Taking the higher
 * of the two means a good scan is never wrongly called poor, which matters
 * more here than catching every bad one.
 *
 * Returns null when the image cannot be measured.
 */
export async function estimateImageDpi(
  buf: Buffer,
  ext: string,
): Promise<number | null> {
  return withTempDir(async (dir) => {
    const input = path.join(dir, `in.${ext}`);
    await fs.writeFile(input, buf);
    const { ok, stdout } = await run(
      "identify",
      ["-format", "%w %h %x %U", `${input}[0]`],
      IMAGE_CONVERT_TIMEOUT_MS,
    );
    if (!ok) return null;
    const [rawWidth, rawHeight, rawDensity, units] = stdout.trim().split(/\s+/);
    const width = Number(rawWidth);
    const height = Number(rawHeight);
    if (!width || !height) return null;

    const fromPixels = Math.round(
      Math.max(width, height) / ASSUMED_PAGE_LENGTH_INCHES,
    );
    // PNG records density per centimetre, JPEG and TIFF per inch. A file that
    // gives a number but no unit is read as inches — per centimetre would mean
    // an implausible resolution, and a file with no density at all reports 72,
    // which is discarded below either way.
    const density = Number(rawDensity);
    const perInch =
      units === "PixelsPerCentimeter" ? density * 2.54 : density;
    // 72 is what software writes when it does not actually know, and anything
    // above 1200 is a corrupt or nonsensical reading.
    const fromFile =
      Number.isFinite(perInch) && perInch > 72 && perInch <= 1200
        ? Math.round(perInch)
        : 0;
    return Math.max(fromPixels, fromFile);
  });
}

/** Wraps an image in a PDF, one page, without adding any text. */
async function imageToPdf(buf: Buffer, ext: string): Promise<Buffer | null> {
  return withTempDir(async (dir) => {
    const original = path.join(dir, `in.${ext}`);
    await fs.writeFile(original, buf);
    const output = path.join(dir, "out.pdf");
    let source = original;

    // HEIC/HEIF are not understood by img2pdf and usually not by ImageMagick
    // without a delegate, so unwrap them to JPEG first.
    if (ext === "heic" || ext === "heif") {
      const jpeg = path.join(dir, "in.jpg");
      const converted = await run(
        "heif-convert",
        ["-q", "95", original, jpeg],
        IMAGE_CONVERT_TIMEOUT_MS,
      );
      if (converted.ok) source = jpeg;
    }

    // img2pdf embeds JPEG and PNG data losslessly and is the preferred route.
    const direct = await run(
      "img2pdf",
      [source, "-o", output],
      IMAGE_CONVERT_TIMEOUT_MS,
    );
    if (direct.ok) return fs.readFile(output);

    // Everything else — webp, gif, bmp, palette PNGs, anything img2pdf
    // rejects — is normalised to PNG by ImageMagick and then wrapped by
    // img2pdf. ImageMagick is deliberately never asked to write the PDF
    // itself: Debian's ImageMagick policy forbids it, and that policy is a
    // Ghostscript hardening measure worth leaving in place.
    const normalized = path.join(dir, "normalized.png");
    for (const magick of ["magick", "convert"]) {
      const conversion = await run(
        magick,
        [`${source}[0]`, normalized],
        IMAGE_CONVERT_TIMEOUT_MS,
      );
      if (!conversion.ok) continue;
      const wrapped = await run(
        "img2pdf",
        [normalized, "-o", output],
        IMAGE_CONVERT_TIMEOUT_MS,
      );
      if (wrapped.ok) return fs.readFile(output);
    }
    console.error(`[ocr] could not turn a .${ext} image into a PDF`);
    return null;
  });
}

/**
 * Adds a text layer to a PDF. Pages that already carry text are left exactly
 * as they are, so running a mixed bundle through this is safe.
 */
export async function ocrPdf(
  buf: Buffer,
  options: { oversample?: boolean } = {},
): Promise<Buffer | null> {
  if (!(await ocrAvailable())) return null;
  return withTempDir(async (dir) => {
    const input = path.join(dir, "in.pdf");
    const output = path.join(dir, "out.pdf");
    await fs.writeFile(input, buf);
    const result = await run(
      "ocrmypdf",
      [
        // One page at a time. Left to itself ocrmypdf works on as many pages
        // as there are processors, and on a machine this size that runs it
        // out of memory on a long scan — the whole run is then killed and the
        // document silently stays unreadable.
        "--jobs",
        "1",
        "--skip-text",
        "--deskew",
        "--clean",
        "--rotate-pages",
        // Oversampling helps a coarse scan and costs a lot of memory, so it
        // is used only for single pictures, never for long bundles.
        ...(options.oversample ? ["--oversample", "400"] : []),
        "--output-type",
        "pdf",
        "--quiet",
        input,
        output,
      ],
      OCR_TIMEOUT_MS,
    );
    if (!result.ok) {
      const reason =
        result.stderr.trim() ||
        result.stdout.trim() ||
        "no output — the process was killed, most likely by the machine running out of memory";
      console.error(`[ocr] ocrmypdf failed: ${reason.slice(0, 500)}`);
      return null;
    }
    return fs.readFile(output).catch(() => null);
  });
}

/**
 * True when a PDF looks like a scan: it has pages, but almost no text on them.
 * `text` is the output of extractPdfText, which labels every page.
 */
export function pdfNeedsOcr(text: string, pageCount: number | null): boolean {
  const pages = pageCount && pageCount > 0 ? pageCount : 1;
  const stripped = text.replace(/\[Page \d+\]/g, "").replace(/\s+/g, "");
  return stripped.length < MIN_CHARS_PER_PAGE * pages;
}

export type SearchableResult = {
  /** A PDF carrying a text layer, or null if one could not be produced. */
  pdf: Buffer | null;
  /** Plain-language warning to show the user, or null if there is nothing to say. */
  warning: string | null;
};

/**
 * Wraps an uploaded picture in a PDF so it can be previewed straight away.
 * No text is added here — that is the slow part and happens afterwards.
 * Never throws.
 */
export async function pdfFromImage(
  buf: Buffer,
  ext: string,
): Promise<SearchableResult> {
  try {
    const dpi = await estimateImageDpi(buf, ext);
    const warning =
      dpi !== null && dpi < LOW_RESOLUTION_DPI
        ? `This image is low resolution (about ${dpi} dots per inch). Text read from it is often wrong — rescan at 300 dpi and check any figures against the original.`
        : null;
    return { pdf: await imageToPdf(buf, ext), warning };
  } catch (err) {
    console.error("[ocr] unexpected failure preparing an image:", err);
    return { pdf: null, warning: null };
  }
}

/** Non-space character count of a PDF's existing text layer, or null. */
async function pdfTextCharCount(buf: Buffer): Promise<number | null> {
  return withTempDir(async (dir) => {
    const input = path.join(dir, "in.pdf");
    await fs.writeFile(input, buf);
    const { ok, stdout } = await run(
      "pdftotext",
      [input, "-"],
      IMAGE_CONVERT_TIMEOUT_MS,
    );
    if (!ok) return null;
    return stdout.replace(/\s+/g, "").length;
  });
}

/**
 * True when a PDF already carries a usable text layer. Null when it could not
 * be measured, in which case the file is best left alone.
 */
export async function pdfHasTextLayer(
  buf: Buffer,
  pageCount: number | null,
): Promise<boolean | null> {
  const chars = await pdfTextCharCount(buf);
  if (chars === null) return null;
  const pages = pageCount && pageCount > 0 ? pageCount : 1;
  return chars >= MIN_CHARS_PER_PAGE * pages;
}

/** Note prepended to text that came from OCR, so the model treats it with care. */
export const OCR_TEXT_NOTE =
  "[Read by optical character recognition from a scan or photograph. Wording and figures may contain recognition errors — check anything you quote against the original document.]";
