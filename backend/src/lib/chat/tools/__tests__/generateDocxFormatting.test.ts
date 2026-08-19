import { describe, expect, it, vi, beforeEach } from "vitest";
import JSZip from "jszip";

// Capture whatever bytes generate_docx would have stored, so the test can
// look at the real Word XML instead of trusting the call arguments.
const uploaded: ArrayBuffer[] = [];

vi.mock("../../../storage", () => ({
  downloadFile: vi.fn(),
  generatedDocKey: () => "generated/test.docx",
  uploadFile: vi.fn(async (_key: string, buf: ArrayBuffer) => {
    uploaded.push(buf);
  }),
}));
vi.mock("../../../downloadTokens", () => ({
  buildDownloadUrl: () => "https://example.test/download",
}));
vi.mock("../../../convert", () => ({
  convertedPdfKey: () => "converted/test.pdf",
  docxToPdf: vi.fn(),
}));

import { generateDocx } from "../documentOps";

const fakeDb = () => {
  const table = (id: string) => ({
    insert: () => ({
      select: () => ({
        single: async () => ({ data: { id }, error: null }),
      }),
    }),
    update: () => ({ eq: async () => ({ error: null }) }),
    select: () => ({
      eq: () => ({
        order: () => ({ limit: async () => ({ data: [], error: null }) }),
      }),
    }),
  });
  return {
    from: (name: string) =>
      table(name === "documents" ? "doc-uuid" : "version-uuid"),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
};

async function render(
  title: string,
  sections: unknown[],
  style?: Record<string, unknown>,
) {
  uploaded.length = 0;
  const result = await generateDocx(title, sections, "user-1", fakeDb(), {
    projectId: null,
    style,
  });
  expect((result as { error?: string }).error).toBeUndefined();
  expect(uploaded).toHaveLength(1);
  const zip = await JSZip.loadAsync(uploaded[0]);
  return zip.file("word/document.xml")!.async("string");
}

describe("generate_docx formatting", () => {
  beforeEach(() => {
    uploaded.length = 0;
  });

  it("keeps the contract look when no style is given", async () => {
    const xml = await render("Services Agreement", [
      { heading: "Definitions", content: "The following terms apply." },
    ]);
    // Times New Roman 11pt, uppercase title, automatic clause numbering.
    expect(xml).toContain("Times New Roman");
    expect(xml).toContain('w:val="22"');
    expect(xml).toContain("SERVICES AGREEMENT");
    expect(xml).toContain("<w:numPr>");
    expect(xml).not.toContain("<w:spacing w:after=\"0\"/>");
  });

  it("lays out a certificate of service the way it was asked for", async () => {
    const xml = await render(
      "Certificate of Service",
      [
        {
          content: "**CERTIFICATE OF SERVICE**",
          format: { align: "center" },
        },
        {
          content:
            "I hereby certify that on August 19, 2026, a true and correct copy of the foregoing was served on counsel of record.\n\nService was made by electronic mail.",
        },
        {
          content: "Respectfully submitted,\n\n_____________________\nJane Doe",
          format: { align: "left", indent: 3.5 },
        },
      ],
      {
        font: "Century Schoolbook",
        fontSize: 12,
        lineSpacing: "double",
        numbering: "none",
        showTitle: false,
        pageNumbers: true,
        margins: { top: 1, bottom: 1, left: 1, right: 1 },
      },
    );

    // Font and size the drafter asked for.
    expect(xml).toContain("Century Schoolbook");
    expect(xml).toContain('w:val="24"');
    // Double spacing.
    expect(xml).toContain('w:line="480"');
    // Centred first line and an indented signature block.
    expect(xml).toContain('<w:jc w:val="center"/>');
    expect(xml).toContain('w:left="5040"');
    // Nothing numbered, nothing auto-capitalised, no generated title.
    expect(xml).not.toContain("<w:numPr>");
    // showTitle:false means the only "CERTIFICATE OF SERVICE" on the page
    // is the line the drafter wrote, not a second one added by the tool.
    expect(xml.match(/CERTIFICATE OF SERVICE/g)).toHaveLength(1);
    // The **markers** became real bold, not literal asterisks.
    expect(xml).toContain("<w:b/>");
    expect(xml).not.toContain("**CERTIFICATE");
    // Page number in the footer.
    expect(xml).toContain("footer");
  });

  it("supports underline, italic and tab stops inside a line", async () => {
    const xml = await render(
      "Notice",
      [{ content: "Dated: August 19, 2026\t_Jane Doe_ and *counsel*" }],
      { numbering: "none" },
    );
    expect(xml).toContain("<w:u ");
    expect(xml).toContain("<w:i/>");
    expect(xml).toContain("<w:tab/>");
    expect(xml).not.toContain("_Jane Doe_");
  });

  it("draws a borderless caption table when asked", async () => {
    const xml = await render(
      "Motion",
      [
        {
          table: {
            headers: ["JANE DOE,\nPlaintiff,", "Case No. 2026-CV-1234"],
            rows: [["v.", ""]],
            borders: false,
            headerRow: false,
            widths: [55, 45],
          },
        },
      ],
      { numbering: "none" },
    );
    expect(xml).toContain('w:val="none"');
    expect(xml).not.toContain('w:fill="F2F2F2"');
    expect(xml).toContain('w:w="55%"');
    // Each line of a caption cell is its own line on the page.
    expect(xml).toContain("JANE DOE,");
    expect(xml).toContain("Plaintiff,");
    expect(xml).not.toContain("JANE DOE,\nPlaintiff,");
    // The table's own grid has to go too, not just the cell borders.
    expect(xml).not.toContain('<w:tblBorders><w:top w:val="single"');
  });
});
