import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import {
    extractDocxBodyParagraphsMarked,
    extractDocxBodyText,
} from "../docxTrackedChanges";

const W_NS =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';

function run(text: string, rPr = ""): string {
    const props = rPr ? `<w:rPr>${rPr}</w:rPr>` : "";
    return `<w:r>${props}<w:t xml:space="preserve">${text}</w:t></w:r>`;
}

async function makeDocx(paragraphBodies: string[]): Promise<Buffer> {
    const zip = new JSZip();
    zip.file(
        "word/document.xml",
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
            `<w:document ${W_NS}><w:body>` +
            paragraphBodies.map((b) => `<w:p>${b}</w:p>`).join("") +
            `</w:body></w:document>`,
    );
    return zip.generateAsync({ type: "nodebuffer" });
}

describe("extractDocxBodyParagraphsMarked", () => {
    it("shows bold, italic and underline as inline markers", async () => {
        const bytes = await makeDocx([
            run("Scope of Work. ", "<w:b/><w:bCs/>") + run("Cooks will furnish the labor."),
            run("emphasised", "<w:i/>"),
            run("defined term", "<w:u w:val=\"single\"/>"),
        ]);
        const lines = await extractDocxBodyParagraphsMarked(bytes);
        expect(lines).toEqual([
            "**Scope of Work.** Cooks will furnish the labor.",
            "*emphasised*",
            "_defined term_",
        ]);
    });

    it("merges adjacent runs that share the same look", async () => {
        // Word habitually splits one bold phrase across several runs.
        const bytes = await makeDocx([
            run("RESIDENTIAL ", "<w:b/>") + run("SERVICES ", "<w:b/>") + run("AGREEMENT", "<w:b/>"),
        ]);
        const lines = await extractDocxBodyParagraphsMarked(bytes);
        expect(lines).toEqual(["**RESIDENTIAL SERVICES AGREEMENT**"]);
    });

    it("leaves a span alone when the marker syntax cannot express it", async () => {
        const bytes = await makeDocx([
            // Signature blank: pure underscores under an underline would be
            // unparseable, so it stays as-is.
            run("________________", "<w:u w:val=\"single\"/>"),
            // A bold toggle explicitly turned off is not bold.
            run("plain despite w:b", '<w:b w:val="0"/>'),
        ]);
        const lines = await extractDocxBodyParagraphsMarked(bytes);
        expect(lines).toEqual(["________________", "plain despite w:b"]);
    });

    it("keeps whitespace at the edges outside the marker", async () => {
        const bytes = await makeDocx([
            run("lead-in ", "") + run(" bold middle ", "<w:b/>") + run("tail", ""),
        ]);
        const lines = await extractDocxBodyParagraphsMarked(bytes);
        expect(lines).toEqual(["lead-in  **bold middle** tail"]);
    });

    it("marks a run with several looks with the strongest one only", async () => {
        const bytes = await makeDocx([run("both", "<w:b/><w:i/>")]);
        const lines = await extractDocxBodyParagraphsMarked(bytes);
        expect(lines).toEqual(["**both**"]);
    });

    it("adds nothing to a plain document", async () => {
        const bytes = await makeDocx([run("Just ordinary text.")]);
        const marked = await extractDocxBodyParagraphsMarked(bytes);
        expect(marked.join("\n")).toBe(await extractDocxBodyText(bytes));
    });
});
