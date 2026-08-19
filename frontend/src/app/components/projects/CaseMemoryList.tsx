"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pin, Pencil, History, Trash2, Plus, X, Check } from "lucide-react";
import {
    createProjectMemory,
    deleteProjectMemory,
    listProjectMemories,
    supersedeProjectMemory,
    updateProjectMemory,
    type MemoryCategory,
    type ProjectMemory,
} from "@/app/lib/mikeApi";
import type { Document } from "@/app/components/shared/types";

/**
 * The facts a matter has remembered: who the parties are, the dates that
 * matter, the position taken, what was decided, what is still open, and how
 * the firm wants things drafted.
 *
 * They are sent to the assistant with every question asked in the matter, so
 * they are short by design. Each one can point back at the document and page
 * it came from, so it can be checked rather than taken on trust.
 *
 * A fact that has changed is replaced rather than overwritten: the old wording
 * stays behind the new one, so a deadline that moved twice still reads as a
 * history rather than as a single number that was quietly edited.
 */

/** The longest a single fact may be. Matches the cap the server enforces. */
const BODY_MAX_CHARS = 500;

/** How long a "could not save" note stays up before it takes itself away. */
const NOTICE_TIMEOUT_MS = 6000;

const CATEGORIES: { id: MemoryCategory; label: string; hint: string }[] = [
    { id: "parties", label: "Parties", hint: "Who is who, and what they do" },
    { id: "dates", label: "Dates", hint: "Deadlines and hearings" },
    { id: "position", label: "Position", hint: "What we are arguing for" },
    { id: "decisions", label: "Decisions", hint: "What has been settled" },
    { id: "questions", label: "Open", hint: "Still to be answered" },
    { id: "drafting", label: "Drafting", hint: "How documents should look" },
];

const CATEGORY_HEADINGS: Record<MemoryCategory, string> = {
    parties: "Parties and roles",
    dates: "Key dates",
    position: "Our position",
    decisions: "Decisions made",
    questions: "Open questions",
    drafting: "Drafting preferences",
};

function CategoryPicker({
    value,
    onChange,
    disabled,
}: {
    value: MemoryCategory;
    onChange: (category: MemoryCategory) => void;
    disabled?: boolean;
}) {
    return (
        <div className="flex flex-wrap gap-1">
            {CATEGORIES.map((category) => (
                <button
                    key={category.id}
                    type="button"
                    disabled={disabled}
                    title={category.hint}
                    onClick={() => onChange(category.id)}
                    className={`rounded-full border px-2 py-0.5 text-xs transition-colors disabled:opacity-50 ${
                        value === category.id
                            ? "border-gray-800 bg-gray-800 text-white"
                            : "border-gray-200 text-gray-600 hover:border-gray-400"
                    }`}
                >
                    {category.label}
                </button>
            ))}
        </div>
    );
}

/**
 * Where a fact came from. Optional — plenty of facts are simply known — but
 * when it is set, the fact can be checked against the file it came out of.
 */
function SourcePicker({
    documents,
    documentId,
    page,
    onChange,
    disabled,
}: {
    documents: Document[];
    documentId: string | null;
    page: number | null;
    onChange: (documentId: string | null, page: number | null) => void;
    disabled?: boolean;
}) {
    return (
        <div className="flex items-center gap-1">
            <select
                value={documentId ?? ""}
                disabled={disabled}
                onChange={(e) =>
                    onChange(e.target.value || null, e.target.value ? page : null)
                }
                className="min-w-0 flex-1 rounded border border-gray-200 px-1.5 py-1 text-xs text-gray-700 disabled:opacity-50"
            >
                <option value="">No source document</option>
                {documents.map((document) => (
                    <option key={document.id} value={document.id}>
                        {document.filename}
                    </option>
                ))}
            </select>
            {documentId && (
                <input
                    type="number"
                    min={1}
                    value={page ?? ""}
                    disabled={disabled}
                    placeholder="Page"
                    onChange={(e) =>
                        onChange(
                            documentId,
                            e.target.value ? Number(e.target.value) : null,
                        )
                    }
                    className="w-16 shrink-0 rounded border border-gray-200 px-1.5 py-1 text-xs text-gray-700 disabled:opacity-50"
                />
            )}
        </div>
    );
}

/** The writing box, used both for a new fact and for changing an existing one. */
function FactEditor({
    initialBody,
    initialCategory,
    initialDocumentId,
    initialPage,
    documents,
    saveLabel,
    busy,
    onCancel,
    onSave,
}: {
    initialBody: string;
    initialCategory: MemoryCategory;
    initialDocumentId: string | null;
    initialPage: number | null;
    documents: Document[];
    saveLabel: string;
    busy: boolean;
    onCancel: () => void;
    onSave: (values: {
        body: string;
        category: MemoryCategory;
        documentId: string | null;
        page: number | null;
    }) => void;
}) {
    const [body, setBody] = useState(initialBody);
    const [category, setCategory] = useState<MemoryCategory>(initialCategory);
    const [documentId, setDocumentId] = useState(initialDocumentId);
    const [page, setPage] = useState(initialPage);
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        textareaRef.current?.focus();
    }, []);

    const canSave = body.trim().length > 0 && !busy;

    return (
        <div className="space-y-2 rounded border border-gray-300 bg-white p-2">
            <textarea
                ref={textareaRef}
                value={body}
                maxLength={BODY_MAX_CHARS}
                rows={3}
                onChange={(e) => setBody(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Escape") onCancel();
                    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSave) {
                        onSave({ body, category, documentId, page });
                    }
                }}
                placeholder="One fact, in a line or two."
                className="w-full resize-none rounded border border-gray-200 p-2 text-sm leading-relaxed text-gray-800 outline-none placeholder:text-gray-400 focus:border-gray-400"
            />
            <CategoryPicker
                value={category}
                onChange={setCategory}
                disabled={busy}
            />
            <SourcePicker
                documents={documents}
                documentId={documentId}
                page={page}
                onChange={(nextDocument, nextPage) => {
                    setDocumentId(nextDocument);
                    setPage(nextPage);
                }}
                disabled={busy}
            />
            <div className="flex items-center justify-end gap-1">
                <button
                    type="button"
                    onClick={onCancel}
                    disabled={busy}
                    className="rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 disabled:opacity-50"
                >
                    Cancel
                </button>
                <button
                    type="button"
                    onClick={() => onSave({ body, category, documentId, page })}
                    disabled={!canSave}
                    className="flex items-center gap-1 rounded bg-gray-800 px-2 py-1 text-xs text-white hover:bg-gray-700 disabled:opacity-40"
                >
                    <Check className="h-3 w-3" />
                    {saveLabel}
                </button>
            </div>
        </div>
    );
}

export function CaseMemoryList({
    projectId,
    documents,
    canEdit,
    onOpenDocument,
}: {
    projectId: string;
    /** The matter's files, so a fact can point at the one it came from. */
    documents: Document[];
    canEdit: boolean;
    onOpenDocument?: (documentId: string, filename: string) => void;
}) {
    const [memories, setMemories] = useState<ProjectMemory[] | null>(null);
    const [adding, setAdding] = useState(false);
    /** The fact being changed, and whether that change replaces or corrects it. */
    const [editing, setEditing] = useState<{
        id: string;
        mode: "correct" | "replace";
    } | null>(null);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const noticeTimerRef = useRef<number | null>(null);

    // A note about something the reader can simply try again should take
    // itself away rather than sit across the panel.
    const showNotice = useCallback((message: string) => {
        setNotice(message);
        if (noticeTimerRef.current !== null) {
            window.clearTimeout(noticeTimerRef.current);
        }
        noticeTimerRef.current = window.setTimeout(
            () => setNotice(null),
            NOTICE_TIMEOUT_MS,
        );
    }, []);

    useEffect(() => {
        let cancelled = false;
        listProjectMemories(projectId)
            .then((loaded) => {
                if (!cancelled) setMemories(loaded);
            })
            .catch(() => {
                if (!cancelled) setMemories([]);
            });
        return () => {
            cancelled = true;
        };
    }, [projectId]);

    const documentsById = useMemo(() => {
        const byId = new Map<string, Document>();
        for (const document of documents) byId.set(document.id, document);
        return byId;
    }, [documents]);

    const grouped = useMemo(() => {
        const groups = new Map<MemoryCategory, ProjectMemory[]>();
        for (const memory of memories ?? []) {
            const list = groups.get(memory.category) ?? [];
            list.push(memory);
            groups.set(memory.category, list);
        }
        // Pinned facts float to the top of their own group.
        for (const list of groups.values()) {
            list.sort((a, b) => Number(b.pinned) - Number(a.pinned));
        }
        return CATEGORIES.map((category) => ({
            category: category.id,
            heading: CATEGORY_HEADINGS[category.id],
            items: groups.get(category.id) ?? [],
        })).filter((group) => group.items.length > 0);
    }, [memories]);

    async function handleAdd(values: {
        body: string;
        category: MemoryCategory;
        documentId: string | null;
        page: number | null;
    }) {
        setBusyId("new");
        try {
            const created = await createProjectMemory(projectId, {
                body: values.body,
                category: values.category,
                source_document_id: values.documentId,
                source_page: values.page,
            });
            setMemories((prev) => [...(prev ?? []), created]);
            setAdding(false);
        } catch {
            showNotice("That fact could not be saved. Try again.");
        } finally {
            setBusyId(null);
        }
    }

    async function handleSaveEdit(
        memory: ProjectMemory,
        mode: "correct" | "replace",
        values: {
            body: string;
            category: MemoryCategory;
            documentId: string | null;
            page: number | null;
        },
    ) {
        setBusyId(memory.id);
        try {
            if (mode === "correct") {
                const updated = await updateProjectMemory(projectId, memory.id, {
                    body: values.body,
                    category: values.category,
                    source_document_id: values.documentId,
                    source_page: values.page,
                });
                setMemories((prev) =>
                    (prev ?? []).map((m) => (m.id === memory.id ? updated : m)),
                );
            } else {
                const replacement = await supersedeProjectMemory(
                    projectId,
                    memory.id,
                    {
                        body: values.body,
                        category: values.category,
                        source_document_id: values.documentId,
                        source_page: values.page,
                    },
                );
                setMemories((prev) =>
                    (prev ?? []).map((m) =>
                        m.id === memory.id ? replacement : m,
                    ),
                );
            }
            setEditing(null);
        } catch {
            showNotice("That change could not be saved. Try again.");
        } finally {
            setBusyId(null);
        }
    }

    async function handlePin(memory: ProjectMemory) {
        setBusyId(memory.id);
        try {
            const updated = await updateProjectMemory(projectId, memory.id, {
                pinned: !memory.pinned,
            });
            setMemories((prev) =>
                (prev ?? []).map((m) => (m.id === memory.id ? updated : m)),
            );
        } catch {
            showNotice("That could not be changed. Try again.");
        } finally {
            setBusyId(null);
        }
    }

    async function handleDelete(memory: ProjectMemory) {
        setBusyId(memory.id);
        try {
            await deleteProjectMemory(projectId, memory.id);
            setMemories((prev) =>
                (prev ?? []).filter((m) => m.id !== memory.id),
            );
        } catch {
            showNotice("That fact could not be removed. Try again.");
        } finally {
            setBusyId(null);
        }
    }

    const total = memories?.length ?? 0;

    return (
        <div className="flex min-h-0 flex-col">
            <div className="flex items-center justify-between gap-2 px-3 pt-3">
                <h3 className="text-xs font-medium text-gray-700">
                    Remembered facts{total > 0 ? ` (${total})` : ""}
                </h3>
                {canEdit && !adding && (
                    <button
                        type="button"
                        onClick={() => setAdding(true)}
                        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-gray-500 hover:bg-gray-100 hover:text-gray-800"
                    >
                        <Plus className="h-3 w-3" />
                        Add
                    </button>
                )}
            </div>

            <p className="px-3 pb-2 pt-1 text-xs leading-relaxed text-gray-500">
                Short facts about this matter, sent with every question along
                with the instructions above.
            </p>

            {notice && (
                <div className="mx-3 mb-2 flex items-start gap-2 rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-800">
                    <span className="min-w-0 flex-1">{notice}</span>
                    <button
                        type="button"
                        onClick={() => setNotice(null)}
                        title="Dismiss"
                        className="shrink-0 rounded p-0.5 hover:bg-amber-100"
                    >
                        <X className="h-3 w-3" />
                    </button>
                </div>
            )}

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-3">
                {adding && (
                    <FactEditor
                        initialBody=""
                        initialCategory="parties"
                        initialDocumentId={null}
                        initialPage={null}
                        documents={documents}
                        saveLabel="Add"
                        busy={busyId === "new"}
                        onCancel={() => setAdding(false)}
                        onSave={handleAdd}
                    />
                )}

                {memories === null ? (
                    <p className="text-xs text-gray-400">Loading…</p>
                ) : total === 0 && !adding ? (
                    <p className="text-xs leading-relaxed text-gray-400">
                        Nothing remembered yet. Add the things you would
                        otherwise have to repeat — the trial date, who acts for
                        whom, what has already been decided.
                    </p>
                ) : (
                    grouped.map((group) => (
                        <div key={group.category} className="space-y-1.5">
                            <h4 className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
                                {group.heading}
                            </h4>
                            {group.items.map((memory) => {
                                const isEditing = editing?.id === memory.id;
                                if (isEditing) {
                                    return (
                                        <FactEditor
                                            key={memory.id}
                                            initialBody={
                                                editing.mode === "replace"
                                                    ? memory.body
                                                    : memory.body
                                            }
                                            initialCategory={memory.category}
                                            initialDocumentId={
                                                memory.source_document_id
                                            }
                                            initialPage={memory.source_page}
                                            documents={documents}
                                            saveLabel={
                                                editing.mode === "replace"
                                                    ? "Replace"
                                                    : "Save"
                                            }
                                            busy={busyId === memory.id}
                                            onCancel={() => setEditing(null)}
                                            onSave={(values) =>
                                                void handleSaveEdit(
                                                    memory,
                                                    editing.mode,
                                                    values,
                                                )
                                            }
                                        />
                                    );
                                }

                                const source = memory.source_document_id
                                    ? documentsById.get(
                                          memory.source_document_id,
                                      )
                                    : undefined;

                                return (
                                    <div
                                        key={memory.id}
                                        className="group rounded border border-transparent px-1.5 py-1 hover:border-gray-200 hover:bg-gray-50"
                                    >
                                        <div className="flex items-start gap-1.5">
                                            {memory.pinned && (
                                                <Pin className="mt-0.5 h-3 w-3 shrink-0 fill-current text-gray-500" />
                                            )}
                                            <p className="min-w-0 flex-1 whitespace-pre-wrap text-sm leading-relaxed text-gray-800">
                                                {memory.body}
                                            </p>
                                        </div>

                                        <div className="mt-0.5 flex items-center justify-between gap-2">
                                            {source ? (
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        onOpenDocument?.(
                                                            source.id,
                                                            source.filename,
                                                        )
                                                    }
                                                    className="min-w-0 truncate text-left text-[11px] text-blue-600 hover:underline"
                                                >
                                                    {source.filename}
                                                    {memory.source_page
                                                        ? `, p. ${memory.source_page}`
                                                        : ""}
                                                </button>
                                            ) : (
                                                <span className="text-[11px] text-gray-300">
                                                    No source
                                                </span>
                                            )}

                                            {canEdit && (
                                                <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                                                    <button
                                                        type="button"
                                                        title={
                                                            memory.pinned
                                                                ? "Stop always sending this"
                                                                : "Always send this"
                                                        }
                                                        disabled={
                                                            busyId === memory.id
                                                        }
                                                        onClick={() =>
                                                            void handlePin(
                                                                memory,
                                                            )
                                                        }
                                                        className={`rounded p-1 hover:bg-gray-200 disabled:opacity-40 ${
                                                            memory.pinned
                                                                ? "text-gray-700"
                                                                : "text-gray-400"
                                                        }`}
                                                    >
                                                        <Pin className="h-3 w-3" />
                                                    </button>
                                                    <button
                                                        type="button"
                                                        title="Fix the wording"
                                                        disabled={
                                                            busyId === memory.id
                                                        }
                                                        onClick={() =>
                                                            setEditing({
                                                                id: memory.id,
                                                                mode: "correct",
                                                            })
                                                        }
                                                        className="rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-700 disabled:opacity-40"
                                                    >
                                                        <Pencil className="h-3 w-3" />
                                                    </button>
                                                    <button
                                                        type="button"
                                                        title="This has changed — replace it, keeping the old wording behind it"
                                                        disabled={
                                                            busyId === memory.id
                                                        }
                                                        onClick={() =>
                                                            setEditing({
                                                                id: memory.id,
                                                                mode: "replace",
                                                            })
                                                        }
                                                        className="rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-700 disabled:opacity-40"
                                                    >
                                                        <History className="h-3 w-3" />
                                                    </button>
                                                    <button
                                                        type="button"
                                                        title="Remove — for a fact that should never have been written down"
                                                        disabled={
                                                            busyId === memory.id
                                                        }
                                                        onClick={() =>
                                                            void handleDelete(
                                                                memory,
                                                            )
                                                        }
                                                        className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-40"
                                                    >
                                                        <Trash2 className="h-3 w-3" />
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    ))
                )}
            </div>
        </div>
    );
}
