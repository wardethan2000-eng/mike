import { describe, expect, it } from "vitest";
import { isOcrDerived, shouldReadFromRendition } from "../documentRendition";

const version = (over: Record<string, unknown> = {}) => ({
    file_type: "pdf",
    storage_path: "uploads/u/doc.pdf",
    pdf_storage_path: "uploads/u/doc.pdf",
    ...over,
});

describe("shouldReadFromRendition", () => {
    it("reads a photo from its OCR copy", () => {
        expect(
            shouldReadFromRendition(
                version({
                    file_type: "heic",
                    storage_path: "uploads/u/photo.heic",
                    pdf_storage_path: "converted-pdfs/u/doc.pdf",
                }),
            ),
        ).toBe(true);
    });

    it("reads a scanned PDF from its searchable copy", () => {
        expect(
            shouldReadFromRendition(
                version({ pdf_storage_path: "converted-pdfs/u/doc.pdf" }),
            ),
        ).toBe(true);
    });

    it("leaves a PDF that is its own rendition alone", () => {
        expect(shouldReadFromRendition(version())).toBe(false);
    });

    it("reads plain text from the rendered page so citations line up", () => {
        expect(
            shouldReadFromRendition(
                version({
                    file_type: "txt",
                    storage_path: "uploads/u/notes.txt",
                    pdf_storage_path: "converted-pdfs/u/doc.pdf",
                }),
            ),
        ).toBe(true);
    });

    it("never diverts Word files, which have their own tracked-changes reader", () => {
        expect(
            shouldReadFromRendition(
                version({
                    file_type: "docx",
                    storage_path: "uploads/u/deed.docx",
                    pdf_storage_path: "converted-pdfs/u/doc.pdf",
                }),
            ),
        ).toBe(false);
    });

    it("handles a missing version or a missing rendition", () => {
        expect(shouldReadFromRendition(null)).toBe(false);
        expect(shouldReadFromRendition(undefined)).toBe(false);
        expect(
            shouldReadFromRendition(version({ pdf_storage_path: null })),
        ).toBe(false);
    });
});

describe("isOcrDerived", () => {
    it("is true for images and for scanned PDFs given a searchable copy", () => {
        expect(
            isOcrDerived(
                version({
                    file_type: "jpg",
                    storage_path: "uploads/u/scan.jpg",
                    pdf_storage_path: "converted-pdfs/u/doc.pdf",
                }),
            ),
        ).toBe(true);
        expect(
            isOcrDerived(version({ pdf_storage_path: "converted-pdfs/u/doc.pdf" })),
        ).toBe(true);
    });

    it("is false for an ordinary PDF and for a converted Word file", () => {
        expect(isOcrDerived(version())).toBe(false);
        expect(
            isOcrDerived(
                version({
                    file_type: "docx",
                    storage_path: "uploads/u/deed.docx",
                    pdf_storage_path: "converted-pdfs/u/doc.pdf",
                }),
            ),
        ).toBe(false);
    });
});
