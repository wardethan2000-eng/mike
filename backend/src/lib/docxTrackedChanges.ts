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
    /** The footnote this run references, when it carries a w:footnoteReference. */
    footnoteId?: string;
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
        const fnRef = findChildByName(rKids, "w:footnoteReference");
        const footnoteId = fnRef
            ? String(elAttrs(fnRef)["@_w:id"] ?? "")
            : undefined;
        runs.push({
            childIndex: topChildIdx,
            rPr,
            textNodes,
            ...(footnoteId ? { footnoteId } : {}),
        });
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
    // Inline **bold**/_underline_/*italic* markers in the inserted text become
    // formatting on top of the inherited look, so a redline can add a bold
    // heading or an underlined defined term rather than only plain words.
    const emitIns = (pos: number, text: string, wId: string) => {
        if (!text) return;
        const rPr = rPrForPos(pos === spanEnd ? pos - 1 : pos);
        const pieces = splitIntoParagraphs(text);
        for (let i = 0; i < pieces.length; i++) {
            if (i > 0) newRunGroup.push(makeParagraphBreakMarker());
            if (!pieces[i]) continue;
            const segs = inlineEditRuns(pieces[i]).filter(
                (s) => s.text || s.footnoteRef,
            );
            newRunGroup.push(
                makeEl(
                    "w:ins",
                    segs.map((seg) =>
                        seg.footnoteRef
                            ? buildFootnoteReferenceRun(seg.footnoteRef)
                            : buildRun(rPrWithMarks(rPr, seg), seg.text, "w:t"),
                    ),
                    {
                        "w:id": wId,
                        "w:author": author,
                        "w:date": now,
                    },
                ),
            );
        }
    };

    // Footnote-reference runs carry no characters, so the char walk below
    // would silently drop any that sit inside the touched span. Collect them
    // with their positions (the start of the next text after them) so each
    // one is re-emitted where it belongs: as-is in untouched stretches, and
    // wrapped in w:del where the words around it are deleted — rejecting the
    // change then restores the reference, accepting removes it.
    const refEmits: { pos: number; slotIdx: number; consumed: boolean }[] = [];
    for (let r = firstRunIdx; r <= lastRunIdx; r++) {
        const slot = flat.runs[r];
        if (slot.textNodes.length > 0 || !slot.footnoteId) continue;
        let pos = spanEnd;
        for (let k = r + 1; k <= lastRunIdx; k++) {
            if (flat.runs[k].textNodes.length > 0) {
                pos = flat.runs[k].textNodes[0].paraStart;
                break;
            }
        }
        refEmits.push({ pos, slotIdx: r, consumed: false });
    }
    const refNode = (e: { slotIdx: number }): XNode => {
        const slot = flat.runs[e.slotIdx];
        const child = paraChildren[slot.childIndex];
        return elName(child) === "w:r"
            ? cloneNode(child)
            : buildFootnoteReferenceRun(slot.footnoteId!);
    };
    const emitNormalWithRefs = (a: number, b: number) => {
        let start = a;
        for (const e of refEmits) {
            if (e.consumed || e.pos < a || e.pos > b) continue;
            emitNormal(start, Math.min(e.pos, b));
            e.consumed = true;
            newRunGroup.push(refNode(e));
            start = Math.min(e.pos, b);
        }
        emitNormal(start, b);
    };
    const emitDeletedRefs = (p: PlannedChange) => {
        for (const e of refEmits) {
            if (e.consumed || e.pos < p.deleteStart || e.pos > p.deleteEnd)
                continue;
            e.consumed = true;
            const wId = allocWId();
            p.markDelWIds.push(wId);
            newRunGroup.push(
                makeEl("w:del", [refNode(e)], {
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
        emitNormalWithRefs(cursor, p.deleteStart);
        // Insertion fires at the edit boundary
        if (p.insertedText) emitIns(p.deleteStart, p.insertedText, p.insWId!);
        // Deletion wraps the span
        if (p.deleteEnd > p.deleteStart) {
            emitDel(p.deleteStart, p.deleteEnd, p.delWId!);
            emitDeletedRefs(p);
        }
        cursor = p.deleteEnd;
    }
    emitNormalWithRefs(cursor, spanEnd);

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

/** True when a toggle property (w:b, w:i, w:u, ...) is present and not explicitly off. */
function toggleOn(rPr: XNode | null, name: string): boolean {
    if (!rPr) return false;
    const el = findChildByName(elChildren(rPr), name);
    if (!el) return false;
    const val = elAttrs(el)["@_w:val"];
    if (val == null) return true;
    const v = String(val).toLowerCase();
    return v !== "0" && v !== "false" && v !== "none";
}

/**
 * Wrap a span of text in an inline marker, markdown-style: whitespace at the
 * edges stays outside the marker, and a span the marker syntax cannot express
 * (marker characters inside, or an empty core) is left unwrapped.
 */
function wrapMarked(text: string, marker: "**" | "*" | "_"): string {
    const lead = /^\s*/.exec(text)![0];
    if (lead.length === text.length) return text;
    const trail = /\s*$/.exec(text)![0];
    const core = text.slice(lead.length, text.length - trail.length);
    if (marker === "_" ? /[_\n]/.test(core) : /\*/.test(core)) return text;
    return lead + marker + core + marker + trail;
}

/**
 * The layout tokens the marked read view prefixes onto a body paragraph, so
 * the model can see — and reproduce — what plain text cannot carry: a page
 * break before the paragraph, its heading level, its centering. They match
 * what parseLayoutTokens reads back off a write_document paragraph.
 */
const LAYOUT_TOKEN_RE =
    /^\[(page break|heading [1-3]|centered|right)\]\s*/;

/**
 * Read leading `[page break]`/`[heading N]`/`[centered]`/`[right]` tokens off
 * a line. Returns the remaining text and the layout they describe.
 */
export function parseLayoutTokens(line: string): {
    text: string;
    align?: "center" | "right";
    heading?: 1 | 2 | 3;
    pageBreak?: boolean;
} {
    const out: ReturnType<typeof parseLayoutTokens> = { text: line };
    let rest = line;
    for (;;) {
        const m = LAYOUT_TOKEN_RE.exec(rest);
        if (!m) break;
        const token = m[1];
        if (token === "page break") out.pageBreak = true;
        else if (token === "centered") out.align = "center";
        else if (token === "right") out.align = "right";
        else out.heading = Number(token.slice(-1)) as 1 | 2 | 3;
        rest = rest.slice(m[0].length);
    }
    out.text = rest;
    return out;
}

/** A line with the read view's layout tokens removed. */
export function stripLayoutTokens(line: string): string {
    return parseLayoutTokens(line).text;
}

/**
 * The body text with bold/italic/underline shown as inline markers —
 * `**bold**`, `*italic*`, `_underline_` — one string per paragraph, and
 * body-level paragraphs prefixed with layout tokens (`[page break]`,
 * `[heading 1]`, `[centered]`, `[right]`) where they apply. This is what the
 * model reads: without it, it cannot know which words the source emphasises
 * or which lines are centered, so it cannot keep them when rewriting.
 *
 * The syntax matches what the drafting tools parse back (inlineEditRuns and
 * parseLayoutTokens), so a model that echoes it reproduces the formatting.
 * A run carrying more than one mark gets the strongest one (bold, then
 * underline, then italic) — the parser has no syntax for combinations.
 * Paragraphs inside tables get no layout tokens; cells are too small for the
 * noise to pay for itself.
 */
export async function extractDocxBodyParagraphsMarked(
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

    const hasPageBreakRun = (n: unknown): boolean => {
        const name = elName(n);
        if (!name) return false;
        if (name === "w:br") {
            return String(elAttrs(n)["@_w:type"] ?? "") === "page";
        }
        return elChildren(n as XNode).some(hasPageBreakRun);
    };

    const layoutTokens = (paraNode: XNode): string => {
        const kids = elChildren(paraNode);
        const pPr = findChildByName(kids, "w:pPr");
        const pPrKids = pPr ? elChildren(pPr) : [];
        const tokens: string[] = [];
        if (
            findChildByName(pPrKids, "w:pageBreakBefore") ||
            kids.some(hasPageBreakRun)
        ) {
            tokens.push("[page break]");
        }
        const pStyle = findChildByName(pPrKids, "w:pStyle");
        const styleVal = pStyle ? String(elAttrs(pStyle)["@_w:val"] ?? "") : "";
        const hm = /^Heading([1-3])$/.exec(styleVal);
        if (hm) tokens.push(`[heading ${hm[1]}]`);
        const jc = findChildByName(pPrKids, "w:jc");
        const jcVal = jc ? String(elAttrs(jc)["@_w:val"] ?? "") : "";
        if (jcVal === "center") tokens.push("[centered]");
        else if (jcVal === "right" || jcVal === "end") tokens.push("[right]");
        return tokens.length ? tokens.join(" ") + " " : "";
    };

    const paragraphMarked = (paraChildren: XNode[]): string => {
        const flat = flattenParagraph(paraChildren);
        // Adjacent runs with the same marks merge into one span, so a word
        // Word split across runs is not wrapped piecemeal.
        const spans: { text: string; marker: "" | "**" | "*" | "_" }[] = [];
        for (const slot of flat.runs) {
            // A footnote reference mark reads as [fn N] — the same token the
            // drafting tools parse back into a real reference.
            if (slot.footnoteId) {
                spans.push({ text: `[fn ${slot.footnoteId}]`, marker: "" });
                continue;
            }
            const text = slot.textNodes.map((tn) => tn.text).join("");
            if (!text) continue;
            const marker = toggleOn(slot.rPr, "w:b")
                ? "**"
                : toggleOn(slot.rPr, "w:u")
                  ? "_"
                  : toggleOn(slot.rPr, "w:i")
                    ? "*"
                    : "";
            const prev = spans[spans.length - 1];
            if (prev && prev.marker === marker) prev.text += text;
            else spans.push({ text, marker });
        }
        return spans
            .map((s) => (s.marker ? wrapMarked(s.text, s.marker) : s.text))
            .join("");
    };

    const lines: string[] = [];
    const collect = (nodes: XNode[], inTable: boolean) => {
        for (const n of nodes) {
            const name = elName(n);
            if (!name) continue;
            if (name === "w:p") {
                const prefix = inTable ? "" : layoutTokens(n);
                lines.push(prefix + paragraphMarked(elChildren(n)));
            } else if (
                name === "w:tbl" ||
                name === "w:tr" ||
                name === "w:tc"
            ) {
                collect(elChildren(n), true);
            } else if (name === "w:sdt" || name === "w:sdtContent") {
                collect(elChildren(n), inTable);
            }
        }
    };
    collect(bodyChildren, false);
    return lines;
}

/** extractDocxBodyText, with the inline formatting markers included. */
export async function extractDocxBodyTextMarked(
    bytes: Buffer,
): Promise<string> {
    return (await extractDocxBodyParagraphsMarked(bytes)).join("\n");
}

const HEADER_FOOTER_PART_RE = /^word\/(header\d*|footer\d*|footnotes)\.xml$/;

function partKind(partName: string): "header" | "footer" | "footnote" {
    if (partName.startsWith("header")) return "header";
    if (partName.startsWith("footer")) return "footer";
    return "footnote";
}

/** Footnote wrappers that hold layout plumbing rather than a real note. */
const FOOTNOTE_PLUMBING_TYPES = new Set([
    "separator",
    "continuationSeparator",
    "continuationNotice",
]);

/**
 * The document's footnotes, in file order: id and text (paragraphs joined
 * with newlines). Separator plumbing entries are skipped. Empty when the
 * document has no word/footnotes.xml.
 */
export async function extractDocxFootnotes(
    bytes: Buffer,
): Promise<{ id: string; text: string }[]> {
    const zip = await JSZip.loadAsync(bytes);
    const file = getZipEntry(zip, "word/footnotes.xml");
    if (!file) return [];
    const parser = createParser();
    const tree = parser.parse(await file.async("string")) as XNode[];
    const out: { id: string; text: string }[] = [];
    const visit = (nodes: XNode[]) => {
        for (const n of nodes) {
            const name = elName(n);
            if (!name) continue;
            if (name === "w:footnote") {
                const attrs = elAttrs(n);
                const type = String(attrs["@_w:type"] ?? "");
                if (FOOTNOTE_PLUMBING_TYPES.has(type)) continue;
                const id = String(attrs["@_w:id"] ?? "");
                const paras: XNode[] = [];
                collectParagraphNodes(elChildren(n), paras);
                const text = paras
                    .map((p) => flattenParagraph(elChildren(p)).paraText)
                    .filter((line) => line.trim())
                    .join("\n")
                    .trim();
                if (id && text) out.push({ id, text });
            } else {
                visit(elChildren(n));
            }
        }
    };
    visit(tree);
    return out;
}

/** Every w:p under `nodes`, depth-first — headers nest them in tables too. */
function collectParagraphNodes(nodes: XNode[], out: XNode[]): void {
    for (const n of nodes) {
        const name = elName(n);
        if (!name) continue;
        if (name === "w:p") out.push(n);
        else collectParagraphNodes(elChildren(n), out);
    }
}

/**
 * The text of the document's page headers and footers, one entry per distinct
 * part, paragraphs joined with newlines. Empty parts are dropped and repeats
 * (the same header declared for first/even/odd pages) deduplicated.
 */
export async function extractDocxHeadersFooters(bytes: Buffer): Promise<{
    headers: string[];
    footers: string[];
}> {
    const zip = await JSZip.loadAsync(bytes);
    const parser = createParser();
    const headers: string[] = [];
    const footers: string[] = [];
    for (const path of Object.keys(zip.files).sort()) {
        const m = HEADER_FOOTER_PART_RE.exec(path.replace(/\\/g, "/"));
        if (!m) continue;
        const raw = await zip.files[path].async("string");
        const tree = parser.parse(raw) as XNode[];
        const paras: XNode[] = [];
        collectParagraphNodes(tree, paras);
        const text = paras
            .map((p) => flattenParagraph(elChildren(p)).paraText)
            .filter((line) => line.trim())
            .join("\n");
        if (!text) continue;
        const kind = partKind(m[1]);
        if (kind === "footnote") continue; // footnotes are read separately
        const bucket = kind === "header" ? headers : footers;
        if (!bucket.includes(text)) bucket.push(text);
    }
    return { headers, footers };
}

const FOOTNOTES_CONTENT_TYPE =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml";
const FOOTNOTES_REL_TYPE =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes";

/**
 * Record brand-new footnotes in word/footnotes.xml and return their ids, in
 * order. When the document has no footnotes part at all, it is created and
 * wired up: the part itself (with Word's separator plumbing), its content
 * type, and the relationship from document.xml.
 */
export async function addFootnotesToZip(
    zip: JSZip,
    texts: string[],
): Promise<string[]> {
    if (texts.length === 0) return [];
    const parser = createParser();
    const builder = createBuilder();
    const xmlHeader = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;

    // Load or create the footnotes part.
    const existing = getZipEntry(zip, "word/footnotes.xml");
    let tree: XNode[];
    if (existing) {
        tree = parser.parse(await existing.async("string")) as XNode[];
    } else {
        const skeleton =
            `<w:footnotes xmlns:w="${W_NS_ATTRS["xmlns:w"]}">` +
            `<w:footnote w:type="separator" w:id="-1"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:separator/></w:r></w:p></w:footnote>` +
            `<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>` +
            `</w:footnotes>`;
        tree = parser.parse(skeleton) as XNode[];

        // Content type for the new part.
        const ctFile = getZipEntry(zip, "[Content_Types].xml");
        if (ctFile) {
            const ctRaw = await ctFile.async("string");
            if (!ctRaw.includes("/word/footnotes.xml")) {
                zip.file(
                    "[Content_Types].xml",
                    ctRaw.replace(
                        "</Types>",
                        `<Override PartName="/word/footnotes.xml" ContentType="${FOOTNOTES_CONTENT_TYPE}"/></Types>`,
                    ),
                );
            }
        }

        // Relationship from document.xml to the new part.
        const relPath = "word/_rels/document.xml.rels";
        const relFile = getZipEntry(zip, relPath);
        if (relFile) {
            const relRaw = await relFile.async("string");
            if (!relRaw.includes(FOOTNOTES_REL_TYPE)) {
                const usedIds = [...relRaw.matchAll(/Id="rId(\d+)"/g)].map(
                    (m) => Number(m[1]),
                );
                const nextRel = (usedIds.length ? Math.max(...usedIds) : 0) + 1;
                zip.file(
                    relPath,
                    relRaw.replace(
                        "</Relationships>",
                        `<Relationship Id="rId${nextRel}" Type="${FOOTNOTES_REL_TYPE}" Target="footnotes.xml"/></Relationships>`,
                    ),
                );
            }
        } else {
            zip.file(
                relPath,
                xmlHeader +
                    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
                    `<Relationship Id="rId9001" Type="${FOOTNOTES_REL_TYPE}" Target="footnotes.xml"/></Relationships>`,
            );
        }
    }

    // Find the footnotes root and the highest id in use.
    let root: XNode | null = null;
    const findRoot = (nodes: XNode[]) => {
        for (const n of nodes) {
            if (elName(n) === "w:footnotes") {
                root = n;
                return;
            }
            findRoot(elChildren(n));
        }
    };
    findRoot(tree);
    if (!root) throw new Error("w:footnotes root missing from footnotes.xml");
    let maxId = 0;
    for (const child of elChildren(root)) {
        if (elName(child) !== "w:footnote") continue;
        const id = parseInt(String(elAttrs(child)["@_w:id"] ?? ""), 10);
        if (Number.isFinite(id) && id > maxId) maxId = id;
    }

    // Append one entry per note, in Word's usual shape: the automatic number
    // mark, a space, then the note's text.
    const ids: string[] = [];
    const rootChildren = elChildren(root as XNode);
    for (const text of texts) {
        const id = String(++maxId);
        ids.push(id);
        rootChildren.push(
            makeEl(
                "w:footnote",
                [
                    makeEl("w:p", [
                        makeEl("w:pPr", [
                            makeEl("w:pStyle", [], { "w:val": "FootnoteText" }),
                        ]),
                        makeEl("w:r", [
                            makeEl("w:rPr", [
                                makeEl("w:rStyle", [], {
                                    "w:val": "FootnoteReference",
                                }),
                            ]),
                            makeEl("w:footnoteRef", []),
                        ]),
                        buildRun(null, ` ${text}`, "w:t"),
                    ]),
                ],
                { "w:id": id },
            ),
        );
    }
    setChildren(root as XNode, rootChildren);

    zip.file("word/footnotes.xml", xmlHeader + (builder.build(tree) as string));
    return ids;
}

/** Overwrite a w:t's text, preserving its element identity and attributes. */
function setWtText(wtEl: XNode, text: string): void {
    setChildren(wtEl, [makeText(text)]);
    const attrs = (wtEl[ATTR_KEY] as Record<string, string>) ?? {};
    attrs["@_xml:space"] = "preserve";
    wtEl[ATTR_KEY] = attrs;
}

/**
 * Apply plain find/replace edits to the page headers, footers and footnote
 * text. Tracked changes are not written here — these parts sit outside the
 * body's review pipeline — so the text is simply replaced, keeping every run,
 * logo and layout element in place: only the matched characters change, and
 * the replacement takes the look of the run the match starts in.
 *
 * Each edit carries its caller-side index so the caller can tell which of a
 * larger batch landed. An edit with an empty `find` is skipped — inserting
 * new material into a header is not supported.
 */
export async function applyHeaderFooterEdits(
    bytes: Buffer,
    edits: { index: number; find: string; replace: string }[],
): Promise<{
    bytes: Buffer;
    applied: { index: number; part: "header" | "footer" | "footnote" }[];
}> {
    const applied: { index: number; part: "header" | "footer" | "footnote" }[] =
        [];
    const todo = edits.filter((e) => e.find);
    if (todo.length === 0) return { bytes, applied };

    const zip = await JSZip.loadAsync(bytes);
    const parser = createParser();
    const builder = createBuilder();
    const done = new Set<number>();
    let anyPartChanged = false;

    for (const path of Object.keys(zip.files).sort()) {
        const m = HEADER_FOOTER_PART_RE.exec(path.replace(/\\/g, "/"));
        if (!m) continue;
        const raw = await zip.files[path].async("string");
        const tree = parser.parse(raw) as XNode[];
        const paras: XNode[] = [];
        collectParagraphNodes(tree, paras);
        let partChanged = false;

        for (const edit of todo) {
            if (done.has(edit.index)) continue;
            // Header text is short and shown to the model verbatim, so the
            // replacement is plain: markers stripped, newlines flattened.
            const replaceText = stripInlineMarkers(edit.replace).replace(
                /\s*\n\s*/g,
                " ",
            );
            for (const p of paras) {
                const flat = flattenParagraph(elChildren(p));
                const at = flat.paraText.indexOf(edit.find);
                if (at < 0) continue;
                const end = at + edit.find.length;
                // Splice per text node: the node containing the match start
                // keeps its lead and gains the replacement; nodes wholly
                // inside the range are emptied; the node containing the end
                // keeps its tail.
                let inserted = false;
                for (const slot of flat.runs) {
                    for (const tn of slot.textNodes) {
                        if (tn.paraEnd <= at || tn.paraStart >= end) continue;
                        const lead =
                            at > tn.paraStart
                                ? tn.text.slice(0, at - tn.paraStart)
                                : "";
                        const tail =
                            end < tn.paraEnd
                                ? tn.text.slice(end - tn.paraStart)
                                : "";
                        const middle = inserted ? "" : replaceText;
                        inserted = true;
                        setWtText(tn.wtEl, lead + middle + tail);
                    }
                }
                if (inserted) {
                    done.add(edit.index);
                    applied.push({
                        index: edit.index,
                        part: partKind(m[1]),
                    });
                    partChanged = true;
                }
                break;
            }
        }

        if (partChanged) {
            zip.file(
                path,
                `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
                    (builder.build(tree) as string),
            );
            anyPartChanged = true;
        }
    }

    if (!anyPartChanged) return { bytes, applied };
    const out = await zip.generateAsync({ type: "nodebuffer" });
    return { bytes: Buffer.from(out), applied };
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
        // Paragraph-mark changes live in w:pPr and row-insertion marks in
        // w:trPr; neither is rendered as an <ins>/<del> element, so including
        // them would shift the index mapping the frontend relies on.
        if (name === "w:pPr" || name === "w:trPr") return;
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

        // A replace carrying **bold**/_underline_/*italic* markers skips the
        // diff-collapse: the collapse compares characters and could cut a
        // marker in half, leaving stray asterisks in the document. The whole
        // find is deleted and the whole marked text inserted instead.
        const replaceIsMarked = stripInlineMarkers(replace) !== replace;
        const { deleted, inserted, leadingEq } = replaceIsMarked
            ? { deleted: originalFind, inserted: replace, leadingEq: 0 }
            : collapseDiff(originalFind, replace);
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
            // Reported as the plain characters that landed in the document —
            // the markers themselves are formatting, not text.
            insertedText: stripInlineMarkers(plan.insertedText),
            contextBefore: plan.contextBefore,
            contextAfter: plan.contextAfter,
            reason: plan.reason,
        });
    }

    // Materialize brand-new footnotes named in the surviving plans: allocate
    // ids, record the notes in word/footnotes.xml, and rewrite the inserted
    // text to plain [fn id] references before emission. Doing this after
    // planning means an edit whose anchor failed never leaves an orphaned
    // note behind.
    {
        const NEW_FN_RE = /\[fn new:([^\]]+)\]/g;
        const carriers: PlannedChange[] = [];
        const noteTexts: string[] = [];
        for (const list of plansPerParagraph.values()) {
            for (const pc of list) {
                const found = [...pc.insertedText.matchAll(NEW_FN_RE)];
                if (found.length === 0) continue;
                carriers.push(pc);
                noteTexts.push(...found.map((m) => m[1].trim()));
            }
        }
        if (noteTexts.length > 0) {
            const ids = await addFootnotesToZip(zip, noteTexts);
            let k = 0;
            for (const pc of carriers) {
                pc.insertedText = pc.insertedText.replace(
                    NEW_FN_RE,
                    () => `[fn ${ids[k++]}]`,
                );
            }
        }
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
    /**
     * A footnote reference mark, written in text as `[fn N]`. Carries no
     * characters of its own; N is the footnote's id in word/footnotes.xml.
     */
    footnoteRef?: string;
    /**
     * A brand-new footnote, written in text as `[fn new: note text]`. The
     * applier allocates a real id, records the note in word/footnotes.xml
     * (creating the part if the document has none) and turns this into a
     * reference mark at this spot.
     */
    footnoteNew?: string;
}

export interface EditParagraph {
    text: string;
    /**
     * Leave the field out to keep the paragraph's own alignment; null or
     * "left" returns it to the margin.
     */
    align?: "left" | "center" | "right" | "justify" | null;
    /**
     * true starts this paragraph on a fresh page, false takes an existing
     * page break off it. Leave it out to keep whatever the paragraph has.
     */
    pageBreak?: boolean | null;
    /**
     * 1-3 to make this paragraph a Word heading, 0 or null for body text.
     * Leave the field out entirely to keep whatever style the paragraph
     * already carries.
     * Applied as a w:pStyle referencing Word's built-in Heading styles, so the
     * document's own heading look is used and Word's navigation pane picks
     * them up.
     */
    heading?: number | null;
    /**
     * Rows of a table to place here instead of a paragraph. Used when a
     * rewrite adds a table the original document did not have.
     */
    table?: { rows: string[][]; borders?: boolean; widths?: number[] } | null;
    /**
     * "bullet" or "number" to make this paragraph a list item, null for an
     * ordinary paragraph. Leave the field out entirely to keep whatever
     * numbering the paragraph already carries. Consecutive paragraphs of the same kind form
     * one list, so a numbered run counts 1, 2, 3.
     */
    list?: "bullet" | "number" | null;
    runs: EditRun[];
}

export interface FormattedEditResult {
    bytes: Buffer;
    changed: boolean;
}

/**
 * Split a line into runs on the inline markers the assistant uses when
 * writing document text: **bold**, _underline_, *italic*, and `[fn N]` for a
 * footnote reference mark (which carries no characters of its own).
 */
export function inlineEditRuns(line: string): EditRun[] {
    const runs: EditRun[] = [];
    const pattern =
        /(\*\*[^*]+\*\*|_[^_\n]+_|\*[^*\n]+\*|\[fn \d+\]|\[fn new:[^\]]+\])/g;
    const push = (text: string, marks: Partial<EditRun>) => {
        if (!text) return;
        runs.push({ text, ...marks });
    };
    let last = 0;
    for (const match of line.matchAll(pattern)) {
        const at = match.index ?? 0;
        push(line.slice(last, at), {});
        const token = match[0];
        if (token.startsWith("**")) push(token.slice(2, -2), { bold: true });
        else if (token.startsWith("[fn new:"))
            runs.push({ text: "", footnoteNew: token.slice(8, -1).trim() });
        else if (token.startsWith("[fn "))
            runs.push({ text: "", footnoteRef: token.slice(4, -1) });
        else if (token.startsWith("_"))
            push(token.slice(1, -1), { underline: true });
        else push(token.slice(1, -1), { italic: true });
        last = at + token.length;
    }
    push(line.slice(last), {});
    if (runs.length === 0) runs.push({ text: "" });
    return runs;
}

/**
 * A paragraph's text reduced to what matters for "did it change?": curly and
 * straight quotes, dash variants and whitespace runs all compare equal. A
 * model echoing a document back retypes its typography — ’ as ', “ as ", a
 * tab run as spaces — and those must not read as edits to review.
 */
export function canonicalParagraphText(s: string): string {
    return s
        .replace(/[\u2018\u2019\u2032]/g, "'")
        .replace(/[\u201C\u201D\u2033]/g, '"')
        .replace(/[\u2013\u2014]/g, "-")
        .replace(/[\u00A0\u200B]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** The plain characters of a marker-carrying string, as inlineEditRuns reads it. */
export function stripInlineMarkers(line: string): string {
    return inlineEditRuns(line)
        .map((run) => run.text)
        .join("");
}

/**
 * Serialize runs back into marker text — the inverse of inlineEditRuns, used
 * when a formatted rewrite has to travel through the find/replace redline
 * pipeline as a string. Spans the syntax cannot express stay plain.
 */
export function runsToMarkedText(runs: EditRun[]): string {
    return runs
        .map((run) => {
            if (run.footnoteNew) return `[fn new: ${run.footnoteNew}]`;
            if (run.footnoteRef) return `[fn ${run.footnoteRef}]`;
            const marker = run.bold ? "**" : run.underline ? "_" : run.italic ? "*" : "";
            return marker ? wrapMarked(run.text, marker) : run.text;
        })
        .join("");
}

/**
 * A copy of `base` with the run's marks (bold/italic/underline) ADDED on top.
 * Unlike buildRunProps this keeps whatever toggles the base already has —
 * plain inserted text should inherit its surroundings exactly, and marked
 * text should only gain the mark.
 */
function rPrWithMarks(base: XNode | null, run: EditRun): XNode | null {
    if (!run.bold && !run.italic && !run.underline) return base;
    const kids: XNode[] = base ? elChildren(base).map(cloneNode) : [];
    const has = (name: string) => kids.some((c) => elName(c) === name);
    const marks: XNode[] = [];
    if (run.bold && !has("w:b")) {
        marks.push(makeEl("w:b", []));
        marks.push(makeEl("w:bCs", []));
    }
    if (run.italic && !has("w:i")) {
        marks.push(makeEl("w:i", []));
        marks.push(makeEl("w:iCs", []));
    }
    if (run.underline && !has("w:u")) {
        marks.push(makeEl("w:u", [], { "w:val": "single" }));
    }
    if (marks.length === 0) return base;
    // Keep w:rFonts first, as the schema's ordering expects.
    const rFontsIdx = kids.findIndex((c) => elName(c) === "w:rFonts");
    const at = rFontsIdx >= 0 ? rFontsIdx + 1 : 0;
    return makeEl("w:rPr", [...kids.slice(0, at), ...marks, ...kids.slice(at)]);
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
    list?: { numId: number } | null,
    pageBreak?: boolean | null,
): XNode | null {
    // `undefined` means "leave this as the paragraph already has it" — what a
    // whole-document rewrite wants, since it only supplies words and the
    // document's own headings and clause numbering should survive. `null`
    // means "remove it", which is what the in-app editor sends when someone
    // turns a heading or a list item back into ordinary text.
    const keepStyle = heading === undefined;
    const keepList = list === undefined;
    const keepAlign = align === undefined;
    const keepPageBreak = pageBreak === undefined;
    const wantHeading =
        typeof heading === "number" && heading >= 1 && heading <= 3
            ? heading
            : null;
    const base = basePPr ? cloneNode(basePPr) : null;
    const noAlign = !align || align === "left";
    if (noAlign && keepAlign && !wantHeading && !list && !pageBreak && !base)
        return null;

    const pPr = base ?? makeEl("w:pPr", []);
    let kids = elChildren(pPr);

    // Heading: replace any existing paragraph style. Removing it returns the
    // paragraph to the document's default (body) style.
    if (!keepStyle) {
        kids = kids.filter((c) => elName(c) !== "w:pStyle");
        if (wantHeading) {
            // w:pStyle must be the first child of w:pPr.
            kids = [
                makeEl("w:pStyle", [], { "w:val": `Heading${wantHeading}` }),
                ...kids,
            ];
        }
    }

    // List membership. w:numPr lives inside w:pPr, after w:pStyle.
    if (!keepList) kids = kids.filter((c) => elName(c) !== "w:numPr");
    if (list) {
        const numPr = makeEl("w:numPr", [
            makeEl("w:ilvl", [], { "w:val": "0" }),
            makeEl("w:numId", [], { "w:val": String(list.numId) }),
        ]);
        const styleIdx = kids.findIndex((c) => elName(c) === "w:pStyle");
        const at = styleIdx >= 0 ? styleIdx + 1 : 0;
        kids = [...kids.slice(0, at), numPr, ...kids.slice(at)];
    }

    // Start this paragraph on a fresh page.
    if (!keepPageBreak) {
        kids = kids.filter((c) => elName(c) !== "w:pageBreakBefore");
        if (pageBreak) kids = [makeEl("w:pageBreakBefore", []), ...kids];
    }

    // Alignment.
    if (!keepAlign) kids = kids.filter((c) => elName(c) !== "w:jc");
    if (!keepAlign && !noAlign) {
        // Schema order inside w:pPr: pStyle, numPr, ... , jc.
        const numIdx = kids.findIndex((c) => elName(c) === "w:numPr");
        const styleIdx = kids.findIndex((c) => elName(c) === "w:pStyle");
        const at = Math.max(numIdx, styleIdx) + 1;
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

/**
 * Word renders a list only if the document has a numbering part defining it.
 * Generated documents often have none, so build (or extend) word/numbering.xml
 * with one bullet definition and one decimal definition, and make sure the
 * package registers the part. Returns the numId for each kind.
 *
 * Existing definitions are never modified — a firm template keeps its own list
 * look; we only append the two definitions we need with unused ids.
 */
const LIST_ABSTRACT_BULLET = 9100;
const LIST_ABSTRACT_NUMBER = 9101;

function buildAbstractNum(id: number, kind: "bullet" | "number"): XNode {
    const lvls: XNode[] = [];
    for (let i = 0; i < 3; i++) {
        const indent = 720 * (i + 1);
        const bulletChars = ["", "o", ""];
        lvls.push(
            makeEl(
                "w:lvl",
                [
                    makeEl("w:start", [], { "w:val": "1" }),
                    makeEl("w:numFmt", [], {
                        "w:val": kind === "bullet" ? "bullet" : "decimal",
                    }),
                    makeEl("w:lvlText", [], {
                        "w:val": kind === "bullet" ? bulletChars[i] : `%${i + 1}.`,
                    }),
                    makeEl("w:lvlJc", [], { "w:val": "left" }),
                    makeEl("w:pPr", [
                        makeEl("w:ind", [], {
                            "w:left": String(indent),
                            "w:hanging": "360",
                        }),
                    ]),
                    ...(kind === "bullet"
                        ? [
                              makeEl("w:rPr", [
                                  makeEl("w:rFonts", [], {
                                      "w:ascii": "Symbol",
                                      "w:hAnsi": "Symbol",
                                      "w:hint": "default",
                                  }),
                              ]),
                          ]
                        : []),
                ],
                { "w:ilvl": String(i) },
            ),
        );
    }
    return makeEl(
        "w:abstractNum",
        [makeEl("w:multiLevelType", [], { "w:val": "hybridMultilevel" }), ...lvls],
        { "w:abstractNumId": String(id) },
    );
}

/**
 * Ensure numbering definitions exist. Mutates/creates the numbering tree and
 * returns { bullet, number } numIds, or null if the part can't be prepared.
 */
function ensureNumbering(
    numberingTree: XNode[] | null,
    kinds: Set<"bullet" | "number">,
): { tree: XNode[]; ids: Record<string, number>; changed: boolean } | null {
    if (kinds.size === 0) return null;
    let tree = numberingTree;
    let changed = false;
    if (!tree) {
        tree = [
            makeEl("w:numbering", [], {
                "xmlns:w":
                    "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
            }),
        ];
        changed = true;
    }
    let root: XNode | null = null;
    for (const top of tree) if (elName(top) === "w:numbering") root = top;
    if (!root) return null;

    const kids = elChildren(root);
    const haveAbstract = new Set<string>();
    const haveNum = new Map<string, string>(); // numId -> abstractNumId
    let maxNumId = 0;
    for (const c of kids) {
        const name = elName(c);
        if (name === "w:abstractNum") {
            const id = String(elAttrs(c)["@_w:abstractNumId"] ?? "");
            if (id) haveAbstract.add(id);
        } else if (name === "w:num") {
            const id = String(elAttrs(c)["@_w:numId"] ?? "");
            const ref = findChildByName(elChildren(c), "w:abstractNumId");
            const refVal = ref ? String(elAttrs(ref)["@_w:val"] ?? "") : "";
            if (id) {
                haveNum.set(id, refVal);
                const n = parseInt(id, 10);
                if (Number.isFinite(n) && n > maxNumId) maxNumId = n;
            }
        }
    }

    const ids: Record<string, number> = {};
    // w:abstractNum elements must all precede w:num elements.
    const abstracts: XNode[] = [];
    const nums: XNode[] = [];
    for (const kind of kinds) {
        const absId =
            kind === "bullet" ? LIST_ABSTRACT_BULLET : LIST_ABSTRACT_NUMBER;
        // Reuse our own definition if a previous save already added it.
        let numId: number | null = null;
        for (const [nId, aId] of haveNum) {
            if (aId === String(absId)) {
                numId = parseInt(nId, 10);
                break;
            }
        }
        if (!haveAbstract.has(String(absId))) {
            abstracts.push(buildAbstractNum(absId, kind));
            haveAbstract.add(String(absId));
            changed = true;
        }
        if (numId === null) {
            numId = ++maxNumId;
            nums.push(
                makeEl(
                    "w:num",
                    [makeEl("w:abstractNumId", [], { "w:val": String(absId) })],
                    { "w:numId": String(numId) },
                ),
            );
            haveNum.set(String(numId), String(absId));
            changed = true;
        }
        ids[kind] = numId;
    }

    if (changed) {
        const existingAbstract = kids.filter(
            (c) => elName(c) === "w:abstractNum",
        );
        const existingNums = kids.filter((c) => elName(c) === "w:num");
        const others = kids.filter(
            (c) => elName(c) !== "w:abstractNum" && elName(c) !== "w:num",
        );
        setChildren(root, [
            ...others,
            ...existingAbstract,
            ...abstracts,
            ...existingNums,
            ...nums,
        ]);
    }
    return { tree, ids, changed };
}

/**
 * Register word/numbering.xml in [Content_Types].xml and the document's
 * relationships, so a document that never had a numbering part gets a valid
 * one. No-ops when the entries already exist.
 */
async function registerNumberingPart(zip: JSZip): Promise<void> {
    // Content types
    const ctFile = getZipEntry(zip, "[Content_Types].xml");
    if (ctFile) {
        const raw = await ctFile.async("string");
        if (!raw.includes("/word/numbering.xml")) {
            const entry =
                '<Override PartName="/word/numbering.xml" ' +
                'ContentType="application/vnd.openxmlformats-officedocument' +
                '.wordprocessingml.numbering+xml"/>';
            const out = raw.replace("</Types>", `${entry}</Types>`);
            setZipEntry(zip, "[Content_Types].xml", out);
        }
    }
    // Document relationships
    const relPath = "word/_rels/document.xml.rels";
    const relFile = getZipEntry(zip, relPath);
    if (relFile) {
        const raw = await relFile.async("string");
        if (!raw.includes('Target="numbering.xml"')) {
            // Pick an id that isn't taken.
            let n = 900;
            while (raw.includes(`Id="rId${n}"`)) n++;
            const entry =
                `<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org` +
                `/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>`;
            const out = raw.replace("</Relationships>", `${entry}</Relationships>`);
            setZipEntry(zip, relPath, out);
        }
    }
}

/** Build a fresh <w:p> from a formatted paragraph, inheriting base props. */
function buildFormattedParagraph(
    para: EditParagraph,
    baseRPr: XNode | null,
    basePPr: XNode | null,
    listNumId?: number | null,
): XNode {
    if (para.table && para.table.rows.length > 0) {
        return buildSimpleTable(para.table.rows, {
            baseRPr,
            borders: para.table.borders,
            widths: para.table.widths,
        });
    }
    const children: XNode[] = [];
    const pPr = applyParagraphProps(
        basePPr,
        // Absent means "keep the paragraph's own alignment"; see
        // applyParagraphProps.
        para.align,
        // Absent means "keep what this paragraph already had"; see
        // applyParagraphProps.
        para.heading,
        listNumId
            ? { numId: listNumId }
            : para.list === undefined
              ? undefined
              : null,
        para.pageBreak,
    );
    if (pPr) children.push(pPr);
    const runs = para.runs && para.runs.length ? para.runs : [{ text: para.text }];
    for (const run of runs) {
        if (run.footnoteRef) {
            children.push(buildFootnoteReferenceRun(run.footnoteRef));
            continue;
        }
        if (!run.text) continue;
        const rPr = buildRunProps(baseRPr, run);
        children.push(buildRun(rPr, run.text, "w:t"));
    }
    // A paragraph with no runs still needs to exist (empty line).
    return makeEl("w:p", children);
}

/**
 * Build a simple bordered table: one row per entry, one cell per string. Used
 * when a rewrite adds a table the document being copied did not have — a new
 * exhibit grid, a price schedule. Cells inherit the run formatting passed in,
 * so the table reads in the document's own font.
 */
export function buildSimpleTable(
    rows: string[][],
    opts?: { baseRPr?: XNode | null; borders?: boolean; widths?: number[] },
): XNode {
    const columns = Math.max(1, ...rows.map((row) => row.length));
    // Word measures table widths in fiftieths of a percent; spread the columns
    // evenly unless told otherwise.
    const widths =
        opts?.widths && opts.widths.length === columns
            ? opts.widths
            : Array.from({ length: columns }, () => 1 / columns);
    const total = widths.reduce((sum, w) => sum + w, 0) || 1;
    const pctOf = (w: number) => String(Math.round((w / total) * 5000));

    const borderSides = ["top", "left", "bottom", "right", "insideH", "insideV"];
    const borderEls = borderSides.map((side) =>
        makeEl(`w:${side}`, [], {
            "w:val": opts?.borders === false ? "none" : "single",
            "w:sz": "4",
            "w:space": "0",
            "w:color": "auto",
        }),
    );

    const tblPr = makeEl("w:tblPr", [
        makeEl("w:tblW", [], { "w:w": "5000", "w:type": "pct" }),
        makeEl("w:tblBorders", borderEls),
    ]);
    const tblGrid = makeEl(
        "w:tblGrid",
        widths.map((w) => makeEl("w:gridCol", [], { "w:w": pctOf(w) })),
    );

    const trs = rows.map((row) =>
        makeEl(
            "w:tr",
            Array.from({ length: columns }, (_, i) => {
                const text = row[i] ?? "";
                const tcPr = makeEl("w:tcPr", [
                    makeEl("w:tcW", [], {
                        "w:w": pctOf(widths[i]),
                        "w:type": "pct",
                    }),
                ]);
                const paragraph = makeEl("w:p", [
                    buildRun(
                        opts?.baseRPr ? cloneNode(opts.baseRPr) : null,
                        text,
                        "w:t",
                    ),
                ]);
                return makeEl("w:tc", [tcPr, paragraph]);
            }),
        ),
    );

    return makeEl("w:tbl", [tblPr, tblGrid, ...trs]);
}

/**
 * Insert tables into the body as tracked changes. Each table's rows carry a
 * w:ins row-insertion mark and every cell run is wrapped in w:ins, so the
 * whole table reads as one reviewable insertion: accepting strips the marks,
 * rejecting removes the rows (and the empty shell with them — see
 * resolveInTree). Each table goes in after the first body paragraph whose
 * text equals `afterParagraphText`, or before the document's final paragraph
 * when that anchor is missing.
 *
 * Returns one change per table: `insId` is the first cell-run wrapper (a
 * rendered element the UI can anchor a card to) and `extraIds` the rest.
 */
export async function insertTrackedTables(
    bytes: Buffer,
    tables: {
        afterParagraphText: string | null;
        rows: string[][];
        borders?: boolean;
        widths?: number[];
    }[],
    opts?: { author?: string },
): Promise<{
    bytes: Buffer;
    changes: { insId: string; extraIds: string[]; preview: string }[];
}> {
    const author = opts?.author ?? "Mike";
    const now = new Date().toISOString();
    const zip = await JSZip.loadAsync(bytes);
    const docXmlFile = getZipEntry(zip, "word/document.xml");
    if (!docXmlFile) throw new Error("document.xml missing from docx");
    const docXmlRaw = await docXmlFile.async("string");
    const parser = createParser();
    const tree = parser.parse(docXmlRaw) as XNode[];
    const bodyChildren = findBody(tree);
    if (!bodyChildren) throw new Error("document body missing from docx");

    let nextId = maxTrackedId(tree) + 1;
    const changes: { insId: string; extraIds: string[]; preview: string }[] =
        [];

    for (const spec of tables) {
        const tbl = buildSimpleTable(spec.rows, {
            borders: spec.borders,
            widths: spec.widths,
        });
        const ids: string[] = [];
        let firstRunId: string | null = null;
        for (const tr of elChildren(tbl)) {
            if (elName(tr) !== "w:tr") continue;
            const rowId = String(nextId++);
            ids.push(rowId);
            const trPr = makeEl("w:trPr", [
                makeEl("w:ins", [], {
                    "w:id": rowId,
                    "w:author": author,
                    "w:date": now,
                }),
            ]);
            const cells = elChildren(tr);
            setChildren(tr, [trPr, ...cells]);
            for (const tc of cells) {
                if (elName(tc) !== "w:tc") continue;
                for (const p of elChildren(tc)) {
                    if (elName(p) !== "w:p") continue;
                    const newKids = elChildren(p).map((k) => {
                        if (elName(k) !== "w:r") return k;
                        const runId = String(nextId++);
                        ids.push(runId);
                        if (
                            firstRunId === null &&
                            elChildren(k).some((c) => elName(c) === "w:t")
                        ) {
                            firstRunId = runId;
                        }
                        return makeEl("w:ins", [k], {
                            "w:id": runId,
                            "w:author": author,
                            "w:date": now,
                        });
                    });
                    setChildren(p, newKids);
                }
            }
        }

        // Where the table goes: after its anchor paragraph, else before the
        // final paragraph (which carries the section properties).
        let at = -1;
        if (spec.afterParagraphText) {
            for (let i = 0; i < bodyChildren.length; i++) {
                if (elName(bodyChildren[i]) !== "w:p") continue;
                const text = flattenParagraph(
                    elChildren(bodyChildren[i]),
                ).paraText;
                if (text === spec.afterParagraphText) {
                    at = i + 1;
                    break;
                }
            }
        }
        if (at < 0) {
            for (let i = bodyChildren.length - 1; i >= 0; i--) {
                if (elName(bodyChildren[i]) === "w:p") {
                    at = i;
                    break;
                }
            }
            if (at < 0) at = bodyChildren.length;
        }
        bodyChildren.splice(at, 0, tbl);

        const insId = firstRunId ?? ids[ids.length - 1];
        changes.push({
            insId,
            extraIds: ids.filter((id) => id !== insId),
            preview: spec.rows.map((row) => row.join(" | ")).join("\n"),
        });
    }

    replaceBody(tree, bodyChildren);
    const builder = createBuilder();
    zip.file(
        "word/document.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
            (builder.build(tree) as string),
    );
    const out = await zip.generateAsync({ type: "nodebuffer" });
    return { bytes: Buffer.from(out), changes };
}

/** A run holding a footnote reference mark, styled the way Word writes them. */
function buildFootnoteReferenceRun(footnoteId: string): XNode {
    return makeEl("w:r", [
        makeEl("w:rPr", [
            makeEl("w:rStyle", [], { "w:val": "FootnoteReference" }),
        ]),
        makeEl("w:footnoteReference", [], { "w:id": footnoteId }),
    ]);
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
        isListItem: boolean;
        /**
         * The children array this paragraph actually sits in. A paragraph
         * inside a table cell belongs to that cell, not to the body, and has
         * to be rebuilt where it lives or its text is duplicated into the
         * body and the table keeps its old wording.
         */
        container: XNode[];
        /** Ids of the footnotes this paragraph references, in order. */
        footnoteIds: string[];
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
                const flat = flattenParagraph(kids);
                paras.push({
                    node: n,
                    text: flat.paraText,
                    footnoteIds: flat.runs
                        .filter((slot) => slot.footnoteId)
                        .map((slot) => slot.footnoteId!),
                    baseRPr: firstRunRPr(kids),
                    basePPr: pPr,
                    hasSectPr: !!(pPr && findChildByName(elChildren(pPr), "w:sectPr")),
                    headingLevel: hm ? Number(hm[1]) : 0,
                    isListItem: !!(
                        pPr && findChildByName(elChildren(pPr), "w:numPr")
                    ),
                    container: nodes,
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

    // Brand-new footnotes named in the rewrite: allocate ids and record the
    // notes now, so the walk below emits real reference marks.
    {
        const noteTexts: string[] = [];
        for (const paragraph of next)
            for (const run of paragraph.runs ?? [])
                if (run.footnoteNew) noteTexts.push(run.footnoteNew);
        if (noteTexts.length > 0) {
            const ids = await addFootnotesToZip(zip, noteTexts);
            let k = 0;
            for (const paragraph of next)
                for (const run of paragraph.runs ?? [])
                    if (run.footnoteNew) {
                        run.footnoteRef = ids[k++];
                        delete run.footnoteNew;
                    }
        }
    }

    // Prepare list numbering before rebuilding paragraphs, so each list
    // paragraph can be given its numId.
    const usedLists = new Set<"bullet" | "number">();
    for (const ep of next) {
        if (ep.list === "bullet" || ep.list === "number") usedLists.add(ep.list);
    }
    let listIds: Record<string, number> = {};
    let numberingTreeToWrite: XNode[] | null = null;
    if (usedLists.size > 0) {
        const numFile = getZipEntry(zip, "word/numbering.xml");
        const existingTree = numFile
            ? (createParser().parse(await numFile.async("string")) as XNode[])
            : null;
        const prepared = ensureNumbering(existingTree, usedLists);
        if (prepared) {
            listIds = prepared.ids;
            if (prepared.changed) numberingTreeToWrite = prepared.tree;
        }
    }
    const listNumIdFor = (ep: EditParagraph): number | null => {
        if (ep.list === "bullet" || ep.list === "number") {
            return listIds[ep.list] ?? null;
        }
        return null;
    };

    const nextText = next.map((p) => p.text);
    // Fast path: nothing changed.
    if (
        nextText.length === current.length &&
        nextText.every((t, i) => t === current[i])
    ) {
        // Text identical, but formatting/alignment may still have changed. Fall
        // through and rebuild; if the rebuild is byte-identical it's harmless.
    }

    // Align current paragraphs to the edited ones. Matching is canonical —
    // quotes, dashes and whitespace runs compare loosely — because a model
    // echoing the document back retypes its typography, and a paragraph that
    // differs only that way is the SAME paragraph and must keep its original
    // bytes (curly quotes included) rather than be rebuilt.
    const pairs = lcsPairs(
        current.map(canonicalParagraphText),
        nextText.map(canonicalParagraphText),
    );
    const matchedOld = new Set(pairs.map((p) => p[0]));
    const matchedNew = new Map(pairs.map((p) => [p[1], p[0]]));

    // Build the replacement node for each ORIGINAL paragraph position, plus any
    // brand-new paragraphs inserted before it.
    // Walk both sequences together.
    // Replacements are bucketed against the original paragraph they belong
    // with, so each one can be rebuilt inside the container it actually lives
    // in — the body, a table cell, a content control.
    const emitted = new Map<number, XNode[]>();
    const trailing: XNode[] = [];
    let oi = 0;
    let nj = 0;
    const newBodyParas = {
        push(node: XNode) {
            if (oi >= paras.length) {
                trailing.push(node);
                return;
            }
            const bucket = emitted.get(oi);
            if (bucket) bucket.push(node);
            else emitted.set(oi, [node]);
        },
    };
    const nearestBaseRPr = (): XNode | null => {
        // Prefer the previous emitted original paragraph's base, else the next.
        for (let k = oi - 1; k >= 0; k--) if (paras[k].baseRPr) return paras[k].baseRPr;
        for (let k = oi; k < paras.length; k++) if (paras[k].baseRPr) return paras[k].baseRPr;
        return null;
    };
    const nearestBasePPr = (): XNode | null => {
        for (let k = oi - 1; k >= 0; k--)
            if (paras[k].basePPr && !paras[k].hasSectPr) return paras[k].basePPr;
        for (let k = oi; k < paras.length; k++)
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
            const headingChanged =
                ep.heading !== undefined && wantHeading !== currentHeading;
            const wantList = ep.list === "bullet" || ep.list === "number";
            const listChanged =
                ep.list !== undefined && wantList !== paras[oi].isListItem;
            const hasFormatting =
                (ep.align !== undefined && ep.align !== "left") ||
                ep.pageBreak !== undefined ||
                headingChanged ||
                listChanged ||
                (ep.runs || []).some(
                    (r) => r.bold || r.italic || r.underline || r.color || r.size,
                );
            // A paragraph whose runs are only split around [fn N] tokens is
            // still a plain unchanged paragraph: keep the original node — it
            // already carries the real reference and its formatting, whether
            // or not the model echoed the tokens. (The multi-run rebuild rule
            // exists for the in-app editor, which never sends footnote runs.)
            const splitByFootnotes = (ep.runs || []).some(
                (r) => r.footnoteRef,
            );
            // When the model names footnotes explicitly, honour a changed
            // set — that is how a new footnote lands on an otherwise
            // unchanged sentence. Without tokens, the original (and its
            // references) is kept as-is.
            const refsChanged =
                splitByFootnotes &&
                (ep.runs || [])
                    .filter((r) => r.footnoteRef)
                    .map((r) => r.footnoteRef)
                    .join(",") !== paras[oi].footnoteIds.join(",");
            if (
                hasFormatting ||
                refsChanged ||
                (!splitByFootnotes && ep.runs && ep.runs.length > 1)
            ) {
                newBodyParas.push(
                    buildFormattedParagraph(
                        ep,
                        paras[oi].baseRPr,
                        paras[oi].basePPr,
                        listNumIdFor(ep),
                    ),
                );
            } else {
                newBodyParas.push(paras[oi].node);
            }
            oi++;
            nj++;
            continue;
        }
        // An unmatched original sitting opposite an unmatched replacement is a
        // paragraph that was rewritten. Its look comes from the paragraph it
        // replaces — the same clause number, indent, alignment and font — which
        // is what adapting a precedent needs.
        if (
            oi < paras.length &&
            nj < next.length &&
            !matchedOld.has(oi) &&
            !matchedNew.has(nj) &&
            !paras[oi].hasSectPr
        ) {
            newBodyParas.push(
                buildFormattedParagraph(
                    next[nj],
                    paras[oi].baseRPr,
                    paras[oi].basePPr,
                    listNumIdFor(next[nj]),
                ),
            );
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
                    listNumIdFor(next[nj]),
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

    // Put every paragraph back where it came from. Tables, content controls,
    // and the section properties that close the body are left untouched.
    const paraIndexByNode = new Map<XNode, number>();
    paras.forEach((para, index) => paraIndexByNode.set(para.node, index));

    // Paragraphs added past the end of the document belong in the body, after
    // its last paragraph — never inside whatever table happened to come last.
    let trailingAnchor = -1;
    for (const [index, para] of paras.entries()) {
        if (para.container === bodyChildren) trailingAnchor = index;
    }

    const containers = new Set(paras.map((para) => para.container));
    for (const container of containers) {
        const rebuilt: XNode[] = [];
        for (const n of container) {
            const index =
                elName(n) === "w:p" ? paraIndexByNode.get(n) : undefined;
            if (index === undefined) {
                rebuilt.push(n);
                continue;
            }
            for (const node of emitted.get(index) ?? []) rebuilt.push(node);
            if (index === trailingAnchor) {
                for (const node of trailing) rebuilt.push(node);
            }
        }
        // The container array is the one held in the tree, so writing to it
        // updates the document itself.
        container.length = 0;
        container.push(...rebuilt);
    }
    if (trailingAnchor === -1 && trailing.length > 0) {
        bodyChildren.push(...trailing);
    }

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
    if (numberingTreeToWrite) {
        setZipEntry(
            zip,
            "word/numbering.xml",
            ensureXmlDeclaration(createBuilder().build(numberingTreeToWrite)),
        );
        await registerNumberingPart(zip);
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

            // A row whose w:trPr carries a matching w:ins was inserted as
            // part of a tracked table. Rejecting removes the whole row;
            // accepting removes the marker and keeps it (the run wrappers
            // inside its cells are handled by the recursion below).
            if (name === "w:tr") {
                const rowKids = elChildren(n);
                const trPr = findChildByName(rowKids, "w:trPr");
                const rowMark = trPr
                    ? findChildByName(elChildren(trPr), "w:ins")
                    : null;
                const rowId = rowMark
                    ? String(elAttrs(rowMark)["@_w:id"] ?? "")
                    : "";
                if (rowMark && ids.has(rowId)) {
                    touched = true;
                    if (mode === "reject") continue;
                    setChildren(
                        trPr!,
                        elChildren(trPr!).filter((c) => c !== rowMark),
                    );
                }
            }

            // Recurse first so nested tables/sdts get processed
            const kids = elChildren(n);
            if (kids.length) {
                const newKids = rewrite(kids);
                if (newKids !== kids) setChildren(n, newKids);
            }

            // A table whose every row was a rejected insertion is an empty
            // shell — drop it rather than leave an invalid element behind.
            if (
                name === "w:tbl" &&
                !elChildren(n).some((c) => elName(c) === "w:tr")
            ) {
                touched = true;
                continue;
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
