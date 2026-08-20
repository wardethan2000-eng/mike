/**
 * Running the firm — /admin.
 *
 * Everything here is for a firm administrator: who works here, what the firm
 * is called, and handing a departed colleague's matters to somebody else.
 * Every change is written to the audit history, because in a law firm the
 * question "who did that, and when" is not an afterthought.
 */

import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { requireFirmAdmin } from "../middleware/requireAdmin";
import { createServerSupabase } from "../lib/supabase";
import { recordAudit } from "../lib/audit";
import {
    clearFirmCache,
    clearMembershipCache,
    countActiveAdmins,
    getMembership,
    isFirmRole,
    isFirmMemberStatus,
    type FirmMembership,
} from "../lib/firm";
import { normalizeAllowedModels } from "../lib/allowedModels";
import { normalizeDraftingDefaults } from "../lib/draftingContext";
import { parsePaginationQuery } from "../lib/pagination";
import {
    API_KEY_PROVIDERS,
    getFirmApiKeyProviders,
    hasEnvApiKey,
    normalizeApiKeyProvider,
    saveFirmApiKey,
} from "../lib/userApiKeys";
import { safeErrorLog } from "../lib/safeError";

export const adminRouter = Router();
adminRouter.use(requireAuth, requireFirmAdmin);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_TTL_DAYS = 14;

function membership(res: { locals: Record<string, unknown> }): FirmMembership {
    return res.locals.membership as FirmMembership;
}

function trimmedOrNull(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
}

function frontendBaseUrl(): string {
    const raw =
        process.env.FRONTEND_URL ||
        process.env.NEXT_PUBLIC_SITE_URL ||
        "http://localhost:3000";
    return raw.replace(/\/+$/, "");
}

export function inviteLinkFor(token: string): string {
    return `${frontendBaseUrl()}/signup?invite=${token}`;
}

// ---------------------------------------------------------------------------
// The firm itself
// ---------------------------------------------------------------------------

/** The caller's own firm — never simply "the firm", so an administrator can
 *  only ever read and change the one they belong to. */
async function callersFirm(res: {
    locals: Record<string, unknown>;
}): Promise<Record<string, unknown> | null> {
    const db = createServerSupabase();
    const { data } = await db
        .from("firms")
        .select("*")
        .eq("id", membership(res as never).firmId)
        .maybeSingle();
    return (data as Record<string, unknown> | null) ?? null;
}

adminRouter.get("/firm", async (_req, res) => {
    const firm = await callersFirm(res);
    if (!firm) return void res.status(404).json({ detail: "No firm set up." });
    res.json(firm);
});

adminRouter.patch("/firm", async (req, res) => {
    const db = createServerSupabase();
    const firm = await callersFirm(res);
    if (!firm) return void res.status(404).json({ detail: "No firm set up." });

    const updates: Record<string, unknown> = {};
    if ("name" in req.body) {
        const name = trimmedOrNull(req.body.name);
        if (!name)
            return void res
                .status(400)
                .json({ detail: "The firm needs a name." });
        updates.name = name;
    }
    if ("address_lines" in req.body) {
        const lines = req.body.address_lines;
        if (!Array.isArray(lines) || lines.some((l) => typeof l !== "string")) {
            return void res
                .status(400)
                .json({ detail: "The address must be a list of lines." });
        }
        updates.address_lines = lines
            .map((l: string) => l.trim())
            .filter((l: string) => l !== "")
            .slice(0, 8);
    }
    for (const field of [
        "phone",
        "website",
        "default_jurisdiction",
        "citation_style",
    ] as const) {
        if (field in req.body) updates[field] = trimmedOrNull(req.body[field]);
    }
    // Sent quietly with every chat anyone at the firm has, so it is capped at
    // a length a person would actually read.
    if ("standing_instructions" in req.body) {
        const standing = trimmedOrNull(req.body.standing_instructions);
        if (standing && standing.length > 4000) {
            return void res.status(400).json({
                detail: "Standing instructions can be up to 4,000 characters.",
            });
        }
        updates.standing_instructions = standing;
    }
    if ("drafting_defaults" in req.body) {
        const raw = req.body.drafting_defaults;
        if (raw === null) {
            updates.drafting_defaults = null;
        } else if (
            !raw ||
            typeof raw !== "object" ||
            Array.isArray(raw)
        ) {
            return void res
                .status(400)
                .json({ detail: "Those drafting defaults are not usable." });
        } else {
            const cleaned = normalizeDraftingDefaults(raw);
            updates.drafting_defaults = Object.keys(cleaned).length
                ? cleaned
                : null;
        }
    }
    if ("allowed_models" in req.body) {
        const raw = req.body.allowed_models;
        if (raw !== null && !Array.isArray(raw)) {
            return void res
                .status(400)
                .json({ detail: "That list of models is not usable." });
        }
        updates.allowed_models = normalizeAllowedModels(raw);
    }
    if (Object.keys(updates).length === 0) {
        return void res.status(400).json({ detail: "Nothing to change." });
    }

    const { data, error } = await db
        .from("firms")
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq("id", firm.id as string)
        .select("*")
        .single();
    if (error || !data)
        return void res.status(500).json({ detail: "Could not save that." });

    clearFirmCache();
    await recordAudit(db, {
        userId: res.locals.userId as string,
        userEmail: res.locals.userEmail as string,
        action: "admin_firm_update",
        surface: "admin",
        title: "Firm details changed",
        detail: { fields: Object.keys(updates) },
    });
    res.json(data);
});

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

adminRouter.get("/members", async (_req, res) => {
    const db = createServerSupabase();
    const firmId = membership(res).firmId;

    const { data: members, error } = await db
        .from("firm_members")
        .select("user_id, role, status, can_edit_firm_library, created_at")
        .eq("firm_id", firmId)
        .order("created_at", { ascending: true });
    if (error) return void res.status(500).json({ detail: error.message });

    const rows = (members ?? []) as {
        user_id: string;
        role: string;
        status: string;
        can_edit_firm_library: boolean;
        created_at: string;
    }[];
    const ids = rows.map((r) => r.user_id);
    const profiles = ids.length
        ? await db
              .from("user_profiles")
              .select("user_id, email, display_name")
              .in("user_id", ids)
        : { data: [] as { user_id: string; email: string | null; display_name: string | null }[] };
    const byId = new Map(
        ((profiles.data ?? []) as {
            user_id: string;
            email: string | null;
            display_name: string | null;
        }[]).map((p) => [p.user_id, p]),
    );

    // How many matters each person is responsible for — the number an admin
    // needs when someone is leaving.
    const { data: owned } = await db
        .from("projects")
        .select("user_id")
        .eq("firm_id", firmId);
    const matterCounts = new Map<string, number>();
    for (const row of (owned ?? []) as { user_id: string }[]) {
        matterCounts.set(row.user_id, (matterCounts.get(row.user_id) ?? 0) + 1);
    }

    res.json(
        rows.map((r) => ({
            user_id: r.user_id,
            email: byId.get(r.user_id)?.email ?? null,
            display_name: byId.get(r.user_id)?.display_name ?? null,
            role: r.role,
            status: r.status,
            can_edit_firm_library: r.can_edit_firm_library,
            matter_count: matterCounts.get(r.user_id) ?? 0,
            joined_at: r.created_at,
            is_you: r.user_id === (res.locals.userId as string),
        })),
    );
});

adminRouter.patch("/members/:userId", async (req, res) => {
    const db = createServerSupabase();
    const firmId = membership(res).firmId;
    const targetId = req.params.userId;
    const actingUserId = res.locals.userId as string;

    const target = await getMembership(db, targetId);
    if (!target || target.firmId !== firmId) {
        return void res.status(404).json({ detail: "No such person." });
    }

    const updates: Record<string, unknown> = {};
    if ("role" in req.body) {
        if (!isFirmRole(req.body.role)) {
            return void res.status(400).json({ detail: "Unknown role." });
        }
        updates.role = req.body.role;
    }
    if ("status" in req.body) {
        if (!isFirmMemberStatus(req.body.status)) {
            return void res.status(400).json({ detail: "Unknown status." });
        }
        updates.status = req.body.status;
    }
    if ("can_edit_firm_library" in req.body) {
        updates.can_edit_firm_library =
            req.body.can_edit_firm_library === true;
    }
    if (Object.keys(updates).length === 0) {
        return void res.status(400).json({ detail: "Nothing to change." });
    }

    // The firm must keep somebody who can administer it. Refuse the change
    // that would take the last one away — including doing it to yourself.
    const losesAdmin =
        target.role === "admin" &&
        target.status === "active" &&
        ((updates.role !== undefined && updates.role !== "admin") ||
            updates.status === "deactivated");
    if (losesAdmin && (await countActiveAdmins(db, firmId)) <= 1) {
        return void res.status(400).json({
            detail:
                "This is the firm's only administrator. Make someone else an administrator first.",
        });
    }

    const { error } = await db
        .from("firm_members")
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq("user_id", targetId)
        .eq("firm_id", firmId);
    if (error) return void res.status(500).json({ detail: error.message });
    clearMembershipCache(targetId);

    // Deactivating bars the account at the sign-in provider, so an open
    // session stops working rather than running until its token expires.
    if (updates.status !== undefined) {
        try {
            await db.auth.admin.updateUserById(targetId, {
                ban_duration:
                    updates.status === "deactivated" ? "876000h" : "none",
            });
        } catch (err) {
            console.error("[admin] could not change sign-in status", {
                error: safeErrorLog(err),
            });
        }
    }

    await recordAudit(db, {
        userId: actingUserId,
        userEmail: res.locals.userEmail as string,
        action: "admin_member_update",
        surface: "admin",
        title: "Changed a colleague's access",
        detail: { target_user_id: targetId, ...updates },
    });

    res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Invitations
// ---------------------------------------------------------------------------

adminRouter.get("/invites", async (_req, res) => {
    const db = createServerSupabase();
    const { data, error } = await db
        .from("firm_invites")
        .select(
            "id, email, role, token, expires_at, accepted_at, created_at",
        )
        .eq("firm_id", membership(res).firmId)
        .order("created_at", { ascending: false })
        .limit(100);
    if (error) return void res.status(500).json({ detail: error.message });
    res.json(
        ((data ?? []) as { token: string }[]).map((row) => ({
            ...row,
            link: inviteLinkFor(row.token),
        })),
    );
});

adminRouter.post("/invites", async (req, res) => {
    const db = createServerSupabase();
    const firmId = membership(res).firmId;
    const email = typeof req.body.email === "string"
        ? req.body.email.trim().toLowerCase()
        : "";
    if (!EMAIL_RE.test(email)) {
        return void res
            .status(400)
            .json({ detail: "That does not look like an email address." });
    }
    const role = "role" in req.body ? req.body.role : "attorney";
    if (!isFirmRole(role)) {
        return void res.status(400).json({ detail: "Unknown role." });
    }

    const { data: existing } = await db
        .from("user_profiles")
        .select("user_id")
        .ilike("email", email)
        .maybeSingle();
    if (existing) {
        return void res
            .status(409)
            .json({ detail: "Somebody already uses that address." });
    }

    const expiresAt = new Date(
        Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { data, error } = await db
        .from("firm_invites")
        .insert({
            firm_id: firmId,
            email,
            role,
            created_by: res.locals.userId as string,
            expires_at: expiresAt,
        })
        .select("id, email, role, token, expires_at, created_at")
        .single();
    if (error) return void res.status(500).json({ detail: error.message });

    await recordAudit(db, {
        userId: res.locals.userId as string,
        userEmail: res.locals.userEmail as string,
        action: "admin_invite_create",
        surface: "admin",
        title: `Invited ${email}`,
        detail: { email, role },
    });

    res.status(201).json({
        ...(data as Record<string, unknown>),
        link: inviteLinkFor((data as { token: string }).token),
    });
});

adminRouter.delete("/invites/:id", async (req, res) => {
    const db = createServerSupabase();
    const { error } = await db
        .from("firm_invites")
        .delete()
        .eq("id", req.params.id)
        .eq("firm_id", membership(res).firmId)
        .is("accepted_at", null);
    if (error) return void res.status(500).json({ detail: error.message });
    res.status(204).send();
});

// ---------------------------------------------------------------------------
// Handing matters over
// ---------------------------------------------------------------------------

adminRouter.get("/projects", async (req, res) => {
    const db = createServerSupabase();
    let query = db
        .from("projects")
        .select("id, name, cm_number, user_id, visibility, updated_at")
        .eq("firm_id", membership(res).firmId)
        .order("updated_at", { ascending: false })
        .limit(500);
    const ownerId = req.query.owner_user_id;
    if (typeof ownerId === "string" && ownerId) {
        query = query.eq("user_id", ownerId);
    }
    const { data, error } = await query;
    if (error) return void res.status(500).json({ detail: error.message });
    res.json(data ?? []);
});

adminRouter.patch("/projects/:projectId/owner", async (req, res) => {
    const db = createServerSupabase();
    const firmId = membership(res).firmId;
    const newOwnerId =
        typeof req.body.user_id === "string" ? req.body.user_id : "";
    if (!newOwnerId) {
        return void res
            .status(400)
            .json({ detail: "Choose who should take this matter on." });
    }

    const newOwner = await getMembership(db, newOwnerId);
    if (!newOwner || newOwner.firmId !== firmId || newOwner.status !== "active") {
        return void res.status(400).json({
            detail: "Matters can only be handed to someone working at the firm.",
        });
    }

    const { data: project } = await db
        .from("projects")
        .select("id, user_id, name")
        .eq("id", req.params.projectId)
        .eq("firm_id", firmId)
        .maybeSingle();
    if (!project) return void res.status(404).json({ detail: "No such matter." });

    const previousOwner = (project as { user_id: string }).user_id;
    const { error } = await db
        .from("projects")
        .update({ user_id: newOwnerId, updated_at: new Date().toISOString() })
        .eq("id", req.params.projectId)
        .eq("firm_id", firmId);
    if (error) return void res.status(500).json({ detail: error.message });

    await recordAudit(db, {
        userId: res.locals.userId as string,
        userEmail: res.locals.userEmail as string,
        action: "admin_project_reassign",
        surface: "admin",
        projectId: req.params.projectId,
        title: `Handed over ${(project as { name: string }).name}`,
        detail: { from_user_id: previousOwner, to_user_id: newOwnerId },
    });

    res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// The firm's shared content
// ---------------------------------------------------------------------------

/** Everything the firm has published for everyone to run. */
adminRouter.get("/workflows", async (_req, res) => {
    const db = createServerSupabase();
    const firmId = membership(res).firmId;

    const { data, error } = await db
        .from("workflows")
        .select("id, user_id, title, type, practice, language, created_at")
        .eq("firm_id", firmId)
        .order("created_at", { ascending: false });
    if (error) return void res.status(500).json({ detail: error.message });

    const rows = (data ?? []) as {
        id: string;
        user_id: string | null;
        title: string | null;
        type: string | null;
        practice: string | null;
        language: string | null;
        created_at: string;
    }[];
    const authorIds = [
        ...new Set(rows.map((row) => row.user_id).filter(Boolean)),
    ] as string[];
    const names = new Map<string, string>();
    if (authorIds.length) {
        const { data: profiles } = await db
            .from("user_profiles")
            .select("user_id, display_name, email")
            .in("user_id", authorIds);
        for (const profile of (profiles ?? []) as {
            user_id: string;
            display_name: string | null;
            email: string | null;
        }[]) {
            names.set(
                profile.user_id,
                profile.display_name?.trim() || profile.email || "",
            );
        }
    }

    res.json(
        rows.map((row) => ({
            ...row,
            author_name: row.user_id ? (names.get(row.user_id) ?? "") : "",
        })),
    );
});

/** Rename one of the firm's workflows. */
adminRouter.patch("/workflows/:workflowId", async (req, res) => {
    const db = createServerSupabase();
    const firmId = membership(res).firmId;
    const title = trimmedOrNull(req.body.title);
    if (!title) {
        return void res.status(400).json({ detail: "A workflow needs a name." });
    }

    const { data, error } = await db
        .from("workflows")
        .update({ title: title.slice(0, 200) })
        .eq("id", req.params.workflowId)
        .eq("firm_id", firmId)
        .select("id, title")
        .maybeSingle();
    if (error) return void res.status(500).json({ detail: error.message });
    if (!data) return void res.status(404).json({ detail: "No such workflow." });

    await recordAudit(db, {
        userId: res.locals.userId as string,
        userEmail: res.locals.userEmail as string,
        action: "admin_firm_workflow_update",
        surface: "admin",
        title: `Renamed the firm workflow "${title}"`,
        detail: { workflow_id: req.params.workflowId },
    });
    res.json(data);
});

/** Take one of the firm's workflows off the shared list. The person who wrote
 *  it keeps their own copy. */
adminRouter.delete("/workflows/:workflowId", async (req, res) => {
    const db = createServerSupabase();
    const firmId = membership(res).firmId;

    const { data: workflow } = await db
        .from("workflows")
        .select("id, title")
        .eq("id", req.params.workflowId)
        .eq("firm_id", firmId)
        .maybeSingle();
    if (!workflow)
        return void res.status(404).json({ detail: "No such workflow." });

    const { error } = await db
        .from("workflows")
        .delete()
        .eq("id", req.params.workflowId)
        .eq("firm_id", firmId);
    if (error) return void res.status(500).json({ detail: error.message });

    await recordAudit(db, {
        userId: res.locals.userId as string,
        userEmail: res.locals.userEmail as string,
        action: "admin_firm_workflow_delete",
        surface: "admin",
        title: `Removed the firm workflow "${(workflow as { title: string }).title}"`,
        detail: { workflow_id: req.params.workflowId },
    });
    res.status(204).send();
});

// ---------------------------------------------------------------------------
// The firm's accounts with the AI providers
// ---------------------------------------------------------------------------
//
// A stored key is never handed back out, not even to the administrator who set
// it. All these routes say is which providers the firm holds an account for,
// and where each person's key is coming from.

adminRouter.get("/api-keys", async (_req, res) => {
    const db = createServerSupabase();
    const firmId = membership(res).firmId;
    const held = new Set(await getFirmApiKeyProviders(firmId, db));
    res.json(
        API_KEY_PROVIDERS.map((provider) => ({
            provider,
            firm_key_set: held.has(provider),
            // Without a firm key, the server's own setting is what everybody
            // falls back on — worth showing so a blank row is not alarming.
            server_key_set: hasEnvApiKey(provider),
        })),
    );
});

adminRouter.put("/api-keys/:provider", async (req, res) => {
    const provider = normalizeApiKeyProvider(String(req.params.provider));
    if (!provider) {
        return void res.status(404).json({ detail: "No such provider." });
    }
    const value = trimmedOrNull(req.body?.key);
    if (!value) {
        return void res.status(400).json({ detail: "Paste the key first." });
    }

    const db = createServerSupabase();
    try {
        await saveFirmApiKey(
            membership(res).firmId,
            provider,
            value,
            res.locals.userId as string,
            db,
        );
    } catch (error) {
        console.error("[admin/api-keys] save failed", safeErrorLog(error));
        return void res.status(500).json({ detail: "That key did not save." });
    }

    await recordAudit(db, {
        userId: res.locals.userId as string,
        userEmail: res.locals.userEmail as string,
        action: "admin_firm_key_set",
        surface: "admin",
        title: `Set the firm's ${provider} key`,
        detail: { provider },
    });
    res.json({ ok: true });
});

adminRouter.delete("/api-keys/:provider", async (req, res) => {
    const provider = normalizeApiKeyProvider(String(req.params.provider));
    if (!provider) {
        return void res.status(404).json({ detail: "No such provider." });
    }
    const db = createServerSupabase();
    try {
        await saveFirmApiKey(
            membership(res).firmId,
            provider,
            null,
            res.locals.userId as string,
            db,
        );
    } catch (error) {
        console.error("[admin/api-keys] remove failed", safeErrorLog(error));
        return void res
            .status(500)
            .json({ detail: "That key could not be removed." });
    }

    await recordAudit(db, {
        userId: res.locals.userId as string,
        userEmail: res.locals.userEmail as string,
        action: "admin_firm_key_remove",
        surface: "admin",
        title: `Removed the firm's ${provider} key`,
        detail: { provider },
    });
    res.status(204).send();
});

// ---------------------------------------------------------------------------
// What people have been doing
// ---------------------------------------------------------------------------

/** Read-only history across everybody at the firm, newest first. */
adminRouter.get("/audit", async (req, res) => {
    const db = createServerSupabase();
    const pagination = parsePaginationQuery(req.query as Record<string, unknown>);

    // Only people at this firm — the history is not a way around the firm
    // boundary if a second firm ever exists.
    const { data: members } = await db
        .from("firm_members")
        .select("user_id")
        .eq("firm_id", membership(res).firmId);
    const memberIds = (members ?? []).map(
        (row) => (row as { user_id: string }).user_id,
    );
    if (memberIds.length === 0) {
        return void res.json({ events: [], hasMore: false });
    }

    let query = db
        .from("audit_events")
        .select(
            "id, created_at, user_id, user_email, action, status, title, surface, project_id, chat_id, document_id, model",
        )
        .in("user_id", memberIds);

    const person = typeof req.query.user_id === "string" ? req.query.user_id : "";
    if (person) query = query.eq("user_id", person);
    const action = typeof req.query.action === "string" ? req.query.action : "";
    if (action) query = query.eq("action", action);
    const matter =
        typeof req.query.project_id === "string" ? req.query.project_id : "";
    if (matter) query = query.eq("project_id", matter);
    const from = typeof req.query.from === "string" ? req.query.from : "";
    if (from) query = query.gte("created_at", from);
    const to = typeof req.query.to === "string" ? req.query.to : "";
    if (to) query = query.lte("created_at", to);

    // One row past the page tells us whether there is more, without a count.
    const { data, error } = await query
        .order("created_at", { ascending: false })
        .range(pagination.offset, pagination.offset + pagination.limit);
    if (error) return void res.status(500).json({ detail: error.message });

    const rows = (data ?? []) as Record<string, unknown>[];
    res.json({
        events: rows.slice(0, pagination.limit),
        hasMore: rows.length > pagination.limit,
    });
});

/** The list of things that happen, so the filter can offer them. */
adminRouter.get("/audit/actions", async (_req, res) => {
    const db = createServerSupabase();
    const { data, error } = await db
        .from("audit_events")
        .select("action")
        .order("action", { ascending: true })
        .limit(5000);
    if (error) return void res.status(500).json({ detail: error.message });
    const actions = [
        ...new Set(
            (data ?? []).map((row) => String((row as { action: string }).action)),
        ),
    ].sort();
    res.json({ actions });
});

/**
 * How much each person has used, for one month.
 *
 * Counted from the history rather than from the messages table, because the
 * messages table does not record which model answered — the history does, and
 * it is written once per message sent.
 */
adminRouter.get("/usage", async (req, res) => {
    const db = createServerSupabase();
    const month =
        typeof req.query.month === "string" &&
        /^\d{4}-\d{2}$/.test(req.query.month)
            ? req.query.month
            : new Date().toISOString().slice(0, 7);
    const start = `${month}-01T00:00:00.000Z`;
    const [year, monthNumber] = month.split("-").map(Number);
    const nextMonth =
        monthNumber === 12
            ? `${year + 1}-01`
            : `${year}-${String(monthNumber + 1).padStart(2, "0")}`;
    const end = `${nextMonth}-01T00:00:00.000Z`;

    const { data: members } = await db
        .from("firm_members")
        .select("user_id")
        .eq("firm_id", membership(res).firmId);
    const memberIds = (members ?? []).map(
        (row) => (row as { user_id: string }).user_id,
    );
    if (memberIds.length === 0) {
        return void res.json({ month, people: [] });
    }

    const { data, error } = await db
        .from("audit_events")
        .select("user_id, user_email, model")
        .eq("action", "chat.message")
        .in("user_id", memberIds)
        .gte("created_at", start)
        .lt("created_at", end)
        .limit(50000);
    if (error) return void res.status(500).json({ detail: error.message });

    const byPerson = new Map<
        string,
        { user_id: string; email: string; messages: number; byModel: Map<string, number> }
    >();
    for (const row of (data ?? []) as {
        user_id: string;
        user_email: string | null;
        model: string | null;
    }[]) {
        const entry = byPerson.get(row.user_id) ?? {
            user_id: row.user_id,
            email: row.user_email ?? "",
            messages: 0,
            byModel: new Map<string, number>(),
        };
        entry.messages += 1;
        if (!entry.email && row.user_email) entry.email = row.user_email;
        const model = row.model ?? "not recorded";
        entry.byModel.set(model, (entry.byModel.get(model) ?? 0) + 1);
        byPerson.set(row.user_id, entry);
    }

    const names = new Map<string, string>();
    const { data: profiles } = await db
        .from("user_profiles")
        .select("user_id, display_name")
        .in("user_id", memberIds);
    for (const profile of (profiles ?? []) as {
        user_id: string;
        display_name: string | null;
    }[]) {
        if (profile.display_name?.trim()) {
            names.set(profile.user_id, profile.display_name.trim());
        }
    }

    res.json({
        month,
        people: [...byPerson.values()]
            .map((entry) => ({
                user_id: entry.user_id,
                email: entry.email,
                display_name: names.get(entry.user_id) ?? null,
                messages: entry.messages,
                by_model: [...entry.byModel.entries()]
                    .map(([model, count]) => ({ model, count }))
                    .sort((a, b) => b.count - a.count),
            }))
            .sort((a, b) => b.messages - a.messages),
    });
});
