"use client";

import {
    type ReactNode,
    useCallback,
    useEffect,
    useMemo,
    useRef,
    useState,
} from "react";
import { useRouter } from "next/navigation";
import { ChevronDown, ChevronRight, Loader2, Plus, Upload } from "lucide-react";
import {
    getAuditHistory,
    getProject,
    listTabularReviews,
    updateCaseContext,
    uploadProjectDocument,
    type AuditEvent,
    type ProjectMemory,
} from "@/app/lib/mikeApi";
import type { Document, TabularReview } from "@/app/components/shared/types";
import {
    formatUnsupportedDocumentWarning,
    partitionSupportedDocumentFiles,
    SUPPORTED_DOCUMENT_ACCEPT,
} from "@/app/lib/documentUploadValidation";
import {
    daysUntil,
    formatDay,
    formatNearness,
    isPressing,
    upcomingDates,
    type MatterDate,
} from "@/app/lib/matterDates";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { FileTypeIcon } from "@/app/components/shared/FileTypeIcon";
import { Button } from "@/app/components/ui/button";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";
import { CaseInstructionsEditor } from "./CaseOverviewPanel";
import { CaseMemoryList, type SuggestionMode } from "./CaseMemoryList";
import { ProjectSectionToolbar, useProjectWorkspace } from "./ProjectWorkspace";

/**
 * The front page of a matter.
 *
 * Opening a matter used to land on its file list, which said what the matter
 * held but nothing about where it stood. This page answers the two questions
 * anyone actually opens a matter with — what is coming up, and where did we
 * leave off — and puts what the assistant has been told about the case in
 * plain sight rather than behind a panel inside a chat.
 *
 * Three columns divided by hairlines rather than boxed into cards: what Mike
 * knows on the left, asking and recent work in the middle, files and reviews on
 * the right, and the dates the matter is working towards across the top. Each
 * column scrolls on its own so the page itself stays put. On a narrow screen
 * they stack in that order, so a phone still opens on the dates and the
 * question box.
 */

/** How many recent chats, files and reviews each section shows. */
const RECENT_LIMIT = 5;
const DOCUMENT_LIMIT = 6;
const REVIEW_LIMIT = 3;
const ACTIVITY_LIMIT = 12;

function SectionHeading({
    title,
    count,
    actions,
}: {
    title: string;
    count?: number;
    actions?: ReactNode;
}) {
    return (
        <div className="flex items-center gap-2">
            <h3 className="text-xs font-medium text-gray-700">
                {title}
                {count != null && count > 0 ? ` (${count})` : ""}
            </h3>
            <div className="ml-auto flex shrink-0 items-center gap-3">
                {actions}
            </div>
        </div>
    );
}

function SectionLink({
    children,
    onClick,
}: {
    children: ReactNode;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            className="rounded text-xs text-gray-500 transition-colors hover:text-gray-900"
        >
            {children}
        </button>
    );
}

function Hint({ children }: { children: ReactNode }) {
    return <p className="text-xs leading-relaxed text-gray-500">{children}</p>;
}

function relativeDay(iso: string | null | undefined): string {
    if (!iso) return "";
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return "";
    const days = -daysUntil(then);
    if (days <= 0) return "Today";
    if (days === 1) return "Yesterday";
    if (days < 7) return `${days} days ago`;
    return formatDay(then);
}

/**
 * What an entry in the matter's history did, in the words someone reading the
 * page would use. Anything not listed keeps its own name rather than being
 * hidden, so a new kind of event shows up instead of silently vanishing.
 */
function describeEvent(event: AuditEvent): string {
    switch (event.action) {
        case "chat.message":
            return "asked a question";
        case "document.uploaded":
            return "added a document";
        case "document.generated":
            return "produced a document";
        case "document.edited":
            return "edited a document";
        case "document.legal_source_saved":
            return "saved a legal source";
        case "memory.added":
            return "wrote down a fact";
        case "memory.accepted":
            return "kept a fact Mike found";
        case "memory.auto_saved":
            return "remembered a fact Mike found";
        case "memory.edited":
            return "corrected a fact";
        case "memory.replaced":
            return "replaced a fact";
        case "memory.removed":
        case "memory.dismissed":
            return "removed a fact";
        case "memory.pinned":
            return "pinned a fact";
        default:
            return event.action.replace(/[._]/g, " ");
    }
}

export function ProjectOverviewView({ projectId }: { projectId: string }) {
    const router = useRouter();
    const {
        project,
        setProject,
        projectLoading,
        projectChats,
        projectChatsLoading,
        ensureProjectChats,
        createChat,
        creatingChat,
        openNewReview,
    } = useProjectWorkspace();
    const { saveChat, setNewChatMessages } = useChatHistoryContext();

    const [memories, setMemories] = useState<ProjectMemory[]>([]);
    const [reviews, setReviews] = useState<TabularReview[] | null>(null);
    const [activity, setActivity] = useState<AuditEvent[] | null>(null);
    const [activityOpen, setActivityOpen] = useState(false);
    const [question, setQuestion] = useState("");
    const [asking, setAsking] = useState(false);
    const [editingInstructions, setEditingInstructions] = useState(false);
    const [uploading, setUploading] = useState(0);
    const [uploadWarning, setUploadWarning] = useState<string | null>(null);
    const [dragging, setDragging] = useState(false);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        void ensureProjectChats();
    }, [ensureProjectChats]);

    useEffect(() => {
        let cancelled = false;
        listTabularReviews(projectId, { limit: REVIEW_LIMIT })
            .then((loaded) => {
                if (!cancelled) setReviews(loaded);
            })
            .catch(() => {
                if (!cancelled) setReviews([]);
            });
        return () => {
            cancelled = true;
        };
    }, [projectId]);

    // Only asked for once someone opens it — the history is the least of what
    // this page is for, and most visits never look at it.
    useEffect(() => {
        if (!activityOpen) return;
        const controller = new AbortController();
        getAuditHistory({ project: projectId }, controller.signal)
            .then((result) =>
                setActivity(result.events.slice(0, ACTIVITY_LIMIT)),
            )
            .catch(() => {
                // A matter with no history yet, and a history that could not be
                // read, come to the same thing on this page.
                if (!controller.signal.aborted) setActivity([]);
            });
        return () => controller.abort();
    }, [projectId, activityOpen]);

    const handleMemoriesChange = useCallback((next: ProjectMemory[]) => {
        setMemories(next);
    }, []);

    const dates = useMemo<MatterDate[]>(
        () =>
            upcomingDates(
                memories
                    .filter((memory) => memory.category === "dates")
                    .map((memory) => memory.body),
            ),
        [memories],
    );

    const documents = useMemo(() => {
        const all = [...(project?.documents ?? [])];
        all.sort(
            (a, b) =>
                new Date(b.updated_at ?? b.created_at ?? 0).getTime() -
                new Date(a.updated_at ?? a.created_at ?? 0).getTime(),
        );
        return all;
    }, [project?.documents]);

    const suggestionMode: SuggestionMode =
        project?.suggest_facts === false
            ? "off"
            : project?.auto_remember === true
              ? "keep"
              : "ask";

    const handleSuggestionModeChange = useCallback(
        async (mode: SuggestionMode) => {
            const settings = {
                auto_remember: mode === "keep",
                suggest_facts: mode !== "off",
            };
            const before = {
                auto_remember: project?.auto_remember === true,
                suggest_facts: project?.suggest_facts !== false,
            };
            setProject((prev) => (prev ? { ...prev, ...settings } : prev));
            try {
                await updateCaseContext(projectId, settings);
            } catch {
                setProject((prev) => (prev ? { ...prev, ...before } : prev));
            }
        },
        [project?.auto_remember, project?.suggest_facts, projectId, setProject],
    );

    /** Start a chat with the question already asked. */
    async function ask() {
        const content = question.trim();
        if (!content || asking) return;
        setAsking(true);
        try {
            const chatId = await saveChat(projectId);
            if (!chatId) return;
            setNewChatMessages([{ role: "user", content }]);
            setQuestion("");
            router.push(`/projects/${projectId}/assistant/chat/${chatId}`);
        } finally {
            setAsking(false);
        }
    }

    /** Open a document on the Documents tab, beside the file list. */
    const openDocument = useCallback(
        (documentId: string, page?: number | null) => {
            const at = page != null ? `&page=${page}` : "";
            router.push(
                `/projects/${projectId}/documents?open=${encodeURIComponent(documentId)}${at}`,
            );
        },
        [projectId, router],
    );

    async function addFiles(fileList: FileList | null) {
        const files = Array.from(fileList ?? []);
        if (files.length === 0) return;
        const { supported, unsupported } =
            partitionSupportedDocumentFiles(files);
        setUploadWarning(formatUnsupportedDocumentWarning(unsupported));
        if (supported.length === 0) return;
        setUploading(supported.length);
        try {
            for (const file of supported) {
                await uploadProjectDocument(projectId, file);
                setUploading((count) => count - 1);
            }
            const refreshed = await getProject(projectId);
            setProject(refreshed);
        } catch {
            setUploadWarning(
                "Those files could not be added. Try again, or use the Documents tab.",
            );
        } finally {
            setUploading(0);
        }
    }

    const documentsHref = `/projects/${projectId}/documents`;
    const assistantHref = `/projects/${projectId}/assistant`;
    const reviewsHref = `/projects/${projectId}/tabular-reviews`;

    if (!projectLoading && !project) {
        return (
            <div className="flex h-full items-center justify-center">
                <p className="text-gray-400">Project not found</p>
            </div>
        );
    }

    return (
        <>
            <ProjectSectionToolbar />

            <div className="flex min-h-0 flex-1 flex-col">
                {/* Next up ------------------------------------------------ */}
                {dates.length > 0 && (
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-gray-200/70 px-4 pb-3 md:px-8">
                        <span className="text-xs font-medium text-gray-700">
                            Next up
                        </span>
                        {dates.map((entry) => {
                            const pressing = isPressing(entry.date);
                            const nearness = formatNearness(entry.date);
                            return (
                                <span
                                    key={`${entry.body}-${entry.date.toISOString()}`}
                                    title={entry.body}
                                    className="flex items-baseline gap-2 text-xs"
                                >
                                    <span
                                        className={`font-medium ${pressing ? "text-red-700" : "text-gray-800"}`}
                                    >
                                        {entry.label}
                                    </span>
                                    <span
                                        className={`tabular-nums ${pressing ? "text-red-600" : "text-gray-500"}`}
                                    >
                                        {formatDay(entry.date)}
                                        {nearness ? ` · ${nearness}` : ""}
                                    </span>
                                </span>
                            );
                        })}
                    </div>
                )}

                <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,0.95fr)_minmax(0,1.5fr)_minmax(0,1fr)] lg:divide-x lg:divide-gray-200/70 lg:overflow-hidden">
                    {/* What Mike knows ---------------------------------- */}
                    <div className="flex min-h-0 flex-col gap-5 px-4 py-4 md:px-6 lg:overflow-y-auto">
                        <section className="flex flex-col gap-2">
                            <SectionHeading
                                title="Instructions"
                                actions={
                                    <SectionLink
                                        onClick={() =>
                                            setEditingInstructions(
                                                (open) => !open,
                                            )
                                        }
                                    >
                                        {editingInstructions ? "Done" : "Edit"}
                                    </SectionLink>
                                }
                            />
                            {editingInstructions ? (
                                <CaseInstructionsEditor
                                    projectId={projectId}
                                    overview={
                                        project
                                            ? (project.overview ?? null)
                                            : undefined
                                    }
                                    rows={10}
                                    onSaved={(overview) =>
                                        setProject((prev) =>
                                            prev ? { ...prev, overview } : prev,
                                        )
                                    }
                                />
                            ) : project?.overview?.trim() ? (
                                <p className="whitespace-pre-wrap text-sm leading-relaxed text-gray-700">
                                    {project.overview.trim()}
                                </p>
                            ) : (
                                <Hint>
                                    Nothing written yet. Say who you act for,
                                    what the matter is trying to achieve, and
                                    how documents should be laid out — it is
                                    sent with every question asked here.
                                </Hint>
                            )}
                        </section>

                        <section className="-mx-3 flex min-h-[320px] flex-1 flex-col border-t border-gray-200/70 pt-1">
                            <CaseMemoryList
                                projectId={projectId}
                                documents={project?.documents ?? []}
                                suggestionMode={suggestionMode}
                                onSuggestionModeChange={
                                    handleSuggestionModeChange
                                }
                                onMemoriesChange={handleMemoriesChange}
                                onOpenDocument={(documentId, _filename, page) =>
                                    openDocument(documentId, page)
                                }
                            />
                        </section>
                    </div>

                    {/* Asking, and what has been asked ------------------ */}
                    <div className="flex min-h-0 flex-col gap-5 px-4 py-4 md:px-6 lg:overflow-y-auto">
                        <section className="flex flex-col gap-2">
                            <textarea
                                value={question}
                                rows={3}
                                onChange={(event) =>
                                    setQuestion(event.target.value)
                                }
                                onKeyDown={(event) => {
                                    if (
                                        event.key === "Enter" &&
                                        !event.shiftKey
                                    ) {
                                        event.preventDefault();
                                        void ask();
                                    }
                                }}
                                placeholder="Ask about this matter…"
                                className="w-full resize-y rounded-xl border border-gray-200 bg-white/70 p-3 text-sm leading-relaxed text-gray-800 outline-none placeholder:text-gray-400 focus:border-gray-400"
                            />
                            <div className="flex items-center gap-3">
                                <Hint>
                                    Asked of every document in this matter, with
                                    the instructions and facts alongside.
                                </Hint>
                                <div className="ml-auto flex shrink-0 items-center gap-2">
                                    <TabPillButton
                                        onClick={() => void createChat()}
                                        disabled={creatingChat}
                                    >
                                        {creatingChat ? (
                                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        ) : (
                                            <Plus className="h-3.5 w-3.5" />
                                        )}
                                        Empty chat
                                    </TabPillButton>
                                    <Button
                                        size="sm"
                                        onClick={() => void ask()}
                                        disabled={!question.trim() || asking}
                                    >
                                        {asking ? (
                                            <Loader2 className="h-4 w-4 animate-spin" />
                                        ) : (
                                            "Ask"
                                        )}
                                    </Button>
                                </div>
                            </div>
                        </section>

                        <section className="flex flex-col gap-2 border-t border-gray-200/70 pt-4">
                            <SectionHeading
                                title="Recent chats"
                                actions={
                                    <SectionLink
                                        onClick={() =>
                                            router.push(assistantHref)
                                        }
                                    >
                                        See all
                                    </SectionLink>
                                }
                            />
                            {projectChats === null || projectChatsLoading ? (
                                <Hint>Loading…</Hint>
                            ) : projectChats.length === 0 ? (
                                <Hint>
                                    Nothing asked yet. The box above starts the
                                    first one.
                                </Hint>
                            ) : (
                                <ul className="-mx-2 flex flex-col">
                                    {projectChats
                                        .slice(0, RECENT_LIMIT)
                                        .map((chat) => (
                                            <li key={chat.id}>
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        router.push(
                                                            `/projects/${projectId}/assistant/chat/${chat.id}`,
                                                        )
                                                    }
                                                    className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-black/[0.03]"
                                                >
                                                    <span className="min-w-0 flex-1 truncate text-sm text-gray-800">
                                                        {chat.title ||
                                                            "Untitled chat"}
                                                    </span>
                                                    <span className="shrink-0 text-[11px] text-gray-500">
                                                        {relativeDay(
                                                            chat.created_at,
                                                        )}
                                                    </span>
                                                </button>
                                            </li>
                                        ))}
                                </ul>
                            )}
                        </section>

                        {/* The history, kept out of the way ------------- */}
                        <section className="mt-auto flex flex-col gap-2 border-t border-gray-200/70 pt-3">
                            <button
                                type="button"
                                onClick={() => setActivityOpen((open) => !open)}
                                className="flex items-center gap-1 text-xs text-gray-400 transition-colors hover:text-gray-700"
                            >
                                {activityOpen ? (
                                    <ChevronDown className="h-3 w-3" />
                                ) : (
                                    <ChevronRight className="h-3 w-3" />
                                )}
                                Activity in this matter
                            </button>
                            {activityOpen &&
                                (activity === null ? (
                                    <Hint>Loading…</Hint>
                                ) : activity.length === 0 ? (
                                    <Hint>
                                        Nothing has happened in this matter yet.
                                    </Hint>
                                ) : (
                                    <ul className="flex flex-col gap-1.5 pb-1">
                                        {activity.map((event) => (
                                            <li
                                                key={event.id}
                                                className="flex items-baseline gap-2"
                                            >
                                                <span className="line-clamp-2 min-w-0 flex-1 text-xs text-gray-600">
                                                    <span className="text-gray-800">
                                                        {event.user_display_name ||
                                                            event.user_email ||
                                                            "Someone"}
                                                    </span>{" "}
                                                    {describeEvent(event)}
                                                    {event.title ? (
                                                        <span className="text-gray-500">
                                                            {" — "}
                                                            {event.title}
                                                        </span>
                                                    ) : null}
                                                </span>
                                                <span className="shrink-0 text-[11px] text-gray-400">
                                                    {relativeDay(
                                                        event.created_at,
                                                    )}
                                                </span>
                                            </li>
                                        ))}
                                    </ul>
                                ))}
                        </section>
                    </div>

                    {/* Files and reviews -------------------------------- */}
                    <div
                        className="flex min-h-0 flex-col gap-5 px-4 py-4 md:px-6 lg:overflow-y-auto"
                        onDragOver={(event) => {
                            event.preventDefault();
                            setDragging(true);
                        }}
                        onDragLeave={() => setDragging(false)}
                        onDrop={(event) => {
                            event.preventDefault();
                            setDragging(false);
                            void addFiles(event.dataTransfer?.files ?? null);
                        }}
                    >
                        <section className="flex flex-col gap-2">
                            <SectionHeading
                                title="Documents"
                                count={documents.length}
                                actions={
                                    <SectionLink
                                        onClick={() =>
                                            router.push(documentsHref)
                                        }
                                    >
                                        See all
                                    </SectionLink>
                                }
                            />
                            {projectLoading ? (
                                <Hint>Loading…</Hint>
                            ) : documents.length === 0 ? (
                                <Hint>
                                    No documents yet. Drop files below to add
                                    the first.
                                </Hint>
                            ) : (
                                <ul className="-mx-2 flex flex-col">
                                    {documents
                                        .slice(0, DOCUMENT_LIMIT)
                                        .map((doc: Document) => (
                                            <li key={doc.id}>
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        openDocument(doc.id)
                                                    }
                                                    title={`Open ${doc.filename}`}
                                                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-black/[0.03]"
                                                >
                                                    <FileTypeIcon
                                                        fileType={doc.file_type}
                                                        className="h-4 w-4 shrink-0"
                                                    />
                                                    <span className="min-w-0 flex-1 truncate text-sm text-gray-800">
                                                        {doc.filename}
                                                    </span>
                                                    <span className="shrink-0 text-[11px] text-gray-500">
                                                        {relativeDay(
                                                            doc.updated_at ??
                                                                doc.created_at,
                                                        )}
                                                    </span>
                                                </button>
                                            </li>
                                        ))}
                                </ul>
                            )}

                            <input
                                ref={fileInputRef}
                                type="file"
                                multiple
                                accept={SUPPORTED_DOCUMENT_ACCEPT}
                                className="hidden"
                                onChange={(event) => {
                                    void addFiles(event.target.files);
                                    event.target.value = "";
                                }}
                            />
                            <button
                                type="button"
                                onClick={() => fileInputRef.current?.click()}
                                disabled={uploading > 0}
                                className={`mt-1 flex w-full items-center justify-center gap-2 rounded-lg border border-dashed px-3 py-2.5 text-xs transition-colors ${
                                    dragging
                                        ? "border-gray-500 bg-black/[0.03] text-gray-800"
                                        : "border-gray-300 text-gray-500 hover:border-gray-400 hover:text-gray-700"
                                }`}
                            >
                                {uploading > 0 ? (
                                    <>
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        Adding {uploading}{" "}
                                        {uploading === 1 ? "file" : "files"}…
                                    </>
                                ) : (
                                    <>
                                        <Upload className="h-3.5 w-3.5" />
                                        Drop files here, or choose them
                                    </>
                                )}
                            </button>
                            {uploadWarning && (
                                <p className="text-[11px] text-amber-700">
                                    {uploadWarning}
                                </p>
                            )}
                        </section>

                        <section className="flex flex-col gap-2 border-t border-gray-200/70 pt-4">
                            <SectionHeading
                                title="Tabular reviews"
                                actions={
                                    <>
                                        <SectionLink onClick={openNewReview}>
                                            New
                                        </SectionLink>
                                        <SectionLink
                                            onClick={() =>
                                                router.push(reviewsHref)
                                            }
                                        >
                                            See all
                                        </SectionLink>
                                    </>
                                }
                            />
                            {reviews === null ? (
                                <Hint>Loading…</Hint>
                            ) : reviews.length === 0 ? (
                                <Hint>
                                    None yet. A review asks the same questions
                                    of many documents at once.
                                </Hint>
                            ) : (
                                <ul className="-mx-2 flex flex-col">
                                    {reviews.map((review) => (
                                        <li key={review.id}>
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    router.push(
                                                        `/projects/${projectId}/tabular-reviews/${review.id}`,
                                                    )
                                                }
                                                className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-black/[0.03]"
                                            >
                                                <span className="min-w-0 flex-1 truncate text-sm text-gray-800">
                                                    {review.title ||
                                                        "Untitled review"}
                                                </span>
                                                <span className="shrink-0 text-[11px] text-gray-500">
                                                    {review.document_count ??
                                                        review.document_ids
                                                            ?.length ??
                                                        0}{" "}
                                                    docs
                                                </span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </section>
                    </div>
                </div>
            </div>
        </>
    );
}
