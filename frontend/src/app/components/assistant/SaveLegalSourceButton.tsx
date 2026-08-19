"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { BookmarkPlus, Check, Loader2, X } from "lucide-react";
import { PillButton } from "@/app/components/ui/pill-button";
import { ProjectPickerModal } from "@/app/components/modals/ProjectPickerModal";
import {
    listProjects,
    listSavedLegalSources,
    saveLegalSource,
} from "@/app/lib/mikeApi";
import type { Project } from "../shared/types";

/** A case or statute the assistant pulled, in the shape the save API wants. */
export type LegalSourceRef =
    | {
          kind: "case";
          clusterId: number;
          caseName?: string | null;
          citation?: string | null;
          dateFiled?: string | null;
          url?: string | null;
          pdfUrl?: string | null;
      }
    | { kind: "legislation"; legId: string };

const LAST_MATTER_KEY = "mike.legalSource.lastProjectId";

/** What each matter already has filed, so a page full of sources asks once
 *  rather than once per button. Cleared whenever something new is saved. */
const savedByMatter = new Map<string, Promise<Set<string>>>();

function savedKey(kind: string, ref: string) {
    return `${kind}:${ref}`;
}

/** Must match the server's normalizeLegId, or the lookup never matches. */
function normalizeLegId(label: string) {
    return label.trim().replace(/\s+/g, " ").toUpperCase();
}

function loadSaved(projectId: string): Promise<Set<string>> {
    const cached = savedByMatter.get(projectId);
    if (cached) return cached;
    const pending = listSavedLegalSources(projectId)
        .then(
            (rows) =>
                new Set(rows.map((row) => savedKey(row.kind, row.ref))),
        )
        .catch(() => {
            // Not knowing is harmless: the button just offers to save, and
            // saving something already filed is handled server-side.
            savedByMatter.delete(projectId);
            return new Set<string>();
        });
    savedByMatter.set(projectId, pending);
    return pending;
}

/** Which matter and chat the user is looking at, read off the address bar so
 *  no chat component has to pass it down. */
export function useChatLocation(): {
    projectId: string | null;
    chatId: string | null;
} {
    const pathname = usePathname() ?? "";
    return useMemo(
        () => ({
            projectId: /^\/projects\/([^/]+)/.exec(pathname)?.[1] ?? null,
            chatId: /\/chat\/([^/]+)/.exec(pathname)?.[1] ?? null,
        }),
        [pathname],
    );
}

type SaveState = "idle" | "saving" | "saved" | "exists";

export function SaveLegalSourceButton({
    source,
    compact = false,
    variant = "pill",
}: {
    source: LegalSourceRef;
    compact?: boolean;
    /** "pill" sits in the reading panel's button row; "icon" is the small
     *  bookmark on a row in the sources list under an answer. */
    variant?: "pill" | "icon";
}) {
    const { projectId, chatId } = useChatLocation();
    const [state, setState] = useState<SaveState>("idle");
    const [error, setError] = useState<string | null>(null);
    const [pickerOpen, setPickerOpen] = useState(false);
    const [projects, setProjects] = useState<Project[]>([]);
    const [projectsLoading, setProjectsLoading] = useState(false);
    const [chosenProjectId, setChosenProjectId] = useState<string | null>(null);

    // A different source in the same panel starts over. Reset while rendering
    // rather than in an effect, so the button never shows the last source's
    // state.
    const sourceKey =
        source.kind === "case" ? `case:${source.clusterId}` : `leg:${source.legId}`;
    const savedLookupKey =
        source.kind === "case"
            ? savedKey("case", String(Math.floor(source.clusterId)))
            : savedKey("legislation", normalizeLegId(source.legId));
    const [trackedKey, setTrackedKey] = useState(sourceKey);
    if (trackedKey !== sourceKey) {
        setTrackedKey(sourceKey);
        setState("idle");
        setError(null);
    }

    // Show a source that is already in the matter as filed, including after
    // a reload — otherwise it looks unsaved and invites a pointless click.
    useEffect(() => {
        if (!projectId) return;
        let cancelled = false;
        void loadSaved(projectId).then((saved) => {
            if (cancelled) return;
            if (saved.has(savedLookupKey)) setState("exists");
        });
        return () => {
            cancelled = true;
        };
    }, [projectId, savedLookupKey]);

    // Low-impact failures shouldn't stick around.
    useEffect(() => {
        if (!error) return;
        const timer = setTimeout(() => setError(null), 10000);
        return () => clearTimeout(timer);
    }, [error]);

    const save = useCallback(
        async (targetProjectId: string) => {
            if (source.kind === "legislation" && !chatId) {
                setError(
                    "Open this statute from the conversation that found it, then save.",
                );
                return;
            }
            setState("saving");
            setError(null);
            try {
                const result = await saveLegalSource(targetProjectId, {
                    ...(source.kind === "case"
                        ? {
                              kind: "case" as const,
                              cluster_id: source.clusterId,
                              case_name: source.caseName ?? null,
                              citation: source.citation ?? null,
                              date_filed: source.dateFiled ?? null,
                              url: source.url ?? null,
                              pdf_url: source.pdfUrl ?? null,
                          }
                        : {
                              kind: "legislation" as const,
                              leg_id: source.legId,
                              chat_id: chatId as string,
                          }),
                });
                setState(result.status === "exists" ? "exists" : "saved");
                savedByMatter.delete(targetProjectId);
                try {
                    window.localStorage.setItem(
                        LAST_MATTER_KEY,
                        targetProjectId,
                    );
                } catch {
                    // Private browsing: remembering the last matter is a nicety.
                }
            } catch (reason) {
                setState("idle");
                setError(
                    reason instanceof Error && reason.message
                        ? reason.message
                        : "Could not save this source.",
                );
            }
        },
        [chatId, source],
    );

    const openPicker = useCallback(() => {
        setPickerOpen(true);
        if (projects.length) return;
        setProjectsLoading(true);
        void listProjects()
            .then((rows) => {
                setProjects(rows);
                let remembered: string | null = null;
                try {
                    remembered = window.localStorage.getItem(LAST_MATTER_KEY);
                } catch {
                    remembered = null;
                }
                if (remembered && rows.some((row) => row.id === remembered)) {
                    setChosenProjectId(remembered);
                }
            })
            .catch(() => setError("Could not load your matters."))
            .finally(() => setProjectsLoading(false));
    }, [projects.length]);

    const handleClick = () => {
        if (state === "saving" || state === "saved" || state === "exists") return;
        if (projectId) {
            void save(projectId);
        } else {
            openPicker();
        }
    };

    const done = state === "saved" || state === "exists";
    const label = done
        ? state === "exists"
            ? "In Law"
            : "Saved to Law"
        : "Save to Law";
    const title = done
        ? state === "exists"
            ? "This source is already in the matter's Law folder"
            : "Saved to the matter's Law folder"
        : "Save this source to the matter's Law folder";

    const icon =
        state === "saving" ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : done ? (
            <Check className="h-3.5 w-3.5" />
        ) : (
            <BookmarkPlus className="h-3.5 w-3.5" />
        );

    return (
        <>
            {variant === "icon" ? (
                <button
                    type="button"
                    onClick={handleClick}
                    aria-label={label}
                    title={title}
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-700 disabled:cursor-default disabled:text-emerald-600 disabled:hover:bg-transparent"
                    disabled={done || state === "saving"}
                >
                    {icon}
                </button>
            ) : (
                <PillButton
                    tone="white"
                    onClick={handleClick}
                    disabled={done || state === "saving"}
                    title={title}
                    className={compact ? "h-8 w-8 px-0 py-0" : undefined}
                >
                    {icon}
                    <span className={compact ? "sr-only" : undefined}>
                        {label}
                    </span>
                </PillButton>
            )}

            {error && (
                <span className="inline-flex items-center gap-1 rounded-md bg-red-50 px-2 py-1 text-xs text-red-700">
                    {error}
                    <button
                        type="button"
                        onClick={() => setError(null)}
                        aria-label="Dismiss"
                        className="rounded p-0.5 hover:bg-red-100"
                    >
                        <X className="h-3 w-3" />
                    </button>
                </span>
            )}

            <ProjectPickerModal
                open={pickerOpen}
                onClose={() => setPickerOpen(false)}
                projects={projects}
                loading={projectsLoading}
                selectedId={chosenProjectId}
                onSelect={setChosenProjectId}
                breadcrumbs={["Save to a matter"]}
                primaryAction={{
                    label: "Save to Law",
                    disabled: !chosenProjectId,
                    onClick: () => {
                        if (!chosenProjectId) return;
                        setPickerOpen(false);
                        void save(chosenProjectId);
                    },
                }}
            />
        </>
    );
}
