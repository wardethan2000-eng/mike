"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { PillButton } from "@/app/components/ui/pill-button";
import { FieldLabel } from "@/app/components/ui/form-field";
import {
    SETTINGS_CONTROL_CLASS,
    SettingsTextInput,
} from "@/app/components/settings/SettingsTextInput";
import { ModalSelect } from "@/app/components/modals/ModalSelect";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { cn } from "@/app/lib/utils";
import {
    getFirm,
    getFirmWorkflows,
    removeFirmWorkflow,
    updateFirm,
    type Firm,
    type FirmDraftingDefaults,
    type FirmWorkflow,
} from "@/app/lib/mikeApi";
import { SettingsSection } from "../../settings/SettingsSection";
import { AdminErrorBanner } from "../AdminErrorBanner";
import { errorMessage, formatDate } from "../adminHelpers";

const NOT_SET = "__not_set__";
const MAX_INSTRUCTIONS = 4000;

const SPACING_OPTIONS = [
    { value: NOT_SET, label: "Not set" },
    { value: "single", label: "Single" },
    { value: "1.5", label: "One and a half" },
    { value: "double", label: "Double" },
];

export default function AdminContentPage() {
    const [firm, setFirm] = useState<Firm | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    const [instructions, setInstructions] = useState("");
    const [font, setFont] = useState("");
    const [fontSize, setFontSize] = useState("");
    const [spacing, setSpacing] = useState(NOT_SET);
    const [styleNotes, setStyleNotes] = useState("");

    const [workflows, setWorkflows] = useState<FirmWorkflow[]>([]);
    const [workflowsLoading, setWorkflowsLoading] = useState(true);
    const [pendingRemoval, setPendingRemoval] = useState<FirmWorkflow | null>(
        null,
    );
    const [removeStatus, setRemoveStatus] = useState<
        "idle" | "loading" | "complete"
    >("idle");

    const applyFirm = useCallback((loaded: Firm) => {
        setFirm(loaded);
        setInstructions(loaded.standing_instructions ?? "");
        const style = loaded.drafting_defaults ?? {};
        setFont(style.font ?? "");
        setFontSize(style.font_size_pt ? String(style.font_size_pt) : "");
        setSpacing(style.line_spacing ?? NOT_SET);
        setStyleNotes(style.paragraph_style_notes ?? "");
    }, []);

    const loadFirm = useCallback(async () => {
        setLoading(true);
        try {
            applyFirm(await getFirm());
        } catch (loadError) {
            setError(
                errorMessage(loadError, "Could not load the firm's settings."),
            );
        } finally {
            setLoading(false);
        }
    }, [applyFirm]);

    const loadWorkflows = useCallback(async () => {
        setWorkflowsLoading(true);
        try {
            setWorkflows(await getFirmWorkflows());
        } catch (loadError) {
            setError(
                errorMessage(
                    loadError,
                    "Could not load the firm's workflows.",
                ),
            );
        } finally {
            setWorkflowsLoading(false);
        }
    }, []);

    useEffect(() => {
        void loadFirm();
        void loadWorkflows();
    }, [loadFirm, loadWorkflows]);

    async function handleSave() {
        setSaving(true);
        setError(null);
        try {
            const size = Number.parseFloat(fontSize);
            const style: FirmDraftingDefaults = {};
            if (font.trim()) style.font = font.trim();
            if (Number.isFinite(size) && size > 0) style.font_size_pt = size;
            if (spacing !== NOT_SET) {
                style.line_spacing =
                    spacing as FirmDraftingDefaults["line_spacing"];
            }
            if (styleNotes.trim()) {
                style.paragraph_style_notes = styleNotes.trim();
            }

            const updated = await updateFirm({
                standing_instructions: instructions.trim() || null,
                drafting_defaults: Object.keys(style).length ? style : null,
            });
            applyFirm(updated);
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        } catch (saveError) {
            setError(errorMessage(saveError, "Those settings did not save."));
        } finally {
            setSaving(false);
        }
    }

    async function confirmRemoveWorkflow() {
        const pending = pendingRemoval;
        if (!pending || removeStatus === "loading") return;
        setRemoveStatus("loading");
        try {
            await removeFirmWorkflow(pending.id);
            setWorkflows((current) =>
                current.filter((item) => item.id !== pending.id),
            );
            setRemoveStatus("complete");
            setTimeout(() => {
                setPendingRemoval(null);
                setRemoveStatus("idle");
            }, 650);
        } catch (removeError) {
            setRemoveStatus("idle");
            setError(
                errorMessage(
                    removeError,
                    "That workflow could not be taken off the list.",
                ),
            );
        }
    }

    const tooLong = instructions.length > MAX_INSTRUCTIONS;

    return (
        <div className="space-y-8">
            <AdminErrorBanner
                message={error}
                onDismiss={() => setError(null)}
            />

            <section className="space-y-3">
                <h2 className="text-2xl font-medium font-serif text-gray-900">
                    What Mike is told on every chat
                </h2>
                <SettingsSection>
                    {loading ? (
                        <div className="space-y-2 p-4">
                            <div className="h-3 w-32 animate-pulse rounded bg-gray-100" />
                            <div className="h-24 w-full animate-pulse rounded-lg bg-gray-100" />
                        </div>
                    ) : !firm ? (
                        <div className="flex flex-col items-start gap-3 p-4">
                            <p className="text-sm text-gray-500">
                                The firm&apos;s settings could not be loaded.
                            </p>
                            <PillButton
                                tone="white"
                                size="sm"
                                onClick={() => void loadFirm()}
                            >
                                Try again
                            </PillButton>
                        </div>
                    ) : (
                        <div className="space-y-6 p-4">
                            <div>
                                <FieldLabel
                                    htmlFor="firm-instructions"
                                    className="text-sm text-gray-600"
                                >
                                    Standing instructions
                                </FieldLabel>
                                <textarea
                                    id="firm-instructions"
                                    value={instructions}
                                    onChange={(event) =>
                                        setInstructions(event.target.value)
                                    }
                                    rows={6}
                                    placeholder={
                                        "We are a Kansas firm; cite Kansas law first.\nAlways spell out party names in full on first use."
                                    }
                                    className={cn(
                                        "min-h-32 resize-y py-2.5 leading-relaxed",
                                        SETTINGS_CONTROL_CLASS,
                                    )}
                                />
                                <p className="mt-1 text-xs text-gray-500">
                                    Sent quietly with every chat anyone at the
                                    firm has. Nobody sees it in the
                                    conversation. Up to{" "}
                                    {MAX_INSTRUCTIONS.toLocaleString()}{" "}
                                    characters
                                    {instructions.length > 0 &&
                                        ` — ${instructions.length.toLocaleString()} used`}
                                    .
                                </p>
                                {tooLong && (
                                    <p className="mt-1 text-xs text-red-600">
                                        That is too long to send with every
                                        chat. Shorten it before saving.
                                    </p>
                                )}
                            </div>

                            <div className="space-y-4 border-t border-gray-100 pt-6">
                                <div>
                                    <h3 className="text-sm font-medium text-gray-900">
                                        House style
                                    </h3>
                                    <p className="mt-1 text-xs text-gray-500">
                                        Used when Mike builds a document from
                                        nothing. When it copies one of the
                                        firm&apos;s own documents instead, that
                                        document&apos;s own look wins.
                                    </p>
                                </div>

                                <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
                                    <div>
                                        <FieldLabel
                                            htmlFor="firm-font"
                                            className="text-sm text-gray-600"
                                        >
                                            Typeface
                                        </FieldLabel>
                                        <SettingsTextInput
                                            id="firm-font"
                                            type="text"
                                            value={font}
                                            onChange={(event) =>
                                                setFont(event.target.value)
                                            }
                                            placeholder="Times New Roman"
                                        />
                                    </div>
                                    <div>
                                        <FieldLabel
                                            htmlFor="firm-font-size"
                                            className="text-sm text-gray-600"
                                        >
                                            Text size (points)
                                        </FieldLabel>
                                        <SettingsTextInput
                                            id="firm-font-size"
                                            type="number"
                                            value={fontSize}
                                            onChange={(event) =>
                                                setFontSize(event.target.value)
                                            }
                                            placeholder="12"
                                        />
                                    </div>
                                    <div>
                                        <FieldLabel
                                            as="span"
                                            className="text-sm text-gray-600"
                                        >
                                            Line spacing
                                        </FieldLabel>
                                        <ModalSelect
                                            id="firm-line-spacing"
                                            value={spacing}
                                            options={SPACING_OPTIONS}
                                            onChange={setSpacing}
                                        />
                                    </div>
                                </div>

                                <div>
                                    <FieldLabel
                                        htmlFor="firm-style-notes"
                                        className="text-sm text-gray-600"
                                    >
                                        Anything else about how documents should
                                        look
                                    </FieldLabel>
                                    <textarea
                                        id="firm-style-notes"
                                        value={styleNotes}
                                        onChange={(event) =>
                                            setStyleNotes(event.target.value)
                                        }
                                        rows={3}
                                        placeholder="Number every paragraph. Put the case caption at the top of court filings."
                                        className={cn(
                                            "min-h-20 resize-y py-2.5 leading-relaxed",
                                            SETTINGS_CONTROL_CLASS,
                                        )}
                                    />
                                </div>
                            </div>

                            <div className="flex items-center justify-end gap-3">
                                {saved && (
                                    <span className="text-xs font-medium text-green-700">
                                        Saved
                                    </span>
                                )}
                                <PillButton
                                    tone="black"
                                    size="normal"
                                    onClick={() => void handleSave()}
                                    disabled={saving || tooLong}
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
                    )}
                </SettingsSection>
            </section>

            <section className="space-y-3">
                <h2 className="text-2xl font-medium font-serif text-gray-900">
                    Workflows the firm has published
                </h2>
                <SettingsSection>
                    {workflowsLoading ? (
                        <div className="space-y-2 p-4">
                            {[0, 1].map((row) => (
                                <div
                                    key={row}
                                    className="h-10 w-full animate-pulse rounded-lg bg-gray-100"
                                />
                            ))}
                        </div>
                    ) : workflows.length === 0 ? (
                        <p className="p-4 text-sm text-gray-500">
                            Nothing has been published to the firm yet. Anyone
                            can publish one of their own workflows from the
                            Workflows page.
                        </p>
                    ) : (
                        <ul className="divide-y divide-gray-100">
                            {workflows.map((workflow) => (
                                <li
                                    key={workflow.id}
                                    className="flex items-center justify-between gap-4 px-4 py-3"
                                >
                                    <div className="min-w-0">
                                        <p className="truncate text-sm text-gray-900">
                                            {workflow.title || "Untitled"}
                                        </p>
                                        <p className="mt-0.5 text-xs text-gray-500">
                                            {[
                                                workflow.type === "tabular"
                                                    ? "Tabular"
                                                    : "Assistant",
                                                workflow.author_name
                                                    ? `by ${workflow.author_name}`
                                                    : null,
                                                formatDate(workflow.created_at),
                                            ]
                                                .filter(Boolean)
                                                .join(" · ")}
                                        </p>
                                    </div>
                                    <button
                                        type="button"
                                        onClick={() =>
                                            setPendingRemoval(workflow)
                                        }
                                        className="flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-red-500 transition-colors hover:bg-red-500/10"
                                    >
                                        <Trash2 className="h-3.5 w-3.5" />
                                        Take off the list
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </SettingsSection>
            </section>

            <ConfirmPopup
                open={!!pendingRemoval}
                title="Take this off the firm's list?"
                message={
                    <p>
                        <span className="font-medium text-gray-950">
                            {pendingRemoval?.title || "This workflow"}
                        </span>{" "}
                        stops being available to everyone at the firm. The
                        person who wrote it keeps their own copy.
                    </p>
                }
                confirmLabel="Take it off"
                confirmStatus={removeStatus}
                onConfirm={() => void confirmRemoveWorkflow()}
                onCancel={() => {
                    if (removeStatus === "loading") return;
                    setPendingRemoval(null);
                    setRemoveStatus("idle");
                }}
            />
        </div>
    );
}
