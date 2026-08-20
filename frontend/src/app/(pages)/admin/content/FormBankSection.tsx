"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Plus, Trash2 } from "lucide-react";
import { PillButton } from "@/app/components/ui/pill-button";
import { FieldLabel } from "@/app/components/ui/form-field";
import {
    SETTINGS_CONTROL_CLASS,
    SettingsTextInput,
} from "@/app/components/settings/SettingsTextInput";
import { ModalSelect } from "@/app/components/modals/ModalSelect";
import { ModalSegmentedToggle } from "@/app/components/modals/ModalSegmentedToggle";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { cn } from "@/app/lib/utils";
import {
    addFirmForm,
    getFirmForms,
    removeFirmForm,
    searchLibraryDocuments,
    suggestFirmFormNotes,
    updateFirmForm,
    type FirmForm,
    type FirmFormInput,
    type FormFieldSource,
    type FormRequiredField,
    type FormStatus,
    type FormUsageMode,
} from "@/app/lib/mikeApi";
import { SettingsSection } from "../../settings/SettingsSection";
import { errorMessage } from "../adminHelpers";

const MODE_OPTIONS: { value: FormUsageMode; label: string }[] = [
    { value: "precedent", label: "Precedent" },
    { value: "fill", label: "Fill-in form" },
];

const STATUS_OPTIONS: { value: FormStatus; label: string }[] = [
    { value: "draft", label: "Draft" },
    { value: "approved", label: "Approved" },
];

const SOURCE_OPTIONS: { value: FormFieldSource; label: string }[] = [
    { value: "ask", label: "Ask the person drafting" },
    { value: "matter", label: "From the matter" },
    { value: "attorney", label: "From the attorney" },
    { value: "firm", label: "From the firm" },
];

/** Turn "operating-agreement" back into "Operating agreement" for a heading. */
function typeLabel(slug: string): string {
    if (!slug) return "Other";
    const words = slug.split("-").filter(Boolean).join(" ");
    return words.charAt(0).toUpperCase() + words.slice(1);
}

type Draft = {
    title: string;
    documentType: string;
    usageMode: FormUsageMode;
    variantNotes: string;
    description: string;
    draftingGuidance: string;
    practice: string;
    jurisdictions: string;
    requiredFields: FormRequiredField[];
    status: FormStatus;
};

function draftFrom(form: FirmForm): Draft {
    return {
        title: form.title,
        documentType: form.document_type,
        usageMode: form.usage_mode,
        variantNotes: form.variant_notes ?? "",
        description: form.description ?? "",
        draftingGuidance: form.drafting_guidance ?? "",
        practice: form.practice ?? "",
        jurisdictions: form.jurisdictions.join(", "),
        requiredFields: form.required_fields,
        status: form.status,
    };
}

const EMPTY_DRAFT: Draft = {
    title: "",
    documentType: "",
    usageMode: "precedent",
    variantNotes: "",
    description: "",
    draftingGuidance: "",
    practice: "",
    jurisdictions: "",
    requiredFields: [],
    status: "draft",
};

function draftToInput(draft: Draft): FirmFormInput {
    return {
        title: draft.title.trim(),
        document_type: draft.documentType.trim(),
        usage_mode: draft.usageMode,
        variant_notes: draft.variantNotes.trim() || null,
        description: draft.description.trim() || null,
        drafting_guidance: draft.draftingGuidance.trim() || null,
        practice: draft.practice.trim() || null,
        jurisdictions: draft.jurisdictions
            .split(",")
            .map((entry) => entry.trim())
            .filter(Boolean),
        required_fields:
            draft.usageMode === "fill" ? draft.requiredFields : [],
        status: draft.status,
    };
}

/** The notes on one banked document, open for editing. */
function NotesForm({
    draft,
    onChange,
    disabled,
}: {
    draft: Draft;
    onChange: (next: Draft) => void;
    disabled?: boolean;
}) {
    const set = (patch: Partial<Draft>) => onChange({ ...draft, ...patch });

    return (
        <div className="space-y-5">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                    <FieldLabel
                        htmlFor="form-title"
                        className="text-sm text-gray-600"
                    >
                        Name
                    </FieldLabel>
                    <SettingsTextInput
                        id="form-title"
                        type="text"
                        value={draft.title}
                        disabled={disabled}
                        onChange={(event) => set({ title: event.target.value })}
                        placeholder="Operating agreement — two members"
                    />
                </div>
                <div>
                    <FieldLabel
                        htmlFor="form-type"
                        className="text-sm text-gray-600"
                    >
                        Kind of document
                    </FieldLabel>
                    <SettingsTextInput
                        id="form-type"
                        type="text"
                        value={draft.documentType}
                        disabled={disabled}
                        onChange={(event) =>
                            set({ documentType: event.target.value })
                        }
                        placeholder="Operating agreement"
                    />
                    <p className="mt-1 text-xs text-gray-500">
                        Give every version of the same kind the same name here.
                        That is what puts them together as a set to choose from.
                    </p>
                </div>
            </div>

            <div className="flex flex-wrap items-center gap-6">
                <div>
                    <FieldLabel as="span" className="text-sm text-gray-600">
                        How Mike should use it
                    </FieldLabel>
                    <div className="mt-1">
                        <ModalSegmentedToggle
                            value={draft.usageMode}
                            options={MODE_OPTIONS}
                            disabled={disabled}
                            onChange={(usageMode) => set({ usageMode })}
                        />
                    </div>
                </div>
                <div>
                    <FieldLabel as="span" className="text-sm text-gray-600">
                        Offered in chats
                    </FieldLabel>
                    <div className="mt-1">
                        <ModalSegmentedToggle
                            value={draft.status}
                            options={STATUS_OPTIONS}
                            disabled={disabled}
                            onChange={(status) => set({ status })}
                        />
                    </div>
                </div>
            </div>
            <p className="text-xs text-gray-500">
                {draft.usageMode === "precedent"
                    ? "A precedent is a full document to work from. Mike copies it, keeps its look and numbering, and rewrites it for the matter in hand."
                    : "A fill-in form has a fixed shape. Mike copies it and changes only the blanks listed below, leaving everything else alone."}
                {draft.status === "draft"
                    ? " While it is a draft, nobody's chat is offered it."
                    : " Approved, so it is offered in everybody's chats."}
            </p>

            <div>
                <FieldLabel
                    htmlFor="form-variant"
                    className="text-sm text-gray-600"
                >
                    How this one differs from the firm&apos;s others
                </FieldLabel>
                <textarea
                    id="form-variant"
                    value={draft.variantNotes}
                    disabled={disabled}
                    onChange={(event) =>
                        set({ variantNotes: event.target.value })
                    }
                    rows={2}
                    placeholder="Member-managed, two individual members, Kansas."
                    className={cn(
                        "min-h-16 resize-y py-2.5 leading-relaxed",
                        SETTINGS_CONTROL_CLASS,
                    )}
                />
                <p className="mt-1 text-xs text-gray-500">
                    Mike reads these side by side to pick the right starting
                    point. Say which situation this one is for, in plain terms.
                </p>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                    <FieldLabel
                        htmlFor="form-practice"
                        className="text-sm text-gray-600"
                    >
                        Practice area
                    </FieldLabel>
                    <SettingsTextInput
                        id="form-practice"
                        type="text"
                        value={draft.practice}
                        disabled={disabled}
                        onChange={(event) =>
                            set({ practice: event.target.value })
                        }
                        placeholder="Business"
                    />
                </div>
                <div>
                    <FieldLabel
                        htmlFor="form-jurisdictions"
                        className="text-sm text-gray-600"
                    >
                        Written for
                    </FieldLabel>
                    <SettingsTextInput
                        id="form-jurisdictions"
                        type="text"
                        value={draft.jurisdictions}
                        disabled={disabled}
                        onChange={(event) =>
                            set({ jurisdictions: event.target.value })
                        }
                        placeholder="Kansas, Missouri"
                    />
                </div>
            </div>

            <div>
                <FieldLabel
                    htmlFor="form-description"
                    className="text-sm text-gray-600"
                >
                    When to use it, and when not to
                </FieldLabel>
                <textarea
                    id="form-description"
                    value={draft.description}
                    disabled={disabled}
                    onChange={(event) =>
                        set({ description: event.target.value })
                    }
                    rows={2}
                    className={cn(
                        "min-h-16 resize-y py-2.5 leading-relaxed",
                        SETTINGS_CONTROL_CLASS,
                    )}
                />
            </div>

            <div>
                <FieldLabel
                    htmlFor="form-guidance"
                    className="text-sm text-gray-600"
                >
                    Notes for Mike when it drafts from this
                </FieldLabel>
                <textarea
                    id="form-guidance"
                    value={draft.draftingGuidance}
                    disabled={disabled}
                    onChange={(event) =>
                        set({ draftingGuidance: event.target.value })
                    }
                    rows={4}
                    placeholder={
                        draft.usageMode === "precedent"
                            ? "Paragraphs 12 to 14 are the firm's standard wording and carry over word for word. The buy-sell section is deal-specific and should be rewritten."
                            : "Never alter paragraphs 7 to 9. Change only the blanks."
                    }
                    className={cn(
                        "min-h-24 resize-y py-2.5 leading-relaxed",
                        SETTINGS_CONTROL_CLASS,
                    )}
                />
            </div>

            {draft.usageMode === "fill" && (
                <div className="space-y-3 border-t border-gray-100 pt-5">
                    <div>
                        <h4 className="text-sm font-medium text-gray-900">
                            The blanks
                        </h4>
                        <p className="mt-1 text-xs text-gray-500">
                            Anything set to ask is asked for and never made up.
                        </p>
                    </div>
                    {draft.requiredFields.map((field, index) => (
                        <div
                            key={`${field.key}-${index}`}
                            className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_1fr_auto]"
                        >
                            <div>
                                <FieldLabel
                                    htmlFor={`field-label-${index}`}
                                    className="text-xs text-gray-500"
                                >
                                    What it is
                                </FieldLabel>
                                <SettingsTextInput
                                    id={`field-label-${index}`}
                                    type="text"
                                    value={field.label}
                                    disabled={disabled}
                                    onChange={(event) => {
                                        const next = [...draft.requiredFields];
                                        next[index] = {
                                            ...field,
                                            label: event.target.value,
                                        };
                                        set({ requiredFields: next });
                                    }}
                                    placeholder="Client full name"
                                />
                            </div>
                            <div>
                                <FieldLabel
                                    as="span"
                                    className="text-xs text-gray-500"
                                >
                                    Where the answer comes from
                                </FieldLabel>
                                <ModalSelect
                                    id={`field-source-${index}`}
                                    value={field.source}
                                    options={SOURCE_OPTIONS}
                                    disabled={disabled}
                                    onChange={(value) => {
                                        const next = [...draft.requiredFields];
                                        next[index] = {
                                            ...field,
                                            source: value as FormFieldSource,
                                        };
                                        set({ requiredFields: next });
                                    }}
                                />
                            </div>
                            <button
                                type="button"
                                disabled={disabled}
                                onClick={() =>
                                    set({
                                        requiredFields:
                                            draft.requiredFields.filter(
                                                (_, other) => other !== index,
                                            ),
                                    })
                                }
                                className="mb-1 flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-red-500 transition-colors hover:bg-red-500/10"
                            >
                                <Trash2 className="h-3.5 w-3.5" />
                                Remove
                            </button>
                        </div>
                    ))}
                    <PillButton
                        tone="white"
                        size="sm"
                        disabled={disabled}
                        onClick={() =>
                            set({
                                requiredFields: [
                                    ...draft.requiredFields,
                                    {
                                        key: `field_${draft.requiredFields.length + 1}`,
                                        label: "",
                                        source: "ask",
                                    },
                                ],
                            })
                        }
                    >
                        <Plus className="h-3.5 w-3.5" />
                        Add a blank
                    </PillButton>
                </div>
            )}
        </div>
    );
}

export function FormBankSection({
    onError,
}: {
    onError: (message: string) => void;
}) {
    const [forms, setForms] = useState<FirmForm[]>([]);
    const [loading, setLoading] = useState(true);
    const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
    const [editingId, setEditingId] = useState<string | null>(null);
    const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
    const [saving, setSaving] = useState(false);
    const [pendingRemoval, setPendingRemoval] = useState<FirmForm | null>(null);
    const [removeStatus, setRemoveStatus] = useState<
        "idle" | "loading" | "complete"
    >("idle");

    // Adding one
    const [adding, setAdding] = useState(false);
    const [templates, setTemplates] = useState<
        { id: string; filename: string }[]
    >([]);
    const [chosenDocument, setChosenDocument] = useState("");
    const [suggesting, setSuggesting] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            setForms(await getFirmForms());
        } catch (error) {
            onError(
                errorMessage(error, "Could not load the firm's form bank."),
            );
        } finally {
            setLoading(false);
        }
    }, [onError]);

    useEffect(() => {
        void load();
    }, [load]);

    const banked = useMemo(
        () => new Set(forms.map((form) => form.document_id)),
        [forms],
    );

    const groups = useMemo(() => {
        const map = new Map<string, FirmForm[]>();
        for (const form of forms) {
            const list = map.get(form.document_type);
            if (list) list.push(form);
            else map.set(form.document_type, [form]);
        }
        return Array.from(map.entries());
    }, [forms]);

    async function openAdd() {
        setAdding(true);
        setEditingId(null);
        setDraft(EMPTY_DRAFT);
        setChosenDocument("");
        try {
            const results = await searchLibraryDocuments(
                "templates",
                { limit: 200 },
                "firm",
            );
            setTemplates(
                results.documents.map((document) => ({
                    id: document.id,
                    filename: document.filename,
                })),
            );
        } catch (error) {
            onError(
                errorMessage(
                    error,
                    "Could not list the firm's templates to choose from.",
                ),
            );
        }
    }

    async function handleSuggest() {
        if (!chosenDocument) return;
        setSuggesting(true);
        try {
            const proposal = await suggestFirmFormNotes(chosenDocument);
            setDraft({
                title: proposal.title,
                documentType: typeLabel(proposal.document_type),
                usageMode: proposal.usage_mode,
                variantNotes: proposal.variant_notes,
                description: proposal.description,
                draftingGuidance: proposal.drafting_guidance,
                practice: proposal.practice,
                jurisdictions: proposal.jurisdictions.join(", "),
                requiredFields: proposal.required_fields,
                status: "draft",
            });
        } catch (error) {
            onError(
                errorMessage(
                    error,
                    "Mike could not read that document. Fill the notes in by hand.",
                ),
            );
        } finally {
            setSuggesting(false);
        }
    }

    async function handleSave() {
        setSaving(true);
        try {
            if (editingId) {
                const updated = await updateFirmForm(
                    editingId,
                    draftToInput(draft),
                );
                setForms((current) =>
                    current.map((form) =>
                        form.id === updated.id ? updated : form,
                    ),
                );
                setEditingId(null);
            } else {
                const created = await addFirmForm(
                    chosenDocument,
                    draftToInput(draft),
                );
                setForms((current) => [...current, created]);
                setAdding(false);
            }
            setDraft(EMPTY_DRAFT);
        } catch (error) {
            onError(errorMessage(error, "Those notes did not save."));
        } finally {
            setSaving(false);
        }
    }

    async function confirmRemove() {
        const pending = pendingRemoval;
        if (!pending || removeStatus === "loading") return;
        setRemoveStatus("loading");
        try {
            await removeFirmForm(pending.id);
            setForms((current) =>
                current.filter((form) => form.id !== pending.id),
            );
            if (editingId === pending.id) setEditingId(null);
            setRemoveStatus("complete");
            setTimeout(() => {
                setPendingRemoval(null);
                setRemoveStatus("idle");
            }, 650);
        } catch (error) {
            setRemoveStatus("idle");
            onError(
                errorMessage(error, "That entry could not be taken off the list."),
            );
        }
    }

    const canSave =
        draft.title.trim().length > 0 &&
        draft.documentType.trim().length > 0 &&
        (editingId !== null || chosenDocument.length > 0);

    const templateOptions = templates
        .filter((template) => !banked.has(template.id))
        .map((template) => ({
            value: template.id,
            label: template.filename,
        }));

    return (
        <section className="space-y-3">
            <div className="flex items-end justify-between gap-4">
                <div>
                    <h2 className="text-2xl font-medium font-serif text-gray-900">
                        The firm&apos;s form bank
                    </h2>
                    <p className="mt-1 text-sm text-gray-500">
                        The firm&apos;s own model documents, written up so Mike
                        can start a draft from the right one on its own. Nobody
                        has to go and find the file.
                    </p>
                </div>
                {!adding && !editingId && (
                    <PillButton tone="black" size="sm" onClick={() => void openAdd()}>
                        <Plus className="h-4 w-4 shrink-0" />
                        Bank a document
                    </PillButton>
                )}
            </div>

            <SettingsSection>
                {adding || editingId ? (
                    <div className="space-y-6 p-4">
                        {!editingId && (
                            <div className="space-y-3">
                                <div>
                                    <FieldLabel
                                        as="span"
                                        className="text-sm text-gray-600"
                                    >
                                        Which of the firm&apos;s templates
                                    </FieldLabel>
                                    <ModalSelect
                                        id="form-document"
                                        value={chosenDocument}
                                        options={templateOptions}
                                        placeholder={
                                            templateOptions.length
                                                ? "Choose a template"
                                                : "The firm library has no templates left to bank"
                                        }
                                        onChange={setChosenDocument}
                                    />
                                    <p className="mt-1 text-xs text-gray-500">
                                        Only templates on the firm&apos;s
                                        library shelves can go in the bank. Add
                                        one from the Library page first if it is
                                        not here.
                                    </p>
                                </div>
                                <PillButton
                                    tone="white"
                                    size="sm"
                                    disabled={!chosenDocument || suggesting}
                                    onClick={() => void handleSuggest()}
                                >
                                    {suggesting ? (
                                        <>
                                            <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                                            Reading it...
                                        </>
                                    ) : (
                                        "Read it and suggest the notes"
                                    )}
                                </PillButton>
                                <p className="text-xs text-gray-500">
                                    Mike reads the document and fills the notes
                                    in below as a starting point. Nothing is
                                    saved until you check them and press Save.
                                </p>
                            </div>
                        )}

                        <NotesForm
                            draft={draft}
                            onChange={setDraft}
                            disabled={saving}
                        />

                        <div className="flex items-center justify-end gap-3 border-t border-gray-100 pt-4">
                            <PillButton
                                tone="white"
                                size="normal"
                                onClick={() => {
                                    setAdding(false);
                                    setEditingId(null);
                                    setDraft(EMPTY_DRAFT);
                                }}
                            >
                                Cancel
                            </PillButton>
                            <PillButton
                                tone="black"
                                size="normal"
                                disabled={!canSave || saving}
                                onClick={() => void handleSave()}
                            >
                                {saving ? (
                                    <>
                                        <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
                                        Saving...
                                    </>
                                ) : (
                                    "Save"
                                )}
                            </PillButton>
                        </div>
                    </div>
                ) : loading ? (
                    <div className="space-y-2 p-4">
                        {[0, 1].map((row) => (
                            <div
                                key={row}
                                className="h-10 w-full animate-pulse rounded-lg bg-gray-100"
                            />
                        ))}
                    </div>
                ) : forms.length === 0 ? (
                    <p className="p-4 text-sm text-gray-500">
                        Nothing is banked yet. Put a template on the firm&apos;s
                        library shelves, then bank it here and Mike will start
                        from it when somebody asks for that kind of document.
                    </p>
                ) : (
                    <ul className="divide-y divide-gray-100">
                        {groups.map(([type, entries]) => {
                            const open = openGroups[type] !== false;
                            return (
                                <li key={type}>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            setOpenGroups((current) => ({
                                                ...current,
                                                [type]: !open,
                                            }))
                                        }
                                        className="flex w-full items-center gap-2 px-4 py-3 text-left transition-colors hover:bg-gray-50"
                                    >
                                        {open ? (
                                            <ChevronDown className="h-4 w-4 shrink-0 text-gray-400" />
                                        ) : (
                                            <ChevronRight className="h-4 w-4 shrink-0 text-gray-400" />
                                        )}
                                        <span className="text-sm font-medium text-gray-900">
                                            {typeLabel(type)}
                                        </span>
                                        <span className="text-xs text-gray-500">
                                            {entries.length === 1
                                                ? "1 version"
                                                : `${entries.length} versions`}
                                        </span>
                                    </button>
                                    {open && (
                                        <ul className="border-t border-gray-100">
                                            {entries.map((form) => (
                                                <li
                                                    key={form.id}
                                                    className="flex items-center justify-between gap-4 py-3 pl-10 pr-4"
                                                >
                                                    <button
                                                        type="button"
                                                        onClick={() => {
                                                            setEditingId(form.id);
                                                            setAdding(false);
                                                            setDraft({
                                                                ...draftFrom(form),
                                                                documentType:
                                                                    typeLabel(
                                                                        form.document_type,
                                                                    ),
                                                            });
                                                        }}
                                                        className="min-w-0 flex-1 text-left"
                                                    >
                                                        <p className="truncate text-sm text-gray-900">
                                                            {form.title}
                                                        </p>
                                                        <p className="mt-0.5 truncate text-xs text-gray-500">
                                                            {[
                                                                form.usage_mode ===
                                                                "fill"
                                                                    ? "Fill-in form"
                                                                    : "Precedent",
                                                                form.status ===
                                                                "approved"
                                                                    ? "Approved"
                                                                    : "Draft — not offered yet",
                                                                form.jurisdictions.join(
                                                                    "/",
                                                                ) || null,
                                                                form.variant_notes,
                                                            ]
                                                                .filter(Boolean)
                                                                .join(" · ")}
                                                        </p>
                                                    </button>
                                                    <button
                                                        type="button"
                                                        onClick={() =>
                                                            setPendingRemoval(form)
                                                        }
                                                        className="flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-red-500 transition-colors hover:bg-red-500/10"
                                                    >
                                                        <Trash2 className="h-3.5 w-3.5" />
                                                        Take out of the bank
                                                    </button>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </SettingsSection>

            <ConfirmPopup
                open={!!pendingRemoval}
                title="Take this out of the form bank?"
                message={
                    <p>
                        <span className="font-medium text-gray-950">
                            {pendingRemoval?.title || "This entry"}
                        </span>{" "}
                        stops being offered when anyone drafts. The document
                        itself stays on the firm&apos;s library shelves.
                    </p>
                }
                confirmLabel="Take it out"
                confirmStatus={removeStatus}
                onConfirm={() => void confirmRemove()}
                onCancel={() => {
                    if (removeStatus === "loading") return;
                    setPendingRemoval(null);
                    setRemoveStatus("idle");
                }}
            />
        </section>
    );
}
