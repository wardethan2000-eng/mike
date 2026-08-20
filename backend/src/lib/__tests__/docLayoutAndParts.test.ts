import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import {
    applyHeaderFooterEdits,
    applyTrackedEdits,
    extractDocxBodyParagraphsMarked,
    extractDocxBodyText,
    extractDocxHeadersFooters,
    insertTrackedTables,
    parseLayoutTokens,
    resolveTrackedChange,
} from "../docxTrackedChanges";

const W_NS =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function para(body: string, pPr = ""): string {
    return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${body}</w:p>`;
}

function run(text: string, rPr = ""): string {
    const props = rPr ? `<w:rPr>${rPr}</w:rPr>` : "";
    return `<w:r>${props}<w:t xml:space="preserve">${text}</w:t></w:r>`;
}

async function makeDocx(
    paragraphs: string[],
    parts: Record<string, string> = {},
): Promise<Buffer> {
    const zip = new JSZip();
    zip.file(
        "word/document.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
            `<w:document ${W_NS}><w:body>${paragraphs.join("")}</w:body></w:document>`,
    );
    for (const [path, xml] of Object.entries(parts)) zip.file(path, xml);
    return zip.generateAsync({ type: "nodebuffer" });
}

describe("layout tokens", () => {
    it("shows page breaks, headings and centering when reading", async () => {
        const bytes = await makeDocx([
            para(run("TITLE"), `<w:jc w:val="center"/>`),
            para(run("Ordinary text.")),
            para(run("EXHIBIT A"), `<w:pageBreakBefore/><w:jc w:val="center"/>`),
            para(run("Heading text"), `<w:pStyle w:val="Heading2"/>`),
            // A manual page-break run also reads as [page break].
            `<w:p><w:r><w:br w:type="page"/></w:r>${run("After the break")}</w:p>`,
        ]);
        const lines = await extractDocxBodyParagraphsMarked(bytes);
        expect(lines).toEqual([
            "[centered] TITLE",
            "Ordinary text.",
            "[page break] [centered] EXHIBIT A",
            "[heading 2] Heading text",
            "[page break] After the break",
        ]);
    });

    it("parses tokens back off a written paragraph", () => {
        expect(parseLayoutTokens("[page break] [centered] EXHIBIT A")).toEqual({
            text: "EXHIBIT A",
            align: "center",
            pageBreak: true,
        });
        expect(parseLayoutTokens("[heading 2] Warranty")).toEqual({
            text: "Warranty",
            heading: 2,
        });
        expect(parseLayoutTokens("No tokens here [centered] mid-line")).toEqual({
            text: "No tokens here [centered] mid-line",
        });
    });
});

describe("formatted tracked insertions", () => {
    it("turns markers in the replacement into formatting", async () => {
        const bytes = await makeDocx([
            para(run("The notice period is ten days.")),
        ]);
        const applied = await applyTrackedEdits(bytes, [
            {
                find: "The notice period is ten days.",
                replace: "**Notice.** The notice period is _thirty_ days.",
                context_before: "",
                context_after: "",
            },
        ]);
        expect(applied.errors).toEqual([]);
        expect(applied.changes).toHaveLength(1);
        // The card shows plain characters, never the markers.
        expect(applied.changes[0].insertedText).toBe(
            "Notice. The notice period is thirty days.",
        );
        const xml = await (await JSZip.loadAsync(applied.bytes))
            .file("word/document.xml")!
            .async("string");
        expect(xml).not.toContain("**");
        expect(xml).toMatch(/<w:b\b/);
        expect(xml).toMatch(/<w:u\b/);
        // Accepting keeps the formatted runs.
        const ids = [
            applied.changes[0].delId,
            applied.changes[0].insId,
        ].filter((v): v is string => !!v);
        const { bytes: accepted } = await resolveTrackedChange(
            applied.bytes,
            ids,
            "accept",
        );
        await expect(extractDocxBodyText(accepted)).resolves.toBe(
            "Notice. The notice period is thirty days.",
        );
        const acceptedXml = await (await JSZip.loadAsync(accepted))
            .file("word/document.xml")!
            .async("string");
        expect(acceptedXml).toMatch(/<w:b\b/);
    });
});

const HEADER_XML =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:hdr ${W_NS}>` +
    `<w:p><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Cooks Guttering LLC</w:t></w:r>` +
    `<w:r><w:t xml:space="preserve"> — 123 Main St, Wichita, KS</w:t></w:r></w:p>` +
    `</w:hdr>`;

describe("page headers and footers", () => {
    it("reads header text", async () => {
        const bytes = await makeDocx([para(run("Body."))], {
            "word/header1.xml": HEADER_XML,
        });
        const hf = await extractDocxHeadersFooters(bytes);
        expect(hf.headers).toEqual([
            "Cooks Guttering LLC — 123 Main St, Wichita, KS",
        ]);
        expect(hf.footers).toEqual([]);
    });

    it("replaces header text across runs, keeping the rest", async () => {
        const bytes = await makeDocx([para(run("Body."))], {
            "word/header1.xml": HEADER_XML,
        });
        const { bytes: out, applied } = await applyHeaderFooterEdits(bytes, [
            {
                index: 0,
                find: "Cooks Guttering LLC",
                replace: "Central Spray Foam, LLC",
            },
        ]);
        expect(applied).toEqual([{ index: 0, part: "header" }]);
        const hf = await extractDocxHeadersFooters(out);
        expect(hf.headers).toEqual([
            "Central Spray Foam, LLC — 123 Main St, Wichita, KS",
        ]);
        // The address run and its formatting survive untouched.
        const xml = await (await JSZip.loadAsync(out))
            .file("word/header1.xml")!
            .async("string");
        expect(xml).toMatch(/<w:b\b/);
        // The body was not touched.
        await expect(extractDocxBodyText(out)).resolves.toBe("Body.");
    });

    it("reports nothing when the text is not in any header", async () => {
        const bytes = await makeDocx([para(run("Body."))], {
            "word/header1.xml": HEADER_XML,
        });
        const { applied } = await applyHeaderFooterEdits(bytes, [
            { index: 0, find: "Not there", replace: "x" },
        ]);
        expect(applied).toEqual([]);
    });
});

describe("tracked table insertion", () => {
    async function insertOne() {
        const bytes = await makeDocx([
            para(run("Payment schedule follows.")),
            para(run("Signed.")),
        ]);
        return insertTrackedTables(bytes, [
            {
                afterParagraphText: "Payment schedule follows.",
                rows: [
                    ["Milestone", "Amount"],
                    ["Mobilization", "$5,000"],
                ],
            },
        ]);
    }

    it("marks every row and cell run as an insertion", async () => {
        const { bytes, changes } = await insertOne();
        expect(changes).toHaveLength(1);
        expect(changes[0].preview).toBe(
            "Milestone | Amount\nMobilization | $5,000",
        );
        const xml = await (await JSZip.loadAsync(bytes))
            .file("word/document.xml")!
            .async("string");
        expect(xml).toMatch(/<w:tbl>/);
        expect((xml.match(/<w:trPr><w:ins /g) ?? []).length).toBe(2);
        // Table text is present but marked inserted.
        expect(xml).toContain("Mobilization");
        // The table sits after its anchor paragraph.
        expect(xml.indexOf("Payment schedule")).toBeLessThan(
            xml.indexOf("<w:tbl>"),
        );
        expect(xml.indexOf("<w:tbl>")).toBeLessThan(xml.indexOf("Signed."));
    });

    it("accepting keeps the table and strips the markers", async () => {
        const { bytes, changes } = await insertOne();
        const ids = [changes[0].insId, ...changes[0].extraIds];
        const { bytes: accepted, found } = await resolveTrackedChange(
            bytes,
            ids,
            "accept",
        );
        expect(found).toBe(true);
        const xml = await (await JSZip.loadAsync(accepted))
            .file("word/document.xml")!
            .async("string");
        expect(xml).toMatch(/<w:tbl>/);
        expect(xml).toContain("Mobilization");
        expect(xml).not.toMatch(/<w:ins\b/);
    });

    it("rejecting removes the table entirely", async () => {
        const { bytes, changes } = await insertOne();
        const ids = [changes[0].insId, ...changes[0].extraIds];
        const { bytes: rejected, found } = await resolveTrackedChange(
            bytes,
            ids,
            "reject",
        );
        expect(found).toBe(true);
        const xml = await (await JSZip.loadAsync(rejected))
            .file("word/document.xml")!
            .async("string");
        expect(xml).not.toMatch(/<w:tbl>/);
        expect(xml).not.toContain("Mobilization");
        await expect(extractDocxBodyText(rejected)).resolves.toBe(
            "Payment schedule follows.\nSigned.",
        );
    });
});

// ---------------------------------------------------------------------------
// Footnotes
// ---------------------------------------------------------------------------

const FOOTNOTES_XML =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:footnotes ${W_NS}>` +
    `<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>` +
    `<w:footnote w:id="1"><w:p><w:r><w:t xml:space="preserve">See Kan. Stat. Ann. 60-206.</w:t></w:r></w:p></w:footnote>` +
    `<w:footnote w:id="2"><w:p><w:r><w:t xml:space="preserve">Doe v. Roe, 123 F.3d 456 (10th Cir. 1997).</w:t></w:r></w:p></w:footnote>` +
    `</w:footnotes>`;

const FN_REF =
    `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="1"/></w:r>`;

async function makeFootnotedDocx(): Promise<Buffer> {
    return makeDocx(
        [
            `<w:p>${run("Deadlines are computed under Rule 6.")}${FN_REF}${run(" The motion is timely.")}</w:p>`,
            para(run("Nothing else here.")),
        ],
        { "word/footnotes.xml": FOOTNOTES_XML },
    );
}

describe("footnotes", () => {
    it("reads the notes and shows the reference mark inline", async () => {
        const bytes = await makeFootnotedDocx();
        const { extractDocxFootnotes, extractDocxBodyParagraphsMarked } =
            await import("../docxTrackedChanges");
        const notes = await extractDocxFootnotes(bytes);
        expect(notes).toEqual([
            { id: "1", text: "See Kan. Stat. Ann. 60-206." },
            { id: "2", text: "Doe v. Roe, 123 F.3d 456 (10th Cir. 1997)." },
        ]);
        const marked = await extractDocxBodyParagraphsMarked(bytes);
        expect(marked[0]).toBe(
            "Deadlines are computed under Rule 6.[fn 1] The motion is timely.",
        );
        // The plain (anchor) text carries no marker.
        await expect(extractDocxBodyText(bytes)).resolves.toContain(
            "Deadlines are computed under Rule 6. The motion is timely.",
        );
    });

    it("keeps the reference when a tracked rewrite echoes the token", async () => {
        const bytes = await makeFootnotedDocx();
        const applied = await applyTrackedEdits(bytes, [
            {
                find: "Deadlines are computed under Rule 6. The motion is timely.",
                replace:
                    "All deadlines are computed under Rule 6.[fn 1] The motion is therefore timely.",
                context_before: "",
                context_after: "",
            },
        ]);
        expect(applied.errors).toEqual([]);
        const xml = await (await JSZip.loadAsync(applied.bytes))
            .file("word/document.xml")!
            .async("string");
        // The original mark is a tracked deletion; the new one a tracked insert.
        expect(xml).toMatch(
            /<w:del [^>]*>(?:(?!<\/w:del>).)*footnoteReference(?:(?!<\/w:del>).)*<\/w:del>/s,
        );
        expect(xml).toMatch(
            /<w:ins [^>]*>(?:(?!<\/w:ins>).)*footnoteReference(?:(?!<\/w:ins>).)*<\/w:ins>/s,
        );

        const change = applied.changes[0];
        const ids = [
            change.delId,
            change.insId,
            ...(change.extraInsIds ?? []),
            ...(change.extraDelIds ?? []),
        ].filter((v): v is string => !!v);

        // Accepting leaves exactly one reference; so does rejecting.
        const { bytes: accepted } = await resolveTrackedChange(
            applied.bytes,
            ids,
            "accept",
        );
        const acceptedXml = await (await JSZip.loadAsync(accepted))
            .file("word/document.xml")!
            .async("string");
        expect(
            (acceptedXml.match(/<w:footnoteReference /g) ?? []).length,
        ).toBe(1);
        await expect(extractDocxBodyText(accepted)).resolves.toContain(
            "therefore timely",
        );

        const { bytes: rejected } = await resolveTrackedChange(
            applied.bytes,
            ids,
            "reject",
        );
        const rejectedXml = await (await JSZip.loadAsync(rejected))
            .file("word/document.xml")!
            .async("string");
        expect(
            (rejectedXml.match(/<w:footnoteReference /g) ?? []).length,
        ).toBe(1);
        await expect(extractDocxBodyText(rejected)).resolves.toContain(
            "The motion is timely.",
        );
    });

    it("edits a footnote's own text in place", async () => {
        const bytes = await makeFootnotedDocx();
        const { bytes: out, applied } = await applyHeaderFooterEdits(bytes, [
            {
                index: 0,
                find: "Kan. Stat. Ann. 60-206",
                replace: "Kan. Stat. Ann. 60-206(a)",
            },
        ]);
        expect(applied).toEqual([{ index: 0, part: "footnote" }]);
        const { extractDocxFootnotes } = await import("../docxTrackedChanges");
        const notes = await extractDocxFootnotes(out);
        expect(notes[0].text).toBe("See Kan. Stat. Ann. 60-206(a).");
    });
});

describe("creating new footnotes", () => {
    it("parses and round-trips the [fn new:] token", async () => {
        const { inlineEditRuns, runsToMarkedText } = await import(
            "../docxTrackedChanges"
        );
        const runs = inlineEditRuns(
            "The deadline extended.[fn new: Fed. R. Civ. P. 6(a)(1)(C).] It was timely.",
        );
        expect(runs).toEqual([
            { text: "The deadline extended." },
            { text: "", footnoteNew: "Fed. R. Civ. P. 6(a)(1)(C)." },
            { text: " It was timely." },
        ]);
        expect(runsToMarkedText(runs)).toBe(
            "The deadline extended.[fn new: Fed. R. Civ. P. 6(a)(1)(C).] It was timely.",
        );
    });

    it("creates a numbered footnote through a tracked edit", async () => {
        const bytes = await makeFootnotedDocx();
        const applied = await applyTrackedEdits(bytes, [
            {
                find: "Nothing else here.",
                replace:
                    "Nothing else here, except as noted.[fn new: See the docketing order of July 1, 2026.]",
                context_before: "",
                context_after: "",
            },
        ]);
        expect(applied.errors).toEqual([]);
        const { extractDocxFootnotes } = await import("../docxTrackedChanges");
        const notes = await extractDocxFootnotes(applied.bytes);
        // Two existing notes plus the new one, with a fresh id.
        expect(notes).toHaveLength(3);
        expect(notes[2].text).toBe("See the docketing order of July 1, 2026.");
        expect(notes[2].id).toBe("3");
        const xml = await (await JSZip.loadAsync(applied.bytes))
            .file("word/document.xml")!
            .async("string");
        expect(xml).toContain('w:footnoteReference w:id="3"');
        expect(xml).not.toContain("[fn new:");
        // The new mark is part of the tracked insertion.
        expect(xml).toMatch(
            /<w:ins [^>]*>(?:(?!<\/w:ins>).)*w:id="3"(?:(?!<\/w:ins>).)*<\/w:ins>/s,
        );
    });

    it("creates the footnotes part when the document has none", async () => {
        const zip = new JSZip();
        zip.file(
            "[Content_Types].xml",
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
        );
        zip.file(
            "word/_rels/document.xml.rels",
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
        );
        zip.file(
            "word/document.xml",
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
                `<w:document ${W_NS}><w:body>${para(run("A plain memo sentence."))}</w:body></w:document>`,
        );
        const bytes = Buffer.from(
            await zip.generateAsync({ type: "nodebuffer" }),
        );

        const {
            applyFormattedEdits,
            extractDocxBodyParagraphs,
            extractDocxFootnotes,
            inlineEditRuns: parse,
        } = await import("../docxTrackedChanges");
        const baseline = await extractDocxBodyParagraphs(bytes);
        const line =
            "A plain memo sentence.[fn new: Authority for the plain sentence.]";
        const out = await applyFormattedEdits(bytes, baseline, [
            { text: "A plain memo sentence.", runs: parse(line) },
        ]);
        const notes = await extractDocxFootnotes(out.bytes);
        expect(notes).toEqual([
            { id: "1", text: "Authority for the plain sentence." },
        ]);
        const outZip = await JSZip.loadAsync(out.bytes);
        const ct = await outZip.file("[Content_Types].xml")!.async("string");
        expect(ct).toContain("/word/footnotes.xml");
        const rels = await outZip
            .file("word/_rels/document.xml.rels")!
            .async("string");
        expect(rels).toContain("relationships/footnotes");
        const doc = await outZip.file("word/document.xml")!.async("string");
        expect(doc).toContain('w:footnoteReference w:id="1"');
        // The sentence itself is unchanged.
        await expect(extractDocxBodyText(out.bytes)).resolves.toBe(
            "A plain memo sentence.",
        );
    });
});
