export const OFFICE_DOCUMENT_TYPES = new Set([
  "pdf",
  "docx",
  "doc",
  "xlsx",
  "xlsm",
  "xls",
  "pptx",
  "ppt",
]);

// Photos and scans. These carry no text of their own; on upload they are turned
// into a PDF with a text layer (see lib/ocr.ts) so the rest of the app — page
// citations, search, tabular review — works on them unchanged.
export const IMAGE_DOCUMENT_TYPES = new Set([
  "jpg",
  "jpeg",
  "png",
  "tif",
  "tiff",
  "bmp",
  "gif",
  "heic",
  "heif",
  "webp",
]);

// Plain-text and simple word-processor formats. LibreOffice is already present
// for the Office conversions and handles these too, so they cost nothing extra.
export const TEXT_DOCUMENT_TYPES = new Set([
  "txt",
  "md",
  "csv",
  "rtf",
  "odt",
]);

export const ALLOWED_DOCUMENT_TYPES = new Set([
  ...OFFICE_DOCUMENT_TYPES,
  ...IMAGE_DOCUMENT_TYPES,
  ...TEXT_DOCUMENT_TYPES,
]);

export const ALLOWED_DOCUMENT_TYPES_LABEL = [...ALLOWED_DOCUMENT_TYPES].join(", ");

const WORD_TYPES = new Set(["docx", "doc"]);
const SPREADSHEET_TYPES = new Set(["xlsx", "xlsm", "xls"]);
const PRESENTATION_TYPES = new Set(["pptx", "ppt"]);

export function isWordDocumentType(fileType: string | null | undefined) {
  return WORD_TYPES.has((fileType ?? "").toLowerCase());
}

export function isSpreadsheetDocumentType(fileType: string | null | undefined) {
  return SPREADSHEET_TYPES.has((fileType ?? "").toLowerCase());
}

export function isPresentationDocumentType(fileType: string | null | undefined) {
  return PRESENTATION_TYPES.has((fileType ?? "").toLowerCase());
}

export function isImageDocumentType(fileType: string | null | undefined) {
  return IMAGE_DOCUMENT_TYPES.has((fileType ?? "").toLowerCase());
}

export function isTextDocumentType(fileType: string | null | undefined) {
  return TEXT_DOCUMENT_TYPES.has((fileType ?? "").toLowerCase());
}

export function shouldConvertToPdf(fileType: string | null | undefined) {
  const normalized = (fileType ?? "").toLowerCase();
  // Spreadsheets are intentionally excluded: they are rendered natively as a
  // grid in the frontend (Fortune-sheet) from the raw file bytes rather than a
  // PDF rendition, which clipped wide/large sheets.
  // Images are excluded too — they take the OCR path in lib/ocr.ts, which
  // produces a PDF rendition that also carries a text layer.
  return (
    isWordDocumentType(normalized) ||
    isPresentationDocumentType(normalized) ||
    isTextDocumentType(normalized)
  );
}

export function contentTypeForDocumentType(fileType: string | null | undefined) {
  switch ((fileType ?? "").toLowerCase()) {
    case "pdf":
      return "application/pdf";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "xlsm":
      return "application/vnd.ms-excel.sheet.macroEnabled.12";
    case "xls":
      return "application/vnd.ms-excel";
    case "pptx":
      return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
    case "ppt":
      return "application/vnd.ms-powerpoint";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "tif":
    case "tiff":
      return "image/tiff";
    case "bmp":
      return "image/bmp";
    case "gif":
      return "image/gif";
    case "heic":
      return "image/heic";
    case "heif":
      return "image/heif";
    case "webp":
      return "image/webp";
    case "txt":
      return "text/plain";
    case "md":
      return "text/markdown";
    case "csv":
      return "text/csv";
    case "rtf":
      return "application/rtf";
    case "odt":
      return "application/vnd.oasis.opendocument.text";
    default:
      return "application/octet-stream";
  }
}
