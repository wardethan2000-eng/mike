import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { authHeaders } from "../lib/llm/ollama";
import { createServerSupabase } from "../lib/supabase";
import {
    allowedModelsForFirm,
    filterAllowedModels,
} from "../lib/allowedModels";

export const modelsRouter = Router();

// Live list of locally installed Ollama models, shaped like the frontend's
// ModelOption. Returns [] when Ollama is unreachable so the app still works.
modelsRouter.get("/ollama", requireAuth, async (_req, res) => {
    const base = (
        process.env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434/v1"
    ).replace(/\/$/, "");
    try {
        const r = await fetch(`${base}/models`, { headers: authHeaders() });
        if (!r.ok) return void res.json({ models: [] });
        const data = (await r.json()) as { data?: { id: string }[] };
        const models = (data.data ?? []).map((m) => ({
            id: `ollama/${m.id}`,
            label: `${m.id} (local)`,
            group: "Local",
        }));
        // A firm that has named a shortlist should not be offered the rest.
        const allowed = await allowedModelsForFirm(createServerSupabase());
        res.json({ models: filterAllowedModels(models, allowed) });
    } catch {
        res.json({ models: [] });
    }
});
