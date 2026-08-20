import {
  downloadFile,
  generatedDocKey,
  uploadFile,
} from "../../storage";
import { convertedPdfKey, docxToPdf } from "../../convert";
import { createServerSupabase } from "../../supabase";
import {
  applyFormattedEdits,
  applyHeaderFooterEdits,
  applyTrackedEdits,
  extractDocxHeadersFooters,
  extractDocxBodyParagraphs,
  extractDocxBodyText,
  extractDocxBodyTextMarked,
  inlineEditRuns,
  insertTrackedTables,
  parseLayoutTokens,
  runsToMarkedText,
  stripInlineMarkers,
  stripLayoutTokens,
  resolveTrackedChange,
  StaleDocumentError,
  type EditInput,
  type EditParagraph,
  type EditRun,
} from "../../docxTrackedChanges";
import { buildDownloadUrl } from "../../downloadTokens";
import {
  contentSha256,
  loadActiveVersion,
} from "../../documentVersions";
import {
  type DocStore,
  type DocIndex,
  type EditAnnotation,
  STANDARD_FONT_DATA_URL,
  devLog,
} from "../types";
import {
  contentTypeForDocumentType,
  isPresentationDocumentType,
  isSpreadsheetDocumentType,
  isWordDocumentType,
  shouldConvertToPdf,
} from "../../documentTypes";
import {
  isOcrDerived,
  shouldReadFromRendition,
} from "../../documentRendition";
import { OCR_TEXT_NOTE } from "../../ocr";
import { safeErrorMessage } from "../../safeError";
import { extractPresentationText } from "../../officeText";
import { spreadsheetToLLMText } from "../../spreadsheet";


export function citationReminder(
  docLabel: string,
  filename: string,
  promptFilename: string,
): string {
  const isSpreadsheet = isSpreadsheetDocumentType(
    filename.split(".").pop() ?? "",
  );
  const shapeLine = isSpreadsheet
    ? `Use this citation object shape for this spreadsheet: {"ref": 1, "doc_id": "${docLabel}", "quotes": [{"sheet": "Sheet name", "cell": "B7", "quote": "plain cell value"}]}. Cite by "sheet" + "cell" (A1 address or range), not by page.`
    : `Use this citation object shape: {"ref": 1, "doc_id": "${docLabel}", "quotes": [{"page": 1, "quote": "exact verbatim text from the document"}]}. Include top-level "page" and "quote" too only if they match the first quote.`;
  return [
    `[Citation requirement for ${docLabel}]:`,
    `Document filename: ${promptFilename}`,
    `If your final answer makes any factual claim from this document, include inline [N] markers and append a final <CITATIONS> JSON block.`,
    `Every citation entry for this document MUST use "doc_id": "${docLabel}".`,
    shapeLine,
    `Do not use "marker" or "text" keys in the citation block; use "ref" and "quotes".`,
  ].join("\n");
}

export async function extractPdfText(buf: ArrayBuffer): Promise<string> {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    const pdf = await (
      pdfjsLib as unknown as {
        getDocument: (opts: unknown) => {
          promise: Promise<{
            numPages: number;
            getPage: (n: number) => Promise<{
              getTextContent: () => Promise<{
                items: { str?: string }[];
              }>;
            }>;
          }>;
        };
      }
    ).getDocument({
      data: new Uint8Array(buf),
      standardFontDataUrl: STANDARD_FONT_DATA_URL,
    }).promise;
    const parts: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      parts.push(
        `[Page ${i}]\n${textContent.items.map((it) => it.str ?? "").join(" ")}`,
      );
    }
    return parts.join("\n\n");
  } catch {
    return "";
  }
}

/**
 * The text of a PDF grouped into paragraphs, using the page's own geometry:
 * items sharing a baseline make a line, and a vertical gap clearly larger
 * than the page's usual line spacing starts a new paragraph. Used when a PDF
 * precedent is copied into an editable Word file — a paragraph per visual
 * blob reads far better than a paragraph per page.
 */
export async function extractPdfParagraphs(
  buf: ArrayBuffer,
): Promise<string[]> {
  try {
    const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs" as string);
    const pdf = await (
      pdfjsLib as unknown as {
        getDocument: (opts: unknown) => {
          promise: Promise<{
            numPages: number;
            getPage: (n: number) => Promise<{
              getTextContent: () => Promise<{
                items: { str?: string; transform?: number[] }[];
              }>;
            }>;
          }>;
        };
      }
    ).getDocument({
      data: new Uint8Array(buf),
      standardFontDataUrl: STANDARD_FONT_DATA_URL,
    }).promise;

    const paragraphs: string[] = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();

      // Bucket items into lines by their baseline y (rounded to absorb
      // sub-pixel jitter), keeping x order within a line and remembering how
      // far right each line reaches.
      const lines = new Map<
        number,
        { x: number; right: number; str: string }[]
      >();
      for (const item of textContent.items) {
        const str = item.str ?? "";
        if (!str.trim()) continue;
        const t = item.transform ?? [];
        const y = Math.round((t[5] ?? 0) * 2) / 2;
        const x = t[4] ?? 0;
        const width = (item as { width?: number }).width ?? 0;
        const bucket = lines.get(y);
        const entry = { x, right: x + width, str };
        if (bucket) bucket.push(entry);
        else lines.set(y, [entry]);
      }
      const ordered = [...lines.entries()]
        .sort((a, b) => b[0] - a[0]) // top of the page first
        .map(([y, items]) => ({
          y,
          right: Math.max(...items.map((it) => it.right)),
          text: items
            .sort((a, b) => a.x - b.x)
            .map((it) => it.str)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim(),
        }))
        .filter((line) => line.text);
      if (ordered.length === 0) continue;

      // Two signals end a paragraph: a vertical gap clearly wider than the
      // page's usual line spacing, and a line that stops well short of the
      // page's usual right edge (the last line of justified/wrapped text).
      const gaps: number[] = [];
      for (let j = 1; j < ordered.length; j++) {
        gaps.push(ordered[j - 1].y - ordered[j].y);
      }
      const sortedGaps = [...gaps].sort((a, b) => a - b);
      const medianGap = sortedGaps.length
        ? sortedGaps[Math.floor(sortedGaps.length / 2)]
        : 0;
      const gapThreshold =
        medianGap > 0 ? medianGap * 1.6 : Number.POSITIVE_INFINITY;
      const rights = ordered.map((line) => line.right).sort((a, b) => a - b);
      const pageRight = rights[Math.floor(rights.length * 0.9)] ?? 0;
      const shortLine = (right: number) =>
        pageRight > 0 && right < pageRight * 0.85;

      let current = ordered[0].text;
      for (let j = 1; j < ordered.length; j++) {
        if (gaps[j - 1] > gapThreshold || shortLine(ordered[j - 1].right)) {
          paragraphs.push(current);
          current = ordered[j].text;
        } else {
          current += ` ${ordered[j].text}`;
        }
      }
      paragraphs.push(current);
    }
    return paragraphs;
  } catch {
    return [];
  }
}

export type DocxStyle = {
  font?: string;
  fontSize?: number;
  lineSpacing?: string;
  margins?: {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  };
  pageNumbers?: boolean;
  numbering?: string;
  showTitle?: boolean;
  titleAlign?: string;
};

export type DocxSectionFormat = {
  align?: string;
  indent?: number;
  firstLineIndent?: number;
  spaceAfter?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
};

const clampNumber = (
  value: unknown,
  min: number,
  max: number,
  fallback: number,
) => {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
};

// Word stores line spacing in twentieths of a point; 240 is single spacing
// at the usual 12pt line. Returning null leaves Word's own default alone.
const lineSpacingTwips = (value: unknown): number | null => {
  const key = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (key === "double" || key === "2" || key === "2.0") return 480;
  if (key === "1.5" || key === "one and a half") return 360;
  if (key === "single" || key === "1" || key === "1.0") return 240;
  return null;
};

/**
 * Build a plain .docx from paragraph strings — standard legal formatting
 * (Times New Roman 12pt, 1" margins), one paragraph per entry. Used when a
 * PDF precedent is replicated: the PDF's wording carries over into a fully
 * editable Word file whose look is approximated rather than copied, because
 * PDF layout does not survive conversion in editable form.
 */
export async function docxBytesFromParagraphs(
  paragraphs: string[],
): Promise<Buffer> {
  const { Document, Packer, Paragraph, TextRun, convertInchesToTwip } =
    await import("docx");
  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: "Times New Roman", size: 24 } },
      },
    },
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertInchesToTwip(1),
              bottom: convertInchesToTwip(1),
              left: convertInchesToTwip(1),
              right: convertInchesToTwip(1),
            },
          },
        },
        children: paragraphs.map(
          (text) =>
            new Paragraph({
              children: [
                new TextRun({ text, font: "Times New Roman", size: 24 }),
              ],
              spacing: { after: 120 },
            }),
        ),
      },
    ],
  });
  return Buffer.from(await Packer.toBuffer(doc));
}

export async function generateDocx(
  title: string,
  sections: unknown[],
  userId: string,
  db: ReturnType<typeof createServerSupabase>,
  options?: {
    landscape?: boolean;
    projectId?: string | null;
    style?: DocxStyle;
  },
) {
  try {
    const {
      Document,
      Paragraph,
      HeadingLevel,
      Packer,
      Table,
      TableRow,
      TableCell,
      WidthType,
      BorderStyle,
      TextRun,
      AlignmentType,
      LevelFormat,
      LevelSuffix,
      PageOrientation,
      PageBreak,
      Footer,
      PageNumber,
      Tab,
      TabStopType,
      TabStopPosition,
      convertInchesToTwip,
    } = await import("docx");

    const style = options?.style ?? {};
    const FONT =
      typeof style.font === "string" && style.font.trim()
        ? style.font.trim()
        : "Times New Roman";
    // docx sizes are half-points; 11pt stays the default so existing
    // contract output is unchanged.
    const SIZE = Math.round(clampNumber(style.fontSize, 6, 72, 11) * 2);
    const LINE = lineSpacingTwips(style.lineSpacing);
    const numberingMode = style.numbering === "none" ? "none" : "legal";
    const showTitle = style.showTitle !== false;

    // Inline markers so a line can carry emphasis: **bold**, _underline_,
    // *italic*. Underline has no markdown equivalent but legal drafting
    // needs it constantly (case captions, defined terms, signature rules).
    const inlineRuns = (
      text: string,
      base?: { bold?: boolean; italics?: boolean; underline?: boolean },
    ): InstanceType<typeof TextRun>[] => {
      const runs: InstanceType<typeof TextRun>[] = [];
      const pattern = /(\*\*[^*]+\*\*|_[^_\n]+_|\*[^*\n]+\*)/g;
      const pushRun = (
        value: string,
        extra: { bold?: boolean; italics?: boolean; underline?: boolean },
      ) => {
        if (!value) return;
        for (const [i, piece] of value.split("\t").entries()) {
          if (i > 0) {
            runs.push(new TextRun({ children: [new Tab()], font: FONT, size: SIZE }));
          }
          if (!piece) continue;
          runs.push(
            new TextRun({
              text: piece,
              font: FONT,
              size: SIZE,
              color: "000000",
              bold: extra.bold ?? base?.bold,
              italics: extra.italics ?? base?.italics,
              underline:
                (extra.underline ?? base?.underline) ? {} : undefined,
            }),
          );
        }
      };
      let last = 0;
      for (const match of text.matchAll(pattern)) {
        const at = match.index ?? 0;
        pushRun(text.slice(last, at), {});
        const token = match[0];
        if (token.startsWith("**")) pushRun(token.slice(2, -2), { bold: true });
        else if (token.startsWith("_"))
          pushRun(token.slice(1, -1), { underline: true });
        else pushRun(token.slice(1, -1), { italics: true });
        last = at + token.length;
      }
      pushRun(text.slice(last), {});
      if (runs.length === 0) {
        runs.push(new TextRun({ text: "", font: FONT, size: SIZE }));
      }
      return runs;
    };

    // A tab in the text advances to the next stop. Two stops cover the
    // shapes legal documents actually use: a centre stop for signature
    // blocks and "Dated:" lines, and a right stop at the margin.
    const TAB_STOPS = [
      { type: TabStopType.LEFT, position: convertInchesToTwip(3.5) },
      { type: TabStopType.RIGHT, position: TabStopPosition.MAX },
    ];

    const alignOf = (value: unknown, fallback?: unknown) => {
      const key = typeof value === "string" ? value.trim().toLowerCase() : "";
      if (key === "center" || key === "centre") return AlignmentType.CENTER;
      if (key === "right") return AlignmentType.RIGHT;
      if (key === "justify" || key === "justified")
        return AlignmentType.JUSTIFIED;
      if (key === "left") return AlignmentType.LEFT;
      return fallback;
    };

    // Shared paragraph shape: the caller's alignment, indent and spacing if
    // it asked for any, otherwise the defaults this generator has always
    // used, so existing contract output is byte-for-byte unchanged.
    const paraProps = (
      fmt: DocxSectionFormat | undefined,
      defaults: { after: number; align?: unknown },
    ) => {
      const spacing: { after: number; line?: number } = {
        after: Math.round(
          clampNumber(fmt?.spaceAfter, 0, 72, defaults.after / 20) * 20,
        ),
      };
      if (LINE !== null) spacing.line = LINE;
      const left = clampNumber(fmt?.indent, 0, 8, 0);
      const first = clampNumber(fmt?.firstLineIndent, 0, 8, 0);
      const props: Record<string, unknown> = {
        spacing,
        alignment: alignOf(fmt?.align, defaults.align),
        tabStops: TAB_STOPS,
      };
      if (left > 0 || first > 0) {
        props.indent = {
          left: convertInchesToTwip(left),
          firstLine: first > 0 ? convertInchesToTwip(first) : undefined,
        };
      }
      return props;
    };

    type DocChild = InstanceType<typeof Paragraph> | InstanceType<typeof Table>;
    const children: DocChild[] = [];
    if (showTitle) {
      children.push(
        new Paragraph({
          heading: HeadingLevel.TITLE,
          ...paraProps(
            { align: style.titleAlign, spaceAfter: undefined },
            { after: 200, align: AlignmentType.CENTER },
          ),
          children: inlineRuns(
            numberingMode === "none" ? title : title.toUpperCase(),
            { bold: true },
          ),
        }),
      );
    }

    const cellBorder = {
      top: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
      bottom: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
      left: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
      right: { style: BorderStyle.SINGLE, size: 1, color: "CCCCCC" },
    };
    const noBorder = {
      top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
      bottom: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
      left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
      right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    };
    // Word draws its own single-line grid around a table unless the table
    // itself is told otherwise, so clearing the cell borders is not enough.
    const noTableBorder = {
      ...noBorder,
      insideHorizontal: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
      insideVertical: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
    };

    const headingLevels = [
      HeadingLevel.HEADING_1,
      HeadingLevel.HEADING_2,
      HeadingLevel.HEADING_3,
      HeadingLevel.HEADING_4,
    ];
    const LEGAL_NUMBERING_REF = "legal-clause-numbering";
    const legalNumbering = (level: number) => ({
      reference: LEGAL_NUMBERING_REF,
      level: Math.max(0, Math.min(level, 4)),
    });
    const legalNumberingLevels = [
      {
        level: 0,
        format: LevelFormat.DECIMAL,
        text: "%1.",
        alignment: AlignmentType.START,
        suffix: LevelSuffix.TAB,
        isLegalNumberingStyle: true,
        style: {
          paragraph: { indent: { left: 720, hanging: 720 } },
          run: {
            bold: true,
            color: "000000",
            font: FONT,
            size: SIZE,
          },
        },
      },
      {
        level: 1,
        format: LevelFormat.DECIMAL,
        text: "%1.%2",
        alignment: AlignmentType.START,
        suffix: LevelSuffix.TAB,
        isLegalNumberingStyle: true,
        style: {
          paragraph: { indent: { left: 720, hanging: 720 } },
          run: { color: "000000", font: FONT, size: SIZE },
        },
      },
      {
        level: 2,
        format: LevelFormat.LOWER_LETTER,
        text: "(%3)",
        alignment: AlignmentType.START,
        suffix: LevelSuffix.TAB,
        style: {
          paragraph: { indent: { left: 1440, hanging: 720 } },
          run: { color: "000000", font: FONT, size: SIZE },
        },
      },
      {
        level: 3,
        format: LevelFormat.LOWER_ROMAN,
        text: "(%4)",
        alignment: AlignmentType.START,
        suffix: LevelSuffix.TAB,
        style: {
          paragraph: { indent: { left: 1440, hanging: 720 } },
          run: { color: "000000", font: FONT, size: SIZE },
        },
      },
      {
        level: 4,
        format: LevelFormat.UPPER_LETTER,
        text: "(%5)",
        alignment: AlignmentType.START,
        suffix: LevelSuffix.TAB,
        style: {
          paragraph: { indent: { left: 2520, hanging: 720 } },
          run: { color: "000000", font: FONT, size: SIZE },
        },
      },
    ];
    const normalizeTable = (
      table: unknown,
    ): { headers: string[]; rows: string[][] } | null => {
      if (!table || typeof table !== "object") return null;
      const raw = table as { headers?: unknown; rows?: unknown };
      const headers = Array.isArray(raw.headers)
        ? raw.headers
            .map((header) => (typeof header === "string" ? header.trim() : ""))
            .filter(Boolean)
        : [];
      if (headers.length === 0) return null;

      const rawRows = Array.isArray(raw.rows) ? raw.rows : [];
      const rows = rawRows
        .filter((row): row is unknown[] => Array.isArray(row))
        .map((row) =>
          headers.map((_, i) => (typeof row[i] === "string" ? row[i] : "")),
        );

      return { headers, rows };
    };
    const stripManualNumbering = (
      value: string,
    ): { text: string; levelFromPrefix: number | null } => {
      const match = value.trim().match(/^(\d+(?:\.\d+)*)(?:[.)])?\s+(.+)$/);
      if (!match) return { text: value.trim(), levelFromPrefix: null };
      return {
        text: match[2].trim(),
        levelFromPrefix: match[1].split(".").length - 1,
      };
    };
    const parseManualListMarker = (
      value: string,
    ): { text: string; levelOffset: number | null } => {
      const trimmed = value.trim();
      const match = trimmed.match(/^(\(([a-z]+)\)|([a-z]+)[.)])\s+(.+)$/i);
      if (!match) return { text: trimmed, levelOffset: null };
      const marker = (match[2] ?? match[3] ?? "").toLowerCase();
      const isRoman =
        marker === "i" ||
        (marker.length > 1 &&
          /^(?:m{0,4}(?:cm|cd|d?c{0,3})(?:xc|xl|l?x{0,3})(?:ix|iv|v?i{0,3}))$/i.test(
            marker,
          ));
      return { text: match[4].trim(), levelOffset: isRoman ? 3 : 2 };
    };
    const normalizeHeadingText = (value: string) =>
      value
        .trim()
        .replace(/[^a-zA-Z0-9]+/g, " ")
        .trim()
        .toLowerCase();

    const isTitleLikeFirstHeading = (heading: string, sectionIndex: number) => {
      if (sectionIndex !== 0) return false;
      const normalized = normalizeHeadingText(heading);
      const titleNormalized = normalizeHeadingText(title);
      if (!normalized || !titleNormalized) return false;
      if (normalized === titleNormalized) return true;
      return (
        titleNormalized.includes(normalized) &&
        /\b(agreement|contract|deed|terms|policy|notice|nda|disclosure)\b/.test(
          normalized,
        )
      );
    };

    const isUnnumberedHeading = (heading: string, sectionIndex: number) => {
      const normalized = normalizeHeadingText(heading);
      if (!normalized) return true;
      if (normalized === "signatures" || normalized === "signature") {
        return true;
      }
      if (isTitleLikeFirstHeading(heading, sectionIndex)) {
        return true;
      }
      if (
        sectionIndex === 0 &&
        /^(agreement|contract|mutual non disclosure agreement|non disclosure agreement|employment agreement|service level agreement)$/.test(
          normalized,
        )
      ) {
        return true;
      }
      return false;
    };
    const isSignatureLine = (value: string) =>
      /^(?:by|name|title|date):\s*/i.test(value.trim());
    const looksLikeSignatureBlock = (value: string) => {
      const lines = value
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      if (lines.length === 0) return false;
      const signatureLineCount = lines.filter(isSignatureLine).length;
      return signatureLineCount >= 2;
    };
    let currentClauseLevel: number | null = null;

    for (const [sectionIndex, section] of (
      sections as {
        heading?: string;
        content?: string;
        level?: number;
        pageBreak?: boolean;
        format?: DocxSectionFormat;
        table?: {
          headers: string[];
          rows: string[][];
          borders?: boolean;
          headerRow?: boolean;
          widths?: number[];
        };
      }[]
    ).entries()) {
      if (section.pageBreak) {
        children.push(new Paragraph({ children: [new PageBreak()] }));
      }
      if (section.heading) {
        const stripped = stripManualNumbering(section.heading);
        const isUnnumbered = isUnnumberedHeading(stripped.text, sectionIndex);
        const skipHeading = isTitleLikeFirstHeading(
          stripped.text,
          sectionIndex,
        );
        const idx = Math.min(
          stripped.levelFromPrefix ?? (section.level ?? 1) - 1,
          3,
        );
        currentClauseLevel =
          numberingMode === "none" || isUnnumbered || skipHeading ? null : idx;
        const headingText =
          numberingMode === "legal" && idx === 0 && !isUnnumbered
            ? stripped.text.toUpperCase()
            : stripped.text;
        if (!skipHeading) {
          children.push(
            new Paragraph({
              heading: headingLevels[idx],
              numbering:
                numberingMode === "none" || isUnnumbered
                  ? undefined
                  : legalNumbering(idx),
              ...paraProps(section.format, { after: 160 }),
              children: inlineRuns(headingText, {
                bold: section.format?.bold ?? true,
                italics: section.format?.italic,
                underline: section.format?.underline,
              }),
            }),
          );
        }
      }
      const normalizedTable = normalizeTable(section.table);
      if (normalizedTable) {
        const { headers, rows } = normalizedTable;
        // A court caption or a two-column signature block is a table with
        // no rules and no header styling, so both are switchable.
        const showBorders = section.table?.borders !== false;
        const isHeaderRow = section.table?.headerRow !== false;
        const tableBorders = showBorders ? cellBorder : noBorder;
        const rawWidths = Array.isArray(section.table?.widths)
          ? section.table.widths
          : [];
        const cellWidth = (i: number) => {
          const pct = clampNumber(rawWidths[i], 1, 100, 0);
          return pct > 0
            ? { width: { size: pct, type: WidthType.PERCENTAGE } }
            : {};
        };
        const cellParagraphs = (
          value: string,
          opts: { bold?: boolean; align?: unknown },
        ) =>
          value.split("\n").map(
            (line) =>
              new Paragraph({
                children: inlineRuns(line, { bold: opts.bold }),
                alignment: opts.align as never,
              }),
          );
        const tableRows: InstanceType<typeof TableRow>[] = [];
        // Header row
        tableRows.push(
          new TableRow({
            tableHeader: isHeaderRow,
            children: headers.map(
              (h, i) =>
                new TableCell({
                  borders: tableBorders,
                  ...(isHeaderRow ? { shading: { fill: "F2F2F2" } } : {}),
                  ...cellWidth(i),
                  children: cellParagraphs(h, {
                    bold: isHeaderRow,
                    align: AlignmentType.LEFT,
                  }),
                }),
            ),
          }),
        );
        // Data rows — normalize each row to exactly colCount cells.
        // LLMs occasionally emit malformed rows (extra fragments from
        // stray delimiters, or short rows); padding/truncating here
        // keeps the rendered table aligned to the headers.
        for (const normalized of rows) {
          tableRows.push(
            new TableRow({
              children: normalized.map(
                (cell, i) =>
                  new TableCell({
                    borders: tableBorders,
                    ...cellWidth(i),
                    children: cellParagraphs(cell, {}),
                  }),
              ),
            }),
          );
        }
        children.push(
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            ...(showBorders ? {} : { borders: noTableBorder }),
            rows: tableRows,
          }),
        );
        children.push(new Paragraph({ text: "" }));
      }
      if (section.content) {
        let numberedBodyParagraphs = 0;
        const contentIsSignatureBlock =
          section.heading &&
          normalizeHeadingText(section.heading).includes("signature")
            ? true
            : looksLikeSignatureBlock(section.content);
        for (const line of section.content.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) {
            // Contracts have always dropped blank lines and rely on
            // paragraph spacing. Free-form documents (numbering: "none")
            // need the blank line kept, because that is how a drafter
            // controls white space on the page.
            if (numberingMode === "none") {
              children.push(
                new Paragraph({
                  ...paraProps(section.format, { after: 0 }),
                  children: inlineRuns(""),
                }),
              );
            }
            continue;
          }
          const bulletMatch = trimmed.match(/^[-•*]\s+(.+)/);
          const rawText = bulletMatch ? bulletMatch[1].trim() : trimmed;
          const manualList = parseManualListMarker(rawText);
          const numeric = stripManualNumbering(rawText);
          const text = bulletMatch
            ? rawText
            : manualList.levelOffset !== null
              ? manualList.text
              : numeric.text;
          const inferredLevel =
            currentClauseLevel === null || contentIsSignatureBlock
              ? undefined
              : bulletMatch
                ? currentClauseLevel + 2
                : manualList.levelOffset !== null
                  ? currentClauseLevel + manualList.levelOffset
                  : numeric.levelFromPrefix !== null
                    ? numeric.levelFromPrefix
                    : numberedBodyParagraphs === 0
                      ? currentClauseLevel + 1
                      : currentClauseLevel + 2;
          if (currentClauseLevel !== null) numberedBodyParagraphs++;
          children.push(
            new Paragraph({
              numbering:
                inferredLevel === undefined
                  ? undefined
                  : legalNumbering(inferredLevel),
              ...paraProps(section.format, { after: 120 }),
              children: inlineRuns(text, {
                bold: section.format?.bold,
                italics: section.format?.italic,
                underline: section.format?.underline,
              }),
            }),
          );
        }
      }
    }

    const page: Record<string, unknown> = {};
    if (options?.landscape) {
      page.size = { orientation: PageOrientation.LANDSCAPE };
    }
    const m = style.margins;
    if (m && typeof m === "object") {
      const side = (value: unknown) =>
        convertInchesToTwip(clampNumber(value, 0.25, 3, 1));
      page.margin = {
        top: side(m.top),
        bottom: side(m.bottom),
        left: side(m.left),
        right: side(m.right),
      };
    }
    const pageSetup = Object.keys(page).length ? { page } : {};

    const footers = style.pageNumbers
      ? {
          default: new Footer({
            children: [
              new Paragraph({
                alignment: AlignmentType.CENTER,
                children: [
                  new TextRun({
                    children: [PageNumber.CURRENT],
                    font: FONT,
                    size: SIZE,
                  }),
                ],
              }),
            ],
          }),
        }
      : undefined;

    const doc = new Document({
      numbering: {
        config: [
          {
            reference: LEGAL_NUMBERING_REF,
            levels: legalNumberingLevels,
          },
        ],
      },
      sections: [
        {
          properties: pageSetup,
          ...(footers ? { footers } : {}),
          children,
        },
      ],
    });
    const buf = await Packer.toBuffer(doc);
    const zip = await import("jszip");
    const packageZip = await zip.default.loadAsync(buf);
    for (const requiredPath of [
      "[Content_Types].xml",
      "word/document.xml",
      "word/_rels/document.xml.rels",
    ]) {
      if (!packageZip.file(requiredPath)) {
        return {
          error: `Generated DOCX is missing required package part: ${requiredPath}`,
        };
      }
    }
    const docId = crypto.randomUUID().replace(/-/g, "");
    const safeTitle =
      title
        .replace(/[^a-zA-Z0-9 -]/g, "")
        .trim()
        .slice(0, 64) || "document";
    const filename = `${safeTitle}.docx`;
    const key = generatedDocKey(userId, docId, filename);

    await uploadFile(
      key,
      buf.buffer as ArrayBuffer,
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    );
    const downloadUrl = buildDownloadUrl(key, filename);

    // Persist to DB so generated docs are first-class documents:
    // openable in the DocPanel and editable via edit_document. In
    // project chats we attach to the project so it appears in the
    // sidebar; in the general chat we leave project_id null and it
    // stays a standalone document.
    const { data: docRow, error: docErr } = await db
      .from("documents")
      .insert({
        project_id: options?.projectId ?? null,
        user_id: userId,
        status: "ready",
      })
      .select("id")
      .single();
    if (docErr || !docRow) {
      return {
        error: `Failed to record generated document: ${docErr?.message ?? "unknown"}`,
      };
    }
    const documentId = docRow.id as string;

    const { data: versionRow, error: verErr } = await db
      .from("document_versions")
      .insert({
        document_id: documentId,
        storage_path: key,
        source: "generated",
        version_number: 1,
        filename: filename,
        file_type: "docx",
        size_bytes: buf.byteLength,
        page_count: null,
        content_sha256: contentSha256(buf),
      })
      .select("id")
      .single();
    if (verErr || !versionRow) {
      return {
        error: `Failed to record generated document version: ${verErr?.message ?? "unknown"}`,
      };
    }
    const versionId = versionRow.id as string;

    await db
      .from("documents")
      .update({
        current_version_id: versionId,
      })
      .eq("id", documentId);

    return {
      filename,
      download_url: downloadUrl,
      document_id: documentId,
      version_id: versionId,
      version_number: 1,
      storage_path: key,
      message: `Document '${filename}' has been generated successfully.`,
    };
  } catch (e) {
    return { error: String(e) };
  }
}

export function safeGeneratedFilename(title: string, extension: string) {
  const rawTitle = typeof title === "string" ? title : "document";
  const safeTitle =
    rawTitle
      .replace(/[^a-zA-Z0-9 -]/g, "")
      .trim()
      .slice(0, 64) || "document";
  return `${safeTitle}.${extension}`;
}

function xmlEscape(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function excelColumnName(index: number) {
  let n = index + 1;
  let name = "";
  while (n > 0) {
    const mod = (n - 1) % 26;
    name = String.fromCharCode(65 + mod) + name;
    n = Math.floor((n - mod) / 26);
  }
  return name;
}

function normalizeSheetName(value: unknown, fallback: string) {
  const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
  return raw.replace(/[:\\/?*[\]]/g, " ").trim().slice(0, 31) || fallback;
}

function normalizeRows(rows: unknown, colCount: number) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((row): row is unknown[] => Array.isArray(row))
    .map((row) =>
      Array.from({ length: colCount }, (_, i) =>
        row[i] == null ? "" : String(row[i]),
      ),
    );
}

async function buildXlsxWorkbook(title: string, sheetsInput: unknown[]) {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  const sheets = sheetsInput.length ? sheetsInput : [{ name: title, columns: [], rows: [] }];

  const normalizedSheets = sheets.map((sheet, index) => {
    const raw = (sheet && typeof sheet === "object" ? sheet : {}) as {
      name?: unknown;
      columns?: unknown;
      rows?: unknown;
    };
    const columns = Array.isArray(raw.columns)
      ? raw.columns.map((col) => String(col ?? "")).filter((col) => col.trim())
      : [];
    const fallbackColumns = columns.length ? columns : ["Value"];
    return {
      name: normalizeSheetName(raw.name, `Sheet ${index + 1}`),
      columns: fallbackColumns,
      rows: normalizeRows(raw.rows, fallbackColumns.length),
    };
  });

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
${normalizedSheets
  .map(
    (_, i) =>
      `  <Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  )
  .join("\n")}
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
  );
  zip.file(
    "docProps/core.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xmlEscape(title)}</dc:title>
  <dc:creator>Mike</dc:creator>
  <cp:lastModifiedBy>Mike</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified>
</cp:coreProperties>`,
  );
  zip.file(
    "docProps/app.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Mike</Application>
</Properties>`,
  );
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
${normalizedSheets
  .map(
    (sheet, i) =>
      `    <sheet name="${xmlEscape(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`,
  )
  .join("\n")}
  </sheets>
</workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${normalizedSheets
  .map(
    (_, i) =>
      `  <Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
  )
  .join("\n")}
</Relationships>`,
  );

  for (const [sheetIndex, sheet] of normalizedSheets.entries()) {
    const allRows = [sheet.columns, ...sheet.rows];
    const rowXml = allRows
      .map((row, rowIndex) => {
        const rowNumber = rowIndex + 1;
        const cellXml = row
          .map((value, colIndex) => {
            const ref = `${excelColumnName(colIndex)}${rowNumber}`;
            return `<c r="${ref}" t="inlineStr"><is><t>${xmlEscape(value)}</t></is></c>`;
          })
          .join("");
        return `<row r="${rowNumber}">${cellXml}</row>`;
      })
      .join("");
    const lastRef = `${excelColumnName(Math.max(sheet.columns.length - 1, 0))}${Math.max(allRows.length, 1)}`;
    zip.file(
      `xl/worksheets/sheet${sheetIndex + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:${lastRef}"/>
  <sheetData>${rowXml}</sheetData>
</worksheet>`,
    );
  }

  return zip.generateAsync({ type: "nodebuffer" });
}

function pptTextParagraphs(lines: string[], opts: { title?: boolean } = {}) {
  return lines
    .map((line, index) => {
      const escaped = xmlEscape(line);
      const titleAttrs = opts.title ? ' sz="3200" b="1"' : ' sz="2000"';
      const bullet = !opts.title && index >= 0
        ? '<a:pPr marL="342900" indent="-171450"><a:buChar char="&#8226;"/></a:pPr>'
        : "";
      return `<a:p>${bullet}<a:r><a:rPr lang="en-US"${titleAttrs}/><a:t>${escaped}</a:t></a:r></a:p>`;
    })
    .join("");
}

function pptShape(id: number, name: string, x: number, y: number, cx: number, cy: number, body: string) {
  return `<p:sp>
  <p:nvSpPr><p:cNvPr id="${id}" name="${xmlEscape(name)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>
  <p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln><a:noFill/></a:ln></p:spPr>
  <p:txBody><a:bodyPr wrap="square"/><a:lstStyle/>${body}</p:txBody>
</p:sp>`;
}

async function buildPptxPresentation(title: string, slidesInput: unknown[]) {
  const JSZip = (await import("jszip")).default;
  const zip = new JSZip();
  const rawSlides = slidesInput.length
    ? slidesInput
    : [{ title, bullets: ["Generated by Mike"] }];
  const slides = rawSlides.map((slide, index) => {
    const raw = (slide && typeof slide === "object" ? slide : {}) as {
      title?: unknown;
      bullets?: unknown;
    };
    return {
      title:
        typeof raw.title === "string" && raw.title.trim()
          ? raw.title.trim()
          : index === 0
            ? title
            : `Slide ${index + 1}`,
      bullets: Array.isArray(raw.bullets)
        ? raw.bullets.map((bullet) => String(bullet ?? "")).filter(Boolean)
        : [],
    };
  });

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>
  <Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>
  <Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
${slides
  .map(
    (_, i) =>
      `  <Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`,
  )
  .join("\n")}
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`,
  );
  zip.file(
    "docProps/core.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xmlEscape(title)}</dc:title>
  <dc:creator>Mike</dc:creator>
  <cp:lastModifiedBy>Mike</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:modified>
</cp:coreProperties>`,
  );
  zip.file(
    "docProps/app.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Mike</Application>
  <PresentationFormat>On-screen Show (16:9)</PresentationFormat>
  <Slides>${slides.length}</Slides>
</Properties>`,
  );
  zip.file(
    "ppt/presentation.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId${slides.length + 1}"/></p:sldMasterIdLst>
  <p:sldIdLst>
${slides.map((_, i) => `    <p:sldId id="${256 + i}" r:id="rId${i + 1}"/>`).join("\n")}
  </p:sldIdLst>
  <p:sldSz cx="12192000" cy="6858000" type="screen16x9"/>
  <p:notesSz cx="6858000" cy="9144000"/>
</p:presentation>`,
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${slides
  .map(
    (_, i) =>
      `  <Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`,
  )
  .join("\n")}
  <Relationship Id="rId${slides.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>
  <Relationship Id="rId${slides.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/>
</Relationships>`,
  );
  zip.file(
    "ppt/slideMasters/slideMaster1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
  <p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>
</p:sldMaster>`,
  );
  zip.file(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>
</Relationships>`,
  );
  zip.file(
    "ppt/slideLayouts/slideLayout1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank">
  <p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>
</p:sldLayout>`,
  );
  zip.file(
    "ppt/theme/theme1.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Mike">
  <a:themeElements>
    <a:clrScheme name="Office"><a:dk1><a:srgbClr val="111111"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F8FAFC"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="059669"/></a:accent2><a:accent3><a:srgbClr val="D97706"/></a:accent3><a:accent4><a:srgbClr val="7C3AED"/></a:accent4><a:accent5><a:srgbClr val="DC2626"/></a:accent5><a:accent6><a:srgbClr val="0891B2"/></a:accent6><a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme>
    <a:fontScheme name="Office"><a:majorFont><a:latin typeface="Aptos Display"/></a:majorFont><a:minorFont><a:latin typeface="Aptos"/></a:minorFont></a:fontScheme>
    <a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>
  </a:themeElements>
</a:theme>`,
  );

  for (const [index, slide] of slides.entries()) {
    const bullets = slide.bullets.length ? slide.bullets : [""];
    zip.file(
      `ppt/slides/slide${index + 1}.xml`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></p:bgPr></p:bg>
    <p:spTree>
      <p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
      <p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>
      ${pptShape(2, "Title", 685800, 457200, 10820400, 914400, pptTextParagraphs([slide.title], { title: true }))}
      ${pptShape(3, "Content", 914400, 1600200, 10363200, 4343400, pptTextParagraphs(bullets))}
    </p:spTree>
  </p:cSld>
</p:sld>`,
    );
    zip.file(
      `ppt/slides/_rels/slide${index + 1}.xml.rels`,
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>
</Relationships>`,
    );
  }

  return zip.generateAsync({ type: "nodebuffer" });
}

async function persistGeneratedFile(params: {
  title: string;
  extension: "xlsx" | "pptx";
  buffer: Buffer;
  userId: string;
  db: ReturnType<typeof createServerSupabase>;
  projectId?: string | null;
}) {
  const { title, extension, buffer, userId, db, projectId } = params;
  const docId = crypto.randomUUID().replace(/-/g, "");
  const filename = safeGeneratedFilename(title, extension);
  const key = generatedDocKey(userId, docId, filename);
  await uploadFile(
    key,
    buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer,
    contentTypeForDocumentType(extension),
  );

  let pdfStoragePath: string | null = null;
  if (shouldConvertToPdf(extension)) {
    try {
      const pdfBuf = await docxToPdf(buffer);
      const pdfKey = convertedPdfKey(userId, docId);
      await uploadFile(
        pdfKey,
        pdfBuf.buffer.slice(
          pdfBuf.byteOffset,
          pdfBuf.byteOffset + pdfBuf.byteLength,
        ) as ArrayBuffer,
        "application/pdf",
      );
      pdfStoragePath = pdfKey;
    } catch (err) {
      devLog(`[generate_${extension}] Office→PDF conversion failed:`, err);
    }
  }

  const downloadUrl = buildDownloadUrl(key, filename);
  const { data: docRow, error: docErr } = await db
    .from("documents")
    .insert({
      project_id: projectId ?? null,
      user_id: userId,
      status: "ready",
    })
    .select("id")
    .single();
  if (docErr || !docRow) {
    return {
      error: `Failed to record generated document: ${docErr?.message ?? "unknown"}`,
    };
  }
  const documentId = docRow.id as string;

  const { data: versionRow, error: verErr } = await db
    .from("document_versions")
    .insert({
      document_id: documentId,
      storage_path: key,
      pdf_storage_path: pdfStoragePath,
      source: "generated",
      version_number: 1,
      filename,
      file_type: extension,
      size_bytes: buffer.byteLength,
      page_count: null,
      content_sha256: contentSha256(buffer),
    })
    .select("id")
    .single();
  if (verErr || !versionRow) {
    return {
      error: `Failed to record generated document version: ${verErr?.message ?? "unknown"}`,
    };
  }
  const versionId = versionRow.id as string;

  await db
    .from("documents")
    .update({ current_version_id: versionId })
    .eq("id", documentId);

  return {
    filename,
    download_url: downloadUrl,
    document_id: documentId,
    version_id: versionId,
    version_number: 1,
    storage_path: key,
    message: `Document '${filename}' has been generated successfully.`,
  };
}

export async function generateExcel(
  title: string,
  sheets: unknown[],
  userId: string,
  db: ReturnType<typeof createServerSupabase>,
  options?: { projectId?: string | null },
) {
  try {
    const normalizedTitle = typeof title === "string" ? title : "Workbook";
    const buffer = await buildXlsxWorkbook(
      normalizedTitle,
      Array.isArray(sheets) ? sheets : [],
    );
    return persistGeneratedFile({
      title: normalizedTitle,
      extension: "xlsx",
      buffer,
      userId,
      db,
      projectId: options?.projectId ?? null,
    });
  } catch (e) {
    return { error: String(e) };
  }
}

export async function generatePpt(
  title: string,
  slides: unknown[],
  userId: string,
  db: ReturnType<typeof createServerSupabase>,
  options?: { projectId?: string | null },
) {
  try {
    const normalizedTitle = typeof title === "string" ? title : "Presentation";
    const buffer = await buildPptxPresentation(
      normalizedTitle,
      Array.isArray(slides) ? slides : [],
    );
    return persistGeneratedFile({
      title: normalizedTitle,
      extension: "pptx",
      buffer,
      userId,
      db,
      projectId: options?.projectId ?? null,
    });
  } catch (e) {
    return { error: String(e) };
  }
}

// ---------------------------------------------------------------------------
// Document version helpers (DOCX tracked-change editing)
// ---------------------------------------------------------------------------

/**
 * Resolve the current .docx bytes for a document, preferring the active
 * tracked-changes version if one exists, else the original upload.
 */
export async function loadCurrentVersionBytes(
  documentId: string,
  db: ReturnType<typeof createServerSupabase>,
): Promise<{ bytes: Buffer; storage_path: string } | null> {
  const active = await loadActiveVersion(documentId, db);
  if (!active) return null;
  const raw = await downloadFile(active.storage_path);
  if (!raw) return null;
  return { bytes: Buffer.from(raw), storage_path: active.storage_path };
}

/**
 * Write edited .docx bytes back as a document version, and return where they
 * landed. Shared by the two ways a document gets rewritten: editing passages
 * and writing the whole thing.
 */
async function saveEditedDocxVersion(params: {
  documentId: string;
  userId: string;
  bytes: Buffer;
  db: ReturnType<typeof createServerSupabase>;
  reuseVersion?: {
    versionId: string;
    versionNumber: number;
    storagePath: string;
  };
  /** Filename to fall back to when no prior version names the document. */
  fallbackFilename: string;
}): Promise<{
  versionRowId: string;
  newPath: string;
  nextVersionNumber: number;
  versionFilename: string;
} | null> {
  const { documentId, userId, bytes, db, reuseVersion } = params;
  let versionFilename = params.fallbackFilename;
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

  let versionRowId: string;
  let newPath: string;
  let nextVersionNumber: number;

    if (reuseVersion) {
      // Overwrite the existing turn version's file in place. The version
      // row, version_number, and current_version_id all already point here.
      newPath = reuseVersion.storagePath;
      versionRowId = reuseVersion.versionId;
      nextVersionNumber = reuseVersion.versionNumber;

      // Clear the hash before the bytes change; the update below sets it again.
      // Storage and Postgres cannot be written atomically, so a failure between
      // the two leaves the version unhashed and therefore unverifiable, rather
      // than hashed against content it no longer holds.
      await db
        .from("document_versions")
        .update({ content_sha256: null })
        .eq("id", versionRowId);

      await uploadFile(
        newPath,
        ab,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );
      await db
        .from("document_versions")
        .update({
          file_type: "docx",
          size_bytes: bytes.byteLength,
          page_count: null,
          content_sha256: contentSha256(bytes),
        })
        .eq("id", versionRowId);
    } else {
      const versionId = crypto.randomUUID().replace(/-/g, "");
      newPath = `documents/${userId}/${documentId}/edits/${versionId}.docx`;
      await uploadFile(
        newPath,
        ab,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );

      // Per-document sequential number for the new assistant_edit
      // version. The counter spans upload + user_upload + assistant_edit
      // so the original upload is V1 and the first assistant edit is V2.
      const { data: maxRow } = await db
        .from("document_versions")
        .select("version_number")
        .eq("document_id", documentId)
        .in("source", ["upload", "user_upload", "assistant_edit"])
        .order("version_number", { ascending: false, nullsFirst: false })
        .limit(1)
        .maybeSingle();
      nextVersionNumber = ((maxRow?.version_number as number | null) ?? 1) + 1;

      // Inherit the filename from the most recent prior version so
      // user-applied renames carry forward through further edits. Malformed
      // legacy rows without a filename get a neutral placeholder, not the
      // parent document filename. We intentionally do NOT append "[Edited Vn]"
      // — the version number is surfaced separately as a tag in the UI.
      const { data: prevRow } = await db
        .from("document_versions")
        .select("filename, created_at")
        .eq("document_id", documentId)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const inheritedFilename =
        (prevRow?.filename as string | null)?.trim() || "Untitled document";
      versionFilename = inheritedFilename;

      const { data: versionRow, error: verErr } = await db
        .from("document_versions")
        .insert({
          document_id: documentId,
          storage_path: newPath,
          source: "assistant_edit",
          version_number: nextVersionNumber,
          filename: inheritedFilename,
          file_type: "docx",
          size_bytes: bytes.byteLength,
          page_count: null,
          content_sha256: contentSha256(bytes),
        })
        .select("id")
        .single();
      if (verErr || !versionRow) {
        return null;
      }
      versionRowId = versionRow.id as string;
    }

  return { versionRowId, newPath, nextVersionNumber, versionFilename };
}

/**
 * Ensure the document has a document_versions row for the current upload.
 * Called before writing the first 'assistant_edit' row so the history is
 * complete. Idempotent.
 */
export async function runEditDocument(params: {
  documentId: string;
  userId: string;
  edits: EditInput[];
  db: ReturnType<typeof createServerSupabase>;
  /**
   * If provided, append these edits to the existing turn-scoped version
   * (overwrites the file at storagePath and reuses the document_versions
   * row) instead of creating a new version. Used to collapse multiple
   * edit_document tool calls within a single assistant turn into one
   * version.
   */
  reuseVersion?: {
    versionId: string;
    versionNumber: number;
    storagePath: string;
  };
  /**
   * How the edits land in the file.
   *
   * `true` (the default for a document the user owns) writes them as tracked
   * changes the user accepts or rejects one by one.
   *
   * `false` writes them straight into the document. That is what filling in a
   * fresh copy needs: the text being replaced belongs to the document it was
   * copied from, so there is nothing for the user to review — they asked for a
   * new document, not a redline of somebody else's.
   *
   * When omitted, a copy made by replicate_document that has never been edited
   * defaults to `false` and everything else defaults to `true`.
   */
  trackChanges?: boolean;
}): Promise<
  | {
      ok: true;
      version_id: string;
      version_number: number;
      storage_path: string;
      download_url: string;
      annotations: EditAnnotation[];
      applied_count: number;
      /** Edits that landed in the page header/footer, written directly. */
      header_footer_applied: number;
      tracked: boolean;
      errors: { index: number; reason: string }[];
    }
  | { ok: false; error: string }
> {
  const { documentId, userId, edits, db, reuseVersion } = params;

  const { data: doc } = await db
    .from("documents")
    .select("id, is_replica")
    .eq("id", documentId)
    .single();
  if (!doc) return { ok: false, error: "Document not found." };

  // Decide how the edits land. A copy is a document being drafted, so changes
  // go straight into it — and it stays that way until the user starts working
  // on it themselves, since a draft often takes several passes to finish.
  // Anything else gets tracked changes to review.
  let tracked = params.trackChanges ?? true;
  if (params.trackChanges === undefined && doc.is_replica) {
    const { count } = await db
      .from("document_versions")
      .select("id", { count: "exact", head: true })
      .eq("document_id", documentId)
      .in("source", ["user_upload", "user_accept", "user_reject"]);
    if (!count) tracked = false;
  }

  const activeVersion = await loadActiveVersion(documentId, db);
  let versionFilename =
    activeVersion?.filename?.trim() || "Untitled document";

  const current = await loadCurrentVersionBytes(documentId, db);
  if (!current) return { ok: false, error: "Could not load document bytes." };

  // read_document shows the model **bold**/_underline_/*italic* markers and
  // leading [page break]/[heading N]/[centered]/[right] tokens that are not
  // in the document's actual characters. An anchor copied from that view
  // would never match, so any anchor that does not appear verbatim in the
  // document is retried with the decorations stripped. Inline markers in the
  // replacement text stay — applyTrackedEdits turns them into formatting on
  // the inserted words — but the layout tokens are read-view only and come
  // out of the replacement too.
  const undecorate = (s: string) =>
    stripInlineMarkers(s.split("\n").map(stripLayoutTokens).join("\n"));
  const needsStrip = (s: string) => !!s && undecorate(s) !== s;
  const stripReplaceTokens = (s: string) =>
    s.split("\n").map(stripLayoutTokens).join("\n");
  let normalizedEdits = edits;
  if (
    edits.some(
      (e) =>
        needsStrip(e.find) ||
        needsStrip(e.context_before) ||
        needsStrip(e.context_after) ||
        stripReplaceTokens(e.replace) !== e.replace,
    )
  ) {
    const flatText = await extractDocxBodyText(current.bytes);
    const anchor = (s: string) =>
      !needsStrip(s) || flatText.includes(s) ? s : undecorate(s);
    normalizedEdits = edits.map((e) => ({
      ...e,
      find: anchor(e.find),
      context_before: anchor(e.context_before),
      context_after: anchor(e.context_after),
      replace: stripReplaceTokens(e.replace),
    }));
  }

  const applied = await applyTrackedEdits(current.bytes, normalizedEdits, {
    author: "Mike",
  });
  const { changes } = applied;
  let errors = applied.errors;
  let editedBytes = applied.bytes;

  // An edit whose anchor is nowhere in the body may belong to the page
  // header or footer (the letterhead). Those are applied directly — a
  // letterhead correction is not reviewed word by word — and reported
  // alongside the body changes.
  let headerFooterApplied: { index: number; part: "header" | "footer" }[] = [];
  if (errors.length > 0) {
    const failed = new Set(errors.map((e) => e.index));
    const candidates = normalizedEdits
      .map((e, index) => ({ index, find: e.find, replace: e.replace }))
      .filter((e) => failed.has(e.index) && e.find);
    if (candidates.length > 0) {
      const hf = await applyHeaderFooterEdits(editedBytes, candidates);
      if (hf.applied.length > 0) {
        editedBytes = hf.bytes;
        headerFooterApplied = hf.applied;
        const landed = new Set(hf.applied.map((a) => a.index));
        errors = errors.filter((e) => !landed.has(e.index));
      }
    }
  }

  if (!tracked && changes.length > 0) {
    // Accept every change as it is written, so the saved file reads as the
    // finished document rather than as a redline of the one it came from.
    const allIds = changes
      .flatMap((c) => [
        c.delId,
        c.insId,
        ...(c.extraInsIds ?? []),
        ...(c.extraDelIds ?? []),
      ])
      .filter((v): v is string => !!v);
    if (allIds.length > 0) {
      const { bytes: cleanBytes } = await resolveTrackedChange(
        editedBytes,
        allIds,
        "accept",
      );
      editedBytes = cleanBytes;
    }
  }

  if (changes.length === 0 && headerFooterApplied.length === 0) {
    return {
      ok: false,
      error:
        errors[0]?.reason ??
        "No edits could be applied. Refine context_before/context_after and retry.",
    };
  }

  const saved = await saveEditedDocxVersion({
    documentId,
    userId,
    bytes: editedBytes,
    db,
    reuseVersion,
    fallbackFilename: versionFilename,
  });
  if (!saved) {
    return { ok: false, error: "Failed to record document version." };
  }
  const { versionRowId, newPath, nextVersionNumber } = saved;
  versionFilename = saved.versionFilename;

  // Written-in edits have nothing to review, so no per-change rows and no
  // Accept/Reject cards: the document card is the whole result.
  if (!tracked) {
    await db
      .from("documents")
      .update({ current_version_id: versionRowId })
      .eq("id", documentId);

    const cleanFilename = versionFilename.trim() || "Untitled document.docx";
    return {
      ok: true,
      version_id: versionRowId,
      version_number: nextVersionNumber,
      storage_path: newPath,
      download_url: buildDownloadUrl(newPath, cleanFilename),
      annotations: [],
      applied_count: changes.length + headerFooterApplied.length,
      header_footer_applied: headerFooterApplied.length,
      tracked: false,
      errors,
    };
  }

  // Insert one row per change
  const editRows = changes.map((c) => ({
    document_id: documentId,
    version_id: versionRowId,
    change_id: c.id,
    del_w_id: c.delId ?? null,
    ins_w_id: c.insId ?? null,
    // Paragraph marks this change created or removed. Kept apart from
    // del_w_id / ins_w_id because the frontend matches those against the
    // rendered <ins>/<del> elements, which paragraph marks do not produce.
    mark_w_ids: [...(c.extraInsIds ?? []), ...(c.extraDelIds ?? [])],
    deleted_text: c.deletedText,
    inserted_text: c.insertedText,
    context_before: c.contextBefore ?? "",
    context_after: c.contextAfter ?? "",
    status: "pending" as const,
  }));
  // A run whose only landed edits were header/footer ones has no body
  // changes to review — nothing to record, no cards.
  let insertedEdits: {
    id: string;
    change_id: string;
    del_w_id: string | null;
    ins_w_id: string | null;
    deleted_text: string;
    inserted_text: string;
    context_before: string | null;
    context_after: string | null;
  }[] = [];
  if (editRows.length > 0) {
    const { data, error: editsErr } = await db
      .from("document_edits")
      .insert(editRows)
      .select(
        "id, change_id, del_w_id, ins_w_id, deleted_text, inserted_text, context_before, context_after",
      );
    if (editsErr || !data) {
      return { ok: false, error: "Failed to record edits." };
    }
    insertedEdits = data;
  }

  await db
    .from("documents")
    .update({
      current_version_id: versionRowId,
    })
    .eq("id", documentId);

  const annotations: EditAnnotation[] = insertedEdits.map(
    (r: {
      id: string;
      change_id: string;
      deleted_text: string;
      inserted_text: string;
      context_before: string | null;
      context_after: string | null;
    }) => {
      const src = changes.find((c) => c.id === r.change_id);
      return {
        kind: "edit",
        edit_id: r.id,
        document_id: documentId,
        version_id: versionRowId,
        version_number: nextVersionNumber,
        change_id: r.change_id,
        del_w_id: src?.delId,
        ins_w_id: src?.insId,
        deleted_text: r.deleted_text ?? "",
        inserted_text: r.inserted_text ?? "",
        context_before: r.context_before ?? "",
        context_after: r.context_after ?? "",
        reason: src?.reason,
        status: "pending",
      };
    },
  );

  // Persistent, non-expiring permalink. The backend streams fresh bytes
  // on each request, so this URL stays valid as long as the file exists.
  const resolvedFilename = versionFilename.trim() || "Untitled document.docx";
  const permalink = buildDownloadUrl(newPath, resolvedFilename);

  return {
    ok: true,
    version_id: versionRowId,
    version_number: nextVersionNumber,
    storage_path: newPath,
    download_url: permalink,
    annotations,
    applied_count: annotations.length + headerFooterApplied.length,
    header_footer_applied: headerFooterApplied.length,
    tracked: true,
    errors,
  };
}

// ---------------------------------------------------------------------------
// Writing a whole document
// ---------------------------------------------------------------------------

// The inline-marker parser lives with the docx machinery so tracked-change
// insertions can format their runs; re-exported here for existing importers.
export { inlineEditRuns, stripInlineMarkers };

/**
 * Write a document's whole body in one go, keeping the file's own look.
 *
 * Adapting a precedent means rewriting nearly every paragraph, which is a poor
 * fit for find-and-replace: once a clause has been reworded the anchors for
 * the next edit no longer match, and a long contract turns into dozens of
 * fragile round trips. Here the assistant supplies the finished document as a
 * list of paragraphs instead. Each one is matched against the paragraph in the
 * same position, so the original's fonts, margins, numbering, indentation,
 * tables and signature layout carry straight over.
 */
export type WriteBlock =
  | string
  | {
      text?: string;
      /** 1-3 for a heading, "none" for ordinary text, absent to leave as is. */
      style?: "heading1" | "heading2" | "heading3" | "none";
      /** "number"/"bullet" for a list item, "none" for plain, absent to leave as is. */
      list?: "number" | "bullet" | "none";
      align?: "left" | "center" | "right" | "justify";
      /** true starts this block on a fresh page. */
      page_break?: boolean;
      /** Rows of a table to put here instead of a paragraph. */
      table?: { rows: string[][]; borders?: boolean; widths?: number[] };
    };

/** Longest common run of identical paragraphs, as (old index, new index) pairs. */
function alignParagraphs(
  oldTexts: string[],
  newTexts: string[],
): [number, number][] {
  const rows = oldTexts.length;
  const cols = newTexts.length;
  const table: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(cols + 1).fill(0),
  );
  for (let i = rows - 1; i >= 0; i--) {
    for (let j = cols - 1; j >= 0; j--) {
      table[i][j] =
        oldTexts[i] === newTexts[j]
          ? table[i + 1][j + 1] + 1
          : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (oldTexts[i] === newTexts[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

const CONTEXT_CHARS = 40;

/**
 * Turn "here is the document as it should now read" into the list of tracked
 * changes that gets it there: a paragraph whose wording changed becomes one
 * substitution, a paragraph that is gone becomes a deletion, a paragraph that
 * is new becomes an insertion anchored between its neighbours.
 */
export function redlineEditsForRewrite(
  baseline: string[],
  next: EditParagraph[],
): EditInput[] {
  const newTexts = next.map((paragraph) => paragraph.text);
  // Replacement strings keep the paragraphs' bold/italic/underline as inline
  // markers, which applyTrackedEdits turns back into formatted runs — so a
  // redlined rewrite keeps its emphasis just like a clean one.
  const newMarked = next.map((paragraph) =>
    paragraph.runs && paragraph.runs.length
      ? runsToMarkedText(paragraph.runs)
      : paragraph.text,
  );
  const pairs = alignParagraphs(baseline, newTexts);
  const matchedOld = new Set(pairs.map(([o]) => o));
  const matchedNew = new Map(pairs.map(([o, n]) => [n, o]));
  const pairSet = new Set(pairs.map(([o, n]) => `${o}:${n}`));

  const before = (index: number) =>
    (baseline[index - 1] ?? "").slice(-CONTEXT_CHARS);
  const after = (index: number) => (baseline[index] ?? "").slice(0, CONTEXT_CHARS);

  const edits: EditInput[] = [];
  let oi = 0;
  let nj = 0;
  while (oi < baseline.length || nj < newTexts.length) {
    const isPair =
      oi < baseline.length &&
      nj < newTexts.length &&
      matchedOld.has(oi) &&
      matchedNew.get(nj) === oi &&
      pairSet.has(`${oi}:${nj}`);
    if (isPair) {
      oi++;
      nj++;
      continue;
    }
    // Rewritten paragraph: one substitution of the whole paragraph.
    if (
      oi < baseline.length &&
      nj < newTexts.length &&
      !matchedOld.has(oi) &&
      !matchedNew.has(nj)
    ) {
      if (baseline[oi] && newTexts[nj] !== baseline[oi]) {
        edits.push({
          find: baseline[oi],
          replace: newMarked[nj],
          context_before: before(oi),
          context_after: after(oi + 1),
        });
      }
      oi++;
      nj++;
      continue;
    }
    // Paragraph dropped from the document.
    if (oi < baseline.length && !matchedOld.has(oi)) {
      if (baseline[oi]) {
        edits.push({
          find: baseline[oi],
          replace: "",
          context_before: before(oi),
          context_after: after(oi + 1),
        });
      }
      oi++;
      continue;
    }
    // Paragraph added to the document.
    if (nj < newTexts.length && !matchedNew.has(nj)) {
      if (newTexts[nj]) {
        edits.push({
          find: "",
          replace: `\n\n${newMarked[nj]}`,
          context_before: before(oi),
          context_after: after(oi),
        });
      }
      nj++;
      continue;
    }
    if (oi < baseline.length) oi++;
    else nj++;
  }
  return edits;
}

/** Turn one entry from the tool call into what the document writer wants. */
export function writeBlockToParagraph(block: WriteBlock): EditParagraph {
  if (typeof block === "string") {
    // A string paragraph may open with the layout tokens the read view
    // shows — [page break], [heading N], [centered], [right]. Echoing them
    // reproduces the layout, the same way the inline markers work.
    const layout = parseLayoutTokens(block);
    const runs = inlineEditRuns(layout.text);
    const paragraph: EditParagraph = {
      text: runs.map((run) => run.text).join(""),
      runs,
    };
    if (layout.align !== undefined) paragraph.align = layout.align;
    if (layout.heading !== undefined) paragraph.heading = layout.heading;
    if (layout.pageBreak) paragraph.pageBreak = true;
    return paragraph;
  }
  const layout = parseLayoutTokens(block.text ?? "");
  const runs = inlineEditRuns(layout.text);
  const paragraph: EditParagraph = {
    text: runs.map((run) => run.text).join(""),
    runs,
  };
  // Tokens in the text apply unless the object form says otherwise below.
  if (layout.align !== undefined) paragraph.align = layout.align;
  if (layout.heading !== undefined) paragraph.heading = layout.heading;
  if (layout.pageBreak) paragraph.pageBreak = true;
  if (block.style !== undefined) {
    paragraph.heading =
      block.style === "heading1"
        ? 1
        : block.style === "heading2"
          ? 2
          : block.style === "heading3"
            ? 3
            : null;
  }
  if (block.list !== undefined) {
    paragraph.list = block.list === "none" ? null : block.list;
  }
  if (block.align !== undefined) paragraph.align = block.align;
  if (block.page_break !== undefined) paragraph.pageBreak = block.page_break;
  if (block.table && block.table.rows?.length) paragraph.table = block.table;
  return paragraph;
}

export async function runWriteDocument(params: {
  documentId: string;
  userId: string;
  paragraphs: WriteBlock[];
  db: ReturnType<typeof createServerSupabase>;
  /**
   * When true the rewrite arrives as tracked changes the user accepts or
   * rejects, rather than being written straight in. That is what revising a
   * document the user already has calls for; a fresh copy being drafted does
   * not need it.
   */
  trackChanges?: boolean;
  reuseVersion?: {
    versionId: string;
    versionNumber: number;
    storagePath: string;
  };
}): Promise<
  | {
      ok: true;
      version_id: string;
      version_number: number;
      storage_path: string;
      download_url: string;
      paragraph_count: number;
      /** True when the rewrite arrived as tracked changes to review. */
      tracked?: boolean;
      /** How many tracked changes the rewrite produced. */
      changes?: number;
      /** The Accept/Reject cards, when the rewrite is tracked. */
      annotations?: EditAnnotation[];
    }
  | { ok: false; error: string }
> {
  const { documentId, userId, paragraphs, db, reuseVersion } = params;

  if (paragraphs.length === 0) {
    return { ok: false, error: "paragraphs is required and must not be empty." };
  }

  const { data: doc } = await db
    .from("documents")
    .select("id")
    .eq("id", documentId)
    .single();
  if (!doc) return { ok: false, error: "Document not found." };

  const activeVersion = await loadActiveVersion(documentId, db);
  const fallbackFilename =
    activeVersion?.filename?.trim() || "Untitled document";

  const current = await loadCurrentVersionBytes(documentId, db);
  if (!current) return { ok: false, error: "Could not load document bytes." };

  const baseline = await extractDocxBodyParagraphs(current.bytes);
  const next: EditParagraph[] = paragraphs.map(writeBlockToParagraph);

  if (params.trackChanges) {
    // Tables ride separately: text changes travel as find/replace redlines,
    // and each NEW table is inserted afterwards as one tracked insertion
    // (rows marked inserted; one Accept/Reject card per table). A table block
    // whose cells all already appear in the document is the model re-sending
    // an existing table, not adding one — it is left alone, and its cell
    // lines are protected from being read as deletions.
    const textNext: EditParagraph[] = [];
    const newTables: {
      afterParagraphText: string | null;
      rows: string[][];
      borders?: boolean;
      widths?: number[];
    }[] = [];
    const baselineLines = new Set(baseline);
    const protectedLines = new Set<string>();
    for (const paragraph of next) {
      if (!paragraph.table) {
        textNext.push(paragraph);
        continue;
      }
      const cells = paragraph.table.rows.flat().filter((cell) => cell.trim());
      const existing =
        cells.length > 0 && cells.every((cell) => baselineLines.has(cell));
      if (existing) {
        for (const cell of cells) protectedLines.add(cell);
        continue;
      }
      newTables.push({
        afterParagraphText: textNext.length
          ? textNext[textNext.length - 1].text
          : null,
        rows: paragraph.table.rows,
        borders: paragraph.table.borders,
        widths: paragraph.table.widths,
      });
    }
    const edits = redlineEditsForRewrite(baseline, textNext).filter(
      (edit) => !(edit.replace === "" && protectedLines.has(edit.find)),
    );
    if (edits.length === 0 && newTables.length === 0) {
      return { ok: false, error: "The document already reads that way." };
    }

    let base: {
      version_id: string;
      version_number: number;
      storage_path: string;
      download_url: string;
      changes: number;
      annotations: EditAnnotation[];
    };
    if (edits.length > 0) {
      const result = await runEditDocument({
        documentId,
        userId,
        edits,
        db,
        trackChanges: true,
        reuseVersion,
      });
      if (!result.ok) return result;
      base = {
        version_id: result.version_id,
        version_number: result.version_number,
        storage_path: result.storage_path,
        download_url: result.download_url,
        changes: result.applied_count,
        annotations: result.annotations,
      };
    } else {
      // Only tables to add — open a version from the document as it stands.
      const saved = await saveEditedDocxVersion({
        documentId,
        userId,
        bytes: current.bytes,
        db,
        reuseVersion,
        fallbackFilename,
      });
      if (!saved) {
        return { ok: false, error: "Failed to record document version." };
      }
      await db
        .from("documents")
        .update({ current_version_id: saved.versionRowId })
        .eq("id", documentId);
      base = {
        version_id: saved.versionRowId,
        version_number: saved.nextVersionNumber,
        storage_path: saved.newPath,
        download_url: buildDownloadUrl(
          saved.newPath,
          saved.versionFilename.trim() || "Untitled document.docx",
        ),
        changes: 0,
        annotations: [],
      };
    }

    if (newTables.length > 0) {
      const rawVersion = await downloadFile(base.storage_path);
      if (!rawVersion) {
        return { ok: false, error: "Could not load document bytes." };
      }
      const inserted = await insertTrackedTables(
        Buffer.from(rawVersion),
        newTables,
        { author: "Mike" },
      );
      const tableBytes = inserted.bytes;
      await uploadFile(
        base.storage_path,
        tableBytes.buffer.slice(
          tableBytes.byteOffset,
          tableBytes.byteOffset + tableBytes.byteLength,
        ) as ArrayBuffer,
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      );

      const stamp = Date.now();
      const rows = inserted.changes.map((change, i) => ({
        document_id: documentId,
        version_id: base.version_id,
        change_id: `mike-table-${i}-${stamp}`,
        del_w_id: null,
        ins_w_id: change.insId,
        mark_w_ids: change.extraIds,
        deleted_text: "",
        inserted_text: change.preview,
        context_before: "",
        context_after: "",
        status: "pending" as const,
      }));
      const { data: tableEdits, error: tableEditsErr } = await db
        .from("document_edits")
        .insert(rows)
        .select("id, change_id, ins_w_id, inserted_text");
      if (tableEditsErr || !tableEdits) {
        return { ok: false, error: "Failed to record table insertions." };
      }
      base.annotations = [
        ...base.annotations,
        ...tableEdits.map(
          (r: {
            id: string;
            change_id: string;
            ins_w_id: string;
            inserted_text: string;
          }): EditAnnotation => ({
            kind: "edit",
            edit_id: r.id,
            document_id: documentId,
            version_id: base.version_id,
            version_number: base.version_number,
            change_id: r.change_id,
            ins_w_id: r.ins_w_id,
            deleted_text: "",
            inserted_text: r.inserted_text,
            context_before: "",
            context_after: "",
            status: "pending",
          }),
        ),
      ];
      base.changes += tableEdits.length;
    }

    return {
      ok: true,
      version_id: base.version_id,
      version_number: base.version_number,
      storage_path: base.storage_path,
      download_url: base.download_url,
      paragraph_count: next.length,
      tracked: true,
      changes: base.changes,
      annotations: base.annotations,
    };
  }

  let written: Buffer;
  try {
    const result = await applyFormattedEdits(current.bytes, baseline, next);
    written = result.bytes;
  } catch (err) {
    if (err instanceof StaleDocumentError) {
      return {
        ok: false,
        error:
          "The document changed while this was being written. Read it again and rewrite it from what it says now.",
      };
    }
    return {
      ok: false,
      error: `Could not write the document: ${safeErrorMessage(err)}`,
    };
  }

  const saved = await saveEditedDocxVersion({
    documentId,
    userId,
    bytes: written,
    db,
    reuseVersion,
    fallbackFilename,
  });
  if (!saved) {
    return { ok: false, error: "Failed to record document version." };
  }

  await db
    .from("documents")
    .update({ current_version_id: saved.versionRowId })
    .eq("id", documentId);

  const resolvedFilename =
    saved.versionFilename.trim() || "Untitled document.docx";
  return {
    ok: true,
    version_id: saved.versionRowId,
    version_number: saved.nextVersionNumber,
    storage_path: saved.newPath,
    download_url: buildDownloadUrl(saved.newPath, resolvedFilename),
    paragraph_count: next.length,
  };
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

export async function getTurnReadIdentity(params: {
  docLabel: string;
  docStore: DocStore;
  docIndex?: DocIndex;
  db?: ReturnType<typeof createServerSupabase>;
}): Promise<{
  key: string;
  docLabel: string;
  filename: string;
  documentId?: string;
  versionId?: string | null;
  storagePath: string;
} | null> {
  const { docLabel, docStore, docIndex, db } = params;
  const docInfo = docStore.get(docLabel);
  if (!docInfo) return null;

  const documentId = docIndex?.[docLabel]?.document_id;
  if (documentId && db) {
    const active = await loadActiveVersion(documentId, db);
    if (active?.storage_path) {
      return {
        key: `${documentId}:${active.id}`,
        docLabel,
        filename: docInfo.filename,
        documentId,
        versionId: active.id,
        storagePath: active.storage_path,
      };
    }
  }

  return {
    key: `${documentId ?? docLabel}:${docInfo.storage_path}`,
    docLabel,
    filename: docInfo.filename,
    documentId,
    versionId: docIndex?.[docLabel]?.version_id ?? null,
    storagePath: docInfo.storage_path,
  };
}

export function duplicateReadDocumentResult(identity: {
  docLabel: string;
  documentId?: string;
  versionId?: string | null;
}) {
  return JSON.stringify({
    ok: true,
    already_read: true,
    doc_id: identity.docLabel,
    document_id: identity.documentId,
    version_id: identity.versionId ?? null,
    content:
      "This document/version was already read earlier in this response. The full text is not repeated to avoid unnecessary token use.",
    next_required_action:
      "Use the prior read_document/fetch_documents result, call find_in_document for targeted checks, or proceed to edit_document.",
  });
}

export function clearTurnReadsForDocument(
  turnReadState: TurnReadState | undefined,
  documentId: string,
) {
  if (!turnReadState) return;
  for (const [key, value] of turnReadState.entries()) {
    if (value.documentId === documentId) turnReadState.delete(key);
  }
}

export async function readDocumentContent(
  docLabel: string,
  docStore: DocStore,
  write: (s: string) => void,
  docIndex?: DocIndex,
  db?: ReturnType<typeof createServerSupabase>,
  opts?: { emitEvents?: boolean },
): Promise<string> {
  const emitEvents = opts?.emitEvents ?? true;
  devLog(`[read_document] called with docLabel="${docLabel}"`);
  const docInfo = docStore.get(docLabel);
  if (!docInfo) {
    devLog(
      `[read_document] MISS — docLabel "${docLabel}" not in docStore. Known labels:`,
      Array.from(docStore.keys()),
    );
    return "Document not found.";
  }
  devLog(
    `[read_document] docInfo: filename="${docInfo.filename}", file_type="${docInfo.file_type}", storage_path="${docInfo.storage_path}"`,
  );

  const documentId = docIndex?.[docLabel]?.document_id;
  const emitDocRead = () => {
    if (!emitEvents) return;
    write(
      `data: ${JSON.stringify({
        type: "doc_read",
        filename: docInfo.filename,
        document_id: documentId,
      })}\n\n`,
    );
  };
  if (emitEvents)
    write(
      `data: ${JSON.stringify({
        type: "doc_read_start",
        filename: docInfo.filename,
        document_id: documentId,
      })}\n\n`,
    );
  try {
    // The Word add-in supplies the active document's plain-text snapshot with
    // the request. Keep it in the same document-tool pipeline as stored files:
    // availability metadata is visible up front, but the body is returned only
    // after the model explicitly calls read_document.
    if (docInfo.inline_text !== undefined) {
      devLog(
        `[read_document] using request-scoped inline text (chars=${docInfo.inline_text.length}) for filename="${docInfo.filename}"`,
      );
      emitDocRead();
      return docInfo.inline_text;
    }

    // Prefer the current tracked-changes version (if any) so read_document
    // reflects accepted/pending edits rather than the original upload.
    let raw: ArrayBuffer | null = null;
    let sourcePath = docInfo.storage_path;
    if (documentId && db) {
      const current = await loadCurrentVersionBytes(documentId, db);
      if (current) {
        raw = current.bytes.buffer.slice(
          current.bytes.byteOffset,
          current.bytes.byteOffset + current.bytes.byteLength,
        ) as ArrayBuffer;
        sourcePath = current.storage_path;
        devLog(
          `[read_document] using current version path="${sourcePath}" (bytes=${raw.byteLength})`,
        );
      } else {
        devLog(
          `[read_document] loadCurrentVersionBytes returned null for documentId="${documentId}", falling back to original storage_path`,
        );
      }
    }
    if (!raw) {
      raw = await downloadFile(docInfo.storage_path);
      if (raw) {
        devLog(
          `[read_document] fallback download from storage_path="${docInfo.storage_path}" (bytes=${raw.byteLength})`,
        );
      }
    }
    if (!raw) {
      devLog(
        `[read_document] FAILED to download any bytes for docLabel="${docLabel}" (tried path="${sourcePath}")`,
      );
      emitDocRead();
      return "Document could not be read.";
    }
    // Log the first 8 bytes so we can identify real file format regardless
    // of the declared file_type. Valid .docx starts with "PK\x03\x04"
    // (zip). Legacy .doc starts with "\xD0\xCF\x11\xE0" (OLE/CFB).
    // %PDF-1 is a PDF even if mislabeled. Truncated uploads show as all-zero.
    {
      const head = Buffer.from(raw).subarray(0, 8);
      const hex = head.toString("hex");
      const ascii = head.toString("binary").replace(/[^\x20-\x7e]/g, ".");
      devLog(
        `[read_document] magic bytes hex=${hex} ascii="${ascii}" for filename="${docInfo.filename}"`,
      );
    }
    let text: string;
    let fileType = docInfo.file_type?.toLowerCase?.() ?? "";
    // Scans, photographs and plain-text files are read from their PDF
    // rendition: for a picture that is the copy OCR gave a text layer to, for
    // a text file the rendered page, so page numbers in citations match what
    // the reader sees on screen.
    let fromOcr = false;
    if (documentId && db) {
      const activeVersion = await loadActiveVersion(documentId, db);
      const renditionPath = activeVersion?.pdf_storage_path;
      if (shouldReadFromRendition(activeVersion) && renditionPath) {
        const renditionBytes = await downloadFile(renditionPath);
        if (renditionBytes) {
          raw = renditionBytes;
          fromOcr = isOcrDerived(activeVersion);
          fileType = "pdf";
          devLog(
            `[read_document] reading from PDF rendition path="${renditionPath}" ocr=${fromOcr}`,
          );
        }
      }
    }
    if (fileType === "pdf") {
      text = await extractPdfText(raw);
      devLog(
        `[read_document] pdf extracted length=${text.length} for filename="${docInfo.filename}"`,
      );
    } else if (fileType === "docx") {
      // Same flattening as the edit_document matcher, plus inline
      // **bold** / *italic* / _underline_ markers and [centered]-style
      // layout tokens so the model can see — and keep — the document's
      // emphasis and layout when it rewrites. Anchors that echo the
      // decorations are normalised back in runEditDocument.
      text = await extractDocxBodyTextMarked(Buffer.from(raw));
      try {
        const hf = await extractDocxHeadersFooters(Buffer.from(raw));
        for (const header of hf.headers) {
          text += `\n\n--- Page header ---\n${header}`;
        }
        for (const footer of hf.footers) {
          text += `\n\n--- Page footer ---\n${footer}`;
        }
      } catch {
        // A malformed header part never blocks reading the body.
      }
      devLog(
        `[read_document] docx extractDocxBodyText length=${text.length} for filename="${docInfo.filename}"`,
      );
      if (!text) {
        devLog(
          `[read_document] docx accepted-view extractor returned empty, falling back to mammoth for filename="${docInfo.filename}"`,
        );
        const mammoth = await import("mammoth");
        const result = await mammoth.extractRawText({
          buffer: Buffer.from(raw),
        });
        text = result.value;
        devLog(
          `[read_document] docx mammoth fallback length=${text.length} for filename="${docInfo.filename}"`,
        );
      }
    } else if (isSpreadsheetDocumentType(fileType)) {
      // SheetJS reads .xlsx/.xlsm/.xls directly (no PDF detour), emitting a
      // cell-addressed markdown view with Excel-formatted values.
      text = spreadsheetToLLMText(Buffer.from(raw));
      devLog(
        `[read_document] spreadsheet extracted length=${text.length} for filename="${docInfo.filename}"`,
      );
    } else if (fileType === "pptx") {
      text = await extractPresentationText(Buffer.from(raw));
      devLog(
        `[read_document] presentation extracted length=${text.length} for filename="${docInfo.filename}"`,
      );
    } else if (
      isPresentationDocumentType(fileType) ||
      isWordDocumentType(fileType)
    ) {
      devLog(
        `[read_document] legacy Office file_type="${fileType}" for filename="${docInfo.filename}", converting to pdf for text extraction`,
      );
      const pdfBuf = await docxToPdf(Buffer.from(raw));
      text = await extractPdfText(
        pdfBuf.buffer.slice(
          pdfBuf.byteOffset,
          pdfBuf.byteOffset + pdfBuf.byteLength,
        ) as ArrayBuffer,
      );
      devLog(
        `[read_document] legacy Office PDF extraction length=${text.length} for filename="${docInfo.filename}"`,
      );
    } else {
      devLog(
        `[read_document] unknown file_type="${docInfo.file_type}" for filename="${docInfo.filename}", trying mammoth`,
      );
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({
        buffer: Buffer.from(raw),
      });
      text = result.value;
      devLog(
        `[read_document] mammoth length=${text.length} for filename="${docInfo.filename}"`,
      );
    }
    // Text that came from character recognition is flagged so the model
    // quotes it with care rather than treating it as a clean original.
    if (fromOcr && text.trim()) text = `${OCR_TEXT_NOTE}\n\n${text}`;
    devLog(
      `[read_document] DONE filename="${docInfo.filename}" finalTextLength=${text.length} firstChars=${JSON.stringify(text.slice(0, 120))}`,
    );
    emitDocRead();
    return text;
  } catch (err) {
    devLog(
      `[read_document] THREW for docLabel="${docLabel}" filename="${docInfo.filename}":`,
      err,
    );
    if (emitEvents)
      write(
        `data: ${JSON.stringify({ type: "doc_read", filename: docInfo.filename })}\n\n`,
      );
    return "Document could not be read.";
  }
}

/** A character is "punctuation" for tolerant matching if it is not a letter,
 *  number, or whitespace. Dropped entirely (not replaced with a space) so
 *  "U.S." collapses to "us" and "plaintiff's" to "plaintiffs". */
function isPunctuation(ch: string): boolean {
  return !/[\p{L}\p{N}\s]/u.test(ch);
}

/**
 * Build a whitespace-collapsed, lowercased copy of `text`, plus a map from
 * each character index in the normalized form back to the corresponding
 * index in the original text. Used by `findInDocumentContent` (and server-side
 * citation verification) so matches are tolerant of case + whitespace variance
 * but can still return the exact original excerpt.
 *
 * With `stripPunctuation`, punctuation characters are removed from the
 * normalized form too, making matching tolerant of punctuation drift (e.g. a
 * model that adds a stray comma or drops a period). The index map still points
 * back at the surviving original characters so the recovered excerpt is exact.
 */
export function normalizeWithMap(
  text: string,
  opts: { stripPunctuation?: boolean } = {},
): { norm: string; origIdx: number[] } {
  const stripPunctuation = opts.stripPunctuation ?? false;
  const norm: string[] = [];
  const origIdx: number[] = [];
  let prevSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (!prevSpace) {
        norm.push(" ");
        origIdx.push(i);
        prevSpace = true;
      }
    } else if (stripPunctuation && isPunctuation(ch)) {
      // Drop punctuation without disturbing the space-collapsing state so
      // "foo, bar" -> "foo bar" but "U.S." -> "us".
      continue;
    } else {
      norm.push(ch.toLowerCase());
      origIdx.push(i);
      prevSpace = false;
    }
  }
  return { norm: norm.join(""), origIdx };
}

function normalizeQuery(q: string): string {
  return q.trim().replace(/\s+/g, " ").toLowerCase();
}

export type TextMatch = {
  index: number;
  excerpt: string;
  context: string;
};

export function findTextMatches(params: {
  text: string;
  query: string;
  maxResults: number;
  contextChars: number;
  startIndex?: number;
}): { hits: TextMatch[]; totalMatches: number } {
  const { text, query, maxResults, contextChars, startIndex = 0 } = params;
  const { norm, origIdx } = normalizeWithMap(text);
  const needle = normalizeQuery(query);
  const hits: TextMatch[] = [];
  let totalMatches = 0;
  if (!needle) return { hits, totalMatches };

  let from = 0;
  while (from <= norm.length - needle.length) {
    const pos = norm.indexOf(needle, from);
    if (pos < 0) break;
    const endNormPos = pos + needle.length;
    const origStart = origIdx[pos] ?? 0;
    const origEnd =
      endNormPos - 1 < origIdx.length
        ? origIdx[endNormPos - 1] + 1
        : text.length;
    if (hits.length < maxResults) {
      const ctxStart = Math.max(0, origStart - contextChars);
      const ctxEnd = Math.min(text.length, origEnd + contextChars);
      hits.push({
        index: startIndex + hits.length,
        excerpt: text.slice(origStart, origEnd),
        context:
          (ctxStart > 0 ? "…" : "") +
          text.slice(ctxStart, ctxEnd).replace(/\s+/g, " ").trim() +
          (ctxEnd < text.length ? "…" : ""),
      });
    }
    totalMatches++;
    from = pos + Math.max(1, needle.length);
  }

  return { hits, totalMatches };
}

/**
 * Ctrl+F helper. Returns a JSON-serializable result with up to `maxResults`
 * hits, each containing the original-text excerpt plus surrounding context.
 */
export async function findInDocumentContent(params: {
  docLabel: string;
  query: string;
  maxResults?: number;
  contextChars?: number;
  docStore: DocStore;
  write: (s: string) => void;
  docIndex?: DocIndex;
  db?: ReturnType<typeof createServerSupabase>;
}): Promise<string> {
  const {
    docLabel,
    query,
    maxResults = 20,
    contextChars = 80,
    docStore,
    write,
    docIndex,
    db,
  } = params;

  if (!query || !query.trim()) {
    return JSON.stringify({ ok: false, error: "Empty query." });
  }

  const docInfo = docStore.get(docLabel);
  if (!docInfo) {
    return JSON.stringify({
      ok: false,
      error: `Document '${docLabel}' not found.`,
    });
  }
  const documentId = docIndex?.[docLabel]?.document_id;

  // Announce the search to the UI, then reuse readDocumentContent for its
  // fallbacks — but suppress its own doc_read events so the user only sees
  // the doc_find block (not a competing doc_read block for the same op).
  write(
    `data: ${JSON.stringify({
      type: "doc_find_start",
      filename: docInfo.filename,
      document_id: documentId,
      query,
    })}\n\n`,
  );

  const text = await readDocumentContent(
    docLabel,
    docStore,
    write,
    docIndex,
    db,
    { emitEvents: false },
  );
  if (!text || text === "Document could not be read.") {
    write(
      `data: ${JSON.stringify({
        type: "doc_find",
        filename: docInfo.filename,
        document_id: documentId,
        query,
        total_matches: 0,
      })}\n\n`,
    );
    return JSON.stringify({
      ok: false,
      filename: docInfo.filename,
      error: "Document could not be read.",
    });
  }

  const needle = normalizeQuery(query);
  if (!needle) {
    return JSON.stringify({
      ok: false,
      error: "Empty query after normalization.",
    });
  }

  const { hits, totalMatches } = findTextMatches({
    text,
    query,
    maxResults,
    contextChars,
  });

  write(
    `data: ${JSON.stringify({
      type: "doc_find",
      filename: docInfo.filename,
      document_id: documentId,
      query,
      total_matches: totalMatches,
    })}\n\n`,
  );

  return JSON.stringify({
    ok: true,
    filename: docInfo.filename,
    query,
    total_matches: totalMatches,
    returned: hits.length,
    truncated: totalMatches > hits.length,
    hits,
  });
}

export type DocEditedResult = {
  filename: string;
  document_id: string;
  version_id: string;
  version_number: number | null;
  download_url: string;
  annotations: EditAnnotation[];
};

export type TurnEditState = Map<
  string,
  { versionId: string; versionNumber: number; storagePath: string }
>;

export type TurnReadState = Map<
  string,
  {
    docLabel: string;
    filename: string;
    documentId?: string;
    versionId?: string | null;
    storagePath: string;
  }
>;

export type DocCreatedResult = {
  filename: string;
  download_url: string;
  document_id?: string;
  version_id?: string;
  version_number?: number | null;
};

export type DocReplicatedResult = {
  /** Filename of the source document being copied. */
  filename: string;
  /** How many copies were produced in this single tool call. */
  count: number;
  /** One entry per new copy. */
  copies: {
    new_filename: string;
    document_id: string;
    version_id: string;
  }[];
};
