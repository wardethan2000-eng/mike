/**
 * The firm's own library, alongside everybody's personal one.
 *
 * Until now every template, letterhead and form was a copy sitting in one
 * person's library, so a firm of five kept five slightly different versions of
 * the same letter. The library now has two halves: your own, which behaves
 * exactly as it always has, and the firm's, which everyone still working there
 * can read and only administrators (plus anyone given the job) can change.
 *
 * A row with no firm on it is personal. A row with a firm on it is the firm's.
 * That one rule decides both what a query returns and who may write.
 */

import type { createServerSupabase } from "./supabase";
import { downloadFile, uploadFile } from "./storage";
import { contentTypeForDocumentType } from "./documentTypes";
import { getMembership, isActiveMember, type FirmMembership } from "./firm";

type Db = ReturnType<typeof createServerSupabase>;

export type LibraryScope = "personal" | "firm";

export function parseLibraryScope(value: unknown): LibraryScope {
    return value === "firm" ? "firm" : "personal";
}

export type ResolvedLibraryScope = {
    scope: LibraryScope;
    /** The firm whose shelves are being read, or null for a personal one. */
    firmId: string | null;
    /** Whether this person may add to, rename or remove things in this scope. */
    canWrite: boolean;
};

/** Administrators run the firm's library; so does anyone they hand the job to. */
export function canEditFirmLibrary(membership: FirmMembership | null): boolean {
    if (!isActiveMember(membership)) return false;
    return membership.role === "admin" || membership.canEditFirmLibrary;
}

/**
 * Work out which half of the library a request is about. Asking for the firm's
 * half without being an active member of the firm returns null, which callers
 * turn into a 403 — the firm's shelves are not visible from outside it.
 */
export async function resolveLibraryScope(
    db: Db,
    userId: string,
    requested: unknown,
): Promise<ResolvedLibraryScope | null> {
    const scope = parseLibraryScope(requested);
    if (scope === "personal") {
        return { scope, firmId: null, canWrite: true };
    }
    const membership = await getMembership(db, userId);
    if (!isActiveMember(membership)) return null;
    return {
        scope,
        firmId: membership.firmId,
        canWrite: canEditFirmLibrary(membership),
    };
}

/**
 * Narrow a documents or library_folders query to one half of the library.
 * Personal rows are the ones with nobody's firm on them, which is every row
 * that existed before the firm library did — so personal queries return
 * exactly what they always returned.
 */
export function applyLibraryScope<Q>(
    query: Q,
    scope: ResolvedLibraryScope,
    userId: string,
): Q {
    const filterable = query as unknown as {
        eq: (column: string, value: string) => typeof filterable;
        is: (column: string, value: null) => typeof filterable;
    };
    if (scope.scope === "firm" && scope.firmId) {
        return filterable.eq("firm_id", scope.firmId) as unknown as Q;
    }
    return filterable
        .eq("user_id", userId)
        .is("firm_id", null) as unknown as Q;
}

export type PublishTarget = {
    /** The document being copied onto the firm's shelves. */
    documentId: string;
    firmId: string;
    /** Who pressed the button; recorded as the author of the firm's copy. */
    userId: string;
    /** Which half of the library the copy lands in. */
    libraryKind: "file" | "template";
    libraryFolderId?: string | null;
    /** Overrides the copied file's name; blank keeps the original's. */
    filename?: string | null;
};

export type PublishResult =
    | { ok: true; documentId: string; filename: string }
    | { ok: false; status: number; detail: string };

/**
 * Put a copy of a document on the firm's shelves.
 *
 * It is deliberately a copy, not a move: the matter keeps its own file and the
 * person keeps theirs, and neither changes when the firm's copy is edited
 * later. The bytes are copied too rather than shared, so deleting the original
 * can never empty the firm's shelf.
 */
export async function publishDocumentToFirm(
    db: Db,
    target: PublishTarget,
): Promise<PublishResult> {
    const { data: source } = await db
        .from("documents")
        .select("id, current_version_id, status")
        .eq("id", target.documentId)
        .maybeSingle();
    if (!source) {
        return { ok: false, status: 404, detail: "Document not found" };
    }
    const versionId = (source as { current_version_id: string | null })
        .current_version_id;
    if (!versionId) {
        return {
            ok: false,
            status: 409,
            detail: "That document has nothing in it yet.",
        };
    }

    const { data: version } = await db
        .from("document_versions")
        .select(
            "storage_path, pdf_storage_path, filename, file_type, size_bytes, page_count, content_sha256",
        )
        .eq("id", versionId)
        .maybeSingle();
    if (!version) {
        return {
            ok: false,
            status: 409,
            detail: "That document has nothing in it yet.",
        };
    }
    const src = version as {
        storage_path: string | null;
        pdf_storage_path: string | null;
        filename: string | null;
        file_type: string | null;
        size_bytes: number | null;
        page_count: number | null;
        content_sha256: string | null;
    };
    if (!src.storage_path) {
        return {
            ok: false,
            status: 409,
            detail: "That document has nothing in it yet.",
        };
    }

    const filename =
        target.filename?.trim() ||
        src.filename?.trim() ||
        "Untitled document";
    const fileType = (src.file_type ?? "").toLowerCase();

    const bytes = await downloadFile(src.storage_path);
    if (!bytes) {
        return {
            ok: false,
            status: 502,
            detail: "Could not read that document's contents.",
        };
    }
    const pdfBytes = src.pdf_storage_path
        ? await downloadFile(src.pdf_storage_path)
        : null;

    const { data: copy, error: copyError } = await db
        .from("documents")
        .insert({
            project_id: null,
            user_id: target.userId,
            firm_id: target.firmId,
            status: "processing",
            library_kind: target.libraryKind,
            library_folder_id: target.libraryFolderId ?? null,
        })
        .select("id")
        .single();
    if (copyError || !copy) {
        return {
            ok: false,
            status: 500,
            detail: "Could not add that to the firm library.",
        };
    }
    const copyId = (copy as { id: string }).id;

    try {
        const base = `firm-library/${target.firmId}/${copyId}`;
        const extension = filename.match(/\.[^./\\]+$/)?.[0] ?? "";
        const key = `${base}/source${extension}`;
        await uploadFile(key, bytes, contentTypeForDocumentType(fileType));
        let pdfKey: string | null = null;
        if (pdfBytes) {
            pdfKey = `${base}/preview.pdf`;
            await uploadFile(pdfKey, pdfBytes, "application/pdf");
        }

        const { data: newVersion, error: versionError } = await db
            .from("document_versions")
            .insert({
                document_id: copyId,
                storage_path: key,
                pdf_storage_path: pdfKey,
                source: "upload",
                version_number: 1,
                filename,
                file_type: fileType,
                size_bytes: src.size_bytes ?? bytes.byteLength,
                page_count: src.page_count,
                content_sha256: src.content_sha256,
            })
            .select("id")
            .single();
        if (versionError || !newVersion) {
            throw new Error(versionError?.message ?? "no version row");
        }

        await db
            .from("documents")
            .update({
                current_version_id: (newVersion as { id: string }).id,
                status: "ready",
                updated_at: new Date().toISOString(),
            })
            .eq("id", copyId);

        return { ok: true, documentId: copyId, filename };
    } catch {
        // Leaving a half-made row behind would show as a broken shelf entry.
        await db.from("documents").delete().eq("id", copyId);
        return {
            ok: false,
            status: 500,
            detail: "Could not add that to the firm library.",
        };
    }
}
