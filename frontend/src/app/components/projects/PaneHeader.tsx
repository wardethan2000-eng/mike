"use client";

import type { ReactNode } from "react";
import { GripVertical } from "lucide-react";
import type { PaneId } from "@/app/hooks/useProjectChatLayout";

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
    hoverPane,
    onStartDrag,
}: {
    paneId: PaneId;
    label: string;
    /** Fills the middle of the strip — a title, or the document tab bar. */
    children?: ReactNode;
    actions?: ReactNode;
    draggingPane: PaneId | null;
    hoverPane: PaneId | null;
    onStartDrag: (pane: PaneId) => void;
}) {
    const isDropTarget = hoverPane === paneId && draggingPane !== paneId;

    return (
        <div
            data-pane-header={paneId}
            className="relative h-10 flex items-stretch border-b border-gray-200 shrink-0 min-w-0"
        >
            <div
                onMouseDown={(e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    onStartDrag(paneId);
                }}
                title={`Drag to move the ${label.toLowerCase()} panel`}
                className={`flex items-center px-2 shrink-0 transition-colors ${
                    draggingPane === paneId
                        ? "cursor-grabbing text-gray-600"
                        : "cursor-grab text-gray-300 hover:text-gray-600"
                }`}
            >
                <GripVertical className="h-3.5 w-3.5" />
            </div>

            <div className="flex-1 min-w-0 flex items-stretch">{children}</div>

            {actions && (
                <div className="flex items-center gap-1 px-2 shrink-0">
                    {actions}
                </div>
            )}

            {isDropTarget && (
                <div className="absolute inset-0 z-20 flex items-center justify-center bg-blue-50/90 border-2 border-dashed border-blue-400 pointer-events-none">
                    <span className="text-xs font-medium text-blue-600">
                        Drop to move here
                    </span>
                </div>
            )}
        </div>
    );
}
