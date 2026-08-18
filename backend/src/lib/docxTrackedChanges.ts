/**
 * DOCX tracked-changes helpers.
 *
 * `applyTrackedEdits` rewrites a .docx so that the requested substitutions
 * appear as `<w:ins>` / `<w:del>` tracked changes rather than direct text
 * replacements. `resolveTrackedChange` accepts or rejects one change by
 * its `w:id`, producing a new .docx with only that change collapsed.
 *
 * Only text inside `<w:p><w:r><w:t>` is considered. Headers, footers,
 * comments, footnotes are left alone. Pre-existing tracked changes in the
 * paragraph are presented to the matcher in *accepted view*: w:ins runs are
 * treated as normal text, w:del wrappers are invisible. When a new edit's
 * range lands on runs inside a pre-existing w:ins, the wrapper is dropped
 * (accepting that insertion) before the new change is emitted.
 */

import JSZip from "jszip";
import { XMLParser, XMLBuilder } from "fast-xml-parser";
import fastDiff from "fast-diff";

// ---------------------------------------------------------------------------
// JSZip path helpers
// ---------------------------------------------------------------------------
//
// Some older Windows/Word archives store entries with backslash path
// separators (e.g. `word\document.xml`) even though the zip spec requires
// forward slashes. JSZip looks up entries by exact string, so
// `zip.file("word/document.xml")` misses those files. These helpers accept
// the canonical forward-slash form and transparently fall back to the
// backslash variant for both reads and writes.

function getZipEntry(zip: JSZip, pathSlash: string) {
    const direct = zip.file(pathSlash);
    if (direct) return direct;
    return zip.file(pathSlash.replace(/\//g, "\\"));
}

function setZipEntry(
    zip: JSZip,
    pathSlash: string,
    content: string | Buffer,
): void {
    const backslash = pathSlash.replace(/\//g, "\\");
    // If the archive already stores the entry under backslashes, keep it
    // there so we don't emit both variants side by side.
    if (!zip.file(pathSlash) && zip.file(backslash)) {
        zip.file(backslash, content);
        return;
    }
    zip.file(pathSlash, content);
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EditInput {
    find: string;
    replace: string;
    context_before: string;
    context_after: string;
    reason?: string;
}

export interface AppliedChange {
    id: string;
    delId?: string;
    insId?: string;
    /**
     * w:id values for paragraph-mark changes that belong to this same logical
     * change (a new paragraph created by this edit, or the paragraph mark of a
     * paragraph this edit deleted outright). Accepting or rejecting the change
     * must resolve these alongside delId/insId.
     */
    extraInsIds?: string[];
    extraDelIds?: string[];
    deletedText: string;
    insertedText: string;
    contextBefore: string;
    contextAfter: string;
    reason?: string;
}

export interface EditError {
    index: number;
    reason: string;
}

export interface ApplyTrackedEditsResult {
    bytes: Buffer;
    changes: AppliedChange[];
    errors: EditError[];
}

// ---------------------------------------------------------------------------
// Preserve-order tree helpers
// ---------------------------------------------------------------------------

type XNode = Record<string, unknown>;

const ATTR_KEY = ":@";
const TEXT_KEY = "#text";

function elName(n: unknown): string | null {
    if (!n || typeof n !== "object") return null;
    for (const k of Object.keys(n as XNode)) {
        if (k === ATTR_KEY || k === TEXT_KEY) continue;
        return k;
    }
    return null;
}

function isTextNode(n: unknown): n is { [TEXT_KEY]: string } {
    if (!n || typeof n !== "object") return false;
    const obj = n as XNode;
    return TEXT_KEY in obj && elName(n) === null;
}

function elChildren(n: unknown): XNode[] {
    const name = elName(n);
    if (!name) return [];
    const v = (n as XNode)[name];
    return Array.isArray(v) ? (v as XNode[]) : [];
}

function setChildren(n: XNode, children: XNode[]): void {
    const name = elName(n);
    if (!name) return;
    n[name] = children;
}

function elAttrs(n: unknown): Record<string, string> {
    if (!n || typeof n !== "object") return {};
    const a = (n as XNode)[ATTR_KEY];
    return (a as Record<string, string>) ?? {};
}

function makeEl(
    name: string,
    children: XNode[] = [],
    attrs?: Record<string, string>,
): XNode {
    const el: XNode = { [name]: children };
    if (attrs) {
        const attrObj: Record<string, string> = {};
        for (const [k, v] of Object.entries(attrs)) {
            attrObj[`@_${k}`] = v;
        }
        el[ATTR_KEY] = attrObj;
    }
    return el;
}

function makeText(s: string): XNode {
    return { [TEXT_KEY]: s };
}

// ---------------------------------------------------------------------------
// Paragraph-level tracked changes
// ---------------------------------------------------------------------------
//
// A replacement may span more than one paragraph: a blank line in an edit's
// `replace` string means "start a new paragraph here". Word models that as a
// new paragraph whose *paragraph mark* is itself an insertion, recorded as
// <w:pPr><w:rPr><w:ins .../></w:rPr></w:pPr>. Rejecting such a change removes
// the mark, which merges the text back into the following paragraph, so the
// document returns to exactly its previous shape. Deleting a whole paragraph
// is the mirror image: the runs are wrapped in <w:del> and the paragraph mark
// carries <w:del>, so accepting removes the blank line as well as the text.
//
// PBREAK_KEY marks a paragraph split inside the flat run stream that
// `reconstructParagraph` builds. It never reaches the XML: the stream is cut
// into separate <w:p> nodes on these markers before the tree is rebuilt.

const PBREAK_KEY = "mike:pbreak";

function makeParagraphBreakMarker(): XNode {
    return { [PBREAK_KEY]: [] };
}

function isParagraphBreakMarker(n: unknown): boolean {
    return elName(n) === PBREAK_KEY;
}

/** Split inserted text on blank lines into per-paragraph pieces. */
function splitIntoParagraphs(text: string): string[] {
    return text.split(/\r?\n[ \t]*\r?\n/);
}

function findChildByName(children: XNode[], name: string): XNode | null {
    for (const c of children) if (elName(c) === name) return c;
    return null;
}

/**
 * Return a copy of `pPr` whose paragraph mark is flagged as inserted or
 * deleted. Inside w:pPr the run properties element sits near the end (but
 * before w:sectPr / w:pPrChange), and inside w:rPr the w:ins / w:del element
 * must come first — both required by the OOXML schema, and Word rejects the
 * file otherwise.
 */
function withParagraphMarkChange(
    pPr: XNode | null,
    kind: "w:ins" | "w:del",
    wId: string,
    author: string,
    now: string,
): XNode {
    const base = pPr ? cloneNode(pPr) : makeEl("w:pPr", []);
    const kids = elChildren(base);
    const mark = makeEl(kind, [], {
        "w:id": wId,
        "w:author": author,
        "w:date": now,
    });
    const existingRPr = findChildByName(kids, "w:rPr");
    if (existingRPr) {
        setChildren(existingRPr, [mark, ...elChildren(existingRPr)]);
        return base;
    }
    const rPr = makeEl("w:rPr", [mark]);
    const tailIdx = kids.findIndex(
        (k) => elName(k) === "w:sectPr" || elName(k) === "w:pPrChange",
    );
    if (tailIdx >= 0) kids.splice(tailIdx, 0, rPr);
    else kids.push(rPr);
    setChildren(base, kids);
    return base;
}

/**
 * Inspect a paragraph's mark for a tracked change with one of `ids`.
 * "merge" means the paragraph mark goes away, so this paragraph's remaining
 * content joins the paragraph that follows it.
 */
function resolveParagraphMark(
    paraNode: XNode,
    ids: Set<string>,
    mode: "accept" | "reject",
): { touched: boolean; merge: boolean } {
    const pPr = findChildByName(elChildren(paraNode), "w:pPr");
    if (!pPr) return { touched: false, merge: false };
    const rPr = findChildByName(elChildren(pPr), "w:rPr");
    if (!rPr) return { touched: false, merge: false };

    let touched = false;
    let merge = false;
    const kept: XNode[] = [];
    for (const c of elChildren(rPr)) {
        const name = elName(c);
        if (name !== "w:ins" && name !== "w:del") {
            kept.push(c);
            continue;
        }
        const wId = String(elAttrs(c)["@_w:id"] ?? "");
        if (!ids.has(wId)) {
            kept.push(c);
            continue;
        }
        touched = true;
        const keepsMark =
            (name === "w:ins" && mode === "accept") ||
            (name === "w:del" && mode === "reject");
        if (!keepsMark) merge = true;
        // Either way the tracked marker itself is consumed.
    }
    if (touched) setChildren(rPr, kept);
    return { touched, merge };
}

function getTextContent(wtEl: XNode): string {
    // A w:t node has only a single text child (or nothing).
    const kids = elChildren(wtEl);
    let out = "";
    for (const k of kids) {
        if (isTextNode(k)) out += String(k[TEXT_KEY] ?? "");
    }
    return out;
}

// Build a w:r element that wraps a piece of text. Newlines in the text are
// emitted as <w:br/> soft line breaks (interleaved with w:t/w:delText
// segments) so models can request multi-line replacements without the
// literal "\n" showing up as visible text.
function buildRun(rPr: XNode | null, text: string, tagName: "w:t" | "w:delText"): XNode {
    const children: XNode[] = [];
    if (rPr) children.push(cloneNode(rPr));
    const segments = text.split("\n");
    for (let i = 0; i < segments.length; i++) {
        if (i > 0) children.push(makeEl("w:br", []));
        const seg = segments[i];
        if (seg.length > 0) {
            children.push(
                makeEl(tagName, [makeText(seg)], { "xml:space": "preserve" }),
            );
        }
    }
    return makeEl("w:r", children);
}

function cloneNode<T>(n: T): T {
    return JSON.parse(JSON.stringify(n)) as T;
}

// ---------------------------------------------------------------------------
// Paragraph flattening
// ---------------------------------------------------------------------------

interface RunSlot {
    childIndex: number;         // index in paragraph.children
    rPr: XNode | null;          // reference (not cloned)
    /**
     * Per-w:t info. Slots preserve the relative order of the run's textual
     * children. Non-textual run children (w:tab, w:br, ...) are ignored for
     * the char stream but left in place via their surrounding w:r.
     */
    textNodes: { wtEl: XNode; text: string; paraStart: number; paraEnd: number }[];
}

interface Flattened {
    paraText: string;
    // For each char index in paraText: which run slot + which textNode + offset within text
    charRun: Int32Array;      // runIdx
    charTextNode: Int32Array; // index into slot.textNodes
    charOffset: Int32Array;   // offset within that textNode.text
    runs: RunSlot[];          // order corresponds to their paragraph position
}

function flattenParagraph(paraChildren: XNode[]): Flattened {
    const runs: RunSlot[] = [];
    let paraText = "";
    const charRunArr: number[] = [];
    const charTextNodeArr: number[] = [];
    const charOffsetArr: number[] = [];

    const processRun = (rEl: XNode, topChildIdx: number) => {
        const rKids = elChildren(rEl);
        let rPr: XNode | null = null;
        const textNodes: RunSlot["textNodes"] = [];
        for (const rk of rKids) {
            const name = elName(rk);
            if (name === "w:rPr") {
                rPr = rk;
            } else if (name === "w:t") {
                const txt = getTextContent(rk);
                const start = paraText.length;
                textNodes.push({
                    wtEl: rk,
                    text: txt,
                    paraStart: start,
                    paraEnd: start + txt.length,
                });
                const runIdx = runs.length;
                const tnIdx = textNodes.length - 1;
                paraText += txt;
                for (let i = 0; i < txt.length; i++) {
                    charRunArr.push(runIdx);
                    charTextNodeArr.push(tnIdx);
                    charOffsetArr.push(i);
                }
            }
            // other run children (w:tab, w:br, w:sym, …) are left alone
        }
        runs.push({ childIndex: topChildIdx, rPr, textNodes });
    };

    for (let ci = 0; ci < paraChildren.length; ci++) {
        const child = paraChildren[ci];
        const name = elName(child);
        if (name === "w:r") {
            processRun(child, ci);
        } else if (name === "w:ins") {
            // Accepted view: include inner runs as if bare. childIndex points
            // at the w:ins wrapper so reconstruction can drop the wrapper
            // whole when a new edit touches any of these runs.
            for (const inner of elChildren(child)) {
                if (elName(inner) === "w:r") processRun(inner, ci);
            }
        }
        // w:del: skip entirely — accepted view excludes deleted text.
    }

    return {
        paraText,
        charRun: Int32Array.from(charRunArr),
        charTextNode: Int32Array.from(charTextNodeArr),
        charOffset: Int32Array.from(charOffsetArr),
        runs,
    };
}

// ---------------------------------------------------------------------------
// Planning edits on a paragraph
// ---------------------------------------------------------------------------

/**
 * A single logical change. Spans a contiguous [start, end) character range in
 * the paragraph text (may be empty for a pure insert) and may carry an
 * inserted string appended at `start`.
 */
interface PlannedChange {
    editIndex: number;            // source edit index
    deleteStart: number;          // paragraph text offset (inclusive)
    deleteEnd: number;            // paragraph text offset (exclusive); may equal start
    deletedText: string;          // substring of paraText in [start, end)
    insertedText: string;         // may be empty
    contextBefore: string;
    contextAfter: string;
    reason?: string;
    changeId: string;             // logical id (not the w:id)
    delWId?: string;              // w:id of w:del wrapper (if deletedText non-empty)
    insWId?: string;              // w:id of w:ins wrapper (if insertedText non-empty)
    markInsWIds: string[];        // w:ids of paragraph marks this edit created
    markDelWIds: string[];        // w:ids of paragraph marks this edit deleted
}

/**
 * Collapse a `fast-diff` result into a minimal `{deletedText, insertedText}`
 * tuple anchored at a single start position. `fast-diff` produces
 * sequences like EQ-DEL-EQ-INS. For tracked-change UI we want one
 * "replace this substring with that substring" card per edit, so we
 * merge everything into the outer span.
 */
function collapseDiff(find: string, replace: string): { deleted: string; inserted: string; leadingEq: number; trailingEq: number } {
    // Find leading/trailing common substrings so the tracked range is minimal
    let leading = 0;
    const minLen = Math.min(find.length, replace.length);
    while (leading < minLen && find[leading] === replace[leading]) leading++;
    let trailing = 0;
    while (
        trailing < minLen - leading &&
        find[find.length - 1 - trailing] === replace[replace.length - 1 - trailing]
    ) {
        trailing++;
    }
    const deleted = find.slice(leading, find.length - trailing);
    const inserted = replace.slice(leading, replace.length - trailing);
    return { deleted, inserted, leadingEq: leading, trailingEq: trailing };
}

// ---------------------------------------------------------------------------
// Paragraph reconstruction
// ---------------------------------------------------------------------------

/**
 * Given a paragraph's children and a sorted, non-overlapping list of
 * `PlannedChange`s that fall within it, return a new children array with
 * tracked changes inserted.
 */
function reconstructParagraph(
    paraNode: XNode,
    paraChildren: XNode[],
    flat: Flattened,
    plan: PlannedChange[],
    now: string,
    author: string,
    allocWId: () => string,
    allowParagraphDelete: boolean,
): XNode[] {
    if (plan.length === 0) return [paraNode];

    // Determine the run-index span that edits touch.
    let firstRunIdx = flat.runs.length;
    let lastRunIdx = -1;
    for (const p of plan) {
        for (let pos = p.deleteStart; pos < p.deleteEnd; pos++) {
            const r = flat.charRun[pos];
            if (r < firstRunIdx) firstRunIdx = r;
            if (r > lastRunIdx) lastRunIdx = r;
        }
        // Also include the run to the left/right of a pure insertion so we
        // can inherit its rPr.
        if (p.deleteStart === p.deleteEnd && p.deleteStart < flat.paraText.length) {
            const r = flat.charRun[p.deleteStart];
            if (r < firstRunIdx) firstRunIdx = r;
            if (r > lastRunIdx) lastRunIdx = r;
        } else if (p.deleteStart === p.deleteEnd && p.deleteStart > 0) {
            const r = flat.charRun[p.deleteStart - 1];
            if (r < firstRunIdx) firstRunIdx = r;
            if (r > lastRunIdx) lastRunIdx = r;
        }
    }
    if (firstRunIdx > lastRunIdx) {
        // No runs touched (edits against empty paragraph?) — nothing to do.
        return [paraNode];
    }

    // Child-index range in paragraph.children we are going to replace.
    const startChildIdx = flat.runs[firstRunIdx].childIndex;
    const endChildIdx = flat.runs[lastRunIdx].childIndex;

    // Paragraph-text range that this run span covers.
    const firstRun = flat.runs[firstRunIdx];
    const lastRun = flat.runs[lastRunIdx];
    const spanStart =
        firstRun.textNodes.length > 0 ? firstRun.textNodes[0].paraStart : 0;
    const spanEnd =
        lastRun.textNodes.length > 0
            ? lastRun.textNodes[lastRun.textNodes.length - 1].paraEnd
            : spanStart;

    // Walk [spanStart, spanEnd) in paraText, producing a new children array.
    const newRunGroup: XNode[] = [];

    // Helper: get the rPr for the run containing paragraph offset `pos`
    // (clamped to the touched span). Used to inherit formatting for
    // insertions that fall exactly on a boundary.
    const rPrForPos = (pos: number): XNode | null => {
        if (pos < 0) pos = 0;
        if (pos >= flat.paraText.length) pos = flat.paraText.length - 1;
        if (pos < 0) return firstRun.rPr;
        return flat.runs[flat.charRun[pos]].rPr;
    };

    // Emit a "normal" run fragment covering [a, b) of paraText, grouping
    // consecutive chars that belong to the same source text node.
    const emitNormal = (a: number, b: number) => {
        if (a >= b) return;
        let i = a;
        while (i < b) {
            const runIdx = flat.charRun[i];
            const tnIdx = flat.charTextNode[i];
            let j = i + 1;
            while (
                j < b &&
                flat.charRun[j] === runIdx &&
                flat.charTextNode[j] === tnIdx
            ) {
                j++;
            }
            const slot = flat.runs[runIdx];
            const rPr = slot.rPr;
            const slice = flat.paraText.slice(i, j);
            newRunGroup.push(buildRun(rPr, slice, "w:t"));
            i = j;
        }
    };

    // Emit a w:del wrapping run fragments covering [a, b) of paraText.
    const emitDel = (a: number, b: number, wId: string) => {
        if (a >= b) return;
        const inner: XNode[] = [];
        let i = a;
        while (i < b) {
            const runIdx = flat.charRun[i];
            const tnIdx = flat.charTextNode[i];
            let j = i + 1;
            while (
                j < b &&
                flat.charRun[j] === runIdx &&
                flat.charTextNode[j] === tnIdx
            ) {
                j++;
            }
            const slot = flat.runs[runIdx];
            const slice = flat.paraText.slice(i, j);
            inner.push(buildRun(slot.rPr, slice, "w:delText"));
            i = j;
        }
        newRunGroup.push(
            makeEl("w:del", inner, {
                "w:id": wId,
                "w:author": author,
                "w:date": now,
            }),
        );
    };

    // Emit a w:ins at position `pos` inheriting rPr from there. A blank line
    // in the text starts a new paragraph, marked here and cut apart below.
    const emitIns = (pos: number, text: string, wId: string) => {
        if (!text) return;
        const rPr = rPrForPos(pos === spanEnd ? pos - 1 : pos);
        const pieces = splitIntoParagraphs(text);
        for (let i = 0; i < pieces.length; i++) {
            if (i > 0) newRunGroup.push(makeParagraphBreakMarker());
            if (!pieces[i]) continue;
            newRunGroup.push(
                makeEl("w:ins", [buildRun(rPr, pieces[i], "w:t")], {
                    "w:id": wId,
                    "w:author": author,
                    "w:date": now,
                }),
            );
        }
    };

    let cursor = spanStart;
    for (const p of plan) {
        // Untouched slice before this edit
        emitNormal(cursor, p.deleteStart);
        // Insertion fires at the edit boundary
        if (p.insertedText) emitIns(p.deleteStart, p.insertedText, p.insWId!);
        // Deletion wraps the span
        if (p.deleteEnd > p.deleteStart)
            emitDel(p.deleteStart, p.deleteEnd, p.delWId!);
        cursor = p.deleteEnd;
    }
    emitNormal(cursor, spanEnd);

    // Replace only the w:r children that the edits touch; preserve any other
    // interleaved elements (bookmarks, existing tracked-changes, w:sdt …) at
    // their original positions.
    const droppedChildIdx = new Set<number>();
    for (let r = firstRunIdx; r <= lastRunIdx; r++) {
        droppedChildIdx.add(flat.runs[r].childIndex);
    }
    // Any w:del wrappers that sit inside the span we're rewriting are also
    // dropped, which accepts their deletions (their text is already absent
    // from paraText in the accepted view).
    for (let i = startChildIdx; i <= endChildIdx; i++) {
        if (elName(paraChildren[i]) === "w:del") droppedChildIdx.add(i);
    }
    const firstDroppedIdx = startChildIdx;
    void endChildIdx;
    const out: XNode[] = [];
    for (let i = 0; i < paraChildren.length; i++) {
        if (i === firstDroppedIdx) {
            for (const n of newRunGroup) out.push(n);
        }
        if (droppedChildIdx.has(i)) continue;
        out.push(paraChildren[i]);
    }

    // Cut the child stream apart on paragraph-break markers. The last piece
    // keeps the paragraph's original mark and properties; every earlier piece
    // ends with a newly inserted mark, so rejecting the change stitches them
    // back into the single paragraph we started from.
    const originalPPr = findChildByName(out, "w:pPr");
    const pieces: XNode[][] = [[]];
    for (const n of out) {
        if (isParagraphBreakMarker(n)) {
            pieces.push([]);
            continue;
        }
        if (elName(n) === "w:pPr") continue;
        pieces[pieces.length - 1].push(n);
    }

    // A paragraph whose entire text is deleted with nothing put back also
    // loses its paragraph mark, so accepting removes the empty line it would
    // otherwise leave behind.
    const wholeParagraphDeleted =
        allowParagraphDelete &&
        pieces.length === 1 &&
        flat.paraText.length > 0 &&
        plan.length === 1 &&
        plan[0].deleteStart === 0 &&
        plan[0].deleteEnd === flat.paraText.length &&
        !plan[0].insertedText;

    if (wholeParagraphDeleted) {
        const wId = allocWId();
        plan[0].markDelWIds.push(wId);
        const pPr = withParagraphMarkChange(
            originalPPr,
            "w:del",
            wId,
            author,
            now,
        );
        setChildren(paraNode, [pPr, ...pieces[0]]);
        return [paraNode];
    }

    // Attribute each new paragraph mark to the edit whose text created it.
    const insertingPlans = plan.filter((p) => p.insertedText);
    const paraNodes: XNode[] = [];
    for (let i = 0; i < pieces.length; i++) {
        const isLast = i === pieces.length - 1;
        let pPr: XNode | null;
        if (isLast) {
            pPr = originalPPr;
        } else {
            const wId = allocWId();
            const owner = insertingPlans[Math.min(i, insertingPlans.length - 1)];
            if (owner) owner.markInsWIds.push(wId);
            pPr = withParagraphMarkChange(
                originalPPr,
                "w:ins",
                wId,
                author,
                now,
            );
        }
        const kids = pPr ? [pPr, ...pieces[i]] : pieces[i];
        if (i === 0) {
            setChildren(paraNode, kids);
            paraNodes.push(paraNode);
        } else {
            paraNodes.push(makeEl("w:p", kids));
        }
    }
    return paraNodes;
}

// ---------------------------------------------------------------------------
// Locating context in the document
// ---------------------------------------------------------------------------

interface ParagraphRef {
    paraNode: XNode;
    paraChildren: XNode[];
    flat: Flattened;
    globalStart: number; // where this paragraph starts in the full doc text
}

function indexAll(hay: string, needle: string): number[] {
    if (!needle) return [];
    const out: number[] = [];
    let i = 0;
    while (i <= hay.length - needle.length) {
        const j = hay.indexOf(needle, i);
        if (j < 0) break;
        out.push(j);
        i = j + 1;
    }
    return out;
}

// --- Whitespace / punctuation normalization for anchor matching -------------
// The text LLMs see (via mammoth's extractRawText) does not line up 1:1 with
// the raw w:t concatenation: smart quotes, non-breaking spaces, tabs, and
// runs of whitespace all differ. We normalize both haystack and needle to
// a canonical form for matching, then map matched offsets back to the
// original paragraph text.

function preNormalize(s: string): string {
    // All 1-to-1 character replacements — preserves length for straightforward
    // index mapping.
    return s
        .replace(/[\u2018\u2019\u2032]/g, "'")
        .replace(/[\u201C\u201D\u2033]/g, '"')
        .replace(/[\u2013\u2014]/g, "-")
        .replace(/\u00A0/g, " ")
        .replace(/\u200B/g, " ");
}

interface Normalized {
    norm: string;
    // origIdx[i] = index in the *original* string for norm[i]
    origIdx: number[];
}

function normalizeWs(input: string): Normalized {
    const s = preNormalize(input);
    const norm: string[] = [];
    const origIdx: number[] = [];
    let prevSpace = false;
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (/\s/.test(ch)) {
            if (!prevSpace) {
                norm.push(" ");
                origIdx.push(i);
                prevSpace = true;
            }
        } else {
            norm.push(ch);
            origIdx.push(i);
            prevSpace = false;
        }
    }
    return { norm: norm.join(""), origIdx };
}

/**
 * Locate the unique position in `hayNorm` where `findNorm` appears AND is
 * preceded by `ctxBeforeNorm` AND followed by `ctxAfterNorm`. The context
 * check uses direct string-slice equality rather than concatenation so
 * boundary-whitespace collapsing doesn't matter. Returns the normalized
 * [start, end) range of the `find` portion, or a structured error.
 */
function findUniqueAnchor(
    hayNorm: string,
    findNorm: string,
    ctxBeforeNorm: string,
    ctxAfterNorm: string,
): { start: number; end: number } | { error: "none" | "ambiguous" } {
    const candidates: number[] = [];

    const checkCtx = (pos: number): boolean => {
        if (ctxBeforeNorm) {
            const start = pos - ctxBeforeNorm.length;
            if (start < 0) return false;
            if (hayNorm.slice(start, pos) !== ctxBeforeNorm) return false;
        }
        if (ctxAfterNorm) {
            const end = pos + findNorm.length;
            if (hayNorm.slice(end, end + ctxAfterNorm.length) !== ctxAfterNorm)
                return false;
        }
        return true;
    };

    if (findNorm.length === 0) {
        // Pure insertion — scan every position
        for (let i = 0; i <= hayNorm.length; i++) {
            if (checkCtx(i)) candidates.push(i);
        }
    } else {
        let from = 0;
        while (from <= hayNorm.length - findNorm.length) {
            const idx = hayNorm.indexOf(findNorm, from);
            if (idx < 0) break;
            if (checkCtx(idx)) candidates.push(idx);
            from = idx + 1;
        }
    }

    if (candidates.length === 0) return { error: "none" };
    if (candidates.length > 1) return { error: "ambiguous" };
    return {
        start: candidates[0],
        end: candidates[0] + findNorm.length,
    };
}

/** Map a normalized [start, end) range back to the original string range. */
function mapNormRangeToOriginal(
    paraNorm: Normalized,
    origLen: number,
    normStart: number,
    normEnd: number,
): { start: number; end: number } {
    const origStart =
        normStart < paraNorm.origIdx.length
            ? paraNorm.origIdx[normStart]
            : origLen;
    const origEnd =
        normEnd === normStart
            ? origStart
            : normEnd - 1 < paraNorm.origIdx.length
              ? paraNorm.origIdx[normEnd - 1] + 1
              : origLen;
    return { start: origStart, end: origEnd };
}

// ---------------------------------------------------------------------------
// Main: applyTrackedEdits
// ---------------------------------------------------------------------------

const W_NS_ATTRS: Record<string, string> = {
    "xmlns:w":
        "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
};

function createParser() {
    return new XMLParser({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        preserveOrder: true,
        trimValues: false,
        parseAttributeValue: false,
        processEntities: true,
    });
}

function createBuilder() {
    return new XMLBuilder({
        ignoreAttributes: false,
        attributeNamePrefix: "@_",
        preserveOrder: true,
        suppressEmptyNode: false,
        processEntities: true,
    });
}

function findBody(doc: XNode[]): XNode[] | null {
    for (const top of doc) {
        if (elName(top) === "w:document") {
            for (const c of elChildren(top)) {
                if (elName(c) === "w:body") return elChildren(c);
            }
        }
    }
    return null;
}

function replaceBody(doc: XNode[], bodyChildren: XNode[]): void {
    for (const top of doc) {
        if (elName(top) !== "w:document") continue;
        const docKids = elChildren(top);
        for (const c of docKids) {
            if (elName(c) === "w:body") setChildren(c, bodyChildren);
        }
    }
}

/**
 * Walk a tree and collect all max w:id values in w:ins/w:del so new changes
 * can start their numbering safely above it.
 */
function maxTrackedId(doc: XNode[]): number {
    let max = 0;
    const visit = (n: unknown) => {
        const name = elName(n);
        if (!name) return;
        if (name === "w:ins" || name === "w:del") {
            const a = elAttrs(n);
            const raw = a["@_w:id"];
            if (raw != null) {
                const v = parseInt(String(raw), 10);
                if (Number.isFinite(v) && v > max) max = v;
            }
        }
        for (const c of elChildren(n as XNode)) visit(c);
    };
    for (const top of doc) visit(top);
    return max;
}

/**
 * Extract the body text of a .docx using the same flattening rules as the
 * tracked-changes matcher. Paragraphs are joined by a single newline. The
 * output is what the LLM should base its `find` / `context_before` /
 * `context_after` strings on, since it exactly mirrors the string the
 * anchor matcher operates against.
 */
export async function extractDocxBodyText(bytes: Buffer): Promise<string> {
    return (await extractDocxBodyParagraphs(bytes)).join("\n");
}

/**
 * Return the body text one string per paragraph, in document order — the same
 * paragraph list `applyUserParagraphEdits` reconciles against. Used as the
 * authoritative baseline when the viewer saves inline edits.
 */
export async function extractDocxBodyParagraphs(
    bytes: Buffer,
): Promise<string[]> {
    const zip = await JSZip.loadAsync(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) return [];
    const docXmlRaw = await docXmlFile.async("string");
    const parser = createParser();
    const tree = parser.parse(docXmlRaw) as XNode[];
    const bodyChildren = findBody(tree);
    if (!bodyChildren) return [];

    const lines: string[] = [];
    const collect = (nodes: XNode[]) => {
        for (const n of nodes) {
            const name = elName(n);
            if (!name) continue;
            if (name === "w:p") {
                const flat = flattenParagraph(elChildren(n));
                lines.push(flat.paraText);
            } else if (
                name === "w:tbl" ||
                name === "w:tr" ||
                name === "w:tc" ||
                name === "w:sdt" ||
                name === "w:sdtContent"
            ) {
                collect(elChildren(n));
            }
        }
    };
    collect(bodyChildren);
    return lines;
}

/**
 * Walk document.xml in render order and collect the w:id for every
 * w:ins / w:del wrapper. The order here matches what docx-preview emits
 * as <ins>/<del> in the DOM, so the frontend can tag each rendered
 * element by index to recover the w:id attribute that docx-preview drops.
 */
export async function extractTrackedChangeIds(
    bytes: Buffer,
): Promise<{ kind: "ins" | "del"; w_id: string }[]> {
    const zip = await JSZip.loadAsync(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) return [];
    const docXmlRaw = await docXmlFile.async("string");
    const parser = createParser();
    const tree = parser.parse(docXmlRaw) as XNode[];
    const out: { kind: "ins" | "del"; w_id: string }[] = [];
    const visit = (n: unknown) => {
        const name = elName(n);
        if (!name) return;
        // Paragraph-mark changes live in w:pPr and are not rendered as
        // <ins>/<del> elements, so including them would shift the index
        // mapping the frontend relies on.
        if (name === "w:pPr") return;
        if (name === "w:ins" || name === "w:del") {
            const a = elAttrs(n);
            const raw = a["@_w:id"];
            if (raw != null) {
                out.push({
                    kind: name === "w:ins" ? "ins" : "del",
                    w_id: String(raw),
                });
            }
        }
        for (const c of elChildren(n as XNode)) visit(c);
    };
    for (const top of tree) visit(top);
    return out;
}

export async function applyTrackedEdits(
    bytes: Buffer,
    edits: EditInput[],
    opts?: { author?: string },
): Promise<ApplyTrackedEditsResult> {
    const author = opts?.author ?? "Mike";
    const now = new Date().toISOString();

    const zip = await JSZip.loadAsync(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) throw new Error("document.xml missing from docx");
    const docXmlRaw = await docXmlFile.async("string");

    const parser = createParser();
    const tree = parser.parse(docXmlRaw) as XNode[];

    const bodyChildren = findBody(tree);
    if (!bodyChildren) throw new Error("w:body missing from document.xml");

    // Build paragraph table (only w:p at the top level of the body — does not
    // recurse into tables; for tables, w:p also appears inside w:tbl > w:tr >
    // w:tc so we need to traverse deeper).
    const paragraphs: ParagraphRef[] = [];
    const collectParagraphs = (nodes: XNode[]) => {
        for (const n of nodes) {
            const name = elName(n);
            if (!name) continue;
            if (name === "w:p") {
                const kids = elChildren(n);
                const flat = flattenParagraph(kids);
                paragraphs.push({
                    paraNode: n,
                    paraChildren: kids,
                    flat,
                    globalStart: 0, // set below
                });
            } else if (name === "w:tbl" || name === "w:tr" || name === "w:tc" || name === "w:sdt" || name === "w:sdtContent") {
                collectParagraphs(elChildren(n));
            }
        }
    };
    collectParagraphs(bodyChildren);

    // Assign global offsets (paragraphs joined by "\n" so context can
    // straddle a paragraph boundary, though edits themselves must stay
    // inside a single paragraph).
    {
        let off = 0;
        for (const p of paragraphs) {
            p.globalStart = off;
            off += p.flat.paraText.length + 1; // +1 for synthetic separator
        }
    }

    // Precompute normalized forms per paragraph for reuse across edits.
    const paraNorms: Normalized[] = paragraphs.map((p) =>
        normalizeWs(p.flat.paraText),
    );

    let nextWId = maxTrackedId(tree) + 1;
    const plansPerParagraph = new Map<number, PlannedChange[]>();
    const appliedChanges: AppliedChange[] = [];
    const errors: EditError[] = [];

    for (let editIdx = 0; editIdx < edits.length; editIdx++) {
        const edit = edits[editIdx];
        const find = edit.find ?? "";
        const replace = edit.replace ?? "";
        const ctxBefore = edit.context_before ?? "";
        const ctxAfter = edit.context_after ?? "";

        if (!find && !replace) {
            errors.push({ index: editIdx, reason: "Empty edit." });
            continue;
        }
        if (!find && !ctxBefore && !ctxAfter) {
            errors.push({
                index: editIdx,
                reason: "Pure insertion requires context_before or context_after.",
            });
            continue;
        }

        const findNorm = normalizeWs(find).norm;
        const ctxBeforeNorm = normalizeWs(ctxBefore).norm;
        const ctxAfterNorm = normalizeWs(ctxAfter).norm;

        // Strategy:
        //   1) find + full context  (strictest — preferred)
        //   2) find + half context  (drop whichever context side is shorter)
        //   3) find alone           (only if globally unique across doc)
        // At each stage we scan every paragraph. "Unique across the doc"
        // means exactly one paragraph yields exactly one match.
        type Hit = { paraIdx: number; normStart: number; normEnd: number };

        /**
         * Search every paragraph with the given context sides. If any
         * paragraph returns a match AND no paragraph is internally ambiguous,
         * return the collected hits; otherwise signal ambiguous.
         */
        const tryStrategy = (
            cb: string,
            ca: string,
        ): { kind: "ok"; hits: Hit[] } | { kind: "ambiguous" } => {
            const hits: Hit[] = [];
            let ambiguous = false;
            for (let pi = 0; pi < paragraphs.length; pi++) {
                const r = findUniqueAnchor(
                    paraNorms[pi].norm,
                    findNorm,
                    cb,
                    ca,
                );
                if ("error" in r) {
                    if (r.error === "ambiguous") ambiguous = true;
                    continue;
                }
                hits.push({ paraIdx: pi, normStart: r.start, normEnd: r.end });
            }
            if (ambiguous || hits.length > 1) return { kind: "ambiguous" };
            return { kind: "ok", hits };
        };

        let selected: Hit | null = null;
        const attempts = [
            { cb: ctxBeforeNorm, ca: ctxAfterNorm },
            { cb: ctxBeforeNorm, ca: "" },
            { cb: "", ca: ctxAfterNorm },
            { cb: "", ca: "" }, // find-only
        ];
        let sawAmbiguous = false;
        for (const { cb, ca } of attempts) {
            const r = tryStrategy(cb, ca);
            if (r.kind === "ambiguous") {
                sawAmbiguous = true;
                continue;
            }
            if (r.hits.length === 1) {
                selected = r.hits[0];
                break;
            }
        }

        if (!selected) {
            errors.push({
                index: editIdx,
                reason: sawAmbiguous
                    ? `Ambiguous match for find="${truncate(find, 80)}". Add longer context_before / context_after so the anchor is unique.`
                    : `Could not locate find="${truncate(find, 80)}" in the document. Re-read the document and copy context verbatim (including punctuation & whitespace).`,
            });
            continue;
        }

        const hit = selected;
        const paraIdx = hit.paraIdx;
        const paraNorm = paraNorms[paraIdx];
        const origLen = paragraphs[paraIdx].flat.paraText.length;
        const { start: findStart, end: findEnd } = mapNormRangeToOriginal(
            paraNorm,
            origLen,
            hit.normStart,
            hit.normEnd,
        );

        // Use the actual original text in that range as `deletedText` —
        // this preserves the document's whitespace/quote style rather than
        // the normalized needle the LLM provided.
        const originalFind = paragraphs[paraIdx].flat.paraText.slice(
            findStart,
            findEnd,
        );

        const { deleted, inserted, leadingEq } = collapseDiff(
            originalFind,
            replace,
        );
        const minStart = findStart + leadingEq;
        const minEnd = minStart + deleted.length;
        void findEnd;

        const changeId = `mike-${editIdx}-${Date.now()}`;
        const plan: PlannedChange = {
            editIndex: editIdx,
            deleteStart: minStart,
            deleteEnd: minEnd,
            deletedText: deleted,
            insertedText: inserted,
            contextBefore: edit.context_before ?? "",
            contextAfter: edit.context_after ?? "",
            reason: edit.reason,
            changeId,
            delWId: deleted ? String(nextWId++) : undefined,
            insWId: inserted ? String(nextWId++) : undefined,
            markInsWIds: [],
            markDelWIds: [],
        };

        // Check for overlap with earlier plans in the same paragraph.
        const existing = plansPerParagraph.get(paraIdx) ?? [];
        const overlap = existing.some(
            (p) => !(plan.deleteEnd <= p.deleteStart || plan.deleteStart >= p.deleteEnd),
        );
        if (overlap) {
            errors.push({
                index: editIdx,
                reason: "Overlaps a previous edit in the same paragraph.",
            });
            continue;
        }

        existing.push(plan);
        existing.sort((a, b) => a.deleteStart - b.deleteStart);
        plansPerParagraph.set(paraIdx, existing);

        appliedChanges.push({
            id: changeId,
            delId: plan.delWId,
            insId: plan.insWId,
            deletedText: plan.deletedText,
            insertedText: plan.insertedText,
            contextBefore: plan.contextBefore,
            contextAfter: plan.contextAfter,
            reason: plan.reason,
        });
    }

    // Apply plans per paragraph. A plan can turn one paragraph into several
    // (or mark it for removal), so the results are spliced back into the tree.
    const replacements = new Map<XNode, XNode[]>();
    const lastParaNode =
        paragraphs.length > 0
            ? paragraphs[paragraphs.length - 1].paraNode
            : null;
    for (const [paraIdx, plan] of plansPerParagraph) {
        const p = paragraphs[paraIdx];
        // Never remove the final paragraph mark or one carrying section
        // properties — Word treats those as structural.
        const pPr = findChildByName(p.paraChildren, "w:pPr");
        const allowParagraphDelete =
            p.paraNode !== lastParaNode &&
            !(pPr && findChildByName(elChildren(pPr), "w:sectPr"));
        const newParas = reconstructParagraph(
            p.paraNode,
            p.paraChildren,
            p.flat,
            plan,
            now,
            author,
            () => String(nextWId++),
            allowParagraphDelete,
        );
        if (newParas.length !== 1 || newParas[0] !== p.paraNode) {
            replacements.set(p.paraNode, newParas);
        }
        for (const pc of plan) {
            if (!pc.markInsWIds.length && !pc.markDelWIds.length) continue;
            const target = appliedChanges.find((c) => c.id === pc.changeId);
            if (!target) continue;
            if (pc.markInsWIds.length) target.extraInsIds = pc.markInsWIds;
            if (pc.markDelWIds.length) target.extraDelIds = pc.markDelWIds;
        }
    }

    if (replacements.size > 0) {
        const splice = (nodes: XNode[]): XNode[] => {
            const out: XNode[] = [];
            for (const n of nodes) {
                const name = elName(n);
                if (name === "w:p") {
                    const rep = replacements.get(n);
                    if (rep) {
                        for (const r of rep) out.push(r);
                        continue;
                    }
                } else if (
                    name === "w:tbl" ||
                    name === "w:tr" ||
                    name === "w:tc" ||
                    name === "w:sdt" ||
                    name === "w:sdtContent"
                ) {
                    setChildren(n, splice(elChildren(n)));
                }
                out.push(n);
            }
            return out;
        };
        replaceBody(tree, splice(bodyChildren));
    }

    const builder = createBuilder();
    const rebuiltXml = builder.build(tree);
    const withDecl = ensureXmlDeclaration(rebuiltXml);
    setZipEntry(zip, "word/document.xml", withDecl);

    const outBuf = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
    });
    return { bytes: outBuf, changes: appliedChanges, errors };
}

// ---------------------------------------------------------------------------
// Inline editing: reconcile user-edited paragraph text with the document
// ---------------------------------------------------------------------------
//
// The viewer lets the user retype the body of a .docx. On save the frontend
// sends the paragraph texts it started from (`baseline`) and the paragraph
// texts after editing (`next`). We align the two by longest-common-subsequence
// and turn the difference into the same per-paragraph operations the tracked
// engine already knows how to apply — edit a paragraph's words, delete a whole
// paragraph, or grow new ones — then bake them in as the user's own change so
// the result is a clean document, not a redline. Only text runs are touched,
// so headers, footers, images and the signature block are preserved exactly.
//
// `baseline` must match the document's current body paragraphs exactly; if it
// does not, the save is refused rather than risk writing to the wrong place.

export interface UserParagraphEditResult {
    bytes: Buffer;
    changed: boolean;
    opsApplied: number;
}

export class StaleDocumentError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "StaleDocumentError";
    }
}

/** Longest-common-subsequence alignment of two string arrays (exact match). */
function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
    const n = a.length;
    const m = b.length;
    const dp: Int32Array[] = [];
    for (let i = 0; i <= n; i++) dp.push(new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i][j] =
                a[i] === b[j]
                    ? dp[i + 1][j + 1] + 1
                    : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const pairs: Array<[number, number]> = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            pairs.push([i, j]);
            i++;
            j++;
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
            i++;
        } else {
            j++;
        }
    }
    return pairs;
}

interface ParaOps {
    replaceWith?: string;      // modify this paragraph's whole text
    del?: boolean;             // delete this whole paragraph
    after: string[];          // new paragraphs to add after this one
}

/**
 * Diff baseline vs next paragraph text and describe the change per original
 * paragraph index, plus any paragraphs to add before the first one.
 */
function diffParagraphs(
    baseline: string[],
    next: string[],
): { perIndex: Map<number, ParaOps>; atStart: string[] } {
    const perIndex = new Map<number, ParaOps>();
    const atStart: string[] = [];
    const ops = (idx: number): ParaOps => {
        let o = perIndex.get(idx);
        if (!o) {
            o = { after: [] };
            perIndex.set(idx, o);
        }
        return o;
    };

    const pairs = lcsPairs(baseline, next);
    const sentinel: Array<[number, number]> = [
        ...pairs,
        [baseline.length, next.length],
    ];
    let prevOld = -1;
    let prevNew = -1;
    let anchor = -1; // last original index that survives (kept or modified)
    for (const [oi, nj] of sentinel) {
        const removed: number[] = [];
        for (let k = prevOld + 1; k < oi; k++) removed.push(k);
        const added: number[] = [];
        for (let k = prevNew + 1; k < nj; k++) added.push(k);
        const paired = Math.min(removed.length, added.length);
        for (let t = 0; t < paired; t++) {
            ops(removed[t]).replaceWith = next[added[t]];
            anchor = removed[t];
        }
        for (let t = paired; t < removed.length; t++) {
            ops(removed[t]).del = true;
        }
        const leftover = added.slice(paired).map((k) => next[k]);
        if (leftover.length) {
            if (anchor >= 0) ops(anchor).after.push(...leftover);
            else atStart.push(...leftover);
        }
        if (oi < baseline.length) anchor = oi; // the matched pair survives
        prevOld = oi;
        prevNew = nj;
    }
    return { perIndex, atStart };
}

/**
 * Apply inline paragraph edits to a .docx and return clean bytes (no tracked
 * markup). `author` labels the change internally; it never shows because the
 * change is accepted immediately.
 */
export async function applyUserParagraphEdits(
    bytes: Buffer,
    baseline: string[],
    next: string[],
    opts?: { author?: string },
): Promise<UserParagraphEditResult> {
    const author = opts?.author ?? "You";
    const now = new Date().toISOString();

    const zip = await JSZip.loadAsync(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) throw new Error("document.xml missing from docx");
    const docXmlRaw = await docXmlFile.async("string");
    const parser = createParser();
    const tree = parser.parse(docXmlRaw) as XNode[];
    const bodyChildren = findBody(tree);
    if (!bodyChildren) throw new Error("w:body missing from document.xml");

    const paragraphs: ParagraphRef[] = [];
    const collectParagraphs = (nodes: XNode[]) => {
        for (const n of nodes) {
            const name = elName(n);
            if (!name) continue;
            if (name === "w:p") {
                const kids = elChildren(n);
                paragraphs.push({
                    paraNode: n,
                    paraChildren: kids,
                    flat: flattenParagraph(kids),
                    globalStart: 0,
                });
            } else if (
                name === "w:tbl" ||
                name === "w:tr" ||
                name === "w:tc" ||
                name === "w:sdt" ||
                name === "w:sdtContent"
            ) {
                collectParagraphs(elChildren(n));
            }
        }
    };
    collectParagraphs(bodyChildren);

    const current = paragraphs.map((p) => p.flat.paraText);
    if (
        baseline.length !== current.length ||
        baseline.some((t, i) => t !== current[i])
    ) {
        throw new StaleDocumentError(
            "The document changed since editing began. Reopen it and try again.",
        );
    }

    const { perIndex, atStart } = diffParagraphs(baseline, next);
    if (perIndex.size === 0 && atStart.length === 0) {
        return { bytes, changed: false, opsApplied: 0 };
    }

    // Non-empty paragraphs can anchor an insertion (they have a run whose
    // formatting new text inherits); empty ones cannot, so redirect.
    const firstNonEmpty = current.findIndex((t) => t.length > 0);
    const nearestNonEmptyAtOrBefore = (idx: number): number => {
        for (let i = idx; i >= 0; i--) if (current[i].length > 0) return i;
        return -1;
    };

    let nextWId = maxTrackedId(tree) + 1;
    const plansPerParagraph = new Map<number, PlannedChange[]>();
    let editIndex = 0;
    const addPlan = (paraIdx: number, plan: PlannedChange) => {
        const list = plansPerParagraph.get(paraIdx) ?? [];
        list.push(plan);
        list.sort((a, b) => a.deleteStart - b.deleteStart);
        plansPerParagraph.set(paraIdx, list);
    };
    const makePlan = (
        paraIdx: number,
        deleteStart: number,
        deleteEnd: number,
        insertedText: string,
    ): PlannedChange => {
        const deletedText = current[paraIdx].slice(deleteStart, deleteEnd);
        return {
            editIndex: editIndex++,
            deleteStart,
            deleteEnd,
            deletedText,
            insertedText,
            contextBefore: "",
            contextAfter: "",
            changeId: `user-${editIndex}`,
            delWId: deletedText ? String(nextWId++) : undefined,
            insWId: insertedText ? String(nextWId++) : undefined,
            markInsWIds: [],
            markDelWIds: [],
        };
    };
    const redirectInsert = (anchorIdx: number, texts: string[]) => {
        if (!texts.length) return;
        const target = nearestNonEmptyAtOrBefore(anchorIdx);
        if (target < 0) {
            // No non-empty paragraph before the anchor — prepend instead.
            prependAtStart(texts);
            return;
        }
        const len = current[target].length;
        addPlan(target, makePlan(target, len, len, "\n\n" + texts.join("\n\n")));
    };
    const prependAtStart = (texts: string[]) => {
        if (!texts.length || firstNonEmpty < 0) return;
        addPlan(
            firstNonEmpty,
            makePlan(firstNonEmpty, 0, 0, texts.join("\n\n") + "\n\n"),
        );
    };

    for (const [idx, op] of perIndex) {
        if (op.del) {
            addPlan(idx, makePlan(idx, 0, current[idx].length, ""));
        } else if (op.replaceWith !== undefined && op.replaceWith !== current[idx]) {
            addPlan(idx, makePlan(idx, 0, current[idx].length, op.replaceWith));
        }
        if (op.after.length) redirectInsert(idx, op.after);
    }
    prependAtStart(atStart);

    // Build the tracked document, then splice new/removed paragraphs in.
    const appliedChanges: AppliedChange[] = [];
    for (const list of plansPerParagraph.values()) {
        for (const pc of list) {
            appliedChanges.push({
                id: pc.changeId,
                delId: pc.delWId,
                insId: pc.insWId,
                deletedText: pc.deletedText,
                insertedText: pc.insertedText,
                contextBefore: "",
                contextAfter: "",
            });
        }
    }

    const replacements = new Map<XNode, XNode[]>();
    const lastParaNode =
        paragraphs.length > 0
            ? paragraphs[paragraphs.length - 1].paraNode
            : null;
    for (const [paraIdx, plan] of plansPerParagraph) {
        const p = paragraphs[paraIdx];
        const pPr = findChildByName(p.paraChildren, "w:pPr");
        const allowParagraphDelete =
            p.paraNode !== lastParaNode &&
            !(pPr && findChildByName(elChildren(pPr), "w:sectPr"));
        const newParas = reconstructParagraph(
            p.paraNode,
            p.paraChildren,
            p.flat,
            plan,
            now,
            author,
            () => String(nextWId++),
            allowParagraphDelete,
        );
        if (newParas.length !== 1 || newParas[0] !== p.paraNode) {
            replacements.set(p.paraNode, newParas);
        }
        for (const pc of plan) {
            if (!pc.markInsWIds.length && !pc.markDelWIds.length) continue;
            const target = appliedChanges.find((c) => c.id === pc.changeId);
            if (!target) continue;
            if (pc.markInsWIds.length) target.extraInsIds = pc.markInsWIds;
            if (pc.markDelWIds.length) target.extraDelIds = pc.markDelWIds;
        }
    }

    if (replacements.size > 0) {
        const splice = (nodes: XNode[]): XNode[] => {
            const out: XNode[] = [];
            for (const n of nodes) {
                const name = elName(n);
                if (name === "w:p") {
                    const rep = replacements.get(n);
                    if (rep) {
                        for (const r of rep) out.push(r);
                        continue;
                    }
                } else if (
                    name === "w:tbl" ||
                    name === "w:tr" ||
                    name === "w:tc" ||
                    name === "w:sdt" ||
                    name === "w:sdtContent"
                ) {
                    setChildren(n, splice(elChildren(n)));
                }
                out.push(n);
            }
            return out;
        };
        replaceBody(tree, splice(bodyChildren));
    }

    const builder = createBuilder();
    setZipEntry(
        zip,
        "word/document.xml",
        ensureXmlDeclaration(builder.build(tree)),
    );
    const trackedBytes = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
    });

    // Accept every change so the saved file is clean, not a redline.
    const allIds = appliedChanges.flatMap((c) => [
        c.delId,
        c.insId,
        ...(c.extraInsIds ?? []),
        ...(c.extraDelIds ?? []),
    ]).filter((v): v is string => !!v);
    if (allIds.length === 0) {
        return { bytes, changed: false, opsApplied: 0 };
    }
    const { bytes: cleanBytes } = await resolveTrackedChange(
        trackedBytes,
        allIds,
        "accept",
    );
    return { bytes: cleanBytes, changed: true, opsApplied: appliedChanges.length };
}

// ---------------------------------------------------------------------------
// Formatted inline editing (custom in-app editor)
// ---------------------------------------------------------------------------
//
// The in-app editor sends the body back as a list of paragraphs, each carrying
// its plain text plus the inline formatting the user applied (bold / italic /
// underline / colour / size) and an optional alignment. We diff this against
// the document's current body (by text, via LCS) and rebuild ONLY the
// paragraphs that changed, brand-new paragraphs inherit the run formatting of
// the paragraph they grew from so the document's font and size carry over.
// Untouched paragraphs — and the whole header / footer / section setup — are
// left exactly as they were.

export interface EditRun {
    text: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    color?: string; // 6-hex, no leading '#'
    size?: number; // points
}

export interface EditParagraph {
    text: string;
    align?: "left" | "center" | "right" | "justify" | null;
    /**
     * 1-3 to make this paragraph a Word heading, 0/undefined for body text.
     * Applied as a w:pStyle referencing Word's built-in Heading styles, so the
     * document's own heading look is used and Word's navigation pane picks
     * them up.
     */
    heading?: number | null;
    runs: EditRun[];
}

export interface FormattedEditResult {
    bytes: Buffer;
    changed: boolean;
}

const RPR_TOGGLE_NAMES = new Set([
    "w:b",
    "w:bCs",
    "w:i",
    "w:iCs",
    "w:u",
    "w:color",
    "w:sz",
    "w:szCs",
]);

/**
 * Build a run-properties element for one run: start from the paragraph's
 * original run properties (so font family, language, etc. are kept), drop the
 * properties the toolbar owns, then re-add them from the run's flags. Keeping
 * w:rFonts first satisfies the schema's ordering expectations.
 */
function buildRunProps(baseRPr: XNode | null, run: EditRun): XNode | null {
    const baseKids = baseRPr ? elChildren(baseRPr) : [];
    const kept: XNode[] = [];
    for (const c of baseKids) {
        const name = elName(c);
        if (name && RPR_TOGGLE_NAMES.has(name)) continue;
        kept.push(cloneNode(c));
    }
    const toggles: XNode[] = [];
    if (run.bold) {
        toggles.push(makeEl("w:b", []));
        toggles.push(makeEl("w:bCs", []));
    }
    if (run.italic) {
        toggles.push(makeEl("w:i", []));
        toggles.push(makeEl("w:iCs", []));
    }
    if (run.underline) {
        toggles.push(makeEl("w:u", [], { "w:val": "single" }));
    }
    if (run.color && /^[0-9a-fA-F]{6}$/.test(run.color)) {
        toggles.push(makeEl("w:color", [], { "w:val": run.color.toUpperCase() }));
    }
    if (typeof run.size === "number" && run.size > 0 && run.size < 400) {
        // OOXML sizes are half-points.
        const half = String(Math.round(run.size * 2));
        toggles.push(makeEl("w:sz", [], { "w:val": half }));
        toggles.push(makeEl("w:szCs", [], { "w:val": half }));
    }
    if (kept.length === 0 && toggles.length === 0) return null;
    // Insert toggles right after w:rFonts if present, else at the front.
    const rFontsIdx = kept.findIndex((c) => elName(c) === "w:rFonts");
    const at = rFontsIdx >= 0 ? rFontsIdx + 1 : 0;
    const children = [...kept.slice(0, at), ...toggles, ...kept.slice(at)];
    return makeEl("w:rPr", children);
}

/** Set/replace/remove the alignment on a cloned paragraph-properties element. */
function applyParagraphProps(
    basePPr: XNode | null,
    align: EditParagraph["align"],
    heading: number | null | undefined,
): XNode | null {
    const wantHeading =
        typeof heading === "number" && heading >= 1 && heading <= 3
            ? heading
            : null;
    const base = basePPr ? cloneNode(basePPr) : null;
    const noAlign = !align || align === "left";
    if (noAlign && !wantHeading && !base) return null;

    const pPr = base ?? makeEl("w:pPr", []);
    let kids = elChildren(pPr);

    // Heading: replace any existing paragraph style. Removing it returns the
    // paragraph to the document's default (body) style.
    kids = kids.filter((c) => elName(c) !== "w:pStyle");
    if (wantHeading) {
        // w:pStyle must be the first child of w:pPr.
        kids = [
            makeEl("w:pStyle", [], { "w:val": `Heading${wantHeading}` }),
            ...kids,
        ];
    }

    // Alignment.
    kids = kids.filter((c) => elName(c) !== "w:jc");
    if (!noAlign) {
        const styleIdx = kids.findIndex((c) => elName(c) === "w:pStyle");
        const at = styleIdx >= 0 ? styleIdx + 1 : 0;
        kids = [
            ...kids.slice(0, at),
            makeEl("w:jc", [], { "w:val": align as string }),
            ...kids.slice(at),
        ];
    }
    setChildren(pPr, kids);
    return pPr;
}

/**
 * Word only renders a Heading style the document actually defines. Generated
 * documents often define none, so add a minimal definition for any heading
 * level used that is missing — bold, slightly larger than body, with space
 * above. Existing definitions are never touched, so a firm template keeps its
 * own heading look.
 */
function ensureHeadingStyles(
    stylesTree: XNode[] | null,
    levels: Set<number>,
): boolean {
    if (!stylesTree || levels.size === 0) return false;
    let root: XNode | null = null;
    for (const top of stylesTree) {
        if (elName(top) === "w:styles") root = top;
    }
    if (!root) return false;
    const kids = elChildren(root);
    const have = new Set<string>();
    for (const c of kids) {
        if (elName(c) !== "w:style") continue;
        const id = elAttrs(c)["@_w:styleId"];
        if (id) have.add(String(id));
    }
    const SIZES: Record<number, string> = { 1: "32", 2: "28", 3: "26" };
    let added = false;
    for (const lvl of Array.from(levels).sort()) {
        const id = `Heading${lvl}`;
        if (have.has(id)) continue;
        const style = makeEl(
            "w:style",
            [
                makeEl("w:name", [], { "w:val": `heading ${lvl}` }),
                makeEl("w:basedOn", [], { "w:val": "Normal" }),
                makeEl("w:qFormat", []),
                makeEl("w:pPr", [
                    makeEl("w:keepNext", []),
                    makeEl("w:spacing", [], { "w:before": "240", "w:after": "120" }),
                    makeEl("w:outlineLvl", [], { "w:val": String(lvl - 1) }),
                ]),
                makeEl("w:rPr", [
                    makeEl("w:b", []),
                    makeEl("w:bCs", []),
                    makeEl("w:sz", [], { "w:val": SIZES[lvl] ?? "26" }),
                    makeEl("w:szCs", [], { "w:val": SIZES[lvl] ?? "26" }),
                ]),
            ],
            { "w:type": "paragraph", "w:styleId": id },
        );
        kids.push(style);
        added = true;
    }
    if (added) setChildren(root, kids);
    return added;
}

/** Build a fresh <w:p> from a formatted paragraph, inheriting base props. */
function buildFormattedParagraph(
    para: EditParagraph,
    baseRPr: XNode | null,
    basePPr: XNode | null,
): XNode {
    const children: XNode[] = [];
    const pPr = applyParagraphProps(
        basePPr,
        para.align ?? null,
        para.heading ?? null,
    );
    if (pPr) children.push(pPr);
    const runs = para.runs && para.runs.length ? para.runs : [{ text: para.text }];
    for (const run of runs) {
        if (!run.text) continue;
        const rPr = buildRunProps(baseRPr, run);
        children.push(buildRun(rPr, run.text, "w:t"));
    }
    // A paragraph with no runs still needs to exist (empty line).
    return makeEl("w:p", children);
}

/** The first run's rPr in a paragraph, if any (used as the formatting base). */
function firstRunRPr(paraChildren: XNode[]): XNode | null {
    for (const c of paraChildren) {
        if (elName(c) !== "w:r") continue;
        const rPr = findChildByName(elChildren(c), "w:rPr");
        if (rPr) return rPr;
    }
    return null;
}

/**
 * Apply the in-app editor's formatted body back to the document and return
 * clean bytes. `baseline` is the plain text of every body paragraph as the
 * editor received it; if it no longer matches the document, the save is
 * refused rather than risk writing to the wrong place.
 */
export async function applyFormattedEdits(
    bytes: Buffer,
    baseline: string[],
    next: EditParagraph[],
): Promise<FormattedEditResult> {
    const zip = await JSZip.loadAsync(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) throw new Error("document.xml missing from docx");
    const docXmlRaw = await docXmlFile.async("string");
    const parser = createParser();
    const tree = parser.parse(docXmlRaw) as XNode[];
    const bodyChildren = findBody(tree);
    if (!bodyChildren) throw new Error("w:body missing from document.xml");

    interface Para {
        node: XNode;
        text: string;
        baseRPr: XNode | null;
        basePPr: XNode | null;
        hasSectPr: boolean;
        headingLevel: number; // 0 = body text
    }
    const paras: Para[] = [];
    const collect = (nodes: XNode[]) => {
        for (const n of nodes) {
            const name = elName(n);
            if (!name) continue;
            if (name === "w:p") {
                const kids = elChildren(n);
                const pPr = findChildByName(kids, "w:pPr");
                const pStyle = pPr
                    ? findChildByName(elChildren(pPr), "w:pStyle")
                    : null;
                const styleVal = pStyle
                    ? String(elAttrs(pStyle)["@_w:val"] ?? "")
                    : "";
                const hm = /^Heading([1-9])$/.exec(styleVal);
                paras.push({
                    node: n,
                    text: flattenParagraph(kids).paraText,
                    baseRPr: firstRunRPr(kids),
                    basePPr: pPr,
                    hasSectPr: !!(pPr && findChildByName(elChildren(pPr), "w:sectPr")),
                    headingLevel: hm ? Number(hm[1]) : 0,
                });
            } else if (
                name === "w:tbl" ||
                name === "w:tr" ||
                name === "w:tc" ||
                name === "w:sdt" ||
                name === "w:sdtContent"
            ) {
                collect(elChildren(n));
            }
        }
    };
    collect(bodyChildren);

    const current = paras.map((p) => p.text);
    if (
        baseline.length !== current.length ||
        baseline.some((t, i) => t !== current[i])
    ) {
        throw new StaleDocumentError(
            "The document changed since editing began. Reopen it and try again.",
        );
    }

    const nextText = next.map((p) => p.text);
    // Fast path: nothing changed.
    if (
        nextText.length === current.length &&
        nextText.every((t, i) => t === current[i])
    ) {
        // Text identical, but formatting/alignment may still have changed. Fall
        // through and rebuild; if the rebuild is byte-identical it's harmless.
    }

    // Align current paragraphs to the edited ones.
    const pairs = lcsPairs(current, nextText);
    const matchedOld = new Set(pairs.map((p) => p[0]));
    const matchedNew = new Map(pairs.map((p) => [p[1], p[0]]));

    // Build the replacement node for each ORIGINAL paragraph position, plus any
    // brand-new paragraphs inserted before it.
    // Walk both sequences together.
    const newBodyParas: XNode[] = [];
    let oi = 0;
    let nj = 0;
    const nearestBaseRPr = (): XNode | null => {
        // Prefer the previous emitted original paragraph's base, else the next.
        for (let k = oi - 1; k >= 0; k--) if (paras[k].baseRPr) return paras[k].baseRPr;
        for (let k = oi; k < paras.length; k++) if (paras[k].baseRPr) return paras[k].baseRPr;
        return null;
    };
    const nearestBasePPr = (): XNode | null => {
        for (let k = oi - 1; k >= 0; k--)
            if (paras[k].basePPr && !paras[k].hasSectPr) return paras[k].basePPr;
        return null;
    };

    const pairSet = new Set(pairs.map((p) => `${p[0]}:${p[1]}`));
    while (oi < paras.length || nj < next.length) {
        const isPair =
            oi < paras.length &&
            nj < next.length &&
            matchedOld.has(oi) &&
            matchedNew.get(nj) === oi &&
            pairSet.has(`${oi}:${nj}`);
        if (isPair) {
            // Same text. Rebuild only if formatting/alignment differ from a
            // plain single-run paragraph; simplest correct choice is to keep
            // the ORIGINAL node so untouched paragraphs are byte-identical,
            // unless the editor sent explicit formatting/alignment.
            const ep = next[nj];
            // A heading level that differs from what the paragraph already has
            // (including clearing one) must rebuild the paragraph.
            const currentHeading = paras[oi].headingLevel;
            const wantHeading =
                typeof ep.heading === "number" && ep.heading >= 1 && ep.heading <= 3
                    ? ep.heading
                    : 0;
            const headingChanged = wantHeading !== currentHeading;
            const hasFormatting =
                (ep.align && ep.align !== "left") ||
                headingChanged ||
                (ep.runs || []).some(
                    (r) => r.bold || r.italic || r.underline || r.color || r.size,
                );
            if (hasFormatting || (ep.runs && ep.runs.length > 1)) {
                newBodyParas.push(
                    buildFormattedParagraph(ep, paras[oi].baseRPr, paras[oi].basePPr),
                );
            } else {
                newBodyParas.push(paras[oi].node);
            }
            oi++;
            nj++;
            continue;
        }
        // Unmatched original paragraph -> deleted (unless it holds sectPr or is
        // the final paragraph, which we must keep for document structure).
        if (oi < paras.length && !matchedOld.has(oi)) {
            const isLast = oi === paras.length - 1;
            if (paras[oi].hasSectPr || isLast) {
                // Keep the structural paragraph; if there's a matching edited
                // paragraph we could rebuild, but safest is to keep it as-is.
                newBodyParas.push(paras[oi].node);
            }
            oi++;
            continue;
        }
        // Unmatched edited paragraph -> newly inserted.
        if (nj < next.length && !matchedNew.has(nj)) {
            newBodyParas.push(
                buildFormattedParagraph(
                    next[nj],
                    nearestBaseRPr(),
                    nearestBasePPr(),
                ),
            );
            nj++;
            continue;
        }
        // Fallback to avoid an infinite loop.
        if (oi < paras.length) {
            newBodyParas.push(paras[oi].node);
            oi++;
        } else {
            nj++;
        }
    }

    // Rebuild the body: replace the run of top-level w:p nodes with the new
    // list, preserving any non-paragraph body children (tables, sdt, the final
    // sectPr element that sits directly under body) in place.
    const paraNodeSet = new Set(paras.map((p) => p.node));
    const newBody: XNode[] = [];
    let injected = false;
    for (const n of bodyChildren) {
        if (elName(n) === "w:p" && paraNodeSet.has(n)) {
            if (!injected) {
                for (const p of newBodyParas) newBody.push(p);
                injected = true;
            }
            continue; // drop original paragraph (already re-emitted)
        }
        newBody.push(n);
    }
    if (!injected) for (const p of newBodyParas) newBody.push(p);
    replaceBody(tree, newBody);

    const builder = createBuilder();
    setZipEntry(
        zip,
        "word/document.xml",
        ensureXmlDeclaration(builder.build(tree)),
    );

    // Make sure every heading level used is actually defined, or Word renders
    // the paragraph as plain body text.
    const usedHeadings = new Set<number>();
    for (const ep of next) {
        if (
            typeof ep.heading === "number" &&
            ep.heading >= 1 &&
            ep.heading <= 3
        ) {
            usedHeadings.add(ep.heading);
        }
    }
    if (usedHeadings.size > 0) {
        const stylesFile = getZipEntry(zip, "word/styles.xml");
        if (stylesFile) {
            const stylesRaw = await stylesFile.async("string");
            const stylesTree = createParser().parse(stylesRaw) as XNode[];
            if (ensureHeadingStyles(stylesTree, usedHeadings)) {
                setZipEntry(
                    zip,
                    "word/styles.xml",
                    ensureXmlDeclaration(createBuilder().build(stylesTree)),
                );
            }
        }
    }

    const out = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
    });
    return { bytes: out, changed: true };
}

// ---------------------------------------------------------------------------
// Resolve a single tracked change (Accept or Reject)
// ---------------------------------------------------------------------------

/**
 * Walk the XML tree and transform matching w:ins/w:del wrappers for the
 * given change id. Returns { found, updatedTree }.
 */
function resolveInTree(
    doc: XNode[],
    changeIds: string[],
    mode: "accept" | "reject",
): { found: boolean } {
    const ids = new Set(changeIds.map((s) => String(s)));
    let touched = false;

    const rewrite = (parentKids: XNode[]): XNode[] => {
        const out: XNode[] = [];
        // Content carried over from a paragraph whose paragraph mark was
        // resolved away; it joins the front of the next paragraph.
        let carried: XNode[] = [];

        // Push a node, handling paragraph marks and pending merges.
        const push = (n: XNode) => {
            if (elName(n) !== "w:p") {
                out.push(n);
                return;
            }
            if (carried.length) {
                const kids = elChildren(n);
                const pPrIdx = kids.findIndex((k) => elName(k) === "w:pPr");
                const at = pPrIdx >= 0 ? pPrIdx + 1 : 0;
                setChildren(n, [
                    ...kids.slice(0, at),
                    ...carried,
                    ...kids.slice(at),
                ]);
                carried = [];
            }
            const mark = resolveParagraphMark(n, ids, mode);
            if (mark.touched) touched = true;
            if (mark.merge) {
                carried = elChildren(n).filter((k) => elName(k) !== "w:pPr");
                return;
            }
            out.push(n);
        };

        for (const n of parentKids) {
            const name = elName(n);
            if (!name) {
                out.push(n);
                continue;
            }

            // Paragraph properties are handled by resolveParagraphMark, not by
            // the generic wrapper logic below — a w:ins there marks a
            // paragraph mark, not a run of inserted text.
            if (name === "w:pPr") {
                out.push(n);
                continue;
            }

            // Recurse first so nested tables/sdts get processed
            const kids = elChildren(n);
            if (kids.length) {
                const newKids = rewrite(kids);
                if (newKids !== kids) setChildren(n, newKids);
            }

            if (name === "w:ins" || name === "w:del") {
                const a = elAttrs(n);
                const wId = String(a["@_w:id"] ?? "");
                if (ids.has(wId)) {
                    touched = true;
                    if (
                        (name === "w:ins" && mode === "accept") ||
                        (name === "w:del" && mode === "reject")
                    ) {
                        // Keep children, drop wrapper. For w:del rejected, we
                        // also need to convert inner w:delText → w:t so the
                        // text reverts to normal body content.
                        const inner =
                            name === "w:del"
                                ? (elChildren(n) as XNode[]).map(unwrapDelText)
                                : (elChildren(n) as XNode[]);
                        for (const c of inner) out.push(c);
                        continue;
                    } else {
                        // accept-del / reject-ins → drop the wrapper and its
                        // inner runs entirely.
                        continue;
                    }
                }
            }

            push(n);
        }

        // Nothing followed the merged paragraph — keep its content by
        // appending it to the previous paragraph, or as its own.
        if (carried.length) {
            let lastPara: XNode | null = null;
            for (let i = out.length - 1; i >= 0; i--) {
                if (elName(out[i]) === "w:p") {
                    lastPara = out[i];
                    break;
                }
            }
            if (lastPara) {
                setChildren(lastPara, [...elChildren(lastPara), ...carried]);
            } else {
                out.push(makeEl("w:p", carried));
            }
            carried = [];
        }
        return out;
    };

    for (const top of doc) {
        if (elName(top) !== "w:document") continue;
        const docKids = elChildren(top);
        setChildren(top, rewrite(docKids));
    }

    return { found: touched };
}

function unwrapDelText(n: XNode): XNode {
    const name = elName(n);
    if (!name) return n;
    if (name === "w:r") {
        const kids = elChildren(n).map(unwrapDelText);
        setChildren(n, kids);
        return n;
    }
    if (name === "w:delText") {
        const attrs = elAttrs(n);
        return {
            "w:t": elChildren(n),
            ...(Object.keys(attrs).length ? { [ATTR_KEY]: attrs } : {}),
        };
    }
    return n;
}

export async function resolveTrackedChange(
    bytes: Buffer,
    changeIds: string[],
    mode: "accept" | "reject",
): Promise<{ bytes: Buffer; found: boolean }> {
    const zip = await JSZip.loadAsync(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) throw new Error("document.xml missing from docx");
    const docXmlRaw = await docXmlFile.async("string");

    const parser = createParser();
    const tree = parser.parse(docXmlRaw) as XNode[];

    const { found } = resolveInTree(tree, changeIds, mode);

    const builder = createBuilder();
    const rebuilt = ensureXmlDeclaration(builder.build(tree));
    setZipEntry(zip, "word/document.xml", rebuilt);
    const out = await zip.generateAsync({
        type: "nodebuffer",
        compression: "DEFLATE",
    });
    return { bytes: out, found };
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function ensureXmlDeclaration(xml: string): string {
    if (xml.startsWith("<?xml")) return xml;
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${xml}`;
}

function truncate(s: string, n: number): string {
    if (!s) return "";
    return s.length > n ? s.slice(0, n) + "…" : s;
}

// Lightweight guards used elsewhere; exported for tests.
export const _internal = {
    flattenParagraph,
    collapseDiff,
    indexAll,
};

// Silence unused import if fastDiff is ever reintroduced for ranged matching.
// kept available in the file because the plan references it for future work.
export const _fastDiff = fastDiff;

// Suppress unused warning for W_NS_ATTRS (kept for potential future use when
// emitting standalone w:ins/w:del into parts without a namespace inheritance).
export const _nsAttrs = W_NS_ATTRS;
