import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
    getFirmForms,
    removeFirmForm,
    searchLibraryDocuments,
    suggestFirmFormNotes,
    updateFirmForm,
    type FirmForm,
} from "@/app/lib/mikeApi";
import { FormBankSection } from "./FormBankSection";

vi.mock("@/app/lib/mikeApi", () => ({
    getFirmForms: vi.fn(),
    addFirmForm: vi.fn(),
    updateFirmForm: vi.fn(),
    removeFirmForm: vi.fn(),
    suggestFirmFormNotes: vi.fn(),
    searchLibraryDocuments: vi.fn(),
}));

function form(overrides: Partial<FirmForm> = {}): FirmForm {
    return {
        id: "form-1",
        firm_id: "firm-1",
        document_id: "doc-1",
        title: "Operating agreement — two members",
        document_type: "operating-agreement",
        usage_mode: "precedent",
        variant_notes: "member-managed, two individual members",
        practice: "Business",
        jurisdictions: ["Kansas"],
        description: null,
        drafting_guidance: null,
        required_fields: [],
        status: "approved",
        created_by: null,
        ...overrides,
    };
}

describe("the form bank on the Content screen", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(searchLibraryDocuments).mockResolvedValue({
            documents: [],
            documentsHasMore: false,
        });
    });

    it("says what to do when nothing is banked yet", async () => {
        vi.mocked(getFirmForms).mockResolvedValue([]);
        render(<FormBankSection onError={() => {}} />);
        expect(
            await screen.findByText(/Nothing is banked yet/i),
        ).toBeInTheDocument();
    });

    it("keeps several versions of one kind of document together and counts them", async () => {
        vi.mocked(getFirmForms).mockResolvedValue([
            form({ id: "a", title: "Two members" }),
            form({ id: "b", title: "Manager-managed" }),
        ]);
        render(<FormBankSection onError={() => {}} />);

        expect(await screen.findByText("Operating agreement")).toBeInTheDocument();
        expect(screen.getByText("2 versions")).toBeInTheDocument();
        expect(screen.getByText("Two members")).toBeInTheDocument();
        expect(screen.getByText("Manager-managed")).toBeInTheDocument();
    });

    it("says plainly that a draft entry is not offered yet", async () => {
        vi.mocked(getFirmForms).mockResolvedValue([form({ status: "draft" })]);
        render(<FormBankSection onError={() => {}} />);
        expect(
            await screen.findByText(/Draft — not offered yet/),
        ).toBeInTheDocument();
    });

    it("opens an entry's notes for editing when it is clicked", async () => {
        vi.mocked(getFirmForms).mockResolvedValue([form()]);
        render(<FormBankSection onError={() => {}} />);

        await userEvent.click(
            await screen.findByText("Operating agreement — two members"),
        );

        expect(
            screen.getByDisplayValue("Operating agreement — two members"),
        ).toBeInTheDocument();
        expect(
            screen.getByDisplayValue("member-managed, two individual members"),
        ).toBeInTheDocument();
    });

    it("shows the blanks only on a fill-in form", async () => {
        vi.mocked(getFirmForms).mockResolvedValue([
            form({
                usage_mode: "fill",
                title: "Engagement letter — flat fee",
                document_type: "engagement-letter",
                required_fields: [
                    { key: "fee", label: "Flat fee", source: "ask" },
                ],
            }),
        ]);
        render(<FormBankSection onError={() => {}} />);

        await userEvent.click(
            await screen.findByText("Engagement letter — flat fee"),
        );

        expect(screen.getByText("The blanks")).toBeInTheDocument();
        expect(screen.getByDisplayValue("Flat fee")).toBeInTheDocument();
    });

    it("saves a change to the notes", async () => {
        vi.mocked(getFirmForms).mockResolvedValue([form()]);
        vi.mocked(updateFirmForm).mockResolvedValue(
            form({ status: "approved" }),
        );
        render(<FormBankSection onError={() => {}} />);

        await userEvent.click(
            await screen.findByText("Operating agreement — two members"),
        );
        await userEvent.click(screen.getByRole("button", { name: "Save" }));

        await waitFor(() => {
            expect(updateFirmForm).toHaveBeenCalledWith(
                "form-1",
                expect.objectContaining({
                    document_type: "Operating agreement",
                    usage_mode: "precedent",
                }),
            );
        });
    });

    it("warns that taking an entry out leaves the document alone", async () => {
        vi.mocked(getFirmForms).mockResolvedValue([form()]);
        render(<FormBankSection onError={() => {}} />);

        await userEvent.click(
            await screen.findByRole("button", { name: /Take out of the bank/i }),
        );

        expect(
            screen.getByText(/stays on the firm's library shelves/i),
        ).toBeInTheDocument();
        expect(removeFirmForm).not.toHaveBeenCalled();
    });

    it("suggests the notes without saving anything", async () => {
        vi.mocked(getFirmForms).mockResolvedValue([]);
        vi.mocked(searchLibraryDocuments).mockResolvedValue({
            documents: [
                {
                    id: "doc-9",
                    project_id: null,
                    filename: "Operating Agreement.docx",
                    file_type: "docx",
                    storage_path: null,
                    pdf_storage_path: null,
                    size_bytes: null,
                    page_count: null,
                    structure_tree: null,
                    status: "ready",
                    created_at: null,
                },
            ],
            documentsHasMore: false,
        });
        vi.mocked(suggestFirmFormNotes).mockResolvedValue({
            title: "Operating agreement — two members",
            document_type: "operating-agreement",
            usage_mode: "precedent",
            variant_notes: "member-managed, two individual members",
            description: "",
            drafting_guidance: "",
            practice: "Business",
            jurisdictions: ["Kansas"],
            required_fields: [],
        });
        render(<FormBankSection onError={() => {}} />);

        await userEvent.click(
            await screen.findByRole("button", { name: /Bank a document/i }),
        );
        await userEvent.click(
            await screen.findByRole("button", { name: /Choose a template/i }),
        );
        await userEvent.click(
            await screen.findByText("Operating Agreement.docx"),
        );
        await userEvent.click(
            screen.getByRole("button", { name: /suggest the notes/i }),
        );

        expect(
            await screen.findByDisplayValue(
                "Operating agreement — two members",
            ),
        ).toBeInTheDocument();
    });
});
