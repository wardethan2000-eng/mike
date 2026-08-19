"use client";

import { useEffect, useMemo, useState } from "react";
import { Users } from "lucide-react";
import { Modal } from "@/app/components/modals/Modal";
import {
    FieldLabel,
    FormTextInput,
} from "@/app/components/ui/form-field";
import type { Project } from "@/app/components/shared/types";
import { ProjectPracticeField } from "./ProjectPracticeField";
import { OVERVIEW_MAX_CHARS } from "./CaseOverviewPanel";

interface ProjectDetailsModalProps {
    open: boolean;
    project: Project | null;
    canEdit: boolean;
    onClose: () => void;
    onSave: (values: {
        name: string;
        cmNumber: string;
        practice: string;
        overview: string;
    }) => Promise<void>;
    onShareProject?: () => void;
}

export function ProjectDetailsModal({
    open,
    project,
    canEdit,
    onClose,
    onSave,
    onShareProject,
}: ProjectDetailsModalProps) {
    const [nameDraft, setNameDraft] = useState("");
    const [cmDraft, setCmDraft] = useState("");
    const [practiceDraft, setPracticeDraft] = useState("");
    const [overviewDraft, setOverviewDraft] = useState("");
    const [saving, setSaving] = useState(false);
    const [saved, setSaved] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!open || !project) return;
        setNameDraft(project.name);
        setCmDraft(project.cm_number ?? "");
        setPracticeDraft(project.practice ?? "");
        setOverviewDraft(project.overview ?? "");
        setSaved(false);
        setError(null);
    }, [open, project]);

    const trimmedName = nameDraft.trim();
    const trimmedCm = cmDraft.trim();
    const trimmedPractice = practiceDraft.trim();
    const trimmedOverview = overviewDraft.trim();
    const hasChanges = useMemo(() => {
        if (!project) return false;
        return (
            trimmedName !== project.name ||
            trimmedCm !== (project.cm_number ?? "") ||
            trimmedPractice !== (project.practice ?? "") ||
            trimmedOverview !== (project.overview ?? "")
        );
    }, [
        project,
        trimmedCm,
        trimmedName,
        trimmedOverview,
        trimmedPractice,
    ]);

    if (!project) return null;

    async function handleSave() {
        if (!canEdit || saving || !hasChanges || !trimmedName) return;
        setSaving(true);
        setSaved(false);
        setError(null);
        try {
            await onSave({
                name: trimmedName,
                cmNumber: trimmedCm,
                practice:
                    trimmedPractice && trimmedPractice !== "Other"
                        ? trimmedPractice
                        : "",
                overview: trimmedOverview,
            });
            setSaved(true);
        } catch {
            setError("Could not update project details.");
        } finally {
            setSaving(false);
        }
    }

    return (
        <Modal
            open={open}
            onClose={onClose}
            breadcrumbs={["Projects", project.name, "Details"]}
            secondaryAction={
                onShareProject
                    ? {
                          label: "Share Project",
                          icon: <Users className="h-4 w-4" />,
                          onClick: onShareProject,
                      }
                    : undefined
            }
            footerStatus={
                error ? (
                    <span className="text-sm text-red-600">{error}</span>
                ) : saved ? (
                    <span className="text-sm text-gray-400">Updated</span>
                ) : null
            }
            primaryAction={
                canEdit
                    ? {
                          label: saving ? "Updating..." : "Update",
                          onClick: () => void handleSave(),
                          disabled: saving || !hasChanges || !trimmedName,
                      }
                    : undefined
            }
            cancelAction={canEdit ? undefined : false}
        >
            <div className="flex min-h-0 flex-1 flex-col gap-6 py-1">
                <div>
                    <FieldLabel htmlFor="project-details-name">
                        Project name
                    </FieldLabel>
                    <FormTextInput
                        id="project-details-name"
                        value={nameDraft}
                        onChange={(e) => {
                            setNameDraft(e.target.value);
                            setSaved(false);
                            setError(null);
                        }}
                        disabled={!canEdit || saving}
                        placeholder="Add project name"
                        variant="minimal"
                    />
                </div>

                <div>
                    <FieldLabel htmlFor="project-details-cm">
                        CM number
                    </FieldLabel>
                    <FormTextInput
                        id="project-details-cm"
                        value={cmDraft}
                        onChange={(e) => {
                            setCmDraft(e.target.value);
                            setSaved(false);
                            setError(null);
                        }}
                        disabled={!canEdit || saving}
                        placeholder="Add a CM number..."
                        variant="minimal"
                        className="text-xl text-gray-600"
                    />
                </div>

                <div>
                    <FieldLabel htmlFor="project-details-practice">
                        Practice
                    </FieldLabel>
                    <ProjectPracticeField
                        id="project-details-practice"
                        value={practiceDraft}
                        onChange={(value) => {
                            setPracticeDraft(value);
                            setSaved(false);
                            setError(null);
                        }}
                        disabled={!canEdit || saving}
                    />
                </div>

                <div>
                    <div className="flex items-baseline justify-between gap-3">
                        <FieldLabel htmlFor="project-details-overview">
                            Case overview
                        </FieldLabel>
                        {canEdit && (
                            <span className="shrink-0 text-xs tabular-nums text-gray-400">
                                {overviewDraft.length}/{OVERVIEW_MAX_CHARS}
                            </span>
                        )}
                    </div>
                    <p className="mb-2 text-xs text-gray-500">
                        What the assistant should know every time it works on
                        this matter — who you act for, what you are trying to
                        achieve, and how you want documents drafted. It is sent
                        with every question asked here.
                    </p>
                    <textarea
                        id="project-details-overview"
                        value={overviewDraft}
                        onChange={(e) => {
                            setOverviewDraft(e.target.value);
                            setSaved(false);
                            setError(null);
                        }}
                        disabled={!canEdit || saving}
                        maxLength={OVERVIEW_MAX_CHARS}
                        rows={7}
                        placeholder="We act for... The goal is... Draft in..."
                        className="w-full resize-y rounded border border-gray-200 p-3 text-sm leading-relaxed text-gray-800 outline-none placeholder:text-gray-400 focus:border-gray-400 disabled:bg-gray-50"
                    />
                </div>

            </div>
        </Modal>
    );
}
