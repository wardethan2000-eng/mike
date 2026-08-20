import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
    MatterSearchPanel,
    withCitationLinks,
} from "./MatterSearchPanel";

const answerMatter = vi.fn();
const searchMatter = vi.fn();

vi.mock("@/app/lib/mikeApi", () => ({
    answerMatter: (...args: unknown[]) => answerMatter(...args),
    searchMatter: (...args: unknown[]) => searchMatter(...args),
}));

vi.mock("@/app/hooks/useSelectedModel", () => ({
    useSelectedModel: () => ["a-model", vi.fn()],
}));

describe("withCitationLinks", () => {
    it("makes a matched citation into a link and leaves the rest alone", () => {
        const linked = withCitationLinks(
            "Rent is monthly (Lease.pdf, page 4), which is usual (as expected).",
            [
                {
                    text: "Lease.pdf, page 4",
                    documentId: "doc-1",
                    filename: "Lease.pdf",
                    page: 4,
                    quote: "Rent is payable monthly.",
                },
            ],
        );
        expect(linked).toBe(
            "Rent is monthly ([Lease.pdf, page 4](#mike-source-0)), which is usual (as expected).",
        );
    });

    it("leaves an answer untouched when nothing was matched", () => {
        expect(withCitationLinks("Nothing to link.", [])).toBe(
            "Nothing to link.",
        );
    });
});

describe("MatterSearchPanel", () => {
    it("asks to open the document when a citation is clicked", async () => {
        answerMatter.mockResolvedValue({
            question: "When is rent due?",
            answer: "Rent falls due monthly (Lease.pdf, page 4).",
            sources: [
                {
                    documentId: "doc-1",
                    filename: "Lease.pdf",
                    page: 4,
                    content: "Rent is payable monthly.",
                    matchedBy: "words",
                    fromFilename: false,
                },
            ],
            citations: [
                {
                    text: "Lease.pdf, page 4",
                    documentId: "doc-1",
                    filename: "Lease.pdf",
                    page: 4,
                    quote: "Rent is payable monthly.",
                },
            ],
        });
        searchMatter.mockResolvedValue({ results: [] });
        const onOpenSource = vi.fn();
        render(
            <MatterSearchPanel
                projectId="project-1"
                onOpenSource={onOpenSource}
            />,
        );

        fireEvent.change(
            screen.getByPlaceholderText(/Ask the matter a question/),
            {
                target: { value: "When is rent due?" },
            },
        );
        fireEvent.click(screen.getByRole("button", { name: "Search" }));

        const citation = await screen.findByRole("button", {
            name: "Lease.pdf, page 4",
        });
        fireEvent.click(citation);
        await waitFor(() =>
            expect(onOpenSource).toHaveBeenCalledWith({
                documentId: "doc-1",
                filename: "Lease.pdf",
                page: 4,
                quote: "Rent is payable monthly.",
            }),
        );
    });
});
