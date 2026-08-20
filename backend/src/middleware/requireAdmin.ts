/**
 * Gate for the firm's administration routes.
 *
 * Runs after `requireAuth`, which has already put the caller's membership on
 * `res.locals`. Anyone who is not an active administrator is refused — the
 * front end also hides these screens, but that is a courtesy, not the lock.
 */

import { Request, Response, NextFunction } from "express";
import { createServerSupabase } from "../lib/supabase";
import { getMembership, isFirmAdmin, type FirmMembership } from "../lib/firm";

export async function requireFirmAdmin(
    _req: Request,
    res: Response,
    next: NextFunction,
): Promise<void> {
    const userId = res.locals.userId as string | undefined;
    if (!userId) {
        res.status(401).json({ detail: "Not signed in" });
        return;
    }

    let membership = res.locals.membership as FirmMembership | null | undefined;
    if (membership === undefined) {
        membership = await getMembership(createServerSupabase(), userId);
        res.locals.membership = membership;
    }

    if (!isFirmAdmin(membership ?? null)) {
        res.status(403).json({
            detail: "Only a firm administrator can do that.",
        });
        return;
    }

    next();
}
