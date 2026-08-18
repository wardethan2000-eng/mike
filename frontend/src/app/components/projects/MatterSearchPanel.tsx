"use client";

import { useRef, useState } from "react";
import { FileText, Loader2, Sparkles } from "lucide-react";
import {
    answerMatter,
    searchMatter,
    type MatterAnswer,
    type MatterSearchHit,
} from "@/app/lib/mikeApi";
import { SearchBar } from "@/app/components/ui/search-bar";
import { TabPillButton } from "@/app/components/ui/tab-pill-button";
import { Button } from "@/app/components/ui/button";
import { useSelectedModel } from "@/app/hooks/useSelectedModel";

type Mode = "find" | "ask";

interface Props {
    projectId: string;
}

function matchLabel(hit: { matchedBy: string; fromFilename: boolean }): string {
    if (hit.fromFilename) return "file name";
    if (hit.matchedBy === "meaning") return "meaning";
    if (hit.matchedBy === "similar") return "approximate";
    return "exact words";
}

function whereLabel(page: number | null): string {
    return page != null ? `page ${page}` : "no page";
}

/**
 * Search a whole matter from the documents view: find the passages that match a
 * word or a meaning, or ask a question and get one answer that cites the
 * document and page. The heavy lifting is on the server (GET /search and
 * POST /search/answer); this only shows the results.
 */
export function MatterSearchPanel({ projectId }: Props) {
    const [mode, setMode] = useState<Mode>("find");
    const [query, setQuery] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [hits, setHits] = useState<MatterSearchHit[] | null>(null);
    const [answer, setAnswer] = useState<MatterAnswer | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    // Use whichever model the user has chosen in the app, so "Ask" works with the
    // provider they actually have set up (the same model the assistant uses).
    const [selectedModel] = useSelectedModel();

    async function run() {
        const q = query.trim();
        if (!q) return;
        abortRef.current?.abort();
        const controller = new AbortController();
        abortRef.current = controller;
        setLoading(true);
        setError(null);
        try {
            if (mode === "find") {
                setAnswer(null);
                const res = await searchMatter(projectId, q, {
                    limit: 25,
                    signal: controller.signal,
                });
                setHits(res.results);
            } else {
                setHits(null);
                const res = await answerMatter(projectId, q, {
                    model: selectedModel,
                    signal: controller.signal,
                });
                setAnswer(res);
            }
        } catch (err) {
            if ((err as { name?: string })?.name === "AbortError") return;
            setError(
                mode === "find"
                    ? "The search could not be completed. Please try again."
                    : "An answer could not be produced. A model may not be set up yet — check Settings.",
            );
        } finally {
            setLoading(false);
        }
    }

    function switchMode(next: Mode) {
        if (next === mode) return;
        setMode(next);
        setError(null);
        setHits(null);
        setAnswer(null);
    }

    return (
        <div className="mb-3 rounded-2xl border border-white/60 bg-white/55 p-3 shadow-[0_3px_12px_rgba(15,23,42,0.05)] backdrop-blur-xl">
            <div className="flex flex-wrap items-center gap-2">
                <div className="flex items-center gap-1.5">
                    <TabPillButton
                        active={mode === "find"}
                        onClick={() => switchMode("find")}
                    >
                        <FileText className="h-3 w-3" />
                        Find passages
                    </TabPillButton>
                    <TabPillButton
                        active={mode === "ask"}
                        onClick={() => switchMode("ask")}
                    >
                        <Sparkles className="h-3 w-3" />
                        Ask the matter
                    </TabPillButton>
                </div>
                <div className="min-w-[200px] flex-1">
                    <SearchBar
                        value={query}
                        onValueChange={setQuery}
                        placeholder={
                            mode === "find"
                                ? "Find a word, name, or idea across every document…"
                                : "Ask a question of the whole matter…"
                        }
                        onKeyDown={(e) => {
                            if (e.key === "Enter") void run();
                        }}
                    />
                </div>
                <Button
                    size="sm"
                    onClick={() => void run()}
                    disabled={loading || !query.trim()}
                >
                    {loading ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                    ) : mode === "find" ? (
                        "Search"
                    ) : (
                        "Ask"
                    )}
                </Button>
            </div>

            {error && (
                <p className="mt-2 text-xs text-red-600">{error}</p>
            )}

            {mode === "find" && hits && !loading && (
                <div className="mt-3">
                    {hits.length === 0 ? (
                        <p className="text-xs text-gray-500">
                            No passages match. The point may not be covered, or a
                            scanned document may have read poorly — try different
                            words.
                        </p>
                    ) : (
                        <ul className="flex flex-col gap-2">
                            {hits.map((h, i) => (
                                <li
                                    key={`${h.documentId}-${i}`}
                                    className="rounded-xl border border-white/60 bg-white/60 px-3 py-2"
                                >
                                    <div className="flex items-baseline justify-between gap-2">
                                        <span className="truncate text-sm font-medium text-gray-900">
                                            {h.filename}
                                        </span>
                                        <span className="shrink-0 text-[11px] text-gray-500">
                                            {whereLabel(h.page)} · {matchLabel(h)}
                                        </span>
                                    </div>
                                    <p className="mt-1 line-clamp-3 text-xs text-gray-600">
                                        {h.content}
                                    </p>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}

            {mode === "ask" && answer && !loading && (
                <div className="mt-3">
                    <p className="whitespace-pre-wrap text-sm text-gray-800">
                        {answer.answer}
                    </p>
                    {answer.sources.length > 0 && (
                        <div className="mt-2">
                            <p className="text-[11px] font-medium uppercase tracking-wide text-gray-400">
                                Sources
                            </p>
                            <ul className="mt-1 flex flex-wrap gap-1.5">
                                {answer.sources.map((s, i) => (
                                    <li
                                        key={`${s.documentId}-${i}`}
                                        className="rounded-full border border-white/70 bg-white/70 px-2 py-0.5 text-[11px] text-gray-600"
                                    >
                                        {s.filename}
                                        {s.page != null ? `, p${s.page}` : ""}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
