// Case memory: the short facts a matter picks up as work goes on.
//
// Anyone working on the matter can add and edit them, because the case memory
// is shared work product rather than one person's notes. Removing a fact for
// good is left to the person who wrote it and to the matter's owner.
//
// Facts are superseded rather than overwritten: replacing one writes a new
// fact and marks the old one as replaced by it, so the history of a moving
// deadline stays readable.
import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { checkProjectAccess } from "../lib/access";
import { safeErrorLog } from "../lib/safeError";
import { fingerprintMemory } from "../lib/memoryEmbedding";
import {
    MEMORY_CATEGORIES,
    MEMORY_BODY_MAX_CHARS,
    type MemoryCategory,
} from "../lib/projectOverview";

/** A stored fact, as the untyped database client hands it back. */
type MemoryRow = {
    id: string;
    user_id: string;
    category: MemoryCategory;
    body: string;
    pinned: boolean;
    source_document_id: string | null;
    source_page: number | null;
    source_chat_id: string | null;
    superseded_by: string | null;
    /** accepted = in force; proposed = Mike suggested it; dismissed = turned down. */
    status: "accepted" | "proposed" | "dismissed";
    origin: "manual" | "assistant";
};

export const projectMemoriesRouter = Router({ mergeParams: true });

/** Everything the client is shown about a fact. */
const SELECT_COLUMNS =
    "id, project_id, user_id, category, body, pinned, status, origin, " +
    "source_document_id, source_page, source_chat_id, superseded_by, " +
    "superseded_at, created_at, updated_at";

function normalizeCategory(value: unknown): MemoryCategory {
    return typeof value === "string" &&
        (MEMORY_CATEGORIES as readonly string[]).includes(value)
        ? (value as MemoryCategory)
        : "parties";
}

/** A fact is one or two lines. Anything longer belongs in a document. */
function normalizeBody(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim().replace(/\s+\n/g, "\n");
    if (!trimmed) return null;
    return trimmed.slice(0, MEMORY_BODY_MAX_CHARS);
}

function normalizeUuid(value: unknown): string | null {
    return typeof value === "string" &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            value,
        )
        ? value
        : null;
}

function normalizePage(value: unknown): number | null {
    const page = typeof value === "number" ? value : Number(value);
    if (!Number.isFinite(page) || page < 1) return null;
    return Math.floor(page);
}

/**
 * Everyone who can work in the matter can read and add facts. Returns the
 * access result, or sends the 404 and returns null.
 */
async function requireProjectAccess(
    req: Parameters<Parameters<typeof projectMemoriesRouter.get>[1]>[0],
    res: Parameters<Parameters<typeof projectMemoriesRouter.get>[1]>[1],
) {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const { projectId } = req.params as { projectId: string };
    const db = createServerSupabase();
    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    if (!access.ok) {
        res.status(404).json({ detail: "Project not found" });
        return null;
    }
    return { db, access, userId, projectId };
}

// GET /projects/:projectId/memories
// The facts in force. ?status=proposed returns the ones Mike has suggested and
// nobody has looked at yet; ?include=replaced also returns the wordings that
// newer facts have replaced.
projectMemoriesRouter.get("/", requireAuth, async (req, res) => {
    const context = await requireProjectAccess(req, res);
    if (!context) return;
    const { db, projectId } = context;

    const status = req.query.status === "proposed" ? "proposed" : "accepted";
    let query = db
        .from("project_memories")
        .select(SELECT_COLUMNS)
        .eq("project_id", projectId)
        .eq("status", status);
    if (req.query.include !== "replaced") {
        query = query.is("superseded_by", null);
    }
    const { data, error } = await query
        .order("pinned", { ascending: false })
        .order("created_at", { ascending: true });
    if (error) {
        console.error("[project-memories] list project memories", safeErrorLog(error));
        return void res.status(500).json({ detail: "Could not load the case memory." });
    }
    res.json(data ?? []);
});

// POST /projects/:projectId/memories
projectMemoriesRouter.post("/", requireAuth, async (req, res) => {
    const context = await requireProjectAccess(req, res);
    if (!context) return;
    const { db, projectId, userId } = context;

    const body = normalizeBody(req.body?.body);
    if (!body) return void res.status(400).json({ detail: "Write the fact first." });

    const { data, error } = await db
        .from("project_memories")
        .insert({
            project_id: projectId,
            user_id: userId,
            category: normalizeCategory(req.body?.category),
            body,
            pinned: req.body?.pinned === true,
            source_document_id: normalizeUuid(req.body?.source_document_id),
            source_page: normalizePage(req.body?.source_page),
            source_chat_id: normalizeUuid(req.body?.source_chat_id),
        })
        .select(SELECT_COLUMNS)
        .single();
    if (error || !data) {
        console.error("[project-memories] create project memory", safeErrorLog(error));
        return void res.status(500).json({ detail: "Could not save the fact." });
    }
    // Written behind the answer: a fact is saved whether or not the model that
    // works out what it is about happens to be up.
    void fingerprintMemory(db, (data as unknown as MemoryRow).id, body);
    res.status(201).json(data);
});

// PATCH /projects/:projectId/memories/:memoryId
// Small corrections — a typo, the wrong grouping, pinning. Use supersede when
// the fact itself has changed.
projectMemoriesRouter.patch("/:memoryId", requireAuth, async (req, res) => {
    const context = await requireProjectAccess(req, res);
    if (!context) return;
    const { db, projectId } = context;
    const { memoryId } = req.params;

    const updates: Record<string, unknown> = {};
    if ("body" in req.body) {
        const body = normalizeBody(req.body.body);
        if (!body) return void res.status(400).json({ detail: "Write the fact first." });
        updates.body = body;
    }
    if ("category" in req.body) {
        updates.category = normalizeCategory(req.body.category);
    }
    if ("pinned" in req.body) updates.pinned = req.body.pinned === true;
    if ("source_document_id" in req.body) {
        updates.source_document_id = normalizeUuid(req.body.source_document_id);
    }
    if ("source_page" in req.body) {
        updates.source_page = normalizePage(req.body.source_page);
    }
    if (Object.keys(updates).length === 0) {
        return void res.status(400).json({ detail: "Nothing to change." });
    }
    updates.updated_at = new Date().toISOString();

    const { data, error } = await db
        .from("project_memories")
        .update(updates)
        .eq("id", memoryId)
        .eq("project_id", projectId)
        .select(SELECT_COLUMNS)
        .single();
    if (error || !data) {
        console.error("[project-memories] update project memory", safeErrorLog(error));
        return void res.status(404).json({ detail: "That fact is no longer there." });
    }
    if (typeof updates.body === "string") {
        void fingerprintMemory(db, memoryId, updates.body);
    }
    res.json(data);
});

// POST /projects/:projectId/memories/:memoryId/supersede
// The fact has changed: write the new one and mark the old as replaced by it.
projectMemoriesRouter.post("/:memoryId/supersede", requireAuth, async (req, res) => {
    const context = await requireProjectAccess(req, res);
    if (!context) return;
    const { db, projectId, userId } = context;
    const { memoryId } = req.params;

    const body = normalizeBody(req.body?.body);
    if (!body) return void res.status(400).json({ detail: "Write the new wording first." });

    const { data: previousRow } = await db
        .from("project_memories")
        .select(SELECT_COLUMNS)
        .eq("id", memoryId)
        .eq("project_id", projectId)
        .maybeSingle();
    const previous = previousRow as unknown as MemoryRow | null;
    if (!previous) {
        return void res.status(404).json({ detail: "That fact is no longer there." });
    }
    if (previous.superseded_by) {
        return void res
            .status(409)
            .json({ detail: "That fact has already been replaced." });
    }

    const { data: replacementRow, error } = await db
        .from("project_memories")
        .insert({
            project_id: projectId,
            user_id: userId,
            category: normalizeCategory(req.body?.category ?? previous.category),
            body,
            pinned: previous.pinned,
            source_document_id:
                normalizeUuid(req.body?.source_document_id) ??
                previous.source_document_id,
            source_page:
                normalizePage(req.body?.source_page) ?? previous.source_page,
            source_chat_id: normalizeUuid(req.body?.source_chat_id),
        })
        .select(SELECT_COLUMNS)
        .single();
    const replacement = replacementRow as unknown as MemoryRow | null;
    if (error || !replacement) {
        console.error("[project-memories] supersede project memory", safeErrorLog(error));
        return void res.status(500).json({ detail: "Could not save the new wording." });
    }

    const now = new Date().toISOString();
    const { error: markError } = await db
        .from("project_memories")
        .update({ superseded_by: replacement.id, superseded_at: now, updated_at: now })
        .eq("id", memoryId)
        .eq("project_id", projectId);
    if (markError) {
        // The new fact exists but the old one was not marked, which would show
        // both at once. Take the new one back out rather than leave a double.
        await db.from("project_memories").delete().eq("id", replacement.id);
        console.error("[project-memories] mark project memory superseded", safeErrorLog(markError));
        return void res.status(500).json({ detail: "Could not save the new wording." });
    }

    void fingerprintMemory(db, replacement.id, body);
    res.status(201).json(replacement);
});

// POST /projects/:projectId/memories/:memoryId/accept
// A suggestion the lawyer is happy with. From here on it is a fact like any
// other and goes out with every question asked in the matter.
projectMemoriesRouter.post("/:memoryId/accept", requireAuth, async (req, res) => {
    const context = await requireProjectAccess(req, res);
    if (!context) return;
    const { db, projectId } = context;
    const { memoryId } = req.params;

    // Accepting is often the moment a wording gets tidied, so take an edited
    // body and grouping in the same breath.
    const updates: Record<string, unknown> = {
        status: "accepted",
        updated_at: new Date().toISOString(),
    };
    if ("body" in req.body) {
        const body = normalizeBody(req.body.body);
        if (!body) return void res.status(400).json({ detail: "Write the fact first." });
        updates.body = body;
    }
    if ("category" in req.body) {
        updates.category = normalizeCategory(req.body.category);
    }

    const { data, error } = await db
        .from("project_memories")
        .update(updates)
        .eq("id", memoryId)
        .eq("project_id", projectId)
        .eq("status", "proposed")
        .select(SELECT_COLUMNS)
        .single();
    if (error || !data) {
        console.error("[project-memories] accept project memory", safeErrorLog(error));
        return void res
            .status(404)
            .json({ detail: "That suggestion is no longer there." });
    }
    void fingerprintMemory(
        db,
        memoryId,
        (data as unknown as MemoryRow).body,
    );
    res.json(data);
});

// POST /projects/:projectId/memories/:memoryId/dismiss
// Turned down. The row stays so the same suggestion does not come round again,
// but it is never sent to the assistant.
projectMemoriesRouter.post("/:memoryId/dismiss", requireAuth, async (req, res) => {
    const context = await requireProjectAccess(req, res);
    if (!context) return;
    const { db, projectId } = context;
    const { memoryId } = req.params;

    const { error } = await db
        .from("project_memories")
        .update({ status: "dismissed", updated_at: new Date().toISOString() })
        .eq("id", memoryId)
        .eq("project_id", projectId)
        .eq("status", "proposed");
    if (error) {
        console.error("[project-memories] dismiss project memory", safeErrorLog(error));
        return void res
            .status(500)
            .json({ detail: "That suggestion could not be turned down." });
    }
    res.status(204).end();
});

// DELETE /projects/:projectId/memories/:memoryId
// For a fact that should never have been written down. Correcting one that has
// simply changed is what supersede is for.
projectMemoriesRouter.delete("/:memoryId", requireAuth, async (req, res) => {
    const context = await requireProjectAccess(req, res);
    if (!context) return;
    const { db, access, projectId, userId } = context;
    const { memoryId } = req.params;

    const { data: memoryRow } = await db
        .from("project_memories")
        .select("id, user_id")
        .eq("id", memoryId)
        .eq("project_id", projectId)
        .maybeSingle();
    const memory = memoryRow as unknown as Pick<
        MemoryRow,
        "id" | "user_id"
    > | null;
    if (!memory) return void res.status(404).json({ detail: "That fact is no longer there." });
    if (memory.user_id !== userId && !access.isOwner) {
        return void res.status(403).json({
            detail: "Only the person who wrote this fact, or the matter's owner, can remove it.",
        });
    }

    // Anything this fact replaced would spring back into force once it goes,
    // so unhook the chain first.
    await db
        .from("project_memories")
        .update({ superseded_by: null, superseded_at: null })
        .eq("superseded_by", memoryId);

    const { error } = await db
        .from("project_memories")
        .delete()
        .eq("id", memoryId)
        .eq("project_id", projectId);
    if (error) {
        console.error("[project-memories] delete project memory", safeErrorLog(error));
        return void res.status(500).json({ detail: "Could not remove the fact." });
    }
    res.status(204).end();
});
