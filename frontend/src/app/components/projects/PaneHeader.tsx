"use client";

import type { ReactNode } from "react";
import { GripVertical } from "lucide-react";
import type { PaneId } from "@/app/hooks/useProjectChatLayout";

export const PANE_DRAG_TYPE = "application/mike-pane";

/**
 * The strip along the top of a panel. Its handle can be dragged onto another
 * panel's strip to swap the two panels around.
 */
export function PaneHeader({
    paneId,
    label,
    children,
    actions,
    draggingPane,
    onDragStateChange,
    onDropPane,
}: {
    paneId: PaneId;
    label: string;
    /** Fills the middle of the strip — a title, or the document tab bar. */
    children?: ReactNode;
    actions?: ReactNode;
    draggingPane: PaneId | null;
    onDragStateChange: (pane: PaneId | null) => void;
    onDropPane: (moved: PaneId, target: PaneId) => void;
}) {
    const isTarget = draggingPane !== null && draggingPane !== paneId;

    return (
        <div
            className="relative h-10 flex items-stretch border-b border-gray-200 shrink-0 min-w-0"
            onDragOver={(e) => {
                if (!isTarget) return;
                if (!e.dataTransfer.types.includes(PANE_DRAG_TYPE)) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
            }}
            onDrop={(e) => {
                if (!isTarget) return;
                const moved = e.dataTransfer.getData(PANE_DRAG_TYPE);
                if (!moved) return;
                e.preventDefault();
                e.stopPropagation();
                onDropPane(moved as PaneId, paneId);
                onDragStateChange(null);
            }}
        >
            <div
                draggable
                onDragStart={(e) => {
                    e.dataTransfer.setData(PANE_DRAG_TYPE, paneId);
                    e.dataTransfer.effectAllowed = "move";
                    onDragStateChange(paneId);
                }}
                onDragEnd={() => onDragStateChange(null)}
                title={`Drag to move the ${label.toLowerCase()} panel`}
                className="flex items-center px-2 shrink-0 cursor-grab active:cursor-grabbing text-gray-300 hover:text-gray-600 transition-colors"
            >
                <GripVertical className="h-3.5 w-3.5" />
            </div>

            <div className="flex-1 min-w-0 flex items-stretch">{children}</div>

            {actions && (
                <div className="flex items-center gap-1 px-2 shrink-0">
                    {actions}
                </div>
            )}

            {isTarget && (
                <div className="absolute inset-0 z-20 flex items-center justify-center bg-blue-50/90 border-2 border-dashed border-blue-400 pointer-events-none">
                    <span className="text-xs font-medium text-blue-600">
                        Drop to move here
                    </span>
                </div>
            )}
        </div>
    );
}
