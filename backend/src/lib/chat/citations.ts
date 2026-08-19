import { type DocIndex, resolveDoc } from "./types";
import { normalizeLegId, type LegislationRecord } from "./tools/legislationTurnState";
import { verifyQuoteAgainstSource } from "./verifyCitations";
import {
  normalizeCaseDocument,
  sourceDocumentType,
  type SourceDocumentQuote,
} from "../sourceDocuments";

// ---------------------------------------------------------------------------
// Internal citation parse types
// ---------------------------------------------------------------------------

type DocumentQuote = {
  page: number | string;
  quote: string;
  // Spreadsheet sources are located by cell instead of page: `sheet` is the
  // worksheet name and `cell` is an A1 address or range (e.g. "B7" or "B7:C9").
  sheet?: string;
  cell?: string;
};

type ParsedDocumentCitation = {
  kind: "document";
  ref: number;
  doc_id: string;
  page: number | string;
  quote: string;
  sheet?: string;
  cell?: string;
  quotes: DocumentQuote[];
};

type ParsedCaseCitation = {
  kind: "case";
  ref: number;
  cluster_id: number;
  quotes: {
    opinionId: number | null;
    type: string | null;
    author: string | null;
    quote: string;
  }[];
};

type ParsedLegislationCitation = {
  kind: "legislation";
  ref: number;
  leg_id: string;
  quotes: { quote: string }[];
};

type ParsedCitation =
  | ParsedDocumentCitation
  | ParsedCaseCitation
  | ParsedLegislationCitation;

function normalizeCitation(raw: unknown): ParsedCitation | null {
  if (!raw || typeof raw !== "object") return null;
  const c = raw as Record<string, unknown>;
  const markerRef =
    typeof c.marker === "string"
      ? Number(c.marker.match(/^\[(\d+)\]$/)?.[1])
      : NaN;
  const ref =
    typeof c.ref === "number"
      ? c.ref
      : Number.isFinite(markerRef)
        ? markerRef
        : null;
  if (typeof ref !== "number") return null;
  const quote = typeof c.quote === "string" ? c.quote : c.text;

  const rawClusterId =
    typeof c.cluster_id === "number"
      ? c.cluster_id
      : typeof c.clusterId === "number"
        ? c.clusterId
        : typeof c.cluster_id === "string"
          ? Number.parseInt(c.cluster_id, 10)
          : typeof c.clusterId === "string"
            ? Number.parseInt(c.clusterId, 10)
            : NaN;
  if (Number.isFinite(rawClusterId) && rawClusterId > 0) {
    const quotes = normalizeCaseCitationQuotes(c);
    if (!quotes.length) {
      if (typeof quote !== "string" || !quote) return null;
      quotes.push({ opinionId: null, type: null, author: null, quote });
    }
    return { kind: "case", ref, cluster_id: Math.floor(rawClusterId), quotes };
  }

  const legId =
    typeof c.leg_id === "string"
      ? c.leg_id
      : typeof c.legId === "string"
        ? c.legId
        : null;
  if (legId && legId.trim()) {
    const legQuotes = normalizeLegislationCitationQuotes(c);
    if (!legQuotes.length) {
      if (typeof quote !== "string" || !quote) return null;
      legQuotes.push({ quote });
    }
    return { kind: "legislation", ref, leg_id: legId.trim(), quotes: legQuotes };
  }

  if (typeof c.doc_id !== "string") return null;
  const quotes = normalizeDocumentCitationQuotes(c);
  if (!quotes.length) {
    if (typeof quote !== "string" || !quote) return null;
    quotes.push({
      page: normalizeCitationPage(c.page),
      quote,
      ...normalizeCellLocator(c),
    });
  }
  return {
    kind: "document",
    ref,
    doc_id: c.doc_id,
    page: quotes[0].page,
    quote: quotes[0].quote,
    sheet: quotes[0].sheet,
    cell: quotes[0].cell,
    quotes,
  };
}

/** Pull an optional spreadsheet `{sheet, cell}` locator off a raw object. */
function normalizeCellLocator(
  c: Record<string, unknown>,
): { sheet?: string; cell?: string } {
  const out: { sheet?: string; cell?: string } = {};
  if (typeof c.sheet === "string" && c.sheet.trim()) out.sheet = c.sheet.trim();
  if (typeof c.cell === "string" && c.cell.trim()) out.cell = c.cell.trim();
  return out;
}

function normalizeCitationPage(value: unknown): number | string {
  if (typeof value === "number") {
    return value;
  } else if (typeof value === "string" && /^\d+\s*-\s*\d+$/.test(value)) {
    return value;
  } else {
    const n = parseInt(String(value ?? ""), 10);
    if (!Number.isFinite(n)) return 1;
    return n;
  }
}

function normalizeDocumentCitationQuotes(
  c: Record<string, unknown>,
): DocumentQuote[] {
  if (!Array.isArray(c.quotes)) return [];
  return c.quotes
    .slice(0, 3)
    .map((raw): DocumentQuote | null => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const row = raw as Record<string, unknown>;
      const text = typeof row.quote === "string" ? row.quote : row.text;
      if (typeof text !== "string" || !text.trim()) return null;
      // Fall back to the top-level sheet/cell so a citation can set them once.
      return {
        page: normalizeCitationPage(row.page ?? c.page),
        quote: text,
        ...normalizeCellLocator({
          sheet: row.sheet ?? c.sheet,
          cell: row.cell ?? c.cell,
        }),
      };
    })
    .filter((quote): quote is DocumentQuote => !!quote);
}

function normalizeCaseCitationQuotes(c: Record<string, unknown>) {
  if (!Array.isArray(c.quotes)) return [];
  return c.quotes
    .slice(0, 3)
    .map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const row = raw as Record<string, unknown>;
      const text = typeof row.quote === "string" ? row.quote : row.text;
      if (typeof text !== "string" || !text.trim()) return null;
      const opinionId =
        typeof row.opinion_id === "number" && Number.isFinite(row.opinion_id)
          ? Math.floor(row.opinion_id)
          : typeof row.opinionId === "number" && Number.isFinite(row.opinionId)
            ? Math.floor(row.opinionId)
            : null;
      return {
        opinionId,
        type: typeof row.type === "string" ? row.type : null,
        author: typeof row.author === "string" ? row.author : null,
        quote: text,
      };
    })
    .filter(
      (quote): quote is {
        opinionId: number | null;
        type: string | null;
        author: string | null;
        quote: string;
      } => !!quote,
    );
}

function normalizeLegislationCitationQuotes(
  c: Record<string, unknown>,
): { quote: string }[] {
  if (!Array.isArray(c.quotes)) return [];
  return c.quotes
    .slice(0, 3)
    .map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const row = raw as Record<string, unknown>;
      const text = typeof row.quote === "string" ? row.quote : row.text;
      if (typeof text !== "string" || !text.trim()) return null;
      return { quote: text };
    })
    .filter((q): q is { quote: string } => !!q);
}

// ---------------------------------------------------------------------------
// Citation block constants and parsers
// ---------------------------------------------------------------------------

export const CITATIONS_BLOCK_RE = /<CITATIONS>\s*([\s\S]*?)\s*<\/CITATIONS>/;
export const CITATIONS_OPEN_TAG = "<CITATIONS>";
export const CITATIONS_CLOSE_TAG = "</CITATIONS>";

type CitationParseDiagnostics = {
  hasBlock: boolean;
  rawLength: number;
  error: string | null;
};

export function parseCitationsWithDiagnostics(text: string): {
  citations: ParsedCitation[];
  diagnostics: CitationParseDiagnostics;
} {
  const match = text.match(CITATIONS_BLOCK_RE);
  if (!match) {
    return { citations: [], diagnostics: { hasBlock: false, rawLength: 0, error: null } };
  }
  const raw = match[1] ?? "";
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return {
        citations: [],
        diagnostics: { hasBlock: true, rawLength: raw.length, error: "CITATIONS block JSON was not an array." },
      };
    }
    return {
      citations: parsed.map(normalizeCitation).filter((c): c is ParsedCitation => c !== null),
      diagnostics: { hasBlock: true, rawLength: raw.length, error: null },
    };
  } catch (error) {
    return {
      citations: [],
      diagnostics: {
        hasBlock: true,
        rawLength: raw.length,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export function parseCitations(text: string): ParsedCitation[] {
  return parseCitationsWithDiagnostics(text).citations;
}

export function parsePartialCitationObjects(text: string): ParsedCitation[] {
  const beforeClose = text.split(CITATIONS_CLOSE_TAG)[0] ?? text;
  const arrayStart = beforeClose.indexOf("[");
  if (arrayStart < 0) return [];

  const parsed: ParsedCitation[] = [];
  let inString = false;
  let escaped = false;
  let depth = 0;
  let objectStart = -1;

  for (let i = arrayStart + 1; i < beforeClose.length; i += 1) {
    const char = beforeClose[i];
    if (escaped) { escaped = false; continue; }
    if (char === "\\") { escaped = inString; continue; }
    if (char === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (char === "{") {
      if (depth === 0) objectStart = i;
      depth += 1;
    } else if (char === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && objectStart >= 0) {
        try {
          const raw = JSON.parse(beforeClose.slice(objectStart, i + 1));
          const citation = normalizeCitation(raw);
          if (citation) parsed.push(citation);
        } catch { /* ignore incomplete/malformed partial object */ }
        objectStart = -1;
      }
    } else if (char === "]" && depth === 0) {
      break;
    }
  }
  return parsed;
}

type CasesByClusterId = Map<number, {
  caseName: string | null;
  citations: string[];
  url: string | null;
  pdfUrl: string | null;
  dateFiled: string | null;
}>;

function legislationHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped
    .split(/\n\s*\n/)
    .map((para) => `<p>${para.trim().replace(/\n/g, "<br/>")}</p>`)
    .filter((para) => para !== "<p></p>")
    .join("\n");
}

export function createCitation(
  citation: ParsedCitation,
  docIndex: DocIndex,
  casesByClusterId?: CasesByClusterId,
  legById?: Map<string, LegislationRecord>,
) {
  if (citation.kind === "legislation") {
    const legId = normalizeLegId(citation.leg_id);
    const record = legById?.get(legId);
    const subId = `legislation:${legId}`;
    const title = record?.label ?? citation.leg_id;
    // Legislation has no stored document id, so it never reaches the streaming
    // verifier. Match each quote against the statute text we captured this turn
    // right here — that drives the same green "verified" badge and the panel
    // highlight that case quotes get, and swaps in the exact source wording
    // when the model's quote drifted.
    const verifiedQuotes = citation.quotes.map((q) => {
      const result = record
        ? verifyQuoteAgainstSource(record.text, q.quote)
        : { verified: false, needs_correction: false };
      const { needs_correction, ...verification } = result;
      const quote =
        needs_correction && verification.source_excerpt
          ? verification.source_excerpt
          : q.quote;
      return { quote, verification };
    });
    const document = {
      document_id: subId,
      title,
      type: "legislation" as const,
      metadata: record?.url ? [{ label: "Source", value: record.url }] : [],
      actions: record?.url
        ? [{ type: "link" as const, url: record.url, label: "Open source" }]
        : [],
      quotes: verifiedQuotes.map((q) => ({
        quote: q.quote,
        verification: q.verification,
        target: { subdocument_id: subId },
      })),
      subdocuments: [
        {
          document_id: subId,
          title,
          type: "html" as const,
          html: record ? legislationHtml(record.text) : null,
          text: record?.text ?? null,
        },
      ],
      version_id: null,
      version_number: null,
    };
    return {
      type: "citation_data",
      kind: "legislation",
      ref: citation.ref,
      document,
      leg_id: legId,
      title,
      url: record?.url ?? null,
      quotes: verifiedQuotes,
      verified: verifiedQuotes.every((q) => q.verification.verified),
    };
  }

  if (citation.kind === "case") {
    const caseRecord = casesByClusterId?.get(citation.cluster_id);
    const document = normalizeCaseDocument({
      clusterId: citation.cluster_id,
      caseName: caseRecord?.caseName,
      citations: caseRecord?.citations,
      url: caseRecord?.url,
      pdfUrl: caseRecord?.pdfUrl,
      dateFiled: caseRecord?.dateFiled,
      quotes: citation.quotes,
    });
    return {
      type: "citation_data",
      kind: "case",
      ref: citation.ref,
      document,
      cluster_id: citation.cluster_id,
      case_name: caseRecord?.caseName ?? null,
      citation: caseRecord?.citations[0] ?? null,
      url: caseRecord?.url ?? null,
      pdfUrl: caseRecord?.pdfUrl ?? null,
      dateFiled: caseRecord?.dateFiled ?? null,
      quotes: citation.quotes,
    };
  }

  const docInfo = resolveDoc(citation.doc_id, docIndex);
  const documentId = docInfo?.document_id ?? citation.doc_id;
  const filename = docInfo?.filename ?? citation.doc_id;
  const quotes: SourceDocumentQuote[] = citation.quotes.map((quote) => ({
    quote: quote.quote,
    target: {
      page: quote.page,
      ...(quote.sheet ? { sheet: quote.sheet } : {}),
      ...(quote.cell ? { cell: quote.cell } : {}),
    },
  }));
  return {
    type: "citation_data",
    kind: "document",
    ref: citation.ref,
    document: {
      document_id: documentId,
      title: filename,
      type: sourceDocumentType(filename),
      metadata: [],
      quotes,
      version_id: docInfo?.version_id ?? null,
      version_number: docInfo?.version_number ?? null,
    },
    doc_id: citation.doc_id,
    document_id: docInfo?.document_id,
    version_id: docInfo?.version_id ?? null,
    version_number: docInfo?.version_number ?? null,
    filename,
    page: citation.page,
    quote: citation.quote,
    sheet: citation.sheet,
    cell: citation.cell,
    quotes: citation.quotes,
  };
}
