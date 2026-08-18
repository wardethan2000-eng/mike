import { describe, expect, it } from "vitest";
import { MIN_CHARS_PER_PAGE, OCR_TEXT_NOTE, pdfNeedsOcr } from "../ocr";

const page = (n: number, body: string) => `[Page ${n}]\n${body}`;

describe("pdfNeedsOcr", () => {
    it("treats a page carrying only its page label as a scan", () => {
        // This is the symptom that started it: the reader returned page
        // numbers and nothing else for an image-only scan.
        expect(pdfNeedsOcr(page(1, ""), 1)).toBe(true);
        expect(pdfNeedsOcr([page(1, ""), page(2, "")].join("\n\n"), 2)).toBe(
            true,
        );
    });

    it("treats a stamped Bates number as still needing OCR", () => {
        expect(pdfNeedsOcr(page(1, "SMITH-000123"), 1)).toBe(true);
    });

    it("leaves a real text layer alone", () => {
        const body = "This Agreement is made on 1 March 2026 between the parties";
        expect(pdfNeedsOcr(page(1, body), 1)).toBe(false);
    });

    it("scales the threshold with the page count", () => {
        const body = "x".repeat(MIN_CHARS_PER_PAGE + 5);
        // Enough text for one page, nowhere near enough for fifty.
        expect(pdfNeedsOcr(page(1, body), 1)).toBe(false);
        expect(pdfNeedsOcr(page(1, body), 50)).toBe(true);
    });

    it("ignores whitespace and treats a missing page count as one page", () => {
        expect(pdfNeedsOcr("[Page 1]\n   \n\t\n", null)).toBe(true);
    });
});

describe("OCR_TEXT_NOTE", () => {
    it("warns the reader that the text came from recognition", () => {
        expect(OCR_TEXT_NOTE).toMatch(/optical character recognition/i);
        expect(OCR_TEXT_NOTE).toMatch(/check/i);
    });
});
