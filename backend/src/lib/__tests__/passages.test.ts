import { describe, expect, it } from "vitest";
import {
    MAX_CHARS,
    TARGET_CHARS,
    splitByPage,
    toPassages,
} from "../passages";

const page = (n: number, body: string) => `[Page ${n}]\n${body}`;

describe("splitByPage", () => {
    it("separates the pages the PDF reader labels", () => {
        const pages = splitByPage(
            [page(1, "first page text"), page(2, "second page text")].join("\n\n"),
        );
        expect(pages.map((p) => p.page)).toEqual([1, 2]);
        expect(pages[0].text).toContain("first page");
        expect(pages[1].text).toContain("second page");
    });

    it("keeps text that appears before any page marker", () => {
        const pages = splitByPage(`a note\n\n${page(1, "body")}`);
        expect(pages[0].page).toBeNull();
        expect(pages[0].text.trim()).toBe("a note");
    });

    it("drops pages that hold nothing but their label", () => {
        // This is the scanned-document case: pages exist, text does not.
        expect(splitByPage([page(1, ""), page(2, "   ")].join("\n"))).toEqual([]);
    });
});

describe("toPassages", () => {
    it("numbers passages in order across the document", () => {
        const text = [
            page(1, "a".repeat(3000)),
            page(2, "b".repeat(3000)),
        ].join("\n\n");
        const passages = toPassages(text);
        expect(passages.map((p) => p.ordinal)).toEqual(
            passages.map((_, i) => i),
        );
    });

    it("never lets a passage span two pages", () => {
        // The whole point: a passage's page number has to be unambiguous.
        const text = [page(1, "alpha ".repeat(400)), page(2, "beta ".repeat(400))].join("\n\n");
        for (const passage of toPassages(text)) {
            const hasAlpha = passage.content.includes("alpha");
            const hasBeta = passage.content.includes("beta");
            expect(hasAlpha && hasBeta).toBe(false);
        }
    });

    it("carries the page number on every passage", () => {
        const passages = toPassages(page(7, "clause text ".repeat(300)));
        expect(passages.length).toBeGreaterThan(1);
        expect(passages.every((p) => p.page === 7)).toBe(true);
    });

    it("repeats a little of the previous passage so clauses are not cut in half", () => {
        const body = Array.from({ length: 12 }, (_, i) =>
            `Section ${i + 1}. ${"word ".repeat(60)}`,
        ).join("\n\n");
        const passages = toPassages(page(1, body));
        expect(passages.length).toBeGreaterThan(1);
        const secondStart = passages[1].content.slice(0, 40);
        expect(passages[0].content).toContain(secondStart.split(" ")[0]);
    });

    it("cuts up a page with no paragraph breaks at all", () => {
        const passages = toPassages(page(1, "x".repeat(9000)));
        expect(passages.length).toBeGreaterThan(3);
        for (const passage of passages) {
            expect(passage.content.length).toBeLessThanOrEqual(
                MAX_CHARS + TARGET_CHARS,
            );
        }
    });

    it("keeps a short document as a single passage", () => {
        const passages = toPassages(page(1, "A short engagement letter."));
        expect(passages).toHaveLength(1);
        expect(passages[0].content).toBe("A short engagement letter.");
        expect(passages[0].page).toBe(1);
    });

    it("returns nothing for a document with no text", () => {
        expect(toPassages("")).toEqual([]);
        expect(toPassages(page(1, "   "))).toEqual([]);
    });

    it("tidies the whitespace PDF extraction leaves behind", () => {
        const passages = toPassages(page(1, "spaced    out\n\n\n\ntext here"));
        expect(passages[0].content).toBe("spaced out\n\ntext here");
    });
});
