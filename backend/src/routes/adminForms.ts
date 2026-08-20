/**
 * The firm's form bank — /admin/forms.
 *
 * These are the notes about documents already sitting on the firm's library
 * shelves: what each one is, which situation it covers, what may be reworked
 * and what must be left alone. Mike reads them so it can start a draft from
 * the firm's own paperwork without anybody having to go and find the file.
 *
 * Who may change them is the same question as who may change the firm library
 * itself: an administrator, or anyone given the job. Nothing here creates,
 * changes or deletes a document — taking an entry off the list leaves the
 * document exactly where it was.
 */

import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { recordAudit } from "../lib/audit";
import { getMembership, isActiveMember } from "../lib/firm";
import { canEditFirmLibrary } from "../lib/firmLibrary";
import { recommendFormNotes } from "../lib/formBankAnalyze";
import {
    FORM_COLUMNS,
    isFormStatus,
    isFormUsageMode,
    normalizeDocumentType,
    normalizeJurisdictions,
    normalizeRequiredFields,
    rowToForm,
    type FirmForm,
} from "../lib/formBank";
import { safeErrorLog } from "../lib/safeError";

export const adminFormsRouter = Router();

const NOT_ALLOWED = {
    detail: "Only an administrator, or someone given the firm library to look after, can change the form bank.",
};

type Db = ReturnType<typeof createServerSupabase>;

/** The caller's firm, if they are allowed to run the bank. */
async function editorFirmId(
    db: Db,
    userId: string | undefined,
): Promise<string | null> {
    if (!userId) return null;
    const membership = await getMembership(db, userId);
    if (!isActiveMember(membership)) return null;
    return canEditFirmLibrary(membership) ? membership.firmId : null;
}

adminFormsRouter.use(requireAuth, async (_req, res, next) => {
    const db = createServerSupabase();
    const firmId = await editorFirmId(db, res.locals.userId as string);
    if (!firmId) return void res.status(403).json(NOT_ALLOWED);
    res.locals.formBankFirmId = firmId;
    next();
});

function firmId(res: { locals: Record<string, unknown> }): string {
    return res.locals.formBankFirmId as string;
}

function trimmedOrNull(value: unknown, max = 4000): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim().slice(0, max);
    return trimmed === "" ? null : trimmed;
}

/**
 * A banked entry has to point at one of the firm's own templates. Somebody
 * else's personal file, or a document inside a matter, is not something the
 * whole firm can draft from.
 */
async function firmTemplate(
    db: Db,
    documentIdValue: string,
    firm: string,
): Promise<{ id: string; filename: string } | null> {
    const { data } = await db
        .from("documents")
        .select("id, firm_id, project_id, library_kind, current_version_id")
        .eq("id", documentIdValue)
        .maybeSingle();
    const doc = data as {
        id: string;
        firm_id: string | null;
        project_id: string | null;
        library_kind: string | null;
        current_version_id: string | null;
    } | null;
    if (
        !doc ||
        doc.firm_id !== firm ||
        doc.project_id !== null ||
        doc.library_kind !== "template"
    ) {
        return null;
    }
    let filename = "Untitled document";
    if (doc.current_version_id) {
        const { data: version } = await db
            .from("document_versions")
            .select("filename")
            .eq("id", doc.current_version_id)
            .maybeSingle();
        const name = (version as { filename?: string | null } | null)?.filename;
        if (name?.trim()) filename = name.trim();
    }
    return { id: doc.id, filename };
}

/** Put each entry's document filename alongside it, for the screen. */
async function withFilenames(
    db: Db,
    forms: FirmForm[],
): Promise<(FirmForm & { filename: string | null })[]> {
    if (!forms.length) return [];
    const { data } = await db
        .from("documents")
        .select("id, current_version_id")
        .in(
            "id",
            forms.map((form) => form.document_id),
        );
    const versionByDocument = new Map<string, string>();
    const documentRows = (Array.isArray(data) ? data : []) as {
        id: string;
        current_version_id: string | null;
    }[];
    for (const row of documentRows) {
        if (row.current_version_id) {
            versionByDocument.set(row.id, row.current_version_id);
        }
    }
    const versionIds = Array.from(versionByDocument.values());
    const names = new Map<string, string>();
    if (versionIds.length) {
        const { data: versions } = await db
            .from("document_versions")
            .select("id, filename")
            .in("id", versionIds);
        const versionRows = (Array.isArray(versions) ? versions : []) as {
            id: string;
            filename: string | null;
        }[];
        for (const row of versionRows) {
            if (row.filename) names.set(row.id, row.filename);
        }
    }
    return forms.map((form) => {
        const versionId = versionByDocument.get(form.document_id);
        return {
            ...form,
            filename: versionId ? (names.get(versionId) ?? null) : null,
        };
    });
}

// ---------------------------------------------------------------------------
// Reading and changing the bank
// ---------------------------------------------------------------------------

adminFormsRouter.get("/", async (_req, res) => {
    const db = createServerSupabase();
    const { data, error } = await db
        .from("firm_forms")
        .select(FORM_COLUMNS)
        .eq("firm_id", firmId(res))
        .order("document_type", { ascending: true })
        .order("title", { ascending: true });
    if (error) {
        return void res
            .status(500)
            .json({ detail: "Could not load the firm's form bank." });
    }
    const forms = (Array.isArray(data) ? data : []).map((row) =>
        rowToForm(row as Record<string, unknown>),
    );
    res.json({ forms: await withFilenames(db, forms) });
});

/** The fields a person may set, from either a create or a change. */
function readNotes(
    body: Record<string, unknown>,
    updates: Record<string, unknown>,
): string | null {
    if ("title" in body) {
        const title = trimmedOrNull(body.title, 200);
        if (!title) return "The entry needs a name.";
        updates.title = title;
    }
    if ("document_type" in body) {
        const slug = normalizeDocumentType(body.document_type);
        if (!slug) {
            return "Say what kind of document this is, so its versions sit together.";
        }
        updates.document_type = slug;
    }
    if ("usage_mode" in body) {
        if (!isFormUsageMode(body.usage_mode)) {
            return "An entry is either a precedent or a fill-in form.";
        }
        updates.usage_mode = body.usage_mode;
    }
    if ("status" in body) {
        if (!isFormStatus(body.status)) {
            return "An entry is either a draft or approved.";
        }
        updates.status = body.status;
    }
    if ("jurisdictions" in body) {
        updates.jurisdictions = normalizeJurisdictions(body.jurisdictions);
    }
    if ("required_fields" in body) {
        updates.required_fields = normalizeRequiredFields(body.required_fields);
    }
    for (const field of [
        "variant_notes",
        "practice",
        "description",
        "drafting_guidance",
    ] as const) {
        if (field in body) updates[field] = trimmedOrNull(body[field]);
    }
    return null;
}

adminFormsRouter.post("/", async (req, res) => {
    const db = createServerSupabase();
    const firm = firmId(res);
    const documentId = trimmedOrNull(req.body?.document_id, 100);
    if (!documentId) {
        return void res
            .status(400)
            .json({ detail: "Say which document this is about." });
    }
    const template = await firmTemplate(db, documentId, firm);
    if (!template) {
        return void res.status(400).json({
            detail: "Only a template on the firm's library shelves can go in the form bank.",
        });
    }

    const updates: Record<string, unknown> = {};
    const problem = readNotes(req.body ?? {}, updates);
    if (problem) return void res.status(400).json({ detail: problem });
    if (!updates.title) updates.title = template.filename;
    if (!updates.document_type) {
        return void res.status(400).json({
            detail: "Say what kind of document this is, so its versions sit together.",
        });
    }

    const { data, error } = await db
        .from("firm_forms")
        .insert({
            firm_id: firm,
            document_id: documentId,
            created_by: res.locals.userId as string,
            ...updates,
        })
        .select(FORM_COLUMNS)
        .single();
    if (error || !data) {
        // The one thing that can realistically collide is banking the same
        // document twice.
        const already = (error?.message ?? "").includes("duplicate");
        return void res.status(already ? 409 : 500).json({
            detail: already
                ? "That document is already in the form bank."
                : "That entry could not be saved.",
        });
    }

    const form = rowToForm(data as Record<string, unknown>);
    await recordAudit(db, {
        userId: res.locals.userId as string,
        userEmail: res.locals.userEmail as string,
        action: "admin_form_create",
        title: form.title,
        surface: "admin",
        documentId: form.document_id,
        detail: { form_id: form.id, document_type: form.document_type },
    });
    res.status(201).json((await withFilenames(db, [form]))[0]);
});

adminFormsRouter.patch("/:id", async (req, res) => {
    const db = createServerSupabase();
    const updates: Record<string, unknown> = {};
    const problem = readNotes(req.body ?? {}, updates);
    if (problem) return void res.status(400).json({ detail: problem });
    if (!Object.keys(updates).length) {
        return void res.status(400).json({ detail: "Nothing to change." });
    }
    updates.updated_at = new Date().toISOString();

    const { data, error } = await db
        .from("firm_forms")
        .update(updates)
        .eq("id", req.params.id)
        .eq("firm_id", firmId(res))
        .select(FORM_COLUMNS)
        .maybeSingle();
    if (error) {
        return void res
            .status(500)
            .json({ detail: "That entry could not be saved." });
    }
    if (!data) {
        return void res
            .status(404)
            .json({ detail: "That entry is not in the form bank." });
    }

    const form = rowToForm(data as Record<string, unknown>);
    await recordAudit(db, {
        userId: res.locals.userId as string,
        userEmail: res.locals.userEmail as string,
        action: "admin_form_update",
        title: form.title,
        surface: "admin",
        documentId: form.document_id,
        detail: { form_id: form.id, changed: Object.keys(updates) },
    });
    res.json((await withFilenames(db, [form]))[0]);
});

adminFormsRouter.delete("/:id", async (req, res) => {
    const db = createServerSupabase();
    const { data, error } = await db
        .from("firm_forms")
        .delete()
        .eq("id", req.params.id)
        .eq("firm_id", firmId(res))
        .select("id, title, document_id")
        .maybeSingle();
    if (error) {
        return void res
            .status(500)
            .json({ detail: "That entry could not be taken off the list." });
    }
    if (!data) {
        return void res
            .status(404)
            .json({ detail: "That entry is not in the form bank." });
    }
    const row = data as { id: string; title: string; document_id: string };
    await recordAudit(db, {
        userId: res.locals.userId as string,
        userEmail: res.locals.userEmail as string,
        action: "admin_form_delete",
        title: row.title,
        surface: "admin",
        documentId: row.document_id,
        detail: { form_id: row.id },
    });
    res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Reading a document and suggesting its notes
// ---------------------------------------------------------------------------

/**
 * Reads the document and suggests what its notes should say. Nothing is saved:
 * the suggestion goes back to the person to correct, and they save it if they
 * agree. Where the firm already banks documents of the same kind, their notes
 * go in with the request so the new one is written as a contrast with them.
 */
adminFormsRouter.post("/analyze", async (req, res) => {
    const db = createServerSupabase();
    const firm = firmId(res);
    const documentId = trimmedOrNull(req.body?.document_id, 100);
    if (!documentId) {
        return void res
            .status(400)
            .json({ detail: "Say which document to read." });
    }
    const template = await firmTemplate(db, documentId, firm);
    if (!template) {
        return void res.status(400).json({
            detail: "Only a template on the firm's library shelves can go in the form bank.",
        });
    }

    try {
        const proposal = await recommendFormNotes({
            db,
            userId: res.locals.userId as string,
            firmId: firm,
            documentId,
            filename: template.filename,
        });
        if (!proposal) {
            return void res.status(502).json({
                detail: "Mike could not read that document well enough to suggest anything. Fill the notes in by hand.",
            });
        }
        res.json(proposal);
    } catch (error) {
        console.error("[admin/forms/analyze] failed", safeErrorLog(error));
        res.status(502).json({
            detail: "Mike could not read that document just now. Try again, or fill the notes in by hand.",
        });
    }
});
