"use client";

import { Check, ChevronDown, X } from "lucide-react";
import { PillButtonUI, type PillButtonUITone } from "./PillButtonUI";

export interface EditCardUIAction {
    label: string;
    onClick?: () => void;
    disabled?: boolean;
    title?: string;
}

export interface EditCardUIProps {
    originalText?: string;
    replacementText?: string;
    reason?: string;
    changeNumber?: number;
    status?: string;
    statusMessage?: string;
    statusMessageClassName?: string;
    ariaBusy?: boolean;
    className?: string;
    actionOrder?: "resolve-first" | "view-first";
    /**
     * Collapse the card down to a single line saying what happened. Used
     * after an edit is accepted or rejected so the chat stops showing a
     * full proposal card for a change that is already settled.
     */
    collapsed?: boolean;
    /** Called when the one-line summary is clicked to open the card again. */
    onToggleCollapsed?: () => void;
    viewAction?: EditCardUIAction;
    acceptAction?: EditCardUIAction;
    rejectAction?: EditCardUIAction;
}

function ActionButton({
    action,
    tone,
    className = "",
}: {
    action: EditCardUIAction;
    tone: PillButtonUITone;
    className?: string;
}) {
    return (
        <PillButtonUI
            tone={tone}
            onClick={action.onClick}
            disabled={action.disabled}
            title={action.title}
            className={className}
        >
            {action.label}
        </PillButtonUI>
    );
}

/**
 * Platform-neutral tracked-change card. Data loading, authentication, document
 * mutation, and status transitions belong to the host wrapper.
 */
export function EditCardUI({
    originalText,
    replacementText,
    reason,
    changeNumber,
    status,
    statusMessage,
    statusMessageClassName = "",
    ariaBusy = false,
    className = "",
    actionOrder = "resolve-first",
    collapsed = false,
    onToggleCollapsed,
    viewAction,
    acceptAction,
    rejectAction,
}: EditCardUIProps) {
    const hasEditText =
        replacementText !== undefined || originalText !== undefined;
    const hasReplacement =
        replacementText !== undefined && replacementText !== "";
    const hasOriginal = originalText !== undefined && originalText !== "";
    const hasResolveActions = !!acceptAction || !!rejectAction;
    const hasActions = !!viewAction || hasResolveActions;

    if (collapsed) {
        const accepted = status === "accepted";
        const clean = (value?: string) =>
            (value ?? "").replace(/\s+/g, " ").trim();
        // Show whatever text the document is left with: the new wording on an
        // accept, the original wording on a reject. A pure deletion has no new
        // wording, so quote what was taken out and say so.
        const removed = accepted && !hasReplacement;
        const trimmed = accepted
            ? clean(replacementText) || clean(originalText)
            : clean(originalText) || clean(replacementText);
        const label = accepted ? "Accepted" : "Rejected";
        return (
            <div
                className={className}
                data-edit-status={status}
                data-edit-collapsed="true"
            >
                <button
                    type="button"
                    onClick={onToggleCollapsed}
                    aria-expanded={false}
                    aria-label={`${label}${trimmed ? `: ${trimmed}` : ""} — show details`}
                    className="flex w-full min-w-0 items-center gap-2 rounded-lg px-1 py-0.5 text-left text-xs text-gray-500 transition-colors hover:bg-gray-900/5"
                >
                    {accepted ? (
                        <Check className="h-3 w-3 shrink-0 text-green-600" />
                    ) : (
                        <X className="h-3 w-3 shrink-0 text-gray-400" />
                    )}
                    <span className="shrink-0 font-medium text-gray-600">
                        {changeNumber !== undefined
                            ? `${changeNumber}. ${label}`
                            : label}
                    </span>
                    {trimmed && (
                        <span className="min-w-0 flex-1 truncate font-sans text-gray-400">
                            {removed
                                ? `removed \u201C${trimmed}\u201D`
                                : `\u201C${trimmed}\u201D`}
                        </span>
                    )}
                    <ChevronDown className="ml-auto h-3 w-3 shrink-0 text-gray-400" />
                </button>
            </div>
        );
    }

    const resolveActions = hasResolveActions ? (
        <div className="flex gap-2">
            {acceptAction && (
                <ActionButton action={acceptAction} tone="blue" />
            )}
            {rejectAction && (
                <ActionButton action={rejectAction} tone="white" />
            )}
        </div>
    ) : null;

    return (
        <div
            className={className}
            data-edit-status={status}
            aria-busy={ariaBusy || undefined}
        >
            {(changeNumber !== undefined || reason) && (
                <div className="mb-2 flex items-start gap-2">
                    {changeNumber !== undefined && (
                        <span
                            aria-label={`Tracked change ${changeNumber}`}
                            title={`Tracked change ${changeNumber}`}
                            className="inline-flex h-4 w-4 shrink-0 self-center items-center justify-center rounded-full bg-gray-200 text-[9px] font-medium leading-none text-gray-600"
                        >
                            {changeNumber}
                        </span>
                    )}
                    {reason && (
                        <p className="min-w-0 flex-1 font-serif text-sm text-gray-500">
                            {reason}
                        </p>
                    )}
                </div>
            )}

            {hasEditText && (
                <div className="rounded-lg bg-gray-100/70 px-2 py-2 font-sans text-xs leading-relaxed">
                    {hasReplacement && (
                        <span className="text-green-700">
                            {replacementText}
                        </span>
                    )}
                    {hasReplacement && hasOriginal && " "}
                    {hasOriginal && (
                        <span className="text-red-600 line-through">
                            {originalText}
                        </span>
                    )}
                </div>
            )}

            {hasActions && actionOrder === "view-first" && (
                <div
                    className="mt-3 flex items-center justify-between gap-2"
                    role="group"
                    aria-label="Edit actions"
                >
                    {viewAction && (
                        <ActionButton action={viewAction} tone="white" />
                    )}
                    {resolveActions}
                </div>
            )}

            {hasActions && actionOrder === "resolve-first" && (
                <div
                    className="mt-2 flex gap-2"
                    role="group"
                    aria-label="Edit actions"
                >
                    {resolveActions}
                    {viewAction && (
                        <ActionButton
                            action={viewAction}
                            tone="black"
                            className="ml-auto"
                        />
                    )}
                </div>
            )}

            {onToggleCollapsed && !collapsed && (status === "accepted" || status === "rejected") && (
                <button
                    type="button"
                    onClick={onToggleCollapsed}
                    aria-expanded={true}
                    className="mt-2 inline-flex items-center gap-1 text-xs text-gray-400 transition-colors hover:text-gray-600"
                >
                    <ChevronDown className="h-3 w-3 rotate-180" />
                    Hide
                </button>
            )}

            {statusMessage && (
                <p
                    className={`mt-2 text-xs ${statusMessageClassName}`}
                    role="status"
                >
                    {statusMessage}
                </p>
            )}
        </div>
    );
}
