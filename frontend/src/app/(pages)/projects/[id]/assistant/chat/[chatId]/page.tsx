"use client";

import {
    Fragment,
    use,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
    type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import {
    Columns3,
    ClipboardList,
    FileText,
    FolderClosed,
    Loader2,
    Pencil,
    Trash2,
    Upload,
    X,
} from "lucide-react";
import {
    deleteChat,
    deleteDocument,
    getChat,
    getProject,
    listProjectMemories,
    updateProject,
    uploadProjectDocument,
    createProjectFolder,
    renameProjectFolder,
    deleteProjectFolder,
    moveDocumentToFolder,
    moveSubfolderToFolder,
} from "@/app/lib/mikeApi";
import { useAssistantChat } from "@/app/hooks/useAssistantChat";
import { useChatHistoryContext } from "@/app/contexts/ChatHistoryContext";
import { UserMessage } from "@/app/components/assistant/UserMessage";
import { AssistantMessage } from "@/app/components/assistant/AssistantMessage";
import { ChatInput } from "@/app/components/assistant/ChatInput";
import type { ChatInputHandle } from "@/app/components/assistant/ChatInput";
import { ProjectExplorer } from "@/app/components/projects/ProjectExplorer";
import { PdfView } from "@/app/components/shared/views/PdfView";
import { SpreadsheetView } from "@/app/components/shared/views/SpreadsheetView";
import { ConfirmPopup } from "@/app/components/popups/ConfirmPopup";
import { OwnerOnlyPopup } from "@/app/components/popups/OwnerOnlyPopup";
import { DocxView } from "@/app/components/shared/views/DocxView";
import { DocPanel } from "@/app/components/assistant/DocPanel";
import { MikeIcon } from "@/app/components/chat/mike-icon";
import { useAuth } from "@/app/contexts/AuthContext";
import { useUserProfile } from "@/app/contexts/UserProfileContext";
import { useSidebar } from "@/app/contexts/SidebarContext";
import { PageHeader } from "@/app/components/shared/PageHeader";
import { HeaderActionsMenu } from "@/app/components/shared/HeaderActionsMenu";
import { PaneHeader } from "@/app/components/projects/PaneHeader";
import { CaseOverviewPanel } from "@/app/components/projects/CaseOverviewPanel";
import {
    PANE_LABELS,
    useProjectChatLayout,
    usePaneDrag,
    type PaneId,
} from "@/app/hooks/useProjectChatLayout";
import type {
    CitationQuote,
    Citation,
    Document,
    EditAnnotation,
    Message,
    PanelDocument,
    Project,
} from "@/app/components/shared/types";
import {
    expandCitationToEntries,
    isDocxFilename,
    isSpreadsheetFilename,
    panelDocumentFromCitation,
} from "@/app/components/shared/types";
import {
    INITIAL_FOLDER_DELETE_DIALOG_STATE,
    clearDeletedDocumentId,
    clearDeletedDocumentTarget,
    folderDeleteDialogReducer,
    removeDeletedDocumentTabs,
} from "@/app/lib/folderDeleteState";

interface Props {
    params: Promise<{ id: string; chatId: string }>;
}

type DocTab = {
    documentId: string;
    filename: string;
    quotes?: CitationQuote[];
    versionId?: string | null;
    refetchKey?: number;
    warning?: string | null;
    scrollTop?: number;
    // Set for statute/legislation tabs. These carry their own text in an
    // in-memory panel document (built by the backend), so they render with
    // DocPanel instead of the file-backed document viewers.
    panelDocument?: PanelDocument;
    citation?: Citation;
};

type EditScrollTarget = {
    key: string;
    documentId: string;
    inserted_text?: string;
    deleted_text?: string;
    ins_w_id?: string | null;
    del_w_id?: string | null;
};

const ICON_SIZE = 28;
const GAP = 14;
const DEFAULT_ASSISTANT_BOTTOM_PADDING = 116;

function AssistantGreeting({ username }: { username: string }) {
    const { profile } = useUserProfile();
    const [loaded, setLoaded] = useState(false);
    const [iconOffset, setIconOffset] = useState(0);
    const [textOffset, setTextOffset] = useState(0);
    const textRef = useRef<HTMLHeadingElement>(null);

    useLayoutEffect(() => {
        if (!profile || !textRef.current) return;
        const h1Width = textRef.current.offsetWidth;
        setIconOffset((h1Width + GAP) / 2);
        setTextOffset((ICON_SIZE + GAP) / 2);
    }, [profile]);

    useEffect(() => {
        if (!iconOffset) return;
        const t = setTimeout(() => setLoaded(true), 100);
        return () => clearTimeout(t);
    }, [iconOffset]);

    return (
        <div className="flex-1 flex items-center justify-center">
            <div className="relative flex items-center justify-center h-[28px]">
                <div
                    className="absolute h-[30px]"
                    style={{
                        left: "50%",
                        transform: loaded
                            ? `translateX(calc(-50% - ${iconOffset}px))`
                            : "translateX(-50%)",
                        transition:
                            "transform 900ms cubic-bezier(0.25, 0.46, 0.45, 0.94)",
                    }}
                >
                    <MikeIcon size={ICON_SIZE} />
                </div>
                <h1
                    ref={textRef}
                    className="absolute text-3xl font-serif font-light text-gray-900 whitespace-nowrap"
                    style={{
                        left: "50%",
                        transform: loaded
                            ? `translateX(calc(-50% + ${textOffset}px))`
                            : "translateX(-50%)",
                        opacity: loaded ? 1 : 0,
                        transition:
                            "transform 900ms cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 800ms ease-in-out 300ms",
                    }}
                >
                    Hi, {username}
                </h1>
            </div>
        </div>
    );
}

/** Drag-handle divider for resizing panels */
function Divider({ onDrag }: { onDrag: (dx: number) => void }) {
    const dragging = useRef(false);
    const lastX = useRef(0);
    const [isDragging, setIsDragging] = useState(false);

    const onMouseDown = (e: React.MouseEvent) => {
        dragging.current = true;
        setIsDragging(true);
        lastX.current = e.clientX;
        document.body.style.cursor = "col-resize";
        document.body.style.userSelect = "none";
    };

    useEffect(() => {
        function onMouseMove(e: MouseEvent) {
            if (!dragging.current) return;
            onDrag(e.clientX - lastX.current);
            lastX.current = e.clientX;
        }
        function onMouseUp() {
            if (!dragging.current) return;
            dragging.current = false;
            setIsDragging(false);
            document.body.style.cursor = "";
            document.body.style.userSelect = "";
        }
        window.addEventListener("mousemove", onMouseMove);
        window.addEventListener("mouseup", onMouseUp);
        return () => {
            window.removeEventListener("mousemove", onMouseMove);
            window.removeEventListener("mouseup", onMouseUp);
        };
    }, [onDrag]);

    return (
        <div className="relative w-0 shrink-0 z-10">
            <div
                onMouseDown={onMouseDown}
                className="absolute inset-y-0 -left-2 -right-2 cursor-col-resize flex items-stretch justify-center"
            >
                {isDragging && (
                    <div className="w-1 bg-blue-500 transition-colors" />
                )}
            </div>
        </div>
    );
}

export default function ProjectAssistantChatPage({ params }: Props) {
    const { id: projectId, chatId } = use(params);
    const router = useRouter();

    const { setSidebarOpen } = useSidebar();
    const { user } = useAuth();
    const { profile } = useUserProfile();
    const username =
        profile?.displayName?.trim() || user?.email?.split("@")[0] || "there";

    const [project, setProject] = useState<Project | null>(null);
    const [chatTitle, setChatTitle] = useState<string | null>(null);
    const [chatOwnerId, setChatOwnerId] = useState<string | null>(null);
    const [ownerOnlyAction, setOwnerOnlyAction] = useState<string | null>(null);
    const [chatLoaded, setChatLoaded] = useState(false);
    const [creatingChat, setCreatingChat] = useState(false);
    const [deletingChat, setDeletingChat] = useState(false);
    const [folderDeleteDialog, dispatchFolderDeleteDialog] = useReducer(
        folderDeleteDialogReducer,
        INITIAL_FOLDER_DELETE_DIALOG_STATE,
    );
    const pendingDeleteFolder = folderDeleteDialog.pending;
    const pendingDeleteFolderStatus = folderDeleteDialog.status;
    const folderDeleteDismissTimerRef = useRef<number | null>(null);

    // Panel arrangement — order, sizes and whether the files rail is showing
    // are the reader's own choice and are remembered between visits.
    const paneRowRef = useRef<HTMLDivElement>(null);

    // Upload state
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [uploading, setUploading] = useState(false);
    const [explorerDragOver, setExplorerDragOver] = useState(false);
    const assistantPanelRef = useRef<HTMLDivElement>(null);

    // Tabs
    const [tabs, setTabs] = useState<DocTab[]>([]);
    const [activeTabId, setActiveTabId] = useState<string | null>(null);
    const [activeQuotes, setActiveQuotes] = useState<CitationQuote[] | null>(
        null,
    );
    const [selectedDocId, setSelectedDocId] = useState<string | null>(null);
    const [editScrollTarget, setEditScrollTarget] =
        useState<EditScrollTarget | null>(null);
    const [reloadingDocIds, setReloadingDocIds] = useState<Set<string>>(
        () => new Set(),
    );

    const activeTab = tabs.find((t) => t.documentId === activeTabId) ?? null;

    // Mike writes down what it thinks is worth remembering only after an answer
    // has gone out, so the case overview panel is told each time one finishes
    // and looks again for suggestions a moment later.
    const [answersFinished, setAnswersFinished] = useState(0);

    // Suggestions waiting to be looked at. Counted here rather than in the
    // panel, because the whole point is to show them when the panel is shut —
    // and the panel is not there to count them then. While it is open it
    // reports its own count back, which keeps the two in step as the reader
    // works through them.
    const [pendingSuggestions, setPendingSuggestions] = useState(0);

    useEffect(() => {
        let cancelled = false;
        const count = () => {
            listProjectMemories(projectId, { status: "proposed" })
                .then((waiting) => {
                    if (!cancelled) setPendingSuggestions(waiting.length);
                })
                .catch(() => {
                    // Nothing to mark is the right answer when we cannot ask.
                });
        };
        count();
        // Suggestions are written after the answer has gone out, so look again
        // a moment later rather than at the instant it finishes.
        const timers = answersFinished
            ? [2500, 9000].map((delay) => window.setTimeout(count, delay))
            : [];
        return () => {
            cancelled = true;
            for (const timer of timers) window.clearTimeout(timer);
        };
    }, [projectId, answersFinished]);

    const handleAutoRememberChange = useCallback(
        async (autoRemember: boolean) => {
            setProject((prev) => (prev ? { ...prev, auto_remember: autoRemember } : prev));
            try {
                await updateProject(projectId, { auto_remember: autoRemember });
            } catch {
                // Put the switch back where it was rather than showing it in a
                // state the matter is not actually in.
                setProject((prev) =>
                    prev ? { ...prev, auto_remember: !autoRemember } : prev,
                );
            }
        },
        [projectId],
    );

    const {
        layout,
        laidOut,
        filesOpen,
        setFilesOpen,
        overviewOpen,
        setOverviewOpen,
        movePane,
        resizePanes,
        resetLayout,
        isDefaultLayout,
    } = useProjectChatLayout({ documentOpen: tabs.length > 0 });
    const { draggingPane, hoverPane, startDrag } = usePaneDrag(movePane);
    const tabBarRef = useRef<HTMLDivElement | null>(null);
    const tabItemRefs = useRef<Record<string, HTMLDivElement | null>>({});

    const chatInputRef = useRef<ChatInputHandle | null>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const messagesContainerRef = useRef<HTMLDivElement>(null);
    const latestUserMessageRef = useRef<HTMLDivElement>(null);
    const [minHeight, setMinHeight] = useState("0px");

    const {
        setCurrentChatId,
        newChatMessages,
        setNewChatMessages,
        chats,
        saveChat,
        renameChat: renameChatInHistory,
    } = useChatHistoryContext();
    const [initialMessages] = useState<Message[]>(newChatMessages ?? []);
    const {
        messages,
        isResponseLoading,
        handleChat,
        continueRun,
        setMessages,
        cancel,
    } = useAssistantChat({ initialMessages, chatId, projectId });

    const wasRespondingRef = useRef(false);
    useEffect(() => {
        if (wasRespondingRef.current && !isResponseLoading) {
            setAnswersFinished((count) => count + 1);
        }
        wasRespondingRef.current = isResponseLoading;
    }, [isResponseLoading]);
    const pendingInitialUserMessageRef = useRef<Message | null>(
        initialMessages.length === 1 && initialMessages[0].role === "user"
            ? initialMessages[0]
            : null,
    );

    const hasLoaded = useRef(false);
    const hasAutoSent = useRef(false);
    const hasInitialScrolled = useRef(false);

    const clearFolderDeleteDismissTimer = useCallback(() => {
        if (folderDeleteDismissTimerRef.current === null) return;
        clearTimeout(folderDeleteDismissTimerRef.current);
        folderDeleteDismissTimerRef.current = null;
    }, []);

    useEffect(() => {
        return () => clearFolderDeleteDismissTimer();
    }, [clearFolderDeleteDismissTimer]);

    useEffect(() => {
        if (activeTabId) return;
        setActiveQuotes(null);
        setEditScrollTarget(null);
    }, [activeTabId]);

    useEffect(() => {
        setSidebarOpen(false);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        getProject(projectId)
            .then(setProject)
            .catch(() => {});
    }, [projectId]);

    // Whenever the assistant mutates project documents — creating a new
    // doc, creating a new version via edit_document, or replicating a doc —
    // refresh the project so the explorer picks up the new/changed files
    // without a manual reload. Keyed by completed mutation events only, so
    // we refetch once the backend has finished persisting the change.
    const projectMutationSignature = useMemo(() => {
        const created: string[] = [];
        const replicated: string[] = [];
        const editedPerDoc: Record<string, number> = {};
        for (const msg of messages) {
            for (const ev of msg.events ?? []) {
                if ("isStreaming" in ev && ev.isStreaming) continue;
                if (ev.type === "doc_created" && ev.document_id) {
                    created.push(
                        `${ev.document_id}:${ev.version_id ?? ""}:${ev.filename}`,
                    );
                    continue;
                }
                if (ev.type === "doc_replicated") {
                    for (const c of ev.copies ?? []) {
                        replicated.push(
                            `${c.document_id}:${c.version_id}:${c.new_filename}`,
                        );
                    }
                    continue;
                }
                if (ev.type === "doc_edited") {
                    editedPerDoc[ev.document_id] = Math.max(
                        editedPerDoc[ev.document_id] ?? 0,
                        (ev.version_number as number | null | undefined) ?? 0,
                    );
                }
            }
        }
        return [
            `created=${created.sort().join(",")}`,
            `replicated=${replicated.sort().join(",")}`,
            `edited=${Object.entries(editedPerDoc)
                .map(([k, v]) => `${k}=${v}`)
                .sort()
                .join(",")}`,
        ].join("|");
    }, [messages]);

    useEffect(() => {
        if (!projectMutationSignature) return;
        getProject(projectId)
            .then(setProject)
            .catch(() => {});
    }, [projectMutationSignature, projectId]);

    useEffect(() => {
        setCurrentChatId(chatId);
    }, [chatId, setCurrentChatId]);

    useEffect(() => {
        if (hasLoaded.current) return;
        hasLoaded.current = true;
        getChat(chatId)
            .then(({ chat, messages: loaded }) => {
                setChatTitle(chat.title);
                setChatOwnerId(chat.user_id ?? null);
                if (loaded.length > 0) setMessages(loaded);
            })
            .catch(() => router.replace(`/projects/${projectId}/assistant`))
            .finally(() => setChatLoaded(true));
    }, [chatId]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        const match = chats?.find((c) => c.id === chatId);
        if (match?.title) setChatTitle(match.title);
    }, [chats, chatId]);

    useEffect(() => {
        const pendingMessage = pendingInitialUserMessageRef.current;
        if (
            pendingMessage &&
            !hasAutoSent.current &&
            !isResponseLoading &&
            messages.length === 1
        ) {
            hasAutoSent.current = true;
            pendingInitialUserMessageRef.current = null;
            setNewChatMessages(null);
            void handleChat(pendingMessage);
        }
    }, [messages.length, isResponseLoading, handleChat, setNewChatMessages]);

    const scrollLatestUserToTop = useCallback(() => {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                const container = messagesContainerRef.current;
                const element = latestUserMessageRef.current;
                if (!container || !element) return;
                container.scrollTo({
                    top: element.offsetTop - 24,
                    behavior: "smooth",
                });
            });
        });
    }, []);

    useEffect(() => {
        const last = messages[messages.length - 1];
        if (last?.role === "user") scrollLatestUserToTop();
    }, [messages, scrollLatestUserToTop]);

    useEffect(() => {
        if (!chatLoaded || hasInitialScrolled.current || messages.length === 0)
            return;
        const container = messagesContainerRef.current;
        const el = latestUserMessageRef.current;
        if (!container || !el) return;
        hasInitialScrolled.current = true;
        setTimeout(() => {
            container.scrollTo({
                top: el.offsetTop - 16,
                behavior: "auto",
            });
        }, 100);
    }, [chatLoaded, messages.length]);

    useEffect(() => {
        if (isResponseLoading) scrollLatestUserToTop();
    }, [isResponseLoading, scrollLatestUserToTop]);

    useEffect(() => {
        const userEl = latestUserMessageRef.current;
        const containerEl = messagesContainerRef.current;
        if (!userEl || !containerEl) return;
        const messageGap = window.innerWidth < 768 ? 24 : 32;
        setMinHeight(
            `${Math.max(
                0,
                containerEl.clientHeight -
                    messageGap * 3 -
                    userEl.offsetHeight -
                    DEFAULT_ASSISTANT_BOTTOM_PADDING,
            )}px`,
        );
    }, [messages.length]);

    useEffect(() => {
        if (!activeTabId) return;
        const el = tabItemRefs.current[activeTabId];
        if (!el) return;
        el.scrollIntoView({
            behavior: "smooth",
            block: "nearest",
            inline: "nearest",
        });
    }, [activeTabId, tabs.length]);

    // ── Tabs ──────────────────────────────────────────────────────────────────
    function openTab(
        docId: string,
        filename: string,
        quotes?: CitationQuote[],
        versionId?: string | null,
    ) {
        setTabs((prev) => {
            const existing = prev.find((t) => t.documentId === docId);
            if (existing) {
                if (
                    versionId !== undefined &&
                    existing.versionId !== versionId
                ) {
                    return prev.map((t) =>
                        t.documentId === docId ? { ...t, versionId } : t,
                    );
                }
                return prev;
            }
            return [
                ...prev,
                { documentId: docId, filename, quotes, versionId },
            ];
        });
        setActiveTabId(docId);
        setActiveQuotes(quotes && quotes.length ? quotes : null);
        setSelectedDocId(docId);
    }

    function closeTab(docId: string) {
        setTabs((prev) => {
            const next = prev.filter((t) => t.documentId !== docId);
            if (activeTabId === docId) {
                const idx = prev.findIndex((t) => t.documentId === docId);
                const fallback = next[idx] ?? next[idx - 1] ?? null;
                setActiveTabId(fallback?.documentId ?? null);
                setActiveQuotes(null);
                setSelectedDocId(fallback?.documentId ?? null);
            }
            return next;
        });
    }

    // Open a statute or a case in the reading panel. A statute arrives with its
    // text inside the citation (backend-built panel document); a case carries
    // only its name and id, and the panel fetches the opinions itself. Either
    // way the tab holds the document rather than a stored file.
    function openLegalSourceTab(citation: Citation) {
        const document = panelDocumentFromCitation(citation);
        const docId = document.document_id;
        setTabs((prev) => {
            const existing = prev.find((t) => t.documentId === docId);
            if (existing) {
                return prev.map((t) =>
                    t.documentId === docId
                        ? { ...t, panelDocument: document, citation }
                        : t,
                );
            }
            return [
                ...prev,
                {
                    documentId: docId,
                    filename: document.title,
                    panelDocument: document,
                    citation,
                },
            ];
        });
        setActiveTabId(docId);
        setActiveQuotes(null);
    }

    function switchTab(docId: string) {
        setActiveTabId(docId);
        setActiveQuotes(null);
        setSelectedDocId(docId);
    }

    // ── Handlers ──────────────────────────────────────────────────────────────
    const handleSubmit = useCallback(
        (message: Message) => {
            if (!activeTab) return handleChat(message);
            return handleChat(message, {
                displayedDoc: {
                    filename: activeTab.filename,
                    documentId: activeTab.documentId,
                },
            });
        },
        [activeTab, handleChat],
    );

    const handleDocClick = (doc: Document) => {
        openTab(doc.id, doc.filename);
    };

    const handleCitationClick = (citation: Citation) => {
        if (citation.kind === "legislation" || citation.kind === "case") {
            openLegalSourceTab(citation);
            return;
        }
        openTab(
            citation.document_id,
            citation.filename,
            expandCitationToEntries(citation),
        );
    };

    const handleOpenDocument = (args: {
        documentId: string;
        filename: string;
        versionId: string | null;
        versionNumber: number | null;
    }) => {
        openTab(args.documentId, args.filename, undefined, args.versionId);
    };

    const handleEditViewClick = (ann: EditAnnotation, filename: string) => {
        openTab(ann.document_id, filename, undefined, ann.version_id ?? null);
        setEditScrollTarget({
            key: `${ann.edit_id}-${Date.now()}`,
            documentId: ann.document_id,
            inserted_text: ann.inserted_text,
            deleted_text: ann.deleted_text,
            ins_w_id: ann.ins_w_id ?? null,
            del_w_id: ann.del_w_id ?? null,
        });
    };

    const handleEditResolved = (_args: {
        editId: string;
        documentId: string;
        status: "accepted" | "rejected";
        versionId: string | null;
        downloadUrl: string | null;
    }) => {
        // Re-render after accept/reject is disabled while we verify the
        // client-side optimistic mutation works on its own. Re-enable by
        // bumping versionId + refetchKey on the matching tab and marking
        // it reloading like before.
        void _args;
    };

    const patchTab = (documentId: string, patch: Partial<DocTab>) => {
        setTabs((prev) =>
            prev.map((t) =>
                t.documentId === documentId ? { ...t, ...patch } : t,
            ),
        );
    };

    const handleEditError = (args: { documentId: string; message: string }) => {
        patchTab(args.documentId, { warning: args.message });
    };

    const dismissTabWarning = (documentId: string) => {
        patchTab(documentId, { warning: null });
    };

    const handleTabScrollChange = (documentId: string, scrollTop: number) => {
        patchTab(documentId, { scrollTop });
    };

    const handleDocxReady = (documentId: string) => {
        setReloadingDocIds((prev) => {
            if (!prev.has(documentId)) return prev;
            const next = new Set(prev);
            next.delete(documentId);
            return next;
        });
    };

    const handleChatDrop = (e: React.DragEvent) => {
        const docId = e.dataTransfer.getData("application/mike-doc");
        // A file dragged in from the desktop is left alone here so the chat
        // box can pick it up and attach it to this conversation only.
        if (!docId) return;
        e.preventDefault();
        const doc = project?.documents?.find((d) => d.id === docId);
        if (doc) chatInputRef.current?.addDoc(doc);
    };

    // ── Chat actions ──────────────────────────────────────────────────────────
    async function handleNewChat() {
        setCreatingChat(true);
        try {
            const id = await saveChat(projectId);
            if (id) router.push(`/projects/${projectId}/assistant/chat/${id}`);
        } finally {
            setCreatingChat(false);
        }
    }

    async function handleDeleteChat() {
        if (chatOwnerId && user?.id && chatOwnerId !== user.id) {
            setOwnerOnlyAction("delete this chat");
            return;
        }
        setDeletingChat(true);
        try {
            await deleteChat(chatId);
            router.push(`/projects/${projectId}/assistant`);
        } finally {
            setDeletingChat(false);
        }
    }

    async function handleRenameChat() {
        if (chatOwnerId && user?.id && chatOwnerId !== user.id) {
            setOwnerOnlyAction("rename this chat");
            return;
        }
        const nextTitle = window.prompt(
            "Rename chat",
            chatTitle ?? "Untitled New Chat",
        );
        const trimmed = nextTitle?.trim();
        if (!trimmed || trimmed === chatTitle) return;
        setChatTitle(trimmed);
        await renameChatInHistory(chatId, trimmed);
    }

    // ── Upload ────────────────────────────────────────────────────────────────
    async function uploadFiles(files: File[]) {
        if (!files.length) return;
        setUploading(true);
        try {
            const uploaded = await Promise.all(
                files.map((f) => uploadProjectDocument(projectId, f)),
            );
            setProject((prev) => {
                if (!prev) return prev;
                return {
                    ...prev,
                    documents: [...(prev.documents ?? []), ...uploaded],
                };
            });
        } catch (err) {
            console.error("Upload failed:", err);
        } finally {
            setUploading(false);
            if (fileInputRef.current) fileInputRef.current.value = "";
        }
    }

    const handleExplorerFileDrop = async (e: React.DragEvent) => {
        e.preventDefault();
        setExplorerDragOver(false);
        const files = Array.from(e.dataTransfer.files);
        if (files.length) {
            await uploadFiles(files);
        }
        // Internal doc/folder moves are handled inside ProjectExplorer (stopPropagation)
    };

    // ── Folder handlers ───────────────────────────────────────────────────────
    const handleCreateFolder = async (
        parentId: string | null,
        name: string,
    ) => {
        const folder = await createProjectFolder(
            projectId,
            name,
            parentId ?? undefined,
        );
        setProject((prev) =>
            prev
                ? { ...prev, folders: [...(prev.folders ?? []), folder] }
                : prev,
        );
    };

    const handleRenameFolder = async (folderId: string, name: string) => {
        await renameProjectFolder(projectId, folderId, name);
        setProject((prev) =>
            prev
                ? {
                      ...prev,
                      folders: (prev.folders ?? []).map((f) =>
                          f.id === folderId ? { ...f, name } : f,
                      ),
                  }
                : prev,
        );
    };

    const folderDeleteImpact = useCallback(
        (folderId: string) => {
            const childrenByParent = new Map<string, string[]>();
            for (const folder of project?.folders ?? []) {
                if (!folder.parent_folder_id) continue;
                const children =
                    childrenByParent.get(folder.parent_folder_id) ?? [];
                children.push(folder.id);
                childrenByParent.set(folder.parent_folder_id, children);
            }

            const toDelete = new Set<string>();
            const stack = [folderId];
            while (stack.length > 0) {
                const id = stack.pop();
                if (!id || toDelete.has(id)) continue;
                toDelete.add(id);
                stack.push(...(childrenByParent.get(id) ?? []));
            }

            const folderIds = [...toDelete];
            const documentIds = (project?.documents ?? [])
                .filter((document) =>
                    document.folder_id
                        ? toDelete.has(document.folder_id)
                        : false,
                )
                .map((document) => document.id);
            return {
                folderIds,
                documentIds,
                documentCount: documentIds.length,
            };
        },
        [project?.documents, project?.folders],
    );

    const requestDeleteFolder = useCallback(
        async (folderId: string) => {
            const folder = (project?.folders ?? []).find(
                (candidate) => candidate.id === folderId,
            );
            if (!folder) return;

            const impact = folderDeleteImpact(folderId);
            clearFolderDeleteDismissTimer();
            dispatchFolderDeleteDialog({
                type: "request",
                pending: {
                    folder,
                    folderIds: impact.folderIds,
                    documentIds: impact.documentIds,
                    documentCount: impact.documentCount,
                },
            });
        },
        [
            clearFolderDeleteDismissTimer,
            folderDeleteImpact,
            project?.folders,
        ],
    );

    const confirmDeletePendingFolder = async () => {
        const pending = pendingDeleteFolder;
        if (!pending || pendingDeleteFolderStatus === "deleting") return;

        dispatchFolderDeleteDialog({
            type: "start",
            folderId: pending.folder.id,
        });

        const folderIds = new Set(pending.folderIds);
        const deletedDocumentIds = new Set(pending.documentIds);

        try {
            await deleteProjectFolder(projectId, pending.folder.id);
            setProject((currentProject) =>
                currentProject
                    ? {
                          ...currentProject,
                          folders: (currentProject.folders ?? []).filter(
                              (folder) => !folderIds.has(folder.id),
                          ),
                          documents: (currentProject.documents ?? []).filter(
                              (document) =>
                                  !deletedDocumentIds.has(document.id),
                          ),
                      }
                    : currentProject,
            );
            setTabs((currentTabs) =>
                removeDeletedDocumentTabs(
                    currentTabs,
                    deletedDocumentIds,
                ),
            );
            setActiveTabId((currentId) =>
                clearDeletedDocumentId(currentId, deletedDocumentIds),
            );
            setSelectedDocId((currentId) =>
                clearDeletedDocumentId(currentId, deletedDocumentIds),
            );
            setEditScrollTarget((currentTarget) =>
                clearDeletedDocumentTarget(
                    currentTarget,
                    deletedDocumentIds,
                ),
            );
            dispatchFolderDeleteDialog({
                type: "complete",
                folderId: pending.folder.id,
            });

            clearFolderDeleteDismissTimer();
            folderDeleteDismissTimerRef.current = window.setTimeout(() => {
                dispatchFolderDeleteDialog({
                    type: "dismiss-completed",
                    folderId: pending.folder.id,
                });
                folderDeleteDismissTimerRef.current = null;
            }, 650);
        } catch (error) {
            console.error("delete folder failed", error);
            dispatchFolderDeleteDialog({
                type: "failed",
                folderId: pending.folder.id,
            });
        }
    };

    const handleMoveDoc = async (
        docId: string,
        targetFolderId: string | null,
    ) => {
        setProject((prev) =>
            prev
                ? {
                      ...prev,
                      documents: (prev.documents ?? []).map((d) =>
                          d.id === docId
                              ? { ...d, folder_id: targetFolderId }
                              : d,
                      ),
                  }
                : prev,
        );
        await moveDocumentToFolder(projectId, docId, targetFolderId);
    };

    const handleMoveFolder = async (
        folderId: string,
        targetFolderId: string | null,
    ) => {
        setProject((prev) =>
            prev
                ? {
                      ...prev,
                      folders: (prev.folders ?? []).map((f) =>
                          f.id === folderId
                              ? { ...f, parent_folder_id: targetFolderId }
                              : f,
                      ),
                  }
                : prev,
        );
        await moveSubfolderToFolder(projectId, folderId, targetFolderId);
    };

    const handleDeleteDoc = async (docId: string) => {
        await deleteDocument(docId);
        setProject((prev) =>
            prev
                ? {
                      ...prev,
                      documents: (prev.documents ?? []).filter(
                          (d) => d.id !== docId,
                      ),
                  }
                : prev,
        );
        setTabs((prev) => prev.filter((t) => t.documentId !== docId));
        if (activeTabId === docId) {
            setActiveTabId(null);
            setActiveQuotes(null);
            setSelectedDocId(null);
            setEditScrollTarget(null);
        }
    };

    // ── Panel arrangement ─────────────────────────────────────────────────────
    const handleDividerDrag = useCallback(
        (left: PaneId, right: PaneId, dx: number) => {
            resizePanes(
                left,
                right,
                dx,
                paneRowRef.current?.getBoundingClientRect().width ?? 0,
            );
        },
        [resizePanes],
    );

    // ── The panels ────────────────────────────────────────────────────────────
    // Each is laid out by the reader's own arrangement below.
    const paneContent: Record<PaneId, ReactNode> = {
        overview: (
            <div className="flex h-full min-h-0 flex-col">
                <PaneHeader
                    paneId="overview"
                    label={PANE_LABELS.overview}
                    draggingPane={draggingPane}
                    hoverPane={hoverPane}
                    onStartDrag={startDrag}
                    actions={
                        <button
                            onClick={() => setOverviewOpen(false)}
                            title="Hide the case overview"
                            className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    }
                >
                    <span className="self-center truncate text-xs text-gray-700">
                        Case overview
                    </span>
                </PaneHeader>

                <div className="flex-1 min-h-0">
                    <CaseOverviewPanel
                        projectId={projectId}
                        overview={project ? (project.overview ?? null) : undefined}
                        canEdit={project?.is_owner !== false}
                        documents={project?.documents ?? []}
                        autoRemember={project?.auto_remember === true}
                        refreshSignal={answersFinished}
                        onSaved={(overview) =>
                            setProject((prev) =>
                                prev ? { ...prev, overview } : prev,
                            )
                        }
                        onAutoRememberChange={handleAutoRememberChange}
                        onPendingCountChange={setPendingSuggestions}
                        onOpenDocument={(documentId, filename) =>
                            openTab(documentId, filename)
                        }
                    />
                </div>
            </div>
        ),
        files: (
            <div
                className="flex h-full min-h-0 flex-col"
                onDragOver={(e) => {
                    e.preventDefault();
                    // Only show the upload overlay for external file drags, not internal moves
                    const isInternal =
                        Array.from(e.dataTransfer.types).includes(
                            "application/mike-doc",
                        ) ||
                        Array.from(e.dataTransfer.types).includes(
                            "application/mike-folder",
                        );
                    if (!isInternal) setExplorerDragOver(true);
                }}
                onDragLeave={(e) => {
                    if (!e.currentTarget.contains(e.relatedTarget as Node))
                        setExplorerDragOver(false);
                }}
                onDrop={handleExplorerFileDrop}
            >
                <PaneHeader
                    paneId="files"
                    label={PANE_LABELS.files}
                    draggingPane={draggingPane}
                    hoverPane={hoverPane}
                    onStartDrag={startDrag}
                    actions={
                        <>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept=".pdf,.docx,.doc,.xlsx,.xlsm,.xls,.pptx,.ppt,.jpg,.jpeg,.png,.tif,.tiff,.bmp,.gif,.heic,.heif,.webp,.txt,.md,.csv,.rtf,.odt"
                                multiple
                                className="hidden"
                                onChange={(e) =>
                                    uploadFiles(Array.from(e.target.files ?? []))
                                }
                            />
                            <button
                                onClick={() => fileInputRef.current?.click()}
                                disabled={uploading}
                                title="Upload documents"
                                className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors disabled:opacity-40"
                            >
                                {uploading ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                    <Upload className="h-3.5 w-3.5" />
                                )}
                            </button>
                            <button
                                onClick={() => setFilesOpen(false)}
                                title="Hide files"
                                className="p-1 rounded text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        </>
                    }
                >
                    <span className="self-center truncate text-xs text-gray-700">
                        Files
                    </span>
                </PaneHeader>

                <div
                    className={`flex-1 min-h-0 overflow-y-auto relative ${explorerDragOver ? "bg-blue-50" : ""}`}
                    onDragOver={(e) => {
                        e.preventDefault();
                    }}
                    onDrop={async (e) => {
                        e.preventDefault();
                        const docId = e.dataTransfer.getData(
                            "application/mike-doc",
                        );
                        const folderId = e.dataTransfer.getData(
                            "application/mike-folder",
                        );
                        if (docId) {
                            e.stopPropagation();
                            await handleMoveDoc(docId, null);
                        } else if (folderId) {
                            e.stopPropagation();
                            await handleMoveFolder(folderId, null);
                        }
                        // External file drops are not stopped — they bubble to handleExplorerFileDrop
                    }}
                >
                    {explorerDragOver && (
                        <div className="absolute inset-0 z-10 flex items-center justify-center pointer-events-none">
                            <p className="text-xs text-blue-500 font-medium">
                                Drop to upload
                            </p>
                        </div>
                    )}
                    <ProjectExplorer
                        projectName={project?.name}
                        documents={project?.documents ?? []}
                        folders={project?.folders ?? []}
                        selectedDocId={selectedDocId}
                        onDocClick={handleDocClick}
                        onCreateFolder={handleCreateFolder}
                        onRenameFolder={handleRenameFolder}
                        onDeleteFolder={requestDeleteFolder}
                        onDeleteDoc={handleDeleteDoc}
                        onMoveDoc={handleMoveDoc}
                        onMoveFolder={handleMoveFolder}
                    />
                </div>
            </div>
        ),

        document: (
            <div className="flex h-full min-h-0 flex-col">
                <PaneHeader
                    paneId="document"
                    label={PANE_LABELS.document}
                    draggingPane={draggingPane}
                    hoverPane={hoverPane}
                    onStartDrag={startDrag}
                >
                    <div
                        ref={tabBarRef}
                        className="flex w-full min-w-0 items-end overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden"
                    >
                        {tabs.map((tab) => {
                            const isActive = tab.documentId === activeTabId;
                            const ext = tab.filename
                                .split(".")
                                .pop()
                                ?.toLowerCase();
                            const iconColor =
                                ext === "pdf"
                                    ? "text-red-500"
                                    : ext === "doc" || ext === "docx"
                                      ? "text-blue-500"
                                      : "text-gray-400";
                            // Pull the doc's latest_version_number out
                            // of the project state so the tab shows V#
                            // whenever the doc has been edited.
                            const versionNumber = (
                                project?.documents ?? []
                            ).find((d) => d.id === tab.documentId)
                                ?.latest_version_number as
                                | number
                                | null
                                | undefined;
                            const showVersionBadge =
                                typeof versionNumber === "number" &&
                                Number.isFinite(versionNumber) &&
                                versionNumber > 1;
                            return (
                                <div
                                    key={tab.documentId}
                                    ref={(el) => {
                                        tabItemRefs.current[tab.documentId] =
                                            el;
                                    }}
                                    onClick={() => switchTab(tab.documentId)}
                                    className={`group flex items-center gap-1.5 px-3 h-full border-r border-gray-200 cursor-pointer shrink-0 max-w-[260px] transition-colors ${
                                        isActive
                                            ? "bg-gray-100"
                                            : "bg-white hover:bg-gray-50"
                                    }`}
                                >
                                    <FileText
                                        className={`h-3.5 w-3.5 shrink-0 ${iconColor}`}
                                    />
                                    <span
                                        className={`text-xs truncate ${isActive ? "text-gray-900 font-medium" : "text-gray-500"}`}
                                    >
                                        {tab.filename}
                                    </span>
                                    {showVersionBadge && (
                                        <span
                                            className={`shrink-0 inline-flex items-center rounded border px-1 py-px text-[9px] font-medium ${
                                                isActive
                                                    ? "border-gray-200 bg-white text-gray-600"
                                                    : "border-gray-200 bg-gray-50 text-gray-500"
                                            }`}
                                        >
                                            V{versionNumber}
                                        </span>
                                    )}
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            closeTab(tab.documentId);
                                        }}
                                        className={`shrink-0 transition-colors ${isActive ? "text-gray-500 hover:text-gray-700" : "text-gray-300 hover:text-gray-600"}`}
                                    >
                                        <X className="h-3 w-3" />
                                    </button>
                                </div>
                            );
                        })}
                    </div>
                </PaneHeader>

                <div className="flex-1 min-h-0 overflow-hidden flex flex-col">
                    {activeTab ? (
                        activeTab.panelDocument ? (
                            <DocPanel
                                key={activeTab.documentId}
                                document={activeTab.panelDocument}
                                mode={
                                    activeTab.citation
                                        ? {
                                              kind: "citation",
                                              citation: activeTab.citation,
                                          }
                                        : { kind: "document" }
                                }
                                onQuote={(quote) =>
                                    chatInputRef.current?.addQuote(quote)
                                }
                            />
                        ) : isDocxFilename(activeTab.filename) ? (
                            <DocxView
                                key={activeTab.documentId}
                                documentId={activeTab.documentId}
                                versionId={activeTab.versionId}
                                refetchKey={activeTab.refetchKey}
                                quotes={activeQuotes ?? undefined}
                                highlightEdit={
                                    editScrollTarget &&
                                    editScrollTarget.documentId ===
                                        activeTab.documentId
                                        ? editScrollTarget
                                        : null
                                }
                                onReady={() =>
                                    handleDocxReady(activeTab.documentId)
                                }
                                warning={activeTab.warning ?? null}
                                onWarningDismiss={() =>
                                    dismissTabWarning(activeTab.documentId)
                                }
                                initialScrollTop={activeTab.scrollTop ?? null}
                                onScrollChange={(top) =>
                                    handleTabScrollChange(
                                        activeTab.documentId,
                                        top,
                                    )
                                }
                                rounded={false}
                                onQuote={(text) =>
                                    chatInputRef.current?.addQuote({
                                        text,
                                        documentId: activeTab.documentId,
                                        documentTitle: activeTab.filename,
                                    })
                                }
                            />
                        ) : isSpreadsheetFilename(activeTab.filename) ? (
                            <SpreadsheetView
                                key={activeTab.documentId}
                                documentId={activeTab.documentId}
                                versionId={activeTab.versionId}
                                rounded={false}
                            />
                        ) : (
                            <PdfView
                                key={activeTab.documentId}
                                doc={{ document_id: activeTab.documentId }}
                                quotes={activeQuotes ?? undefined}
                                rounded={false}
                            />
                        )
                    ) : (
                        <div className="flex items-center justify-center h-full px-8 bg-gray-100">
                            <p className="font-serif text-gray-700 text-xl">
                                Pick a tab to read a document.
                            </p>
                        </div>
                    )}
                </div>
            </div>
        ),

        chat: (
            <div
                ref={assistantPanelRef}
                className="relative flex h-full min-h-0 flex-col"
                onDragOver={(e) => e.preventDefault()}
                onDrop={handleChatDrop}
            >
                <PaneHeader
                    paneId="chat"
                    label={PANE_LABELS.chat}
                    draggingPane={draggingPane}
                    hoverPane={hoverPane}
                    onStartDrag={startDrag}
                >
                    <span className="self-center truncate text-xs text-gray-700">
                        Project Assistant
                    </span>
                </PaneHeader>

                {/* Messages / greeting / shimmer */}
                {!chatLoaded ? (
                    <div className="flex-1 px-4 py-4">
                        <div className="mx-auto w-full max-w-3xl space-y-4">
                            <div className="flex justify-end">
                                <div className="bg-gray-100 rounded-2xl p-4 w-3/4">
                                    <div className="h-3 bg-gradient-to-r from-gray-200 via-gray-300 to-gray-200 bg-[length:200%_100%] animate-[shimmer_2s_ease-in-out_infinite] rounded w-full" />
                                </div>
                            </div>
                            <div className="space-y-2">
                                {[1, 2, 3].map((i) => (
                                    <div
                                        key={i}
                                        className={`h-3 bg-gradient-to-r from-gray-200 via-gray-300 to-gray-200 bg-[length:200%_100%] animate-[shimmer_2s_ease-in-out_infinite] rounded ${i === 3 ? "w-4/6" : "w-full"}`}
                                    />
                                ))}
                            </div>
                        </div>
                    </div>
                ) : messages.length === 0 ? (
                    <div className="flex-1 flex flex-col min-h-0">
                        <AssistantGreeting username={username} />
                    </div>
                ) : (
                    <div
                        ref={messagesContainerRef}
                        className="flex-1 overflow-y-auto px-4 pt-6 md:pt-8 min-h-0"
                        style={{
                            paddingBottom: DEFAULT_ASSISTANT_BOTTOM_PADDING,
                            scrollbarGutter: "stable",
                        }}
                    >
                        <div className="mx-auto w-full max-w-3xl space-y-6 md:space-y-8">
                            {(() => {
                                const lastUserIdx = messages
                                    .map((m) => m.role)
                                    .lastIndexOf("user");
                                const lastAssistantIdx = messages
                                    .map((m) => m.role)
                                    .lastIndexOf("assistant");
                                return messages.map((msg, i) =>
                                    msg.role === "user" ? (
                                        <div
                                            key={i}
                                            ref={
                                                i === lastUserIdx
                                                    ? latestUserMessageRef
                                                    : null
                                            }
                                        >
                                            <UserMessage
                                                content={msg.content ?? ""}
                                                files={msg.files}
                                                workflow={msg.workflow}
                                                onFileClick={(file) => {
                                                    if (!file.document_id)
                                                        return;
                                                    handleOpenDocument({
                                                        documentId:
                                                            file.document_id,
                                                        filename:
                                                            file.filename,
                                                        versionId: null,
                                                        versionNumber: null,
                                                    });
                                                }}
                                            />
                                        </div>
                                    ) : (
                                        <AssistantMessage
                                            key={i}
                                            events={msg.events}
                                            isStreaming={
                                                i === messages.length - 1 &&
                                                isResponseLoading
                                            }
                                            isError={!!msg.error}
                                            citations={msg.citations}
                                            citationStatus={msg.citationStatus}
                                            onCitationClick={
                                                handleCitationClick
                                            }
                                            minHeight={
                                                i === lastAssistantIdx
                                                    ? minHeight
                                                    : "0px"
                                            }
                                            onEditViewClick={
                                                handleEditViewClick
                                            }
                                            onOpenDocument={handleOpenDocument}
                                            onEditResolved={handleEditResolved}
                                            onEditError={handleEditError}
                                            isDocReloading={(docId) =>
                                                reloadingDocIds.has(docId)
                                            }
                                            onContinue={(args) =>
                                                void continueRun(args)
                                            }
                                            isContinuing={isResponseLoading}
                                        />
                                    ),
                                );
                            })()}
                            <div ref={messagesEndRef} />
                        </div>
                    </div>
                )}

                {/* ChatInput */}
                <div className="absolute bottom-2 left-0 right-0 z-30 w-full md:bottom-3">
                    <div className="pointer-events-none absolute -bottom-2 left-4 right-4 z-0 h-7 bg-white/50 backdrop-blur-[1px] md:-bottom-3" />
                    <div className="relative z-20 w-full px-4">
                        <div className="mx-auto w-full max-w-3xl">
                            <ChatInput
                                ref={chatInputRef}
                                onSubmit={handleSubmit}
                                onCancel={cancel}
                                isLoading={isResponseLoading}
                                attachOnly
                                dropZoneRef={assistantPanelRef}
                                projectId={projectId}
                                onDocumentClick={handleDocClick}
                                projectName={project?.name}
                                projectCmNumber={project?.cm_number}
                            />
                        </div>
                    </div>
                </div>
            </div>
        ),
    };

    return (
        <div className="flex flex-col h-full">
            {/* Page header */}
            <PageHeader
                shrink
                breadcrumbs={[
                    {
                        label: "Projects",
                        onClick: () => router.push("/projects"),
                    },
                    project
                        ? {
                              label: project.name,
                              onClick: () =>
                                  router.push(`/projects/${projectId}`),
                              title: "Back to project",
                          }
                        : {
                              loading: true,
                              skeletonClassName: "w-32",
                              onClick: () =>
                                  router.push(`/projects/${projectId}`),
                              title: "Back to project",
                          },
                    {
                        label: "Chats",
                        onClick: () =>
                            router.push(`/projects/${projectId}/assistant`),
                        title: "Back to Chats",
                    },
                    chatLoaded
                        ? {
                              label: chatTitle ?? "Untitled New Chat",
                          }
                        : {
                              loading: true,
                              skeletonClassName: "w-40",
                          },
                ]}
                actions={[
                    {
                        icon: (
                            <span className="relative inline-flex">
                                <ClipboardList className="h-4 w-4" />
                                {pendingSuggestions > 0 && !overviewOpen && (
                                    <span className="absolute -right-1.5 -top-1.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-blue-600 px-1 text-[9px] font-medium leading-none text-white">
                                        {pendingSuggestions}
                                    </span>
                                )}
                            </span>
                        ),
                        onClick: () => setOverviewOpen(!overviewOpen),
                        iconOnly: true,
                        title: overviewOpen
                            ? "Hide the case overview"
                            : pendingSuggestions > 0
                              ? `Case overview — ${pendingSuggestions} suggested fact${pendingSuggestions === 1 ? "" : "s"} waiting`
                              : "Show the case overview",
                    },
                    {
                        icon: <FolderClosed className="h-4 w-4" />,
                        onClick: () => setFilesOpen(!filesOpen),
                        iconOnly: true,
                        title: filesOpen
                            ? "Hide the matter's files"
                            : "Show the matter's files",
                    },
                    {
                        type: "new",
                        onClick: handleNewChat,
                        loading: creatingChat,
                        title: "New chat",
                    },
                    {
                        type: "custom",
                        render: (
                            <HeaderActionsMenu
                                items={[
                                    {
                                        label: overviewOpen
                                            ? "Hide case overview"
                                            : "Show case overview",
                                        icon: ClipboardList,
                                        onSelect: () =>
                                            setOverviewOpen(!overviewOpen),
                                    },
                                    {
                                        label: filesOpen
                                            ? "Hide files"
                                            : "Show files",
                                        icon: FolderClosed,
                                        onSelect: () => setFilesOpen(!filesOpen),
                                    },
                                    {
                                        label: "Reset panel layout",
                                        icon: Columns3,
                                        onSelect: resetLayout,
                                        disabled: isDefaultLayout,
                                    },
                                    {
                                        label: "Rename",
                                        icon: Pencil,
                                        onSelect: () =>
                                            void handleRenameChat(),
                                    },
                                    {
                                        label: deletingChat
                                            ? "Deleting..."
                                            : "Delete",
                                        icon: Trash2,
                                        onSelect: () =>
                                            void handleDeleteChat(),
                                        disabled: deletingChat,
                                        variant: "danger",
                                    },
                                ]}
                            />
                        ),
                    },
                ]}
            />

            {/* Panels, in whatever order and sizes the reader chose */}
            <div
                ref={paneRowRef}
                className="flex flex-1 min-h-0 border-t border-gray-200 overflow-hidden"
            >
                {laidOut.map((paneId, index) => (
                    <Fragment key={paneId}>
                        {index > 0 && (
                            <Divider
                                onDrag={(dx) =>
                                    handleDividerDrag(
                                        laidOut[index - 1],
                                        paneId,
                                        dx,
                                    )
                                }
                            />
                        )}
                        <div
                            style={{
                                flexGrow: layout.weights[paneId],
                                flexBasis: 0,
                            }}
                            className={`flex min-w-0 flex-col ${
                                index < laidOut.length - 1
                                    ? "border-r border-gray-200"
                                    : ""
                            }`}
                        >
                            {paneContent[paneId]}
                        </div>
                    </Fragment>
                ))}
            </div>

            <OwnerOnlyPopup
                open={!!ownerOnlyAction}
                action={ownerOnlyAction ?? undefined}
                onClose={() => setOwnerOnlyAction(null)}
            />
            <ConfirmPopup
                open={!!pendingDeleteFolder}
                title="Delete folder?"
                message={
                    pendingDeleteFolder ? (
                        <div className="space-y-2">
                            <p>
                                This will permanently delete{" "}
                                <span className="font-medium text-gray-950">
                                    {pendingDeleteFolder.folderIds.length}{" "}
                                    {pendingDeleteFolder.folderIds.length === 1
                                        ? "folder"
                                        : "folders"}
                                </span>
                                , including{" "}
                                <span className="font-medium text-gray-950">
                                    {pendingDeleteFolder.folder.name}
                                </span>
                                {pendingDeleteFolder.folderIds.length > 1
                                    ? " and its nested subfolders"
                                    : ""}
                                .
                            </p>
                            {pendingDeleteFolder.documentCount > 0 && (
                                <p>
                                    {pendingDeleteFolder.documentCount}{" "}
                                    {pendingDeleteFolder.documentCount === 1
                                        ? "document"
                                        : "documents"}{" "}
                                    in the deleted{" "}
                                    {pendingDeleteFolder.folderIds.length === 1
                                        ? "folder"
                                        : "folders"}{" "}
                                    will also be permanently deleted.
                                </p>
                            )}
                        </div>
                    ) : undefined
                }
                confirmLabel="Delete"
                confirmStatus={
                    pendingDeleteFolderStatus === "deleting"
                        ? "loading"
                        : pendingDeleteFolderStatus === "deleted"
                          ? "complete"
                          : "idle"
                }
                cancelLabel="Cancel"
                onCancel={() => {
                    if (pendingDeleteFolderStatus === "deleting") return;
                    clearFolderDeleteDismissTimer();
                    dispatchFolderDeleteDialog({ type: "cancel" });
                }}
                onConfirm={() => void confirmDeletePendingFolder()}
            />
        </div>
    );
}
