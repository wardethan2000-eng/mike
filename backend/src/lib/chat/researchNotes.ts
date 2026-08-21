// The running notes document.
//
// Long research is exactly the work that gets lost: the turn pauses, the
// session ends, the model's own summary quietly drops the fourth case it
// checked. So while it works, the assistant writes each finding into a real
// document in the matter — one per chat, named for the topic. The user can
// open it while the work is still running, it survives a pause, and a later
// chat can read it like any other document.
//
// It is stored exactly the way a typed "Text" note is stored: a plain .txt
// document with a PDF rendition, so it opens in the viewer, downloads, and
// turns up in a search of the matter. Appending writes a new version, so the
// history of the research is kept rather than overwritten.

import { createServerSupabase } from "../supabase";
import { downloadFile, uploadFile, storageKey, versionStorageKey } from "../storage";
import { contentTypeForDocumentType } from "../documentTypes";
import { prepareRendition } from "../documentRendition";
import { indexInBackground } from "../passageIndex";
import { contentSha256 } from "../documentVersions";
import { buildDownloadUrl } from "../downloadTokens";
import { randomUUID } from "node:crypto";

type Db = ReturnType<typeof createServerSupabase>;

/** Marks the one document a chat's research notes live in. */
export const RESEARCH_NOTES_SOURCE_KIND = "research_notes";

/**
 * The second line of every notes document. It is written by this module and
 * never by a person, so it is how the rest of the app recognises a file as the
 * assistant's own scratchpad rather than a document under review.
 */
export const RESEARCH_NOTES_HEADER_LINE =
  "Written by the assistant as the work was done.";

/** Guard against a runaway loop filling storage with one enormous note. */
const MAX_NOTES_CHARS = 400_000;
const MAX_ENTRY_CHARS = 20_000;

export type ResearchNotesResult =
  | {
      status: "created" | "appended";
      documentId: string;
      filename: string;
      versionId: string;
      versionNumber: number;
      downloadUrl: string;
      truncated: boolean;
    }
  | { error: string };

/** "Research Notes — Graver lease dispute.txt", with the awkward bits removed. */
export function researchNotesFilename(topic: string | null | undefined): string {
  const cleaned = (topic ?? "")
    .replace(/[\\/:*?"<>|\n\r\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned
    ? `Research Notes — ${cleaned}.txt`
    : "Research Notes.txt";
}

function entryHeading(now: Date): string {
  return now.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/**
 * The text of the notes after this entry is added. Kept as a separate
 * function so the joining rules are testable without a database.
 */
export function composeNotes(args: {
  existing: string;
  entry: string;
  topic?: string | null;
  now?: Date;
}): { text: string; truncated: boolean } {
  const now = args.now ?? new Date();
  const entry = args.entry.trim().slice(0, MAX_ENTRY_CHARS);
  const header = `[${entryHeading(now)}]`;
  const existing = args.existing.trim();
  const opening = existing
    ? ""
    : `Research Notes${args.topic?.trim() ? ` — ${args.topic.trim()}` : ""}\n${RESEARCH_NOTES_HEADER_LINE}\n`;
  const parts = [existing || opening.trim(), `${header}\n${entry}`].filter(
    (part) => part.length > 0,
  );
  let text = parts.join("\n\n---\n\n");
  let truncated = false;
  if (text.length > MAX_NOTES_CHARS) {
    // Keep the newest work: the earliest entries are the ones already
    // summarised into everything that followed them.
    truncated = true;
    text =
      "[Earlier entries were dropped to keep this document a workable size.]\n\n---\n\n" +
      text.slice(text.length - MAX_NOTES_CHARS);
  }
  return { text, truncated };
}

async function findNotesDocument(
  db: Db,
  projectId: string,
  chatId: string,
): Promise<{ id: string; filename: string } | null> {
  const { data } = await db
    .from("documents")
    .select("id, current_version_id")
    .eq("project_id", projectId)
    .eq("source_kind", RESEARCH_NOTES_SOURCE_KIND)
    .eq("source_ref", chatId)
    .maybeSingle();
  if (!data) return null;
  const { data: version } = await db
    .from("document_versions")
    .select("filename")
    .eq("id", data.current_version_id as string)
    .maybeSingle();
  return {
    id: data.id as string,
    filename: (version?.filename as string | null) ?? "Research Notes.txt",
  };
}

async function readCurrentNotes(db: Db, documentId: string): Promise<string> {
  const { data } = await db
    .from("documents")
    .select("current_version_id")
    .eq("id", documentId)
    .maybeSingle();
  const versionId = data?.current_version_id as string | null | undefined;
  if (!versionId) return "";
  const { data: version } = await db
    .from("document_versions")
    .select("storage_path")
    .eq("id", versionId)
    .maybeSingle();
  const path = version?.storage_path as string | null | undefined;
  if (!path) return "";
  const raw = await downloadFile(path);
  return raw ? Buffer.from(raw).toString("utf8") : "";
}

/**
 * Write one entry into this chat's notes document, creating it on the first
 * call. Returns what happened so the assistant can tell the user where the
 * notes are.
 */
export async function appendResearchNotes(args: {
  db: Db;
  userId: string;
  projectId: string;
  chatId: string;
  entry: string;
  topic?: string | null;
}): Promise<ResearchNotesResult> {
  const { db, userId, projectId, chatId } = args;
  if (!args.entry?.trim()) {
    return { error: "Nothing to write — pass the finding as `append`." };
  }
  try {
    const existingDoc = await findNotesDocument(db, projectId, chatId);
    const existingText = existingDoc
      ? await readCurrentNotes(db, existingDoc.id)
      : "";
    const { text, truncated } = composeNotes({
      existing: existingText,
      entry: args.entry,
      topic: args.topic,
    });
    const content = Buffer.from(text, "utf8");
    const filename = existingDoc
      ? existingDoc.filename
      : researchNotesFilename(args.topic);

    if (!existingDoc) {
      return await createNotesDocument({
        db,
        userId,
        projectId,
        chatId,
        filename,
        content,
        truncated,
      });
    }
    return await appendNotesVersion({
      db,
      userId,
      projectId,
      documentId: existingDoc.id,
      filename,
      content,
      truncated,
    });
  } catch (err) {
    console.error("[research-notes] write failed", err);
    return {
      error:
        err instanceof Error
          ? `Could not write the notes: ${err.message}`
          : "Could not write the notes.",
    };
  }
}

async function createNotesDocument(args: {
  db: Db;
  userId: string;
  projectId: string;
  chatId: string;
  filename: string;
  content: Buffer;
  truncated: boolean;
}): Promise<ResearchNotesResult> {
  const { db, userId, projectId, chatId, filename, content } = args;
  const { data: doc, error: insertErr } = await db
    .from("documents")
    .insert({
      project_id: projectId,
      user_id: userId,
      status: "processing",
      source_kind: RESEARCH_NOTES_SOURCE_KIND,
      source_ref: chatId,
    })
    .select("id")
    .single();
  if (insertErr || !doc) {
    return {
      error: `Could not start the notes document: ${insertErr?.message ?? "unknown"}`,
    };
  }
  const documentId = doc.id as string;
  try {
    const key = storageKey(userId, documentId, filename);
    await uploadFile(key, toArrayBuffer(content), contentTypeForDocumentType("txt"));
    const target = {
      content,
      suffix: "txt",
      userId,
      docId: documentId,
      storagePath: key,
      pageCount: null,
      label: "research-notes",
    };
    const rendition = await prepareRendition(target);
    const { data: versionRow, error: verErr } = await db
      .from("document_versions")
      .insert({
        document_id: documentId,
        storage_path: key,
        pdf_storage_path: rendition.pdfStoragePath,
        source: "generated",
        version_number: 1,
        filename,
        file_type: "txt",
        size_bytes: content.byteLength,
        page_count: rendition.pageCount,
        content_sha256: contentSha256(content),
      })
      .select("id")
      .single();
    if (verErr || !versionRow) {
      throw new Error(verErr?.message ?? "could not record the first version");
    }
    const versionId = versionRow.id as string;
    await db
      .from("documents")
      .update({
        current_version_id: versionId,
        status: "ready",
        updated_at: new Date().toISOString(),
      })
      .eq("id", documentId);
    indexInBackground(db, {
      version: {
        id: versionId,
        document_id: documentId,
        storage_path: key,
        pdf_storage_path: rendition.pdfStoragePath,
        file_type: "txt",
      },
      userId,
      projectId,
      label: "index-research-notes",
    });
    return {
      status: "created",
      documentId,
      filename,
      versionId,
      versionNumber: 1,
      downloadUrl: safeDownloadUrl(key, filename),
      truncated: args.truncated,
    };
  } catch (err) {
    await db.from("documents").delete().eq("id", documentId);
    throw err;
  }
}

async function appendNotesVersion(args: {
  db: Db;
  userId: string;
  projectId: string;
  documentId: string;
  filename: string;
  content: Buffer;
  truncated: boolean;
}): Promise<ResearchNotesResult> {
  const { db, userId, projectId, documentId, filename, content } = args;
  const versionSlug = randomUUID().replace(/-/g, "");
  const key = versionStorageKey(userId, documentId, versionSlug, filename);
  await uploadFile(key, toArrayBuffer(content), contentTypeForDocumentType("txt"));
  const rendition = await prepareRendition({
    content,
    suffix: "txt",
    userId,
    docId: documentId,
    storagePath: key,
    pdfKey: `converted-pdfs/${userId}/${documentId}/${versionSlug}.pdf`,
    pageCount: null,
    label: "research-notes",
  });
  const { data: maxRow } = await db
    .from("document_versions")
    .select("version_number")
    .eq("document_id", documentId)
    .order("version_number", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  const nextVersionNumber = ((maxRow?.version_number as number | null) ?? 1) + 1;
  const { data: versionRow, error: verErr } = await db
    .from("document_versions")
    .insert({
      document_id: documentId,
      storage_path: key,
      pdf_storage_path: rendition.pdfStoragePath,
      source: "generated",
      version_number: nextVersionNumber,
      filename,
      file_type: "txt",
      size_bytes: content.byteLength,
      page_count: rendition.pageCount,
      content_sha256: contentSha256(content),
    })
    .select("id")
    .single();
  if (verErr || !versionRow) {
    throw new Error(verErr?.message ?? "could not record the new version");
  }
  const versionId = versionRow.id as string;
  await db
    .from("documents")
    .update({
      current_version_id: versionId,
      status: "ready",
      updated_at: new Date().toISOString(),
    })
    .eq("id", documentId);
  // Matter search reads the current version only, so the newest notes have to
  // be indexed or the document drops out of search as soon as it grows.
  indexInBackground(db, {
    version: {
      id: versionId,
      document_id: documentId,
      storage_path: key,
      pdf_storage_path: rendition.pdfStoragePath,
      file_type: "txt",
    },
    userId,
    projectId,
    label: "index-research-notes",
  });
  return {
    status: "appended",
    documentId,
    filename,
    versionId,
    versionNumber: nextVersionNumber,
    downloadUrl: safeDownloadUrl(key, filename),
    truncated: args.truncated,
  };
}

// A download link is a convenience on the activity card, never the point of
// the call. If signing is misconfigured the notes must still be written.
function safeDownloadUrl(key: string, filename: string): string {
  try {
    return buildDownloadUrl(key, filename);
  } catch (err) {
    console.error("[research-notes] could not sign a download link", err);
    return "";
  }
}

function toArrayBuffer(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(
    buf.byteOffset,
    buf.byteOffset + buf.byteLength,
  ) as ArrayBuffer;
}

/**
 * What this turn wrote to its notes, so the answer and any wrap-up can point
 * at the document rather than repeating its contents.
 */
export type ResearchNotesTurnState = {
  document: { documentId: string; filename: string } | null;
  entries: number;
};

export function newResearchNotesTurnState(): ResearchNotesTurnState {
  return { document: null, entries: 0 };
}

/**
 * The name of this chat's notes document, if it has one. Used when a paused
 * turn is condensed, so the model that picks the work up knows the full record
 * is still in the matter and does not rely on the shortened summary.
 */
export async function researchNotesFilenameForChat(args: {
  db: Db;
  projectId: string | null | undefined;
  chatId: string | null | undefined;
}): Promise<string | null> {
  if (!args.projectId || !args.chatId) return null;
  try {
    const doc = await findNotesDocument(args.db, args.projectId, args.chatId);
    return doc?.filename ?? null;
  } catch (err) {
    console.error("[research-notes] lookup failed", err);
    return null;
  }
}
