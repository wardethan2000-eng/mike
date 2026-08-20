"use client";

import { useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import {
    answerMatter,
    searchMatter,
    type MatterAnswer,
    type MatterAnswerCitation,
    type MatterSearchHit,
} from "@/app/lib/mikeApi";
import { SearchBar } from "@/app/components/ui/search-bar";
import { Button } from "@/app/components/ui/button";
import { useSelectedModel } from "@/app/hooks/useSelectedModel";
import { prefetchDocFile } from "@/app/lib/docFileCache";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

export type MatterSourceRequest = {
    documentId: string;
    filename: string;
    page: number | null;
    /** The passage to highlight once the document is open. */
    quote: string;
};

interface Props {
    projectId: string;
    /**
     * Called when the reader clicks a citation, a source, or a found passage.
     * The documents view opens that file beside the list, at that page, with the
     * words highlighted.
     */
    onOpenSource?: (source: MatterSourceRequest) => void;
}

const CITATION_LINK_PREFIX = "#mike-source-";

function escapeForRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Rewrites the citations the model wrote into markdown links, so each one
 * renders as something the reader can click. Anything that was not matched to a
 * real passage is left exactly as it was written.
 */
export function withCitationLinks(
    answer: string,
    citations: MatterAnswerCitation[],
): string {
    if (citations.length === 0) return answer;
    const indexByText = new Map<string, number>();
    citations.forEach((citation, index) => {
        if (!indexByText.has(citation.text)) indexByText.set(citation.text, index);
    });
    const texts = [...indexByText.keys()].sort((a, b) => b.length - a.length);
    const pattern = new RegExp(texts.map(escapeForRegExp).join("|"), "g");
    return answer.replace(pattern, (match) => {
        const index = indexByText.get(match);
        if (index == null) return match;
        const label = match.replace(/([\[\]])/g, "\\$1");
        return `[${label}](${CITATION_LINK_PREFIX}${index})`;
    });
}

function citationIndexFromHref(href: string | undefined): number | null {
    if (!href || !href.startsWith(CITATION_LINK_PREFIX)) return null;
    const index = Number(href.slice(CITATION_LINK_PREFIX.length));
    return Number.isInteger(index) && index >= 0 ? index : null;
}

function matchLabel(hit: { matchedBy: string; fromFilename: boolean }): string {
    if (hit.fromFilename) return "file name";
    if (hit.matchedBy === "meaning") return "meaning";
    if (hit.matchedBy === "similar") return "approximate";
    return "exact words";
}


// Quietly download the documents behind the results while the reader is still
// reading, so the click that follows opens the file from memory.
function prefetchTopDocuments(documentIds: string[], max = 8): void {
    const unique = [...new Set(documentIds)].slice(0, max);
    for (const id of unique) prefetchDocFile(id);
}

function whereLabel(page: number | null): string {
    return page != null ? `page ${page}` : "no page";
}

/**
 * Search a whole matter from the documents view. One box does both jobs: the
 * question is answered across the matter (with document-and-page citations),
 * and the matching passages are listed underneath, so a single search returns
 * everything. The heavy lifting is on the server (GET /search and
 * POST /search/answer); this only shows the results.
 */
export function MatterSearchPanel({ projectId, onOpenSource }: Props) {
    const [query, setQuery] = useState("");
    const [findLoading, setFindLoading] = useState(false);
    const [askLoading, setAskLoading] = useState(false);
    const [findError, setFindError] = useState<string | null>(null);
    const [askError, setAskError] = useState<string | null>(null);
    const [hits, setHits] = useState<MatterSearchHit[] | null>(null);
    const [answer, setAnswer] = useState<MatterAnswer | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    // Use whichever model the user has chosen in the app, so the answer works
    // with the provider they actually have set up (same model as the assistant).
    const [selectedModel] = useSelectedModel();

    const loading = findLoading || askLoading;

    function run() {
        const q = query.trim();
        if (!q) return;
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        setFindError(null);
        setAskError(null);
        setHits(null);
        setAnswer(null);

        // Both halves run at once: the passages come back quickly, the written
        // answer follows when the model finishes reading them.
        setFindLoading(true);
        void searchMatter(projectId, q, { limit: 25, signal: controller.signal })
            .then((res) => {
                setHits(res.results);
                prefetchTopDocuments(res.results.map((h) => h.documentId));
            })
            .catch((err) => {
                if ((err as { name?: string })?.name === "AbortError") return;
                setFindError(
                    "The search could not be completed. Please try again.",
                );
            })
            .finally(() => {
                if (abortRef.current === controller) setFindLoading(false);
            });

        setAskLoading(true);
        void answerMatter(projectId, q, {
            model: selectedModel,
            signal: controller.signal,
        })
            .then((res) => {
                setAnswer(res);
                prefetchTopDocuments([
                    ...(res.citations ?? []).map((c) => c.documentId),
                    ...res.sources.map((s) => s.documentId),
                ]);
            })
            .catch((err) => {
                if ((err as { name?: string })?.name === "AbortError") return;
                setAskError(
                    "An answer could not be produced. A model may not be set up yet — check Settings.",
                );
            })
            .finally(() => {
                if (abortRef.current === controller) setAskLoading(false);
            });
    }

    // A passage found in the file's name has no words inside the file, so there
    // is nothing to highlight — the document simply opens.
    function openHit(hit: {
        documentId: string;
        filename: string;
        page: number | null;
        content: string;
        fromFilename?: boolean;
    }) {
        onOpenSource?.({
            documentId: hit.documentId,
            filename: hit.filename,
            page: hit.page,
            quote: hit.fromFilename ? "" : hit.content,
        });
    }

    const showResults =
        loading || findError || askError || hits != null || answer != null;

    return (
        <div className="mx-4 mb-3 rounded-2xl border border-white/60 bg-white/55 p-3 shadow-[0_3px_12px_rgba(15,23,42,0.05)] backdrop-blur-xl md:mx-8">
            <div className="flex items-center gap-2">
                <div className="min-w-[200px] flex-1">
                    <SearchBar
                        value={query}
                        onValueChange={setQuery}
                        placeholder="Ask the matter a question, or find a word, name, or idea across every document…"
                        onKeyDown={(e) => {
                            if (e.key === "Enter") run();
                        }}
                    />
                </div>
                <Button
                    size="sm"
                    onClick={run}
                    disabled={loading || !query.trim()}
                >
                    {loading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                        "Search"
                    )}
                </Button>
            </div>

            {showResults && (
                <div className="mt-3 flex flex-col gap-3">
                    {/* The written answer, with clickable citations. */}
                    <div>
                        <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
                            Answer
                        </p>
                        {askLoading ? (
                            <p className="mt-1 flex items-center gap-1.5 text-sm text-gray-500">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                Reading the documents…
                            </p>
                        ) : askError ? (
                            <p className="mt-1 text-sm text-gray-500">
                                {askError}
                            </p>
                        ) : answer ? (
                            <div className="mt-1 text-sm text-gray-800 [&_p]:mb-2 [&_p:last-child]:mb-0 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:mb-0.5 [&_strong]:font-semibold [&_h1]:text-base [&_h1]:font-semibold [&_h2]:font-semibold [&_h3]:font-semibold [&_a]:underline">
                                <ReactMarkdown
                                    remarkPlugins={[remarkGfm]}
                                    components={{
                                        a: ({ href, children, ...rest }) => {
                                            const index =
                                                citationIndexFromHref(href);
                                            if (index == null)
                                                return (
                                                    <a href={href} {...rest}>
                                                        {children}
                                                    </a>
                                                );
                                            const citation = (
                                                answer.citations ?? []
                                            )[index];
                                            if (!citation)
                                                return <>{children}</>;
                                            return (
                                                <button
                                                    type="button"
                                                    onClick={() =>
                                                        onOpenSource?.({
                                                            documentId:
                                                                citation.documentId,
                                                            filename:
                                                                citation.filename,
                                                            page: citation.page,
                                                            quote: citation.quote,
                                                        })
                                                    }
                                                    disabled={!onOpenSource}
                                                    title={
                                                        onOpenSource
                                                            ? "Open this document at the cited passage"
                                                            : undefined
                                                    }
                                                    className="rounded-md px-1 py-px font-medium text-blue-700 underline decoration-blue-300 underline-offset-2 transition-colors enabled:hover:bg-blue-50 enabled:hover:decoration-blue-500 disabled:cursor-default disabled:text-gray-600 disabled:no-underline"
                                                >
                                                    {children}
                                                </button>
                                            );
                                        },
                                    }}
                                >
                                    {withCitationLinks(
                                        answer.answer,
                                        answer.citations ?? [],
                                    )}
                                </ReactMarkdown>
                            </div>
                        ) : null}
                        {answer && answer.sources.length > 0 && (
                            <div className="mt-2">
                                <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
                                    Sources
                                </p>
                                <ul className="mt-1 flex flex-wrap gap-1.5">
                                    {answer.sources.map((s, i) => (
                                        <li key={`${s.documentId}-${i}`}>
                                            <button
                                                type="button"
                                                onClick={() => openHit(s)}
                                                disabled={!onOpenSource}
                                                title={
                                                    onOpenSource
                                                        ? "Open this document at the passage"
                                                        : undefined
                                                }
                                                className="rounded-full border border-white/70 bg-white/70 px-2 py-0.5 text-xs text-gray-600 transition-colors enabled:hover:border-blue-300 enabled:hover:bg-white enabled:hover:text-gray-900 disabled:cursor-default"
                                            >
                                                {s.filename}
                                                {s.page != null
                                                    ? `, p${s.page}`
                                                    : ""}
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </div>

                    {/* Every passage that matched, clickable to open the page. */}
                    <div>
                        <p className="text-xs font-medium uppercase tracking-wide text-gray-400">
                            Passages
                        </p>
                        {findLoading ? (
                            <p className="mt-1 flex items-center gap-1.5 text-sm text-gray-500">
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                Searching…
                            </p>
                        ) : findError ? (
                            <p className="mt-1 text-sm text-red-600">
                                {findError}
                            </p>
                        ) : hits && hits.length === 0 ? (
                            <p className="mt-1 text-sm text-gray-500">
                                No passages match. The point may not be covered,
                                or a scanned document may have read poorly — try
                                different words.
                            </p>
                        ) : hits ? (
                            <ul className="mt-1 flex flex-col gap-2">
                                {hits.map((h, i) => (
                                    <li key={`${h.documentId}-${i}`}>
                                        <button
                                            type="button"
                                            onClick={() => openHit(h)}
                                            disabled={!onOpenSource}
                                            className="w-full rounded-xl border border-white/60 bg-white/60 px-3 py-2 text-left transition-colors enabled:hover:border-blue-300 enabled:hover:bg-white disabled:cursor-default"
                                            title={
                                                onOpenSource
                                                    ? "Open this document at the passage"
                                                    : undefined
                                            }
                                        >
                                            <div className="flex items-baseline justify-between gap-2">
                                                <span className="truncate text-sm font-medium text-gray-900">
                                                    {h.filename}
                                                </span>
                                                <span className="shrink-0 text-xs text-gray-500">
                                                    {whereLabel(h.page)} ·{" "}
                                                    {matchLabel(h)}
                                                </span>
                                            </div>
                                            <p className="mt-1 line-clamp-3 text-sm text-gray-600">
                                                {h.content}
                                            </p>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        ) : null}
                    </div>
                </div>
            )}
        </div>
    );
}
