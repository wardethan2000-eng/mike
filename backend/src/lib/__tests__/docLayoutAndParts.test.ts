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
