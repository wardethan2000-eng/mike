/**
 * Who is asking, and on whose behalf.
 *
 * Mike knew what was in a matter but nothing about the person working it, so
 * a letter it drafted was signed by nobody — or, worse, by a bar number it had
 * made up. These two helpers put the firm's own details and the attorney's own
 * details in front of the model, as facts it may use rather than instructions
 * it must follow.
 *
 * Both are quiet: a person who has filled nothing in adds nothing to the
 * prompt, and a paralegal with no bar number simply has no bar line.
 */

import type { createServerSupabase } from "./supabase";
import { getFirm } from "./firm";
import { formBankSection } from "./formBank";

type Db = ReturnType<typeof createServerSupabase>;

export type BarAdmission = {
    state: string;
    bar_number: string;
    status?: string;
};

export type ProfessionalDetails = {
    display_name: string | null;
    prof_title: string | null;
    prof_phone: string | null;
    practice_areas: string[];
    bar_admissions: BarAdmission[];
    signature_block: string | null;
};

export const EMPTY_PROFESSIONAL_DETAILS: ProfessionalDetails = {
    display_name: null,
    prof_title: null,
    prof_phone: null,
    practice_areas: [],
    bar_admissions: [],
    signature_block: null,
};

export function normalizeBarAdmissions(value: unknown): BarAdmission[] {
    if (!Array.isArray(value)) return [];
    const out: BarAdmission[] = [];
    for (const entry of value) {
        if (!entry || typeof entry !== "object") continue;
        const row = entry as Record<string, unknown>;
        const state = typeof row.state === "string" ? row.state.trim() : "";
        const barNumber =
            typeof row.bar_number === "string" ? row.bar_number.trim() : "";
        if (!state || !barNumber) continue;
        const status =
            typeof row.status === "string" && row.status.trim()
                ? row.status.trim()
                : undefined;
        out.push({ state, bar_number: barNumber, ...(status ? { status } : {}) });
    }
    return out;
}

/**
 * Read the professional fields on their own rather than widening the main
 * profile query, which carries a fallback chain for older databases that this
 * would otherwise break. A database without these columns yields blanks.
 */
export async function loadProfessionalDetails(
    db: Db,
    userId: string,
): Promise<ProfessionalDetails> {
    try {
        const { data, error } = await db
            .from("user_profiles")
            .select(
                "display_name, prof_title, prof_phone, practice_areas, bar_admissions, signature_block",
            )
            .eq("user_id", userId)
            .maybeSingle();
        if (error || !data) return EMPTY_PROFESSIONAL_DETAILS;
        const row = data as Record<string, unknown>;
        return {
            display_name:
                typeof row.display_name === "string" ? row.display_name : null,
            prof_title:
                typeof row.prof_title === "string" ? row.prof_title : null,
            prof_phone:
                typeof row.prof_phone === "string" ? row.prof_phone : null,
            practice_areas: Array.isArray(row.practice_areas)
                ? (row.practice_areas as string[])
                : [],
            bar_admissions: normalizeBarAdmissions(row.bar_admissions),
            signature_block:
                typeof row.signature_block === "string"
                    ? row.signature_block
                    : null,
        };
    } catch {
        return EMPTY_PROFESSIONAL_DETAILS;
    }
}

function formatAdmission(admission: BarAdmission): string {
    const status =
        admission.status && admission.status.toLowerCase() !== "active"
            ? ` (${admission.status})`
            : "";
    return `${admission.state} #${admission.bar_number}${status}`;
}

/**
 * The block describing the person asking. Returns an empty string when there
 * is nothing worth saying, so callers can concatenate it unconditionally.
 */
export function attorneyContextSection(
    person: {
        displayName?: string | null;
        email?: string | null;
    },
    details: ProfessionalDetails,
): string {
    const lines: string[] = [];
    const name = person.displayName?.trim();
    if (name) {
        lines.push(
            details.prof_title?.trim()
                ? `Name: ${name}, ${details.prof_title.trim()}`
                : `Name: ${name}`,
        );
    }
    if (details.bar_admissions.length) {
        lines.push(
            `Admitted to practise: ${details.bar_admissions
                .map(formatAdmission)
                .join("; ")}`,
        );
    }
    if (details.practice_areas.length) {
        lines.push(`Practice areas: ${details.practice_areas.join(", ")}`);
    }
    const contact = [details.prof_phone?.trim(), person.email?.trim()].filter(
        Boolean,
    );
    if (contact.length) lines.push(`Contact: ${contact.join(" · ")}`);

    const signature = details.signature_block?.trim();
    if (!lines.length && !signature) return "";

    let section =
        "\n\nTHE PERSON YOU ARE WORKING FOR\nThese are facts about the person asking, for use when a document has to be signed or a bar number given. Never invent a bar number, and never attribute an admission that is not listed here.";
    if (lines.length) section += `\n${lines.join("\n")}`;
    if (signature) {
        section += `\nSignature block — reproduce it exactly as written, line for line, when a letter or filing needs signing:\n${signature}`;
    }
    return section;
}

export type DraftingDefaults = {
    font?: string;
    font_size_pt?: number;
    line_spacing?: "single" | "1.5" | "double";
    paragraph_style_notes?: string;
};

export const LINE_SPACINGS = ["single", "1.5", "double"] as const;

/**
 * How the firm likes a document to look when Mike is building one from
 * nothing. Anything unrecognised is dropped rather than passed on, so a bad
 * value can never reach the page.
 */
export function normalizeDraftingDefaults(value: unknown): DraftingDefaults {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const row = value as Record<string, unknown>;
    const out: DraftingDefaults = {};

    if (typeof row.font === "string" && row.font.trim()) {
        out.font = row.font.trim().slice(0, 60);
    }
    const size = Number(row.font_size_pt);
    if (Number.isFinite(size) && size >= 6 && size <= 24) {
        out.font_size_pt = Math.round(size * 2) / 2;
    }
    if (
        typeof row.line_spacing === "string" &&
        (LINE_SPACINGS as readonly string[]).includes(row.line_spacing)
    ) {
        out.line_spacing = row.line_spacing as DraftingDefaults["line_spacing"];
    }
    if (
        typeof row.paragraph_style_notes === "string" &&
        row.paragraph_style_notes.trim()
    ) {
        out.paragraph_style_notes = row.paragraph_style_notes
            .trim()
            .slice(0, 1000);
    }
    return out;
}

/**
 * The house look, written out for the model. Empty when the firm has not set
 * one, so a firm that never fills this in reads exactly as it did before.
 */
export function draftingDefaultsSection(defaults: DraftingDefaults): string {
    const lines: string[] = [];
    if (defaults.font) lines.push(`Typeface: ${defaults.font}`);
    if (defaults.font_size_pt) {
        lines.push(`Body text size: ${defaults.font_size_pt} point`);
    }
    if (defaults.line_spacing) {
        lines.push(`Line spacing: ${defaults.line_spacing}`);
    }
    if (defaults.paragraph_style_notes) {
        lines.push(defaults.paragraph_style_notes);
    }
    if (!lines.length) return "";
    return `\nHouse style for a document built from nothing — pass these to generate_docx unless the user or the court asks for something else. When you are copying one of the firm's own documents instead, its own look wins and these are ignored:\n${lines.join(
        "\n",
    )}`;
}

/** The firm's own details, and anything it wants said on every matter. */
export async function firmContextSection(db: Db): Promise<string> {
    const firm = await getFirm(db);
    if (!firm) return "";

    const lines: string[] = [`Firm: ${firm.name}`];
    const address = Array.isArray(firm.address_lines)
        ? firm.address_lines.filter((line) => !!line && line.trim())
        : [];
    if (address.length) lines.push(`Address: ${address.join(", ")}`);
    if (firm.phone?.trim()) lines.push(`Phone: ${firm.phone.trim()}`);
    if (firm.default_jurisdiction?.trim()) {
        lines.push(`Practises mainly in: ${firm.default_jurisdiction.trim()}`);
    }
    if (firm.citation_style?.trim()) {
        lines.push(`Citation style: ${firm.citation_style.trim()}`);
    }

    let section = `\n\nTHE FIRM\n${lines.join("\n")}`;
    const standing = firm.standing_instructions?.trim();
    if (standing) {
        section += `\nHow this firm wants things done:\n${standing}`;
    }
    section += draftingDefaultsSection(
        normalizeDraftingDefaults(firm.drafting_defaults),
    );
    return section;
}

/**
 * Everything about the asker and their firm, ready to append to a chat's
 * system prompt. Empty when neither has anything to say.
 *
 * The firm's banked model documents ride along here too, so drafting starts
 * from the firm's own paperwork in a matter, outside a matter and in Word
 * alike — all three go through this one place.
 */
export async function whoIsAskingSection(
    db: Db,
    userId: string,
    email?: string | null,
): Promise<string> {
    const [details, firmSection, bankSection] = await Promise.all([
        loadProfessionalDetails(db, userId),
        firmContextSection(db),
        formBankSection(db, userId),
    ]);
    return `${firmSection}${attorneyContextSection(
        { displayName: details.display_name, email },
        details,
    )}${bankSection}`;
}
