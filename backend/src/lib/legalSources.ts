// Saving a legal source (a CourtListener case, or a statute pulled by the law
// tools) into a matter's "Law" folder as a first-class document: viewable,
// downloadable, searchable by the matter search, and quotable by the
// assistant. The bytes we store are the court's own PDF where one exists, and
// a generated Word document of the text where one does not (statutes never
// have a PDF).
//
// Nothing here trusts the browser for the text of a source. A case is
// re-fetched from CourtListener by its cluster id; a statute is read back out
// of the answer that quoted it, which the backend wrote itself.

import { createServerSupabase } from "./supabase";
import { getCourtlistenerCaseOpinions } from "./courtlistener";
import { normalizeLegId } from "./chat/tools/legislationTurnState";
import { storageKey, uploadFile } from "./storage";
import { contentTypeForDocumentType } from "./documentTypes";
import { prepareRendition, readInBackground } from "./documentRendition";
import { indexInBackground } from "./passageIndex";
import { contentSha256 } from "./documentVersions";
import { recordAudit } from "./audit";
import { checkProjectAccess } from "./access";

type Db = ReturnType<typeof createServerSupabase>;

/** Folder every saved source lands in. Matched case-insensitively. */
export const LAW_FOLDER_NAME = "Law";

const MAX_PDF_BYTES = 60 * 1024 * 1024;
const PDF_HOSTS = new Set([
  "www.courtlistener.com",
  "courtlistener.com",
  "storage.courtlistener.com",
]);

export type SaveLegalSourceInput =
  | {
      kind: "case";
      clusterId: number;
      /** Display fallbacks from the citation the user clicked. Never trusted
       *  for content — only for the title when CourtListener's own metadata
       *  comes back thin. */
      caseName?: string | null;
      citation?: string | null;
      dateFiled?: string | null;
      url?: string | null;
      pdfUrl?: string | null;
    }
  | { kind: "legislation"; legId: string; chatId: string };

export type SaveLegalSourceResult =
  | {
      status: "saved" | "exists";
      documentId: string;
      filename: string;
      folderId: string | null;
      folderName: string;
      title: string;
    }
  | { error: string; status?: number };

type ResolvedSource = {
  sourceRef: string;
  title: string;
  sourceUrl: string | null;
  content: Buffer;
  suffix: "pdf" | "docx";
  filename: string;
};

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function saveLegalSourceToProject(args: {
  db: Db;
  userId: string;
  userEmail?: string | null;
  projectId: string;
  input: SaveLegalSourceInput;
  courtlistenerToken?: string | null;
}): Promise<SaveLegalSourceResult> {
  const { db, userId, userEmail, projectId, input } = args;

  const access = await checkProjectAccess(projectId, userId, userEmail, db);
  if (!access.ok) return { error: "Matter not found", status: 404 };

  const sourceKind = input.kind;
  const sourceRef =
    input.kind === "case"
      ? String(Math.floor(input.clusterId))
      : normalizeLegId(input.legId);
  if (!sourceRef) return { error: "Unrecognised source", status: 400 };

  // Already filed? Hand back the copy that is there rather than making a
  // second one.
  const existing = await db
    .from("documents")
    .select("id, folder_id, current_version_id")
    .eq("project_id", projectId)
    .eq("source_kind", sourceKind)
    .eq("source_ref", sourceRef)
    .maybeSingle();
  if (existing.data) {
    const documentId = existing.data.id as string;
    const { data: version } = await db
      .from("document_versions")
      .select("filename")
      .eq("document_id", documentId)
      .order("version_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    return {
      status: "exists",
      documentId,
      filename: (version?.filename as string) ?? "",
      folderId: (existing.data.folder_id as string | null) ?? null,
      folderName: LAW_FOLDER_NAME,
      title: (version?.filename as string) ?? "",
    };
  }

  let resolved: ResolvedSource;
  try {
    resolved =
      input.kind === "case"
        ? await resolveCase(input, args.courtlistenerToken ?? null, db)
        : await resolveLegislation(db, {
            legId: input.legId,
            chatId: input.chatId,
            userId,
            userEmail,
          });
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : "Could not read this source",
      status: 502,
    };
  }

  const folderId = await ensureLawFolder(db, projectId, userId);

  const documentId = await storeSourceDocument(db, {
    userId,
    userEmail,
    projectId,
    folderId,
    sourceKind,
    sourceRef,
    resolved,
  });

  return {
    status: "saved",
    documentId,
    filename: resolved.filename,
    folderId,
    folderName: LAW_FOLDER_NAME,
    title: resolved.title,
  };
}

// ---------------------------------------------------------------------------
// The "Law" folder
// ---------------------------------------------------------------------------

async function ensureLawFolder(
  db: Db,
  projectId: string,
  userId: string,
): Promise<string | null> {
  const { data: folders } = await db
    .from("project_subfolders")
    .select("id, name, parent_folder_id")
    .eq("project_id", projectId)
    .is("parent_folder_id", null);
  const match = (folders ?? []).find(
    (folder) =>
      String(folder.name ?? "").trim().toLowerCase() ===
      LAW_FOLDER_NAME.toLowerCase(),
  );
  if (match) return match.id as string;

  const { data, error } = await db
    .from("project_subfolders")
    .insert({
      project_id: projectId,
      user_id: userId,
      name: LAW_FOLDER_NAME,
      parent_folder_id: null,
    })
    .select("id")
    .single();
  if (error || !data) {
    console.error("[legal-source] could not create the Law folder", error);
    // A missing folder is not worth failing the save over — the document still
    // belongs to the matter, it just sits at the top level.
    return null;
  }
  return data.id as string;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

async function resolveCase(
  input: Extract<SaveLegalSourceInput, { kind: "case" }>,
  apiToken: string | null,
  db: Db,
): Promise<ResolvedSource> {
  const clusterId = Math.floor(input.clusterId);
  const fetched = (await getCourtlistenerCaseOpinions({
    clusterId,
    includeFullText: true,
    maxChars: 50000,
    db,
    apiToken,
  })) as Record<string, unknown>;

  const caseName =
    stringOrNull(fetched.caseName) ?? stringOrNull(input.caseName) ?? null;
  const citations = Array.isArray(fetched.citations)
    ? fetched.citations.filter((c): c is string => typeof c === "string")
    : [];
  const citation = citations[0] ?? stringOrNull(input.citation);
  const dateFiled =
    stringOrNull(fetched.dateFiled) ?? stringOrNull(input.dateFiled);
  const court = stringOrNull(fetched.court);
  const webUrl =
    stringOrNull(fetched.url) ??
    stringOrNull(input.url) ??
    `https://www.courtlistener.com/opinion/${clusterId}/`;
  const pdfUrl = allowedPdfUrl(
    stringOrNull(fetched.pdfUrl) ?? stringOrNull(input.pdfUrl),
  );

  const title = [caseName, citation].filter(Boolean).join(", ") ||
    `CourtListener case ${clusterId}`;
  const base = safeFileBase(title);

  if (pdfUrl) {
    const pdf = await downloadPdf(pdfUrl);
    if (pdf) {
      return {
        sourceRef: String(clusterId),
        title,
        sourceUrl: webUrl,
        content: pdf,
        suffix: "pdf",
        filename: `${base}.pdf`,
      };
    }
    console.error("[legal-source] court PDF could not be downloaded", {
      clusterId,
      pdfUrl,
    });
  }

  const opinions = Array.isArray(fetched.opinions)
    ? (fetched.opinions as Record<string, unknown>[])
    : [];
  const sections: DocSection[] = [];
  for (const opinion of opinions) {
    const text = stringOrNull(opinion.text);
    if (!text) continue;
    const heading = [
      opinionLabel(stringOrNull(opinion.type)),
      stringOrNull(opinion.author),
    ]
      .filter(Boolean)
      .join(" — ");
    sections.push({ heading, body: text });
  }
  if (!sections.length) {
    throw new Error(
      "CourtListener returned no text for this case, so there is nothing to save.",
    );
  }

  const content = await buildDocx({
    title,
    facts: [
      court ? { label: "Court", value: court } : null,
      dateFiled ? { label: "Decided", value: dateFiled } : null,
      citation ? { label: "Citation", value: citation } : null,
      { label: "Source", value: webUrl },
    ].filter(Boolean) as DocFact[],
    sections,
  });

  return {
    sourceRef: String(clusterId),
    title,
    sourceUrl: webUrl,
    content,
    suffix: "docx",
    filename: `${base}.docx`,
  };
}

function opinionLabel(type: string | null): string {
  if (!type) return "Opinion";
  const cleaned = type.replace(/^\d+/, "").replace(/_/g, " ").trim();
  if (!cleaned) return "Opinion";
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
}

function allowedPdfUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;
    if (!PDF_HOSTS.has(url.hostname.toLowerCase())) return null;
    return url.toString();
  } catch {
    return null;
  }
}

async function downloadPdf(url: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url, {
      redirect: "follow",
      headers: { accept: "application/pdf" },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) return null;
    // A redirect must not walk us off CourtListener.
    if (!allowedPdfUrl(response.url || url)) return null;
    const declared = Number(response.headers.get("content-length") ?? "0");
    if (declared && declared > MAX_PDF_BYTES) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > MAX_PDF_BYTES) return null;
    // Some misses come back as an HTML error page with a 200.
    if (buffer.subarray(0, 5).toString("latin1") !== "%PDF-") return null;
    return buffer;
  } catch (err) {
    console.error("[legal-source] PDF download failed", err);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Statutes
// ---------------------------------------------------------------------------

async function resolveLegislation(
  db: Db,
  args: {
    legId: string;
    chatId: string;
    userId: string;
    userEmail?: string | null;
  },
): Promise<ResolvedSource> {
  const legId = normalizeLegId(args.legId);
  const { data: chat } = await db
    .from("chats")
    .select("id, user_id, project_id")
    .eq("id", args.chatId)
    .maybeSingle();
  if (!chat) throw new Error("That conversation could not be found.");
  if (chat.user_id !== args.userId) {
    const projectId = chat.project_id as string | null;
    const access = projectId
      ? await checkProjectAccess(projectId, args.userId, args.userEmail, db)
      : { ok: false as const };
    if (!access.ok) throw new Error("That conversation could not be found.");
  }

  const { data: messages } = await db
    .from("chat_messages")
    .select("citations, created_at")
    .eq("chat_id", args.chatId)
    .not("citations", "is", null)
    .order("created_at", { ascending: false })
    .limit(60);

  for (const message of messages ?? []) {
    const citations = Array.isArray(message.citations)
      ? (message.citations as Record<string, unknown>[])
      : [];
    for (const citation of citations) {
      if (citation?.kind !== "legislation") continue;
      const candidate = normalizeLegId(String(citation.leg_id ?? ""));
      if (candidate !== legId) continue;
      const document = citation.document as Record<string, unknown> | undefined;
      const subdocuments = Array.isArray(document?.subdocuments)
        ? (document?.subdocuments as Record<string, unknown>[])
        : [];
      const text = stringOrNull(subdocuments[0]?.text);
      if (!text) continue;
      const title =
        stringOrNull(citation.title) ??
        stringOrNull(document?.title) ??
        args.legId;
      const url = stringOrNull(citation.url);
      const content = await buildDocx({
        title,
        facts: url ? [{ label: "Source", value: url }] : [],
        sections: [{ heading: null, body: text }],
      });
      return {
        sourceRef: legId,
        title,
        sourceUrl: url,
        content,
        suffix: "docx",
        filename: `${safeFileBase(title)}.docx`,
      };
    }
  }

  throw new Error(
    "The text of this statute is no longer to hand. Ask for it again in the chat, then save it.",
  );
}

// ---------------------------------------------------------------------------
// Word document builder
// ---------------------------------------------------------------------------

type DocFact = { label: string; value: string };
type DocSection = { heading: string | null; body: string };

async function buildDocx(args: {
  title: string;
  facts: DocFact[];
  sections: DocSection[];
}): Promise<Buffer> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } =
    await import("docx");
  const FONT = "Times New Roman";
  const SIZE = 22; // 11pt in half-points

  const paragraph = (text: string, options?: { bold?: boolean }) =>
    new Paragraph({
      spacing: { after: 120 },
      children: [
        new TextRun({
          text,
          font: FONT,
          size: SIZE,
          bold: options?.bold ?? false,
        }),
      ],
    });

  const children = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [
        new TextRun({ text: args.title, font: FONT, size: SIZE, bold: true }),
      ],
    }),
    ...args.facts.map((fact) => paragraph(`${fact.label}: ${fact.value}`)),
  ];

  for (const section of args.sections) {
    if (section.heading) {
      children.push(
        new Paragraph({
          spacing: { before: 240, after: 120 },
          children: [
            new TextRun({
              text: section.heading,
              font: FONT,
              size: SIZE,
              bold: true,
            }),
          ],
        }),
      );
    }
    for (const block of section.body.split(/\n\s*\n/)) {
      const text = block.replace(/\s+\n/g, "\n").trim();
      if (text) children.push(paragraph(text));
    }
  }

  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}

// ---------------------------------------------------------------------------
// Storing it
// ---------------------------------------------------------------------------

async function storeSourceDocument(
  db: Db,
  args: {
    userId: string;
    userEmail?: string | null;
    projectId: string;
    folderId: string | null;
    sourceKind: "case" | "legislation";
    sourceRef: string;
    resolved: ResolvedSource;
  },
): Promise<string> {
  const { resolved } = args;
  const { data: doc, error: insertErr } = await db
    .from("documents")
    .insert({
      project_id: args.projectId,
      user_id: args.userId,
      status: "processing",
      folder_id: args.folderId,
      source_kind: args.sourceKind,
      source_ref: args.sourceRef,
      source_url: resolved.sourceUrl,
    })
    .select("id")
    .single();
  if (insertErr || !doc) {
    throw new Error(
      `Failed to record the saved source: ${insertErr?.message ?? "unknown"}`,
    );
  }
  const documentId = doc.id as string;

  try {
    const key = storageKey(args.userId, documentId, resolved.filename);
    const content = resolved.content;
    const bytes = content.buffer.slice(
      content.byteOffset,
      content.byteOffset + content.byteLength,
    ) as ArrayBuffer;
    await uploadFile(key, bytes, contentTypeForDocumentType(resolved.suffix));

    const target = {
      content,
      suffix: resolved.suffix,
      userId: args.userId,
      docId: documentId,
      storagePath: key,
      pageCount: null,
      label: "legal-source",
    };
    const rendition = await prepareRendition(target);

    const { data: versionRow, error: verErr } = await db
      .from("document_versions")
      .insert({
        document_id: documentId,
        storage_path: key,
        pdf_storage_path: rendition.pdfStoragePath,
        source: "legal-source",
        version_number: 1,
        filename: resolved.filename,
        file_type: resolved.suffix,
        size_bytes: content.byteLength,
        page_count: rendition.pageCount,
        content_sha256: contentSha256(content),
      })
      .select("id")
      .single();
    if (verErr || !versionRow) {
      throw new Error(
        `Failed to record the saved source: ${verErr?.message ?? "unknown"}`,
      );
    }
    const versionId = versionRow.id as string;

    await db
      .from("documents")
      .update({
        current_version_id: versionId,
        status: rendition.ocrPending ? "processing" : "ready",
        updated_at: new Date().toISOString(),
      })
      .eq("id", documentId);

    if (rendition.ocrPending) {
      // A scanned court PDF: read it in the background so its text is
      // searchable, exactly as an uploaded scan would be.
      readInBackground(db, {
        documentId,
        versionId,
        target,
        projectId: args.projectId,
      });
    } else {
      indexInBackground(db, {
        version: {
          id: versionId,
          document_id: documentId,
          storage_path: key,
          pdf_storage_path: rendition.pdfStoragePath,
          file_type: resolved.suffix,
        },
        userId: args.userId,
        projectId: args.projectId,
        label: "index-legal-source",
      });
    }

    void recordAudit(db, {
      userId: args.userId,
      userEmail: args.userEmail,
      action: "document.legal_source_saved",
      title: resolved.filename,
      surface: "assistant",
      projectId: args.projectId,
      documentId,
      detail: {
        source_kind: args.sourceKind,
        source_ref: args.sourceRef,
        source_url: resolved.sourceUrl,
      },
    });

    return documentId;
  } catch (err) {
    await db.from("documents").delete().eq("id", documentId);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function safeFileBase(title: string): string {
  return (
    title
      .replace(/[^a-zA-Z0-9 .,-]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "legal source"
  );
}
