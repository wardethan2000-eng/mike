/**
 * Joining the firm — /auth/invite.
 *
 * These two routes are the only ones in the app that answer without a
 * sign-in, because the person using them does not have an account yet. Open
 * registration is closed; an administrator creates an invitation, passes on
 * the link, and this is where that link is spent.
 *
 * The account is created with the server's own credentials, which is what
 * lets people join while public sign-up is switched off.
 */

import { Router } from "express";
import { createServerSupabase } from "../lib/supabase";
import { recordAudit } from "../lib/audit";
import { clearMembershipCache, isFirmRole } from "../lib/firm";
import { safeErrorLog } from "../lib/safeError";

export const firmInvitesRouter = Router();

const UUID_RE =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIN_PASSWORD_LENGTH = 8;

type InviteRow = {
    id: string;
    firm_id: string;
    email: string;
    role: string;
    expires_at: string;
    accepted_at: string | null;
};

async function loadUsableInvite(
    db: ReturnType<typeof createServerSupabase>,
    token: string,
): Promise<InviteRow | null> {
    const { data } = await db
        .from("firm_invites")
        .select("id, firm_id, email, role, expires_at, accepted_at")
        .eq("token", token)
        .maybeSingle();
    const invite = data as InviteRow | null;
    if (!invite) return null;
    if (invite.accepted_at) return null;
    if (new Date(invite.expires_at).getTime() <= Date.now()) return null;
    return invite;
}

// GET /auth/invite/:token — what this link is for, so the page can show the
// firm's name and the address the invitation was written to.
firmInvitesRouter.get("/invite/:token", async (req, res) => {
    const token = req.params.token;
    if (!UUID_RE.test(token)) {
        return void res
            .status(404)
            .json({ detail: "This invitation is not valid." });
    }
    const db = createServerSupabase();
    const invite = await loadUsableInvite(db, token);
    if (!invite) {
        return void res.status(404).json({
            detail: "This invitation has expired or has already been used.",
        });
    }
    const { data: firm } = await db
        .from("firms")
        .select("name")
        .eq("id", invite.firm_id)
        .maybeSingle();
    res.json({
        email: invite.email,
        role: invite.role,
        firm_name: (firm as { name?: string } | null)?.name ?? null,
    });
});

// POST /auth/invite/accept — spend the invitation and create the account.
firmInvitesRouter.post("/invite/accept", async (req, res) => {
    const token = typeof req.body.token === "string" ? req.body.token : "";
    const password =
        typeof req.body.password === "string" ? req.body.password : "";
    const displayName =
        typeof req.body.display_name === "string"
            ? req.body.display_name.trim().slice(0, 120)
            : "";

    if (!UUID_RE.test(token)) {
        return void res
            .status(404)
            .json({ detail: "This invitation is not valid." });
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
        return void res.status(400).json({
            detail: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters.`,
        });
    }

    const db = createServerSupabase();
    const invite = await loadUsableInvite(db, token);
    if (!invite) {
        return void res.status(404).json({
            detail: "This invitation has expired or has already been used.",
        });
    }

    const { data: created, error: createError } =
        await db.auth.admin.createUser({
            email: invite.email,
            password,
            email_confirm: true,
            user_metadata: displayName ? { display_name: displayName } : {},
        });
    if (createError || !created?.user) {
        const message = createError?.message ?? "Could not create the account.";
        console.error("[invite] account creation failed", {
            error: safeErrorLog(createError),
        });
        const alreadyExists = /already|registered|exists/i.test(message);
        return void res.status(alreadyExists ? 409 : 500).json({
            detail: alreadyExists
                ? "There is already an account for that address. Try signing in."
                : "Could not create the account.",
        });
    }

    const newUserId = created.user.id;
    const role = isFirmRole(invite.role) ? invite.role : "attorney";

    const { error: memberError } = await db.from("firm_members").insert({
        firm_id: invite.firm_id,
        user_id: newUserId,
        role,
    });
    if (memberError) {
        // Without a place in the firm the account is useless and, worse,
        // unexplained. Undo it so the invitation can be tried again.
        console.error("[invite] membership insert failed", {
            error: safeErrorLog(memberError),
        });
        try {
            await db.auth.admin.deleteUser(newUserId);
        } catch (err) {
            console.error("[invite] could not roll back the account", {
                error: safeErrorLog(err),
            });
        }
        return void res
            .status(500)
            .json({ detail: "Could not finish setting up the account." });
    }
    clearMembershipCache(newUserId);

    if (displayName) {
        await db
            .from("user_profiles")
            .update({ display_name: displayName, updated_at: new Date().toISOString() })
            .eq("user_id", newUserId);
    }

    await db
        .from("firm_invites")
        .update({
            accepted_at: new Date().toISOString(),
            accepted_user_id: newUserId,
        })
        .eq("id", invite.id);

    await recordAudit(db, {
        userId: newUserId,
        userEmail: invite.email,
        action: "firm_invite_accepted",
        surface: "admin",
        title: "Joined the firm",
        detail: { role },
    });

    res.status(201).json({ ok: true, email: invite.email });
});
