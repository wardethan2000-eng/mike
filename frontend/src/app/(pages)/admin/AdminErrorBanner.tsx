"use client";

import { X } from "lucide-react";

export function AdminErrorBanner({
    message,
    onDismiss,
}: {
    message: string | null;
    onDismiss: () => void;
}) {
    if (!message) return null;

    return (
        <div
            role="alert"
            className="flex items-start justify-between gap-3 rounded-xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-red-700"
        >
            <span className="min-w-0">{message}</span>
            <button
                type="button"
                onClick={onDismiss}
                aria-label="Dismiss"
                className="shrink-0 rounded p-0.5 text-red-500 transition-colors hover:text-red-700"
            >
                <X className="h-4 w-4" />
            </button>
        </div>
    );
}
