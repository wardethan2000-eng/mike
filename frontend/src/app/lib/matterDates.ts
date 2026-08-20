/**
 * The dates a matter is working towards, read out of the facts it remembers.
 *
 * A matter already records its hearings and deadlines as facts under "Dates",
 * written the way a person would write them — "Answer due September 2" or
 * "Scheduling conference 9/18/2026". Nobody types them twice into a separate
 * calendar, so the front page reads the day back out of the words instead.
 *
 * Only dates still to come are shown. A fact about something that already
 * happened ("the amendment was recorded on 5 June 2021") is left where it is,
 * in the list of facts, which is also why nothing here needs to guess whether
 * a date is a deadline or a piece of history: the past filters itself out.
 *
 * A fact whose date cannot be read is not lost either — it stays in the facts
 * list like any other. This only ever adds a shortcut.
 */

const MONTHS: Record<string, number> = {
    jan: 0,
    january: 0,
    feb: 1,
    february: 1,
    mar: 2,
    march: 2,
    apr: 3,
    april: 3,
    may: 4,
    jun: 5,
    june: 5,
    jul: 6,
    july: 6,
    aug: 7,
    august: 7,
    sep: 8,
    sept: 8,
    september: 8,
    oct: 9,
    october: 9,
    nov: 10,
    november: 10,
    dec: 11,
    december: 11,
};

const MONTH_NAMES = Object.keys(MONTHS).sort((a, b) => b.length - a.length);

/** 2026-09-02 */
const ISO_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/;
/** 9/2/2026, 09/02/26, 9-2-2026 */
const NUMERIC_RE = /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2}|\d{4}))?\b/;
/** September 2, 2026 · Sept 2 · Sep 2nd 2026 */
const MONTH_FIRST_RE = new RegExp(
    `\\b(${MONTH_NAMES.join("|")})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`,
    "i",
);
/** 2 September 2026 · 2nd Sept */
const DAY_FIRST_RE = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_NAMES.join("|")})\\.?(?:,?\\s+(\\d{4}))?\\b`,
    "i",
);

/**
 * How far back a date written without a year may fall before it is read as
 * next year's. "Answer due January 8" written in December means the January
 * a few weeks away, not the one ten months gone.
 */
const BACKDATE_GRACE_DAYS = 45;

export type MatterDate = {
    /** The day itself, at midnight where the reader is. */
    date: Date;
    /**
     * The fact with the date taken out — "Answer due September 2" reads back
     * as "Answer due". Falls back to the whole fact when nothing is left.
     */
    label: string;
    /** The fact as written, for the title text on hover. */
    body: string;
};

function daysBetween(from: Date, to: Date): number {
    const DAY_MS = 24 * 60 * 60 * 1000;
    return Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / DAY_MS);
}

function startOfDay(value: Date): Date {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function isRealDate(year: number, month: number, day: number): boolean {
    const candidate = new Date(year, month, day);
    return (
        candidate.getFullYear() === year &&
        candidate.getMonth() === month &&
        candidate.getDate() === day
    );
}

/**
 * The year to read into a date written without one: this year unless that has
 * already gone by, in which case next year.
 */
function inferYear(month: number, day: number, now: Date): number {
    const thisYear = new Date(now.getFullYear(), month, day);
    if (daysBetween(now, thisYear) >= -BACKDATE_GRACE_DAYS) {
        return now.getFullYear();
    }
    return now.getFullYear() + 1;
}

function fullYear(raw: string): number {
    const value = Number.parseInt(raw, 10);
    return raw.length === 2 ? 2000 + value : value;
}

/** Everything left once the date is taken out, tidied at both ends. */
function labelFrom(body: string, matched: string): string {
    const remainder = body.replace(matched, " ");
    const cleaned = remainder
        .replace(/\s+/g, " ")
        // Words that only made sense joined to the date they introduced.
        // "Due" is kept: "Answer due" says something "Answer" alone does not.
        .replace(/\b(on|by|is|are|was|set for|scheduled for|at)\s*$/i, "")
        .replace(/^[\s,;:.\-—–]+|[\s,;:.\-—–]+$/g, "")
        .trim();
    if (!cleaned) return body.trim();
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/**
 * The day a fact is talking about, or null when it does not name one.
 *
 * Reads the first date in the text. A fact that names two ("continued from
 * June 4 to September 2") is rare and reads as the earlier one; correcting
 * that would mean guessing which one matters, and the fact itself is one click
 * away in the list.
 */
export function parseFactDate(body: string, now: Date = new Date()): MatterDate | null {
    const text = body.trim();
    if (!text) return null;

    const iso = ISO_RE.exec(text);
    if (iso) {
        const [matched, year, month, day] = iso;
        const y = Number(year);
        const m = Number(month) - 1;
        const d = Number(day);
        if (isRealDate(y, m, d)) {
            return { date: new Date(y, m, d), label: labelFrom(text, matched), body: text };
        }
    }

    const monthFirst = MONTH_FIRST_RE.exec(text);
    if (monthFirst) {
        const [matched, name, day, year] = monthFirst;
        const m = MONTHS[name.toLowerCase()];
        const d = Number(day);
        const y = year ? fullYear(year) : inferYear(m, d, now);
        if (isRealDate(y, m, d)) {
            return { date: new Date(y, m, d), label: labelFrom(text, matched), body: text };
        }
    }

    const dayFirst = DAY_FIRST_RE.exec(text);
    if (dayFirst) {
        const [matched, day, name, year] = dayFirst;
        const m = MONTHS[name.toLowerCase()];
        const d = Number(day);
        const y = year ? fullYear(year) : inferYear(m, d, now);
        if (isRealDate(y, m, d)) {
            return { date: new Date(y, m, d), label: labelFrom(text, matched), body: text };
        }
    }

    const numeric = NUMERIC_RE.exec(text);
    if (numeric) {
        const [matched, month, day, year] = numeric;
        // Read as month/day, the way dates are written in a US practice.
        const m = Number(month) - 1;
        const d = Number(day);
        const y = year ? fullYear(year) : inferYear(m, d, now);
        if (m >= 0 && m <= 11 && isRealDate(y, m, d)) {
            return { date: new Date(y, m, d), label: labelFrom(text, matched), body: text };
        }
    }

    return null;
}

/**
 * The dates still to come, soonest first.
 *
 * Today counts as still to come — a hearing this afternoon is the most
 * important thing on the page, not the least.
 */
export function upcomingDates(
    bodies: string[],
    now: Date = new Date(),
    limit = 4,
): MatterDate[] {
    const found: MatterDate[] = [];
    for (const body of bodies) {
        const parsed = parseFactDate(body, now);
        if (parsed && daysBetween(now, parsed.date) >= 0) found.push(parsed);
    }
    found.sort((a, b) => a.date.getTime() - b.date.getTime());
    return found.slice(0, limit);
}

/** How many days away a date is. Negative once it has gone by. */
export function daysUntil(date: Date, now: Date = new Date()): number {
    return daysBetween(now, date);
}

/** "Sep 2" — the year only when it is not this one. */
export function formatDay(date: Date, now: Date = new Date()): string {
    return date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
    });
}

/**
 * How near a date is, in words — "today", "tomorrow", "in 13 days". Anything
 * further off than a month says nothing: the date itself is enough by then.
 */
export function formatNearness(date: Date, now: Date = new Date()): string | null {
    const days = daysBetween(now, date);
    if (days < 0) return null;
    if (days === 0) return "today";
    if (days === 1) return "tomorrow";
    if (days <= 30) return `in ${days} days`;
    return null;
}

/** A date close enough that missing it is the day's problem. */
export function isPressing(date: Date, now: Date = new Date()): boolean {
    const days = daysBetween(now, date);
    return days >= 0 && days <= 7;
}
