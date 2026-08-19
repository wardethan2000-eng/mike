import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
    applyTrackedEdits,
    applyUserParagraphEdits,
    applyFormattedEdits,
    StaleDocumentError,
    extractDocxBodyText,
    extractTrackedChangeIds,
    resolveTrackedChange,
} from "../docxTrackedChanges";

const W_NS =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

/**
 * Build a minimal in-memory .docx: a zip whose word/document.xml wraps the
 * given body XML. No [Content_Types].xml etc. — the module only reads
 * word/document.xml, so this is the smallest fixture that exercises it.
 */
async function makeDocx(bodyXml: string): Promise<Buffer> {
    const zip = new JSZip();
    zip.file(
        "word/document.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
            `<w:document ${W_NS}><w:body>${bodyXml}</w:body></w:document>`,
    );
    return zip.generateAsync({ type: "nodebuffer" });
}

function para(text: string): string {
    return `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

async function readDocumentXml(bytes: Buffer): Promise<string> {
    const zip = await JSZip.loadAsync(bytes);
    return zip.file("word/document.xml")!.async("string");
}

describe("extractDocxBodyText", () => {
    it("joins paragraph texts with newlines", async () => {
        const bytes = await makeDocx(para("First paragraph.") + para("Second."));
        await expect(extractDocxBodyText(bytes)).resolves.toBe(
            "First paragraph.\nSecond.",
        );
    });

    it("uses the accepted view: w:ins text included, w:del text excluded", async () => {
        const bytes = await makeDocx(
            `<w:p>` +
                `<w:r><w:t xml:space="preserve">Keep </w:t></w:r>` +
                `<w:ins w:id="1"><w:r><w:t>added</w:t></w:r></w:ins>` +
                `<w:del w:id="2"><w:r><w:delText>removed</w:delText></w:r></w:del>` +
                `</w:p>`,
        );
        await expect(extractDocxBodyText(bytes)).resolves.toBe("Keep added");
    });

    it("returns an empty string when word/document.xml is missing", async () => {
        const zip = new JSZip();
        zip.file("other.txt", "not a docx");
        const bytes = await zip.generateAsync({ type: "nodebuffer" });
        await expect(extractDocxBodyText(bytes)).resolves.toBe("");
    });
});

describe("applyTrackedEdits", () => {
    it("emits a w:del/w:ins pair for a replacement and reports the change", async () => {
        const bytes = await makeDocx(para("The fee is ten dollars."));
        const result = await applyTrackedEdits(bytes, [
            {
                find: "ten dollars",
                replace: "five dollars",
                context_before: "The fee is ",
                context_after: ".",
            },
        ]);

        expect(result.errors).toEqual([]);
        expect(result.changes).toHaveLength(1);
        const change = result.changes[0];
        expect(change.deletedText).toBe("ten");
        expect(change.insertedText).toBe("five");
        expect(change.delId).toBeDefined();
        expect(change.insId).toBeDefined();

        const xml = await readDocumentXml(result.bytes);
        expect(xml).toContain("<w:del");
        expect(xml).toContain("<w:ins");
        expect(xml).toContain(`w:author="Mike"`);
        expect(xml).toContain("<w:delText");

        // Accepted view of the output shows the replacement applied.
        await expect(extractDocxBodyText(result.bytes)).resolves.toBe(
            "The fee is five dollars.",
        );
    });

    it("trims common prefix/suffix so only the changed span is tracked", async () => {
        const bytes = await makeDocx(para("Payment due in 30 days."));
        const result = await applyTrackedEdits(bytes, [
            {
                find: "Payment due in 30 days",
                replace: "Payment due in 45 days",
                context_before: "",
                context_after: "",
            },
        ]);
        expect(result.errors).toEqual([]);
        expect(result.changes[0].deletedText).toBe("30");
        expect(result.changes[0].insertedText).toBe("45");
    });

    it("honours a custom author", async () => {
        const bytes = await makeDocx(para("Hello world."));
        const result = await applyTrackedEdits(
            bytes,
            [{ find: "world", replace: "there", context_before: "", context_after: "" }],
            { author: "Reviewer" },
        );
        const xml = await readDocumentXml(result.bytes);
        expect(xml).toContain(`w:author="Reviewer"`);
    });

    it("supports a pure insertion anchored on context_before", async () => {
        const bytes = await makeDocx(para("Hello world."));
        const result = await applyTrackedEdits(bytes, [
            {
                find: "",
                replace: "brave ",
                context_before: "Hello ",
                context_after: "",
            },
        ]);
        expect(result.errors).toEqual([]);
        expect(result.changes[0].delId).toBeUndefined();
        expect(result.changes[0].insId).toBeDefined();
        await expect(extractDocxBodyText(result.bytes)).resolves.toBe(
            "Hello brave world.",
        );
    });

    it("supports a pure deletion (empty replace)", async () => {
        const bytes = await makeDocx(para("Hello cruel world."));
        const result = await applyTrackedEdits(bytes, [
            {
                find: "cruel ",
                replace: "",
                context_before: "Hello ",
                context_after: "world",
            },
        ]);
        expect(result.errors).toEqual([]);
        expect(result.changes[0].delId).toBeDefined();
        expect(result.changes[0].insId).toBeUndefined();
        await expect(extractDocxBodyText(result.bytes)).resolves.toBe(
            "Hello world.",
        );
    });

    it("numbers new tracked changes above the existing max w:id", async () => {
        const bytes = await makeDocx(
            `<w:p><w:ins w:id="7"><w:r><w:t>Existing insertion. </w:t></w:r></w:ins>` +
                `<w:r><w:t xml:space="preserve">Plain text.</w:t></w:r></w:p>`,
        );
        const result = await applyTrackedEdits(bytes, [
            {
                find: "Plain",
                replace: "Simple",
                context_before: "",
                context_after: " text.",
            },
        ]);
        expect(result.errors).toEqual([]);
        expect(result.changes[0].delId).toBe("8");
        expect(result.changes[0].insId).toBe("9");
    });

    it("reports an error for a find that is not in the document", async () => {
        const bytes = await makeDocx(para("Hello world."));
        const result = await applyTrackedEdits(bytes, [
            {
                find: "goodbye",
                replace: "farewell",
                context_before: "",
                context_after: "",
            },
        ]);
        expect(result.changes).toEqual([]);
        expect(result.errors).toEqual([
            { index: 0, reason: expect.stringContaining("Could not locate") },
        ]);
        // The document itself is returned intact.
        await expect(extractDocxBodyText(result.bytes)).resolves.toBe(
            "Hello world.",
        );
    });

    it("reports an ambiguous match instead of guessing", async () => {
        const bytes = await makeDocx(para("alpha beta alpha"));
        const result = await applyTrackedEdits(bytes, [
            { find: "alpha", replace: "gamma", context_before: "", context_after: "" },
        ]);
        expect(result.changes).toEqual([]);
        expect(result.errors).toEqual([
            { index: 0, reason: expect.stringContaining("Ambiguous match") },
        ]);
    });

    it("rejects empty edits and uncontexted pure insertions", async () => {
        const bytes = await makeDocx(para("Hello world."));
        const result = await applyTrackedEdits(bytes, [
            { find: "", replace: "", context_before: "", context_after: "" },
            { find: "", replace: "orphan", context_before: "", context_after: "" },
        ]);
        expect(result.changes).toEqual([]);
        expect(result.errors).toEqual([
            { index: 0, reason: "Empty edit." },
            {
                index: 1,
                reason: "Pure insertion requires context_before or context_after.",
            },
        ]);
    });

    it("throws when word/document.xml is missing from the archive", async () => {
        const zip = new JSZip();
        zip.file("other.txt", "not a docx");
        const bytes = await zip.generateAsync({ type: "nodebuffer" });
        await expect(applyTrackedEdits(bytes, [])).rejects.toThrow(
            "document.xml missing from docx",
        );
    });

    it("rejects bytes that are not a zip archive at all", async () => {
        await expect(
            applyTrackedEdits(Buffer.from("plainly not a zip"), []),
        ).rejects.toThrow();
    });
});

describe("resolveTrackedChange", () => {
    /** Apply one replace edit and return the output bytes + w:ids. */
    async function trackedFixture() {
        const bytes = await makeDocx(para("The fee is ten dollars."));
        const applied = await applyTrackedEdits(bytes, [
            {
                find: "ten",
                replace: "twenty",
                context_before: "The fee is ",
                context_after: " dollars",
            },
        ]);
        expect(applied.errors).toEqual([]);
        const { delId, insId } = applied.changes[0];
        return { bytes: applied.bytes, delId: delId!, insId: insId! };
    }

    it("accept collapses the change to the new text", async () => {
        const { bytes, delId, insId } = await trackedFixture();
        const resolved = await resolveTrackedChange(bytes, [delId, insId], "accept");
        expect(resolved.found).toBe(true);
        await expect(extractDocxBodyText(resolved.bytes)).resolves.toBe(
            "The fee is twenty dollars.",
        );
        await expect(extractTrackedChangeIds(resolved.bytes)).resolves.toEqual([]);
    });

    it("reject restores the original text, converting w:delText back to w:t", async () => {
        const { bytes, delId, insId } = await trackedFixture();
        const resolved = await resolveTrackedChange(bytes, [delId, insId], "reject");
        expect(resolved.found).toBe(true);
        await expect(extractDocxBodyText(resolved.bytes)).resolves.toBe(
            "The fee is ten dollars.",
        );
        await expect(extractTrackedChangeIds(resolved.bytes)).resolves.toEqual([]);
        const xml = await readDocumentXml(resolved.bytes);
        expect(xml).not.toContain("w:delText");
    });

    it("returns found=false and leaves the document alone for unknown ids", async () => {
        const { bytes } = await trackedFixture();
        const resolved = await resolveTrackedChange(bytes, ["999"], "accept");
        expect(resolved.found).toBe(false);
        await expect(extractTrackedChangeIds(resolved.bytes)).resolves.toHaveLength(2);
    });
});

describe("extractTrackedChangeIds", () => {
    it("lists w:ins/w:del wrappers in document order", async () => {
        const bytes = await makeDocx(
            `<w:p>` +
                `<w:ins w:id="3"><w:r><w:t>a</w:t></w:r></w:ins>` +
                `<w:del w:id="5"><w:r><w:delText>b</w:delText></w:r></w:del>` +
                `<w:ins w:id="9"><w:r><w:t>c</w:t></w:r></w:ins>` +
                `</w:p>`,
        );
        await expect(extractTrackedChangeIds(bytes)).resolves.toEqual([
            { kind: "ins", w_id: "3" },
            { kind: "del", w_id: "5" },
            { kind: "ins", w_id: "9" },
        ]);
    });

    it("returns [] when word/document.xml is missing", async () => {
        const zip = new JSZip();
        zip.file("other.txt", "not a docx");
        const bytes = await zip.generateAsync({ type: "nodebuffer" });
        await expect(extractTrackedChangeIds(bytes)).resolves.toEqual([]);
    });
});

describe("applyTrackedEdits — whole paragraphs", () => {
    /** Every w:id belonging to one logical change, marks included. */
    function allIds(change: {
        delId?: string;
        insId?: string;
        extraInsIds?: string[];
        extraDelIds?: string[];
    }): string[] {
        return [
            change.delId,
            change.insId,
            ...(change.extraInsIds ?? []),
            ...(change.extraDelIds ?? []),
        ].filter((v): v is string => !!v);
    }

    it("turns a blank line in `replace` into a real new paragraph", async () => {
        const bytes = await makeDocx(
            para("Dear Ms. Smith:") + para("[BODY]") + para("Sincerely,"),
        );
        const result = await applyTrackedEdits(bytes, [
            {
                find: "[BODY]",
                replace: "First paragraph.\n\nSecond paragraph.",
                context_before: "Dear Ms. Smith:",
                context_after: "Sincerely,",
            },
        ]);

        expect(result.errors).toEqual([]);
        expect(result.changes).toHaveLength(1);
        // One new paragraph mark for the one new paragraph boundary.
        expect(result.changes[0].extraInsIds).toHaveLength(1);

        const xml = await readDocumentXml(result.bytes);
        // The new paragraph mark is tracked inside the paragraph properties.
        expect(xml).toMatch(/<w:pPr><w:rPr><w:ins[^>]*>(<\/w:ins>)?<\/w:rPr><\/w:pPr>/);
        expect((xml.match(/<w:p[ >]/g) ?? []).length).toBe(4);

        await expect(extractDocxBodyText(result.bytes)).resolves.toBe(
            "Dear Ms. Smith:\nFirst paragraph.\nSecond paragraph.\nSincerely,",
        );
    });

    it("accepting keeps the new paragraphs and drops the tracked marks", async () => {
        const bytes = await makeDocx(para("[BODY]") + para("Sincerely,"));
        const edited = await applyTrackedEdits(bytes, [
            {
                find: "[BODY]",
                replace: "One.\n\nTwo.\n\nThree.",
                context_before: "",
                context_after: "Sincerely,",
            },
        ]);
        expect(edited.changes[0].extraInsIds).toHaveLength(2);

        const { bytes: accepted, found } = await resolveTrackedChange(
            edited.bytes,
            allIds(edited.changes[0]),
            "accept",
        );
        expect(found).toBe(true);

        const xml = await readDocumentXml(accepted);
        expect(xml).not.toContain("<w:ins");
        expect(xml).not.toContain("<w:del");
        await expect(extractDocxBodyText(accepted)).resolves.toBe(
            "One.\nTwo.\nThree.\nSincerely,",
        );
    });

    it("rejecting merges the new paragraphs back into the original one", async () => {
        const bytes = await makeDocx(para("[BODY]") + para("Sincerely,"));
        const edited = await applyTrackedEdits(bytes, [
            {
                find: "[BODY]",
                replace: "One.\n\nTwo.\n\nThree.",
                context_before: "",
                context_after: "Sincerely,",
            },
        ]);

        const { bytes: rejected } = await resolveTrackedChange(
            edited.bytes,
            allIds(edited.changes[0]),
            "reject",
        );

        await expect(extractDocxBodyText(rejected)).resolves.toBe(
            "[BODY]\nSincerely,",
        );
        const xml = await readDocumentXml(rejected);
        expect((xml.match(/<w:p[ >]/g) ?? []).length).toBe(2);
    });

    it("deletes a whole paragraph, blank line included, when accepted", async () => {
        const bytes = await makeDocx(
            para("Keep this.") + para("Drop this.") + para("Keep this too."),
        );
        const edited = await applyTrackedEdits(bytes, [
            {
                find: "Drop this.",
                replace: "",
                context_before: "Keep this.",
                context_after: "Keep this too.",
            },
        ]);
        expect(edited.changes[0].extraDelIds).toHaveLength(1);

        const xml = await readDocumentXml(edited.bytes);
        expect(xml).toMatch(/<w:pPr><w:rPr><w:del[^>]*>(<\/w:del>)?<\/w:rPr><\/w:pPr>/);

        const { bytes: accepted } = await resolveTrackedChange(
            edited.bytes,
            allIds(edited.changes[0]),
            "accept",
        );
        await expect(extractDocxBodyText(accepted)).resolves.toBe(
            "Keep this.\nKeep this too.",
        );

        const { bytes: restored } = await resolveTrackedChange(
            edited.bytes,
            allIds(edited.changes[0]),
            "reject",
        );
        await expect(extractDocxBodyText(restored)).resolves.toBe(
            "Keep this.\nDrop this.\nKeep this too.",
        );
    });

    it("never removes the final paragraph mark of the document", async () => {
        const bytes = await makeDocx(para("First.") + para("Last."));
        const edited = await applyTrackedEdits(bytes, [
            {
                find: "Last.",
                replace: "",
                context_before: "First.",
                context_after: "",
            },
        ]);
        expect(edited.changes[0].extraDelIds).toBeUndefined();
    });

    it("inserts new paragraphs from an empty `find`", async () => {
        const bytes = await makeDocx(para("Dear Ms. Smith:") + para("Sincerely,"));
        const edited = await applyTrackedEdits(bytes, [
            {
                find: "",
                replace: "\n\nNew opening paragraph.",
                context_before: "Dear Ms. Smith:",
                context_after: "",
            },
        ]);
        expect(edited.errors).toEqual([]);

        const { bytes: accepted } = await resolveTrackedChange(
            edited.bytes,
            allIds(edited.changes[0]),
            "accept",
        );
        await expect(extractDocxBodyText(accepted)).resolves.toBe(
            "Dear Ms. Smith:\nNew opening paragraph.\nSincerely,",
        );
    });

    it("keeps the paragraph's own formatting on the paragraphs it grows", async () => {
        const bytes = await makeDocx(
            `<w:p><w:pPr><w:pStyle w:val="Body"/></w:pPr>` +
                `<w:r><w:rPr><w:b/></w:rPr><w:t>[BODY]</w:t></w:r></w:p>` +
                para("End."),
        );
        const edited = await applyTrackedEdits(bytes, [
            {
                find: "[BODY]",
                replace: "One.\n\nTwo.",
                context_before: "",
                context_after: "End.",
            },
        ]);
        const xml = await readDocumentXml(edited.bytes);
        // Both resulting paragraphs carry the source paragraph's style.
        expect((xml.match(/w:val="Body"/g) ?? []).length).toBe(2);
        // Inserted runs inherit the bold run properties.
        expect(xml).toMatch(/<w:ins[^>]*><w:r><w:rPr><w:b\/?>/);
    });

    it("leaves paragraph marks out of the rendered change-id list", async () => {
        const bytes = await makeDocx(para("[BODY]") + para("End."));
        const edited = await applyTrackedEdits(bytes, [
            {
                find: "[BODY]",
                replace: "One.\n\nTwo.",
                context_before: "",
                context_after: "End.",
            },
        ]);
        const ids = await extractTrackedChangeIds(edited.bytes);
        const markIds = new Set(edited.changes[0].extraInsIds ?? []);
        expect(ids.some((i) => markIds.has(i.w_id))).toBe(false);
    });
});

describe("applyUserParagraphEdits — inline viewer editing", () => {
    async function bodyLines(bytes: Buffer): Promise<string[]> {
        return (await extractDocxBodyText(bytes)).split("\n");
    }

    it("edits a paragraph's wording in place and returns a clean doc", async () => {
        const bytes = await makeDocx(
            para("Dear Ms. Smith:") + para("The fee is ten dollars.") + para("Sincerely,"),
        );
        const baseline = ["Dear Ms. Smith:", "The fee is ten dollars.", "Sincerely,"];
        const next = ["Dear Ms. Smith:", "The fee is five dollars.", "Sincerely,"];
        const { bytes: out, changed } = await applyUserParagraphEdits(bytes, baseline, next);
        expect(changed).toBe(true);
        const xml = await readDocumentXml(out);
        expect(xml).not.toContain("<w:ins");
        expect(xml).not.toContain("<w:del");
        expect(await bodyLines(out)).toEqual(next);
    });

    it("adds a new paragraph in the middle", async () => {
        const bytes = await makeDocx(para("One.") + para("Three.") + para("End."));
        const baseline = ["One.", "Three.", "End."];
        const next = ["One.", "Two.", "Three.", "End."];
        const { bytes: out } = await applyUserParagraphEdits(bytes, baseline, next);
        expect(await bodyLines(out)).toEqual(next);
    });

    it("adds several paragraphs at the end of the body", async () => {
        const bytes = await makeDocx(para("Intro.") + para("Closing."));
        const baseline = ["Intro.", "Closing."];
        const next = ["Intro.", "Closing.", "PS one.", "PS two."];
        const { bytes: out } = await applyUserParagraphEdits(bytes, baseline, next);
        expect(await bodyLines(out)).toEqual(next);
    });

    it("deletes a paragraph", async () => {
        const bytes = await makeDocx(para("Keep.") + para("Drop.") + para("Keep too."));
        const baseline = ["Keep.", "Drop.", "Keep too."];
        const next = ["Keep.", "Keep too."];
        const { bytes: out } = await applyUserParagraphEdits(bytes, baseline, next);
        expect(await bodyLines(out)).toEqual(next);
    });

    it("splits one paragraph into two", async () => {
        const bytes = await makeDocx(para("First half. Second half.") + para("End."));
        const baseline = ["First half. Second half.", "End."];
        const next = ["First half.", "Second half.", "End."];
        const { bytes: out } = await applyUserParagraphEdits(bytes, baseline, next);
        expect(await bodyLines(out)).toEqual(next);
    });

    it("merges two paragraphs into one", async () => {
        const bytes = await makeDocx(para("Alpha.") + para("Beta.") + para("End."));
        const baseline = ["Alpha.", "Beta.", "End."];
        const next = ["Alpha. Beta.", "End."];
        const { bytes: out } = await applyUserParagraphEdits(bytes, baseline, next);
        expect(await bodyLines(out)).toEqual(next);
    });

    it("does a combined edit: modify, delete and add together", async () => {
        const bytes = await makeDocx(
            para("Salutation") + para("Body A") + para("Body B") + para("Body C") + para("Sign"),
        );
        const baseline = ["Salutation", "Body A", "Body B", "Body C", "Sign"];
        // Change A, drop B, keep C, add two paragraphs after C.
        const next = ["Salutation", "Body A edited", "Body C", "New D", "New E", "Sign"];
        const { bytes: out } = await applyUserParagraphEdits(bytes, baseline, next);
        expect(await bodyLines(out)).toEqual(next);
    });

    it("preserves an inline image while its paragraph's text is edited", async () => {
        // A run holding a drawing sits beside the text run in the same paragraph.
        const drawing = `<w:r><w:drawing><wp:inline><a:blip/></wp:inline></w:drawing></w:r>`;
        const bytes = await makeDocx(
            `<w:p><w:r><w:t xml:space="preserve">Sincerely,</w:t></w:r>${drawing}</w:p>` +
                para("Ethan J. Ward, Esq."),
        );
        const baseline = ["Sincerely,", "Ethan J. Ward, Esq."];
        const next = ["Sincerely,", "Ethan J. Ward"];
        const { bytes: out } = await applyUserParagraphEdits(bytes, baseline, next);
        const xml = await readDocumentXml(out);
        expect(xml).toContain("<w:drawing>");
        expect(await bodyLines(out)).toEqual(next);
    });

    it("refuses to save when the baseline no longer matches the document", async () => {
        const bytes = await makeDocx(para("One.") + para("Two."));
        await expect(
            applyUserParagraphEdits(bytes, ["One.", "DIFFERENT."], ["One.", "Changed."]),
        ).rejects.toThrow(StaleDocumentError);
    });

    it("is a no-op when nothing changed", async () => {
        const bytes = await makeDocx(para("One.") + para("Two."));
        const { changed, opsApplied } = await applyUserParagraphEdits(
            bytes,
            ["One.", "Two."],
            ["One.", "Two."],
        );
        expect(changed).toBe(false);
        expect(opsApplied).toBe(0);
    });

    it("never deletes the final paragraph, clearing its text instead", async () => {
        const bytes = await makeDocx(para("First.") + para("Last."));
        const { bytes: out } = await applyUserParagraphEdits(
            bytes,
            ["First.", "Last."],
            ["First."],
        );
        // Final paragraph survives (empty) rather than removing the section mark.
        const lines = await bodyLines(out);
        expect(lines[0]).toBe("First.");
    });
});

describe("applyFormattedEdits — in-app formatting editor", () => {
    async function lines(bytes: Buffer): Promise<string[]> {
        return (await extractDocxBodyText(bytes)).split("\n");
    }

    it("applies bold to a paragraph and keeps the text", async () => {
        const bytes = await makeDocx(
            para("Dear Ms. Smith:") + para("The fee is ten dollars.") + para("End."),
        );
        const baseline = ["Dear Ms. Smith:", "The fee is ten dollars.", "End."];
        const next = [
            { text: "Dear Ms. Smith:", runs: [{ text: "Dear Ms. Smith:" }] },
            {
                text: "The fee is ten dollars.",
                runs: [
                    { text: "The fee is " },
                    { text: "ten", bold: true },
                    { text: " dollars." },
                ],
            },
            { text: "End.", runs: [{ text: "End." }] },
        ];
        const { bytes: out, changed } = await applyFormattedEdits(bytes, baseline, next);
        expect(changed).toBe(true);
        expect(await lines(out)).toEqual(baseline);
        const xml = await readDocumentXml(out);
        // A bold run wrapping exactly "ten".
        expect(xml).toMatch(/<w:rPr>(<[^>]*>)*<w:b\/?>(<\/w:b>)?/);
        expect(xml).toContain(">ten<");
    });

    it("inherits the paragraph font when rebuilding a run", async () => {
        const bytes = await makeDocx(
            `<w:p><w:r><w:rPr><w:rFonts w:ascii="Garamond" w:hAnsi="Garamond"/><w:sz w:val="24"/></w:rPr>` +
                `<w:t xml:space="preserve">Hello world.</w:t></w:r></w:p>` +
                para("End."),
        );
        const next = [
            {
                text: "Hello world.",
                runs: [
                    { text: "Hello " },
                    { text: "world", italic: true },
                    { text: "." },
                ],
            },
            { text: "End.", runs: [{ text: "End." }] },
        ];
        const { bytes: out } = await applyFormattedEdits(
            bytes,
            ["Hello world.", "End."],
            next,
        );
        const xml = await readDocumentXml(out);
        // Every rebuilt run keeps Garamond + the base size.
        expect((xml.match(/w:ascii="Garamond"/g) ?? []).length).toBeGreaterThanOrEqual(3);
        expect(xml).toMatch(/<w:i\/?>/);
    });

    it("sets paragraph alignment", async () => {
        const bytes = await makeDocx(para("Centered me.") + para("End."));
        const next = [
            { text: "Centered me.", align: "center" as const, runs: [{ text: "Centered me." }] },
            { text: "End.", runs: [{ text: "End." }] },
        ];
        const { bytes: out } = await applyFormattedEdits(
            bytes,
            ["Centered me.", "End."],
            next,
        );
        const xml = await readDocumentXml(out);
        expect(xml).toMatch(/<w:jc w:val="center"\/?>/);
    });

    it("adds a new formatted paragraph and inherits the neighbour's font", async () => {
        const bytes = await makeDocx(
            `<w:p><w:r><w:rPr><w:rFonts w:ascii="Garamond" w:hAnsi="Garamond"/></w:rPr>` +
                `<w:t xml:space="preserve">First.</w:t></w:r></w:p>` +
                para("End."),
        );
        const next = [
            { text: "First.", runs: [{ text: "First." }] },
            { text: "Brand new.", runs: [{ text: "Brand new.", bold: true }] },
            { text: "End.", runs: [{ text: "End." }] },
        ];
        const { bytes: out } = await applyFormattedEdits(bytes, ["First.", "End."], next);
        expect(await lines(out)).toEqual(["First.", "Brand new.", "End."]);
        const xml = await readDocumentXml(out);
        // The new "Brand new." paragraph carries Garamond AND bold.
        const newPara = xml.slice(xml.indexOf("Brand new") - 400, xml.indexOf("Brand new"));
        expect(newPara).toContain('w:ascii="Garamond"');
        expect(newPara).toMatch(/<w:b\/?>/);
    });

    it("deletes a paragraph", async () => {
        const bytes = await makeDocx(para("Keep.") + para("Drop.") + para("End."));
        const next = [
            { text: "Keep.", runs: [{ text: "Keep." }] },
            { text: "End.", runs: [{ text: "End." }] },
        ];
        const { bytes: out } = await applyFormattedEdits(
            bytes,
            ["Keep.", "Drop.", "End."],
            next,
        );
        expect(await lines(out)).toEqual(["Keep.", "End."]);
    });

    it("leaves untouched paragraphs byte-identical", async () => {
        const bytes = await makeDocx(
            para("Alpha.") + para("Beta.") + para("Gamma."),
        );
        const before = await readDocumentXml(bytes);
        const next = [
            { text: "Alpha.", runs: [{ text: "Alpha." }] },
            { text: "Beta.", runs: [{ text: "Beta.", bold: true }] },
            { text: "Gamma.", runs: [{ text: "Gamma." }] },
        ];
        const { bytes: out } = await applyFormattedEdits(
            bytes,
            ["Alpha.", "Beta.", "Gamma."],
            next,
        );
        const after = await readDocumentXml(out);
        // Alpha and Gamma paragraphs are unchanged verbatim.
        expect(after).toContain("<w:t xml:space=\"preserve\">Alpha.</w:t>");
        expect(after).toContain("<w:t xml:space=\"preserve\">Gamma.</w:t>");
        expect(before).not.toEqual(after); // Beta changed
    });

    it("refuses a stale baseline", async () => {
        const bytes = await makeDocx(para("One.") + para("Two."));
        await expect(
            applyFormattedEdits(bytes, ["One.", "WRONG."], [
                { text: "One.", runs: [{ text: "One." }] },
            ]),
        ).rejects.toThrow(StaleDocumentError);
    });

    it("applies colour and size", async () => {
        const bytes = await makeDocx(para("Big red.") + para("End."));
        const next = [
            {
                text: "Big red.",
                runs: [{ text: "Big red.", color: "FF0000", size: 18 }],
            },
            { text: "End.", runs: [{ text: "End." }] },
        ];
        const { bytes: out } = await applyFormattedEdits(bytes, ["Big red.", "End."], next);
        const xml = await readDocumentXml(out);
        expect(xml).toMatch(/<w:color w:val="FF0000"\/?>/);
        expect(xml).toMatch(/<w:sz w:val="36"\/?>/); // 18pt -> 36 half-points
    });
});

describe("applyFormattedEdits — headings (v2)", () => {
    async function lines(bytes: Buffer): Promise<string[]> {
        return (await extractDocxBodyText(bytes)).split("\n");
    }

    it("turns a paragraph into a Heading 1 and defines the style", async () => {
        const bytes = await makeDocx(para("Section title") + para("Body text."));
        const next = [
            { text: "Section title", heading: 1, runs: [{ text: "Section title" }] },
            { text: "Body text.", runs: [{ text: "Body text." }] },
        ];
        const { bytes: out } = await applyFormattedEdits(
            bytes,
            ["Section title", "Body text."],
            next,
        );
        expect(await lines(out)).toEqual(["Section title", "Body text."]);
        const xml = await readDocumentXml(out);
        expect(xml).toMatch(/<w:pStyle w:val="Heading1"\/?>/);
    });

    it("keeps heading levels 1-3 distinct", async () => {
        const bytes = await makeDocx(para("A") + para("B") + para("C") + para("End."));
        const next = [
            { text: "A", heading: 1, runs: [{ text: "A" }] },
            { text: "B", heading: 2, runs: [{ text: "B" }] },
            { text: "C", heading: 3, runs: [{ text: "C" }] },
            { text: "End.", runs: [{ text: "End." }] },
        ];
        const { bytes: out } = await applyFormattedEdits(
            bytes,
            ["A", "B", "C", "End."],
            next,
        );
        const xml = await readDocumentXml(out);
        expect(xml).toMatch(/Heading1/);
        expect(xml).toMatch(/Heading2/);
        expect(xml).toMatch(/Heading3/);
    });

    it("clears a heading back to body text", async () => {
        const bytes = await makeDocx(
            `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>` +
                `<w:r><w:t xml:space="preserve">Was a heading</w:t></w:r></w:p>` +
                para("End."),
        );
        const next = [
            { text: "Was a heading", heading: 0, runs: [{ text: "Was a heading" }] },
            { text: "End.", runs: [{ text: "End." }] },
        ];
        const { bytes: out } = await applyFormattedEdits(
            bytes,
            ["Was a heading", "End."],
            next,
        );
        const xml = await readDocumentXml(out);
        expect(xml).not.toMatch(/w:val="Heading1"/);
        expect(await lines(out)).toEqual(["Was a heading", "End."]);
    });

    it("keeps a heading alongside alignment", async () => {
        const bytes = await makeDocx(para("Centered heading") + para("End."));
        const next = [
            {
                text: "Centered heading",
                heading: 2,
                align: "center" as const,
                runs: [{ text: "Centered heading" }],
            },
            { text: "End.", runs: [{ text: "End." }] },
        ];
        const { bytes: out } = await applyFormattedEdits(
            bytes,
            ["Centered heading", "End."],
            next,
        );
        const xml = await readDocumentXml(out);
        expect(xml).toMatch(/Heading2/);
        expect(xml).toMatch(/<w:jc w:val="center"\/?>/);
        // pStyle must come before jc inside pPr.
        const pPr = xml.slice(xml.indexOf("<w:pPr>"), xml.indexOf("</w:pPr>"));
        expect(pPr.indexOf("pStyle")).toBeLessThan(pPr.indexOf("w:jc"));
    });

    it("does not overwrite a heading style the document already defines", async () => {
        const zip = new JSZip();
        zip.file(
            "word/document.xml",
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
                `<w:document ${W_NS}><w:body>${para("Title") + para("End.")}</w:body></w:document>`,
        );
        zip.file(
            "word/styles.xml",
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
                `<w:styles ${W_NS}><w:style w:type="paragraph" w:styleId="Heading1">` +
                `<w:name w:val="heading 1"/><w:rPr><w:sz w:val="99"/></w:rPr></w:style></w:styles>`,
        );
        const bytes = await zip.generateAsync({ type: "nodebuffer" });
        const { bytes: out } = await applyFormattedEdits(bytes, ["Title", "End."], [
            { text: "Title", heading: 1, runs: [{ text: "Title" }] },
            { text: "End.", runs: [{ text: "End." }] },
        ]);
        const styles = await (await JSZip.loadAsync(out))
            .file("word/styles.xml")!
            .async("string");
        // The firm's own definition survives untouched.
        expect(styles).toContain('w:val="99"');
        expect((styles.match(/w:styleId="Heading1"/g) ?? []).length).toBe(1);
    });

    it("round-trips colour and size chosen in the editor", async () => {
        const bytes = await makeDocx(para("Styled text.") + para("End."));
        const next = [
            {
                text: "Styled text.",
                runs: [
                    { text: "Styled ", color: "C00000", size: 14 },
                    { text: "text.", bold: true },
                ],
            },
            { text: "End.", runs: [{ text: "End." }] },
        ];
        const { bytes: out } = await applyFormattedEdits(
            bytes,
            ["Styled text.", "End."],
            next,
        );
        const xml = await readDocumentXml(out);
        expect(xml).toMatch(/<w:color w:val="C00000"\/?>/);
        expect(xml).toMatch(/<w:sz w:val="28"\/?>/); // 14pt -> 28 half-points
        expect(await lines(out)).toEqual(["Styled text.", "End."]);
    });
});

describe("applyFormattedEdits — bullet and numbered lists (v3)", () => {
    async function lines(bytes: Buffer): Promise<string[]> {
        return (await extractDocxBodyText(bytes)).split("\n");
    }
    async function part(bytes: Buffer, path: string): Promise<string | null> {
        const zip = await JSZip.loadAsync(bytes);
        const f = zip.file(path);
        return f ? await f.async("string") : null;
    }

    it("makes paragraphs into a bullet list and defines the numbering", async () => {
        const bytes = await makeDocx(para("One") + para("Two") + para("End."));
        const next = [
            { text: "One", list: "bullet" as const, runs: [{ text: "One" }] },
            { text: "Two", list: "bullet" as const, runs: [{ text: "Two" }] },
            { text: "End.", runs: [{ text: "End." }] },
        ];
        const { bytes: out } = await applyFormattedEdits(
            bytes,
            ["One", "Two", "End."],
            next,
        );
        expect(await lines(out)).toEqual(["One", "Two", "End."]);
        const xml = await readDocumentXml(out);
        expect((xml.match(/<w:numPr>/g) ?? []).length).toBe(2);
        const numbering = await part(out, "word/numbering.xml");
        expect(numbering).toBeTruthy();
        expect(numbering!).toContain('w:val="bullet"');
    });

    it("numbers a numbered list with decimal format", async () => {
        const bytes = await makeDocx(para("First") + para("Second") + para("End."));
        const next = [
            { text: "First", list: "number" as const, runs: [{ text: "First" }] },
            { text: "Second", list: "number" as const, runs: [{ text: "Second" }] },
            { text: "End.", runs: [{ text: "End." }] },
        ];
        const { bytes: out } = await applyFormattedEdits(
            bytes,
            ["First", "Second", "End."],
            next,
        );
        const numbering = await part(out, "word/numbering.xml");
        expect(numbering!).toContain('w:val="decimal"');
        const xml = await readDocumentXml(out);
        // Both list paragraphs share one numId, so they count 1, 2.
        const ids = [...xml.matchAll(/<w:numId w:val="(\d+)"/g)].map((m) => m[1]);
        expect(ids).toHaveLength(2);
        expect(new Set(ids).size).toBe(1);
    });

    it("bullets and numbers use different definitions", async () => {
        const bytes = await makeDocx(para("B") + para("N") + para("End."));
        const next = [
            { text: "B", list: "bullet" as const, runs: [{ text: "B" }] },
            { text: "N", list: "number" as const, runs: [{ text: "N" }] },
            { text: "End.", runs: [{ text: "End." }] },
        ];
        const { bytes: out } = await applyFormattedEdits(bytes, ["B", "N", "End."], next);
        const xml = await readDocumentXml(out);
        const ids = [...xml.matchAll(/<w:numId w:val="(\d+)"/g)].map((m) => m[1]);
        expect(new Set(ids).size).toBe(2);
        const numbering = await part(out, "word/numbering.xml");
        expect(numbering!).toContain('w:val="bullet"');
        expect(numbering!).toContain('w:val="decimal"');
    });

    it("registers numbering.xml in the package", async () => {
        const zip = new JSZip();
        zip.file(
            "[Content_Types].xml",
            `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="x"/></Types>`,
        );
        zip.file(
            "word/_rels/document.xml.rels",
            `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="t" Target="styles.xml"/></Relationships>`,
        );
        zip.file(
            "word/document.xml",
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
                `<w:document ${W_NS}><w:body>${para("Item") + para("End.")}</w:body></w:document>`,
        );
        const bytes = await zip.generateAsync({ type: "nodebuffer" });
        const { bytes: out } = await applyFormattedEdits(bytes, ["Item", "End."], [
            { text: "Item", list: "bullet" as const, runs: [{ text: "Item" }] },
            { text: "End.", runs: [{ text: "End." }] },
        ]);
        const ct = await part(out, "[Content_Types].xml");
        const rels = await part(out, "word/_rels/document.xml.rels");
        expect(ct!).toContain("/word/numbering.xml");
        expect(rels!).toContain('Target="numbering.xml"');
    });

    it("turns a list item back into an ordinary paragraph", async () => {
        const bytes = await makeDocx(
            `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="3"/></w:numPr></w:pPr>` +
                `<w:r><w:t xml:space="preserve">Was a bullet</w:t></w:r></w:p>` +
                para("End."),
        );
        const { bytes: out } = await applyFormattedEdits(
            bytes,
            ["Was a bullet", "End."],
            [
                { text: "Was a bullet", list: null, runs: [{ text: "Was a bullet" }] },
                { text: "End.", runs: [{ text: "End." }] },
            ],
        );
        const xml = await readDocumentXml(out);
        expect(xml).not.toContain("<w:numPr>");
        expect(await lines(out)).toEqual(["Was a bullet", "End."]);
    });

    it("does not disturb a document's existing numbering definitions", async () => {
        const zip = new JSZip();
        zip.file(
            "word/document.xml",
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
                `<w:document ${W_NS}><w:body>${para("Item") + para("End.")}</w:body></w:document>`,
        );
        zip.file(
            "word/numbering.xml",
            `<?xml version="1.0"?><w:numbering ${W_NS}>` +
                `<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="lowerRoman"/></w:lvl></w:abstractNum>` +
                `<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
        );
        const bytes = await zip.generateAsync({ type: "nodebuffer" });
        const { bytes: out } = await applyFormattedEdits(bytes, ["Item", "End."], [
            { text: "Item", list: "number" as const, runs: [{ text: "Item" }] },
            { text: "End.", runs: [{ text: "End." }] },
        ]);
        const numbering = await part(out, "word/numbering.xml");
        // The firm's own lowerRoman definition survives, ours is added beside it.
        expect(numbering!).toContain('w:val="lowerRoman"');
        expect(numbering!).toContain('w:val="decimal"');
        expect(numbering!).toContain('w:abstractNumId="1"');
    });

    it("keeps a list item's bold and alignment", async () => {
        const bytes = await makeDocx(para("Point") + para("End."));
        const { bytes: out } = await applyFormattedEdits(bytes, ["Point", "End."], [
            {
                text: "Point",
                list: "bullet" as const,
                align: "center" as const,
                runs: [{ text: "Point", bold: true }],
            },
            { text: "End.", runs: [{ text: "End." }] },
        ]);
        const xml = await readDocumentXml(out);
        expect(xml).toContain("<w:numPr>");
        expect(xml).toMatch(/<w:jc w:val="center"\/?>/);
        expect(xml).toMatch(/<w:b\/?>/);
        // Schema order: numPr must precede jc inside pPr.
        const pPr = xml.slice(xml.indexOf("<w:pPr>"), xml.indexOf("</w:pPr>"));
        expect(pPr.indexOf("numPr")).toBeLessThan(pPr.indexOf("w:jc"));
    });
});
