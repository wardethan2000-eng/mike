// The citation checklist.
//
// When someone asks for the citations in a document to be checked, the model
// is the last thing that should decide which citations there are: a model that
// is running short of room quietly shortens its own list, and the answer still
// reads as if the job was finished. So the system reads the authorities out of
// the document itself, keeps track of which ones were actually pulled up
// during the turn, and says at the end which ones were left.
//
// The same matching is used by the diligence note in streaming.ts, which asks
// the mirror-image question: which authorities did the answer name that were
// never retrieved.

export type AuthorityKind = "case" | "statute";

export type Authority = {
  kind: AuthorityKind;
  /** The citation as it was written, whitespace collapsed. */
  display: string;
  /**
   * Every form this citation might have been stored under. An authority
   * counts as covered when any one of them was retrieved.
   */
  keys: string[];
};

/** Authorities found in one document that was read during the turn. */
export type ChecklistDocument = {
  label: string;
  authorities: Authority[];
};

export type AuthorityChecklistState = {
  /** Keyed by document label so re-reading a document does not double-count. */
  byDocument: Map<string, ChecklistDocument>;
};

export function newAuthorityChecklistState(): AuthorityChecklistState {
  return { byDocument: new Map() };
}

// Citations are written a dozen ways for the same section — with and without
// section marks, spaces and full stops — so comparison happens on a stripped
// form rather than the text as written.
export function normalizeAuthorityKey(citation: string): string {
  return citation.replace(/[\s.,§]/g, "").toUpperCase();
}

/** Drop a subsection so K.S.A. 60-206(a) matches the section that was pulled. */
export function baseAuthorityKey(citation: string): string {
  return normalizeAuthorityKey(citation).replace(/\(.*$/, "");
}

// A statute is stored both under its full citation and under its bare number
// ("K.S.A. 58-2540" and "58-2540"), and it may be written with the state's
// name at either end ("RSMo 407.020", "407.020, RSMo"), so every statute key
// carries its stripped forms too.
function statuteKeys(citation: string): string[] {
  const full = baseAuthorityKey(citation);
  const candidates = [
    full,
    full.replace(/^[A-Z]+/, ""),
    full.replace(/[A-Z]+$/, ""),
  ];
  const keys: string[] = [];
  for (const candidate of candidates) {
    if (!candidate || !/\d/.test(candidate)) continue;
    if (!keys.includes(candidate)) keys.push(candidate);
  }
  return keys;
}

const REPORTER_RE =
  /\b\d{1,4}\s+(?:U\.S\.|F\.(?:2d|3d|4th)|F\.\s?Supp\.(?:\s?[23]d)?|Kan\.\s?App\.\s?2d|Kan\.|P\.(?:2d|3d))\s+\d{1,5}\b/g;

const KSA_RE =
  /\bK\.S\.A\.\s?(?:§+\s?)?\d+[a-z]?-[\d]+[a-z0-9]*(?:\([^)\s]{1,8}\))*/g;

// Missouri sections are numbered 407.020 and carry "RSMo" on one side or the
// other, or are spelled out as Mo. Rev. Stat.
const RSMO_RE =
  /\b(?:RSMo\.?|Mo\.\s?Rev\.\s?Stat\.)\s?(?:§+\s?)?\d+\.\d+(?:\([^)\s]{1,8}\))*|(?:§+\s?)?\b\d+\.\d+(?:\([^)\s]{1,8}\))*\s?,?\s?RSMo\b\.?/g;

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Every case and statute cited in a piece of text, in the order they first
 * appear. Deduplicated on the normalized citation, so the same authority
 * cited twenty times counts once.
 */
export function extractAuthorities(text: string): Authority[] {
  if (!text) return [];
  const found: Authority[] = [];
  const seen = new Set<string>();
  const add = (kind: AuthorityKind, raw: string, keys: string[]) => {
    if (keys.length === 0) return;
    if (seen.has(keys[0])) return;
    seen.add(keys[0]);
    found.push({ kind, display: collapse(raw), keys });
  };
  for (const match of text.matchAll(REPORTER_RE)) {
    add("case", match[0], [normalizeAuthorityKey(match[0])]);
  }
  for (const match of text.matchAll(KSA_RE)) {
    add("statute", match[0], statuteKeys(match[0]));
  }
  for (const match of text.matchAll(RSMO_RE)) {
    add("statute", match[0], statuteKeys(match[0]));
  }
  return found;
}

/**
 * The authorities whose actual text was retrieved during this turn — pulled
 * cases and looked-up statute sections. Anything outside this set was only
 * ever read off a page or recalled by the model.
 */
export function coveredAuthorityKeys(args: {
  caseCitations: Iterable<string>;
  legislationIds: Iterable<string>;
}): Set<string> {
  const covered = new Set<string>();
  for (const citation of args.caseCitations) {
    covered.add(normalizeAuthorityKey(citation));
  }
  for (const legId of args.legislationIds) {
    for (const key of statuteKeys(legId)) covered.add(key);
  }
  return covered;
}

export function isCovered(authority: Authority, covered: Set<string>): boolean {
  return authority.keys.some((key) => covered.has(key));
}

/**
 * The assistant's own running notes are not a document under review. Without
 * this, reading the notes back turns every citation the assistant wrote down
 * into an item it is then accused of not having checked.
 */
// Copied rather than imported so this file stays free of storage and database
// imports; a test asserts it still matches RESEARCH_NOTES_HEADER_LINE.
const NOTES_HEADER_LINE = "Written by the assistant as the work was done.";

function isAssistantsOwnNotes(text: string): boolean {
  return text.slice(0, 400).includes(NOTES_HEADER_LINE);
}

/** Note the authorities in a document the model just read. */
export function recordDocumentAuthorities(
  state: AuthorityChecklistState | undefined,
  label: string,
  text: string,
): void {
  if (!state || !label) return;
  if (state.byDocument.has(label)) return;
  if (isAssistantsOwnNotes(text)) return;
  const authorities = extractAuthorities(text);
  if (authorities.length === 0) return;
  state.byDocument.set(label, { label, authorities });
}

const AUTHORITY_WORDS =
  /\b(?:citations?|cites?|citing|authorit(?:y|ies)|cases?|statutes?|sources?)\b/;
const CHECKING_WORDS =
  /\b(?:check|checks|checked|checking|verify|verifies|verified|verifying|accurac(?:y|ies)|accurate|confirm|confirms|confirmed|validate|validated)\b/;

/**
 * Whether a request is asking for the authorities in a document to be checked.
 * Deliberately narrow: the checklist note is only ever worth showing on this
 * kind of work, and a note on a drafting turn would just be noise.
 */
export function asksForCitationCheck(message: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return AUTHORITY_WORDS.test(lower) && CHECKING_WORDS.test(lower);
}

const CONTINUATION_RE =
  /^\s*(?:\[system\][\s\S]*|keep going|carry on[\s\S]*|continue|go on|please continue|carry on from those notes[\s\S]*)\s*$/i;

/**
 * The request a turn is actually working on. A resumed turn's last message is
 * "keep going", which says nothing about the job, so this walks back to the
 * message that does.
 */
export function latestRequestText(userMessages: string[]): string {
  for (let i = userMessages.length - 1; i >= 0; i -= 1) {
    const text = userMessages[i] ?? "";
    if (!text.trim()) continue;
    if (CONTINUATION_RE.test(text)) continue;
    return text;
  }
  return "";
}

/** Never list more than this many missing authorities in the note. */
const MAX_LISTED = 8;

/**
 * The one visible line the reader sees. Returns null when there is nothing
 * worth saying — everything was checked, or there was no checklist at all.
 */
export function buildChecklistNote(args: {
  state: AuthorityChecklistState;
  covered: Set<string>;
  /**
   * Authorities the answer's own diligence note already names. Repeating them
   * here would say the same thing twice; what this note is for is the ones
   * the answer never mentioned at all.
   */
  alreadyReported?: Set<string>;
}): string | null {
  const authorities: Authority[] = [];
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const doc of args.state.byDocument.values()) {
    labels.push(doc.label);
    for (const authority of doc.authorities) {
      if (seen.has(authority.keys[0])) continue;
      seen.add(authority.keys[0]);
      authorities.push(authority);
    }
  }
  // One stray citation in a document is not a citation list; saying "0 of 1
  // authorities addressed" on an unrelated turn would be noise.
  if (authorities.length < 2) return null;
  const missing = authorities.filter((a) => !isCovered(a, args.covered));
  if (missing.length === 0) return null;
  const unreported = args.alreadyReported
    ? missing.filter((a) => !a.keys.some((key) => args.alreadyReported!.has(key)))
    : missing;
  if (unreported.length === 0) return null;
  const addressed = authorities.length - missing.length;
  const shown = unreported.slice(0, MAX_LISTED).map((a) => a.display);
  const suffix =
    unreported.length > shown.length
      ? ` and ${unreported.length - shown.length} more`
      : "";
  const where = labels.length === 1 ? ` in ${labels[0]}` : "";
  // "Also" when the diligence note above already named some of them.
  const lead = args.alreadyReported?.size
    ? "Also not yet checked"
    : "Not yet checked";
  return `\n\n*Checklist: ${addressed} of ${authorities.length} authorities${where} addressed. ${lead}: ${shown.join("; ")}${suffix}.*`;
}
