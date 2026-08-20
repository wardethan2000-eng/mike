/**
 * The firm's form bank.
 *
 * The firm library already held the documents. What was missing was any way
 * for Mike to find the right one on its own: a template only reached a chat if
 * somebody remembered it existed and attached it by hand. So a firm with four
 * operating agreements, one for each situation it meets, got none of them.
 *
 * The bank is a set of notes about documents that are already on the firm's
 * shelves — what each one is, which situation it covers, what may be reworked
 * and what must be left alone. Those notes go into every chat as a short list,
 * grouped so that four operating agreements read as four versions of one thing
 * rather than four unrelated files. From there Mike can compare the versions
 * and open the one that fits.
 *
 * Nothing here holds a document or changes one. It is notes and looking things
 * up; the copying, writing and editing is the same machinery as always.
 */

import type { createServerSupabase } from "./supabase";
import { getMembership, isActiveMember } from "./firm";
import { FORM_BANK_DRAFTING_RULES } from "./chat/prompts";

type Db = ReturnType<typeof createServerSupabase>;

export const FORM_USAGE_MODES = ["precedent", "fill"] as const;
export type FormUsageMode = (typeof FORM_USAGE_MODES)[number];

export const FORM_STATUSES = ["draft", "approved"] as const;
export type FormStatus = (typeof FORM_STATUSES)[number];

export const FIELD_SOURCES = ["ask", "matter", "attorney", "firm"] as const;
export type FieldSource = (typeof FIELD_SOURCES)[number];

export type RequiredField = {
    key: string;
    label: string;
    source: FieldSource;
    hint?: string;
};

export type FirmForm = {
    id: string;
    firm_id: string;
    document_id: string;
    title: string;
    document_type: string;
    usage_mode: FormUsageMode;
    variant_notes: string | null;
    practice: string | null;
    jurisdictions: string[];
    description: string | null;
    drafting_guidance: string | null;
    required_fields: RequiredField[];
    status: FormStatus;
    created_by: string | null;
    created_at?: string;
    updated_at?: string;
};

export const FORM_COLUMNS =
    "id, firm_id, document_id, title, document_type, usage_mode, variant_notes, practice, jurisdictions, description, drafting_guidance, required_fields, status, created_by, created_at, updated_at";

/**
 * How many entries fit in every chat before the list becomes a cost in its own
 * right. Past this, the chat is told to search the bank instead of being
 * handed all of it.
 */
export const CATALOGUE_LIMIT = 50;

export function isFormUsageMode(value: unknown): value is FormUsageMode {
    return (
        typeof value === "string" &&
        (FORM_USAGE_MODES as readonly string[]).includes(value)
    );
}

export function isFormStatus(value: unknown): value is FormStatus {
    return (
        typeof value === "string" &&
        (FORM_STATUSES as readonly string[]).includes(value)
    );
}

/**
 * Turn what somebody typed into a slug, so "Operating Agreement" and
 * "operating agreement" are the same kind of document and their versions sit
 * together rather than in two separate groups.
 */
export function normalizeDocumentType(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const slug = value
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 80);
    return slug || null;
}

export function normalizeJurisdictions(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of value) {
        if (typeof entry !== "string") continue;
        const trimmed = entry.trim().slice(0, 60);
        if (!trimmed) continue;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(trimmed);
        if (out.length >= 12) break;
    }
    return out;
}

/**
 * The blanks on a fill-in form. Anything unrecognised is dropped rather than
 * passed on: a field with no label is a field nobody can answer, and a source
 * we do not understand would end up invented.
 */
export function normalizeRequiredFields(value: unknown): RequiredField[] {
    if (!Array.isArray(value)) return [];
    const out: RequiredField[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
        const row = entry as Record<string, unknown>;
        const label = typeof row.label === "string" ? row.label.trim() : "";
        if (!label) continue;
        const rawKey = typeof row.key === "string" ? row.key.trim() : "";
        const key =
            (rawKey || label)
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "_")
                .replace(/^_+|_+$/g, "")
                .slice(0, 60) || `field_${out.length + 1}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const source =
            typeof row.source === "string" &&
            (FIELD_SOURCES as readonly string[]).includes(row.source)
                ? (row.source as FieldSource)
                : "ask";
        const hint = typeof row.hint === "string" ? row.hint.trim() : "";
        out.push({
            key,
            label: label.slice(0, 200),
            source,
            ...(hint ? { hint: hint.slice(0, 400) } : {}),
        });
        if (out.length >= 40) break;
    }
    return out;
}

/** Read a database row into the shape the rest of the code expects. */
export function rowToForm(row: Record<string, unknown>): FirmForm {
    return {
        id: String(row.id),
        firm_id: String(row.firm_id),
        document_id: String(row.document_id),
        title: typeof row.title === "string" ? row.title : "Untitled",
        document_type:
            typeof row.document_type === "string" ? row.document_type : "",
        usage_mode: isFormUsageMode(row.usage_mode)
            ? row.usage_mode
            : "precedent",
        variant_notes:
            typeof row.variant_notes === "string" ? row.variant_notes : null,
        practice: typeof row.practice === "string" ? row.practice : null,
        jurisdictions: normalizeJurisdictions(row.jurisdictions),
        description: typeof row.description === "string" ? row.description : null,
        drafting_guidance:
            typeof row.drafting_guidance === "string"
                ? row.drafting_guidance
                : null,
        required_fields: normalizeRequiredFields(row.required_fields),
        status: isFormStatus(row.status) ? row.status : "draft",
        created_by: typeof row.created_by === "string" ? row.created_by : null,
        created_at:
            typeof row.created_at === "string" ? row.created_at : undefined,
        updated_at:
            typeof row.updated_at === "string" ? row.updated_at : undefined,
    };
}

/**
 * The firm whose bank this person may read, or null. Somebody who has left the
 * firm gets nothing, the same as everywhere else.
 */
export async function readableFirmId(
    db: Db,
    userId: string,
): Promise<string | null> {
    const membership = await getMembership(db, userId);
    return isActiveMember(membership) ? membership.firmId : null;
}

/** Every entry the firm has approved, oldest first within each kind. */
export async function listApprovedForms(
    db: Db,
    firmId: string,
): Promise<FirmForm[]> {
    try {
        const { data, error } = await db
            .from("firm_forms")
            .select(FORM_COLUMNS)
            .eq("firm_id", firmId)
            .eq("status", "approved")
            .order("document_type", { ascending: true })
            .order("title", { ascending: true });
        if (error || !data) return [];
        return (data as Record<string, unknown>[]).map(rowToForm);
    } catch {
        return [];
    }
}

/** One approved entry, by its id. */
export async function loadApprovedForm(
    db: Db,
    firmId: string,
    formId: string,
): Promise<FirmForm | null> {
    try {
        const { data, error } = await db
            .from("firm_forms")
            .select(FORM_COLUMNS)
            .eq("id", formId)
            .eq("firm_id", firmId)
            .eq("status", "approved")
            .maybeSingle();
        if (error || !data) return null;
        return rowToForm(data as Record<string, unknown>);
    } catch {
        return null;
    }
}

/** Every approved version of one kind of document. */
export async function listApprovedFormsOfType(
    db: Db,
    firmId: string,
    documentType: string,
): Promise<FirmForm[]> {
    const slug = normalizeDocumentType(documentType);
    if (!slug) return [];
    try {
        const { data, error } = await db
            .from("firm_forms")
            .select(FORM_COLUMNS)
            .eq("firm_id", firmId)
            .eq("status", "approved")
            .eq("document_type", slug)
            .order("title", { ascending: true });
        if (error || !data) return [];
        return (data as Record<string, unknown>[]).map(rowToForm);
    } catch {
        return [];
    }
}

/**
 * A plain word search over the notes, for a bank too big to list in full.
 * Deliberately simple matching — the bank is a shelf of a firm's own documents,
 * not a search engine, and anything cleverer is not worth the machinery until
 * it holds hundreds.
 */
export async function searchApprovedForms(
    db: Db,
    firmId: string,
    query: string,
    limit = 20,
): Promise<FirmForm[]> {
    const term = query.trim().slice(0, 120);
    if (!term) return [];
    const escaped = term.replace(/[%,()]/g, " ").trim();
    if (!escaped) return [];
    try {
        const { data, error } = await db
            .from("firm_forms")
            .select(FORM_COLUMNS)
            .eq("firm_id", firmId)
            .eq("status", "approved")
            .or(
                [
                    `title.ilike.%${escaped}%`,
                    `document_type.ilike.%${escaped}%`,
                    `variant_notes.ilike.%${escaped}%`,
                    `description.ilike.%${escaped}%`,
                    `practice.ilike.%${escaped}%`,
                ].join(","),
            )
            .limit(Math.max(1, Math.min(50, limit)));
        if (error || !data) return [];
        return (data as Record<string, unknown>[]).map(rowToForm);
    } catch {
        return [];
    }
}

/** Turn a slug back into something readable for a heading. */
export function documentTypeLabel(slug: string): string {
    if (!slug) return "Other";
    return slug
        .split("-")
        .filter(Boolean)
        .map((word, index) =>
            index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word,
        )
        .join(" ");
}

function oneLine(value: string | null | undefined, max: number): string | null {
    if (!value) return null;
    const flat = value.replace(/\s+/g, " ").trim();
    if (!flat) return null;
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** How one entry reads in the list Mike is given. */
export function formCatalogueLine(form: FirmForm): string {
    const bits = [
        form.usage_mode === "fill" ? "fill-in form" : "precedent",
        form.jurisdictions.length ? form.jurisdictions.join("/") : null,
        oneLine(form.variant_notes, 220) ?? oneLine(form.description, 220),
    ].filter(Boolean);
    return `  - ${form.title} (id ${form.id}) — ${bits.join(" — ")}`;
}

/** Group entries by the kind of document they are. */
export function groupFormsByType(forms: FirmForm[]): Map<string, FirmForm[]> {
    const groups = new Map<string, FirmForm[]>();
    for (const form of forms) {
        const list = groups.get(form.document_type);
        if (list) list.push(form);
        else groups.set(form.document_type, [form]);
    }
    return groups;
}

/**
 * The list of what the firm banks, written out for the model, grouped so that
 * several versions of one kind of document read as a set to choose from.
 *
 * Empty when the firm banks nothing, so a firm that never sets this up reads
 * exactly as it did before.
 */
export function formBankCatalogue(forms: FirmForm[]): string {
    if (!forms.length) return "";

    const groups = groupFormsByType(forms);
    const shown: string[] = [];
    let count = 0;
    let truncated = false;

    for (const [type, entries] of groups) {
        if (count >= CATALOGUE_LIMIT) {
            truncated = true;
            break;
        }
        const room = CATALOGUE_LIMIT - count;
        const listed = entries.slice(0, room);
        if (listed.length < entries.length) truncated = true;
        count += listed.length;
        const label = documentTypeLabel(type);
        const heading =
            entries.length > 1
                ? `${label} — the firm keeps ${entries.length} versions:`
                : `${label}:`;
        shown.push(`${heading}\n${listed.map(formCatalogueLine).join("\n")}`);
    }

    let section = `\n\nTHE FIRM'S FORM BANK\nThese are the firm's own model documents, already on its shelves. When you are asked to draft something of a kind listed here, start from the firm's own rather than writing from scratch or copying something else.\n\n${shown.join(
        "\n\n",
    )}`;

    if (truncated) {
        section += `\n\nThis is not the whole bank. If what you are asked for is not listed above, call find_firm_form with a few words describing it before assuming the firm has nothing.`;
    }
    return `${section}\n${FORM_BANK_DRAFTING_RULES}`;
}

/**
 * The bank as it should appear in one person's chat: nothing at all unless
 * they work at a firm that has approved some entries.
 */
export async function formBankSection(
    db: Db,
    userId: string,
): Promise<string> {
    try {
        const firmId = await readableFirmId(db, userId);
        if (!firmId) return "";
        const forms = await listApprovedForms(db, firmId);
        if (!forms.length) return "";
        return formBankCatalogue(forms);
    } catch {
        return "";
    }
}

/** The notes on one entry, as the tools hand them back to the model. */
export function formMetadataForModel(form: FirmForm): Record<string, unknown> {
    return {
        form_id: form.id,
        title: form.title,
        document_type: form.document_type,
        usage_mode: form.usage_mode,
        variant_notes: form.variant_notes,
        description: form.description,
        practice: form.practice,
        jurisdictions: form.jurisdictions,
        drafting_guidance: form.drafting_guidance,
        ...(form.usage_mode === "fill"
            ? { required_fields: form.required_fields }
            : {}),
    };
}
