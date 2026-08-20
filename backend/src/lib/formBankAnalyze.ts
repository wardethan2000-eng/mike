/**
 * Suggesting the notes for a banked document.
 *
 * Writing up a precedent properly — what it is, which situation it covers,
 * which paragraphs are the firm's own — is the tedious part of setting the
 * form bank up, and the part most likely to be skipped. So Mike reads the
 * document once and offers a first draft of the notes.
 *
 * It is only ever a suggestion. Nothing is saved here; the person who asked
 * for it reads it, corrects it and saves it themselves. A description of a
 * precedent that nobody checked is worse than none, because Mike would then
 * pick the wrong starting point with confidence.
 */

import type { createServerSupabase } from "./supabase";
import { completeText, resolveModel, DEFAULT_MAIN_MODEL } from "./llm";
import { getUserModelSettings } from "./userSettings";
import { loadActiveVersion } from "./documentVersions";
import { readDocumentContent } from "./chat/tools/documentOps";
import type { DocIndex, DocStore } from "./chat/types";
import {
    listApprovedForms,
    normalizeDocumentType,
    normalizeJurisdictions,
    normalizeRequiredFields,
    type FormUsageMode,
    type RequiredField,
} from "./formBank";

type Db = ReturnType<typeof createServerSupabase>;

/** How much of a long agreement is enough to describe it. */
const MAX_DOCUMENT_CHARS = 60_000;

export type FormNotesProposal = {
    title: string;
    document_type: string;
    usage_mode: FormUsageMode;
    variant_notes: string;
    description: string;
    drafting_guidance: string;
    practice: string;
    jurisdictions: string[];
    required_fields: RequiredField[];
};

const SYSTEM_PROMPT = `You are helping a law firm write up one of its own model documents so that a drafting assistant can later pick the right starting point on its own.

You are given a document's text and, sometimes, the notes on other documents the firm already keeps of the same kind. Reply with a single JSON object and nothing else — no explanation, no code fence.

The JSON object has these keys:
- "title": a short name a lawyer at this firm would recognise, saying what it is and which situation it covers.
- "document_type": a lowercase hyphenated slug for the KIND of document, not this particular version. "operating-agreement", "engagement-letter", "certificate-of-service". Every version of the same kind must get the same slug, so if you are shown the firm's existing versions, reuse their slug exactly.
- "usage_mode": "precedent" if this is a full document meant to be adapted heavily for each new matter. "fill" only if the document is mostly a fixed shape with named blanks in it — long runs of underscores, [bracketed] slots, {{placeholders}} — where the wording around the blanks is not meant to change.
- "variant_notes": one or two sentences saying which situation THIS version is for, written so somebody can tell it apart from the firm's other versions of the same kind. If you are shown the others, write this as a contrast with them. Concrete facts, not praise: how many parties, who manages, which state, which side it favours.
- "description": when to use this one, and when not to.
- "drafting_guidance": notes for the drafting assistant. For a precedent: which provisions look like this firm's standard wording and should carry over word for word, and which sections are deal-specific and expected to be reworked or dropped. For a fill-in form: what may be changed and what must never be touched.
- "practice": the practice area, or "" if it is not clear.
- "jurisdictions": a list of states or courts the document is written for, or [] if it does not say.
- "required_fields": for "fill" only, the blanks in the document, each {"key","label","source","hint"}. "source" is one of "matter" (the answer is a fact about the case or the client), "attorney" (the person signing — their name, title, bar number, signature block), "firm" (the firm's own name, address, phone), or "ask" (nobody can know it without being told — a fee, a deadline the parties agreed, a negotiated figure). Use "ask" whenever inventing the value would be wrong. For a precedent, return [].

Say what the document actually is. If it is not really a model document at all, still fill the fields in as best you can.`;

function parseProposal(reply: string): Record<string, unknown> | null {
    const text = reply.trim();
    // Models sometimes wrap JSON in a code fence even when asked not to.
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1] : text;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    try {
        const parsed = JSON.parse(candidate.slice(start, end + 1));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return null;
        }
        return parsed as Record<string, unknown>;
    } catch {
        return null;
    }
}

function text(value: unknown, max = 2000): string {
    return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Read the document's words, using the same path the chat tools use. */
async function documentText(
    db: Db,
    documentId: string,
    filename: string,
): Promise<string> {
    const active = await loadActiveVersion(documentId, db);
    if (!active?.storage_path) return "";
    const label = "doc-0";
    const docStore: DocStore = new Map();
    docStore.set(label, {
        storage_path: active.storage_path,
        file_type: active.file_type ?? "",
        filename: active.filename?.trim() || filename,
    });
    const docIndex: DocIndex = {
        [label]: { document_id: documentId, filename },
    };
    const content = await readDocumentContent(
        label,
        docStore,
        () => {},
        docIndex,
        db,
        { emitEvents: false },
    );
    return typeof content === "string" ? content : "";
}

export async function recommendFormNotes(params: {
    db: Db;
    userId: string;
    firmId: string;
    documentId: string;
    filename: string;
}): Promise<FormNotesProposal | null> {
    const { db, userId, firmId, documentId, filename } = params;

    const body = await documentText(db, documentId, filename);
    if (!body.trim() || body === "Document not found.") return null;

    // What the firm already keeps, so the new notes are written as a contrast
    // rather than repeating what the siblings say.
    const existing = await listApprovedForms(db, firmId);
    const siblings = existing
        .filter((form) => form.document_id !== documentId)
        .slice(0, 40)
        .map(
            (form) =>
                `- kind "${form.document_type}" — ${form.title}: ${
                    form.variant_notes ?? form.description ?? "no notes"
                }`,
        );

    const settings = await getUserModelSettings(userId, db);
    const model = resolveModel(null, DEFAULT_MAIN_MODEL);

    const reply = await completeText({
        model,
        systemPrompt: SYSTEM_PROMPT,
        user: [
            siblings.length
                ? `Documents this firm already keeps:\n${siblings.join("\n")}\n`
                : "",
            `File name: ${filename}`,
            "",
            "The document:",
            body.slice(0, MAX_DOCUMENT_CHARS),
        ]
            .filter(Boolean)
            .join("\n"),
        maxTokens: 2000,
        apiKeys: settings.api_keys,
    });

    const parsed = parseProposal(reply);
    if (!parsed) return null;

    const usageMode: FormUsageMode =
        parsed.usage_mode === "fill" ? "fill" : "precedent";
    return {
        title: text(parsed.title, 200) || filename,
        document_type:
            normalizeDocumentType(parsed.document_type) ?? "other-document",
        usage_mode: usageMode,
        variant_notes: text(parsed.variant_notes),
        description: text(parsed.description),
        drafting_guidance: text(parsed.drafting_guidance, 4000),
        practice: text(parsed.practice, 120),
        jurisdictions: normalizeJurisdictions(parsed.jurisdictions),
        required_fields:
            usageMode === "fill"
                ? normalizeRequiredFields(parsed.required_fields)
                : [],
    };
}
