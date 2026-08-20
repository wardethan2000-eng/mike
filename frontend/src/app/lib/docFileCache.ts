"use client";

import { supabase } from "@/app/lib/supabase";

/**
 * A small in-memory cache of document files, so opening a document the reader
 * was just shown — a citation, a search hit, a re-opened file — does not wait
 * on a fresh download. Search results prefetch their documents through this
 * cache the moment they arrive, which makes the later click feel immediate.
 *
 * Entries expire after a short while so a newly uploaded version is not hidden
 * behind a stale copy, and the cache is capped by total size so big scans
 * cannot pile up in memory.
 */
export type DocFile =
    | { type: "pdf"; buffer: ArrayBuffer }
    | { type: "spreadsheet"; buffer: ArrayBuffer }
    | { type: "docx"; buffer: null };

type Entry = {
    at: number;
    promise: Promise<DocFile>;
    bytes: number;
};

const TTL_MS = 10 * 60 * 1000;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;
const MAX_ENTRIES = 16;

const cache = new Map<string, Entry>();

function cacheKey(documentId: string, versionId?: string | null): string {
    return `${documentId}:${versionId ?? "current"}`;
}

function isSpreadsheetContentType(contentType: string): boolean {
    return (
        contentType.includes("spreadsheetml") || // .xlsx
        contentType.includes("ms-excel") // .xls / .xlsm
    );
}

async function download(
    documentId: string,
    versionId?: string | null,
): Promise<DocFile> {
    const {
        data: { session },
    } = await supabase.auth.getSession();
    const token = session?.access_token;
    const apiBase =
        process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
    const qs = versionId
        ? `?version_id=${encodeURIComponent(versionId)}`
        : "";
    const response = await fetch(
        `${apiBase}/single-documents/${documentId}/display${qs}`,
        {
            headers: token ? { Authorization: `Bearer ${token}` } : {},
        },
    );
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("application/pdf")) {
        return { type: "pdf", buffer: await response.arrayBuffer() };
    }
    if (isSpreadsheetContentType(contentType)) {
        return { type: "spreadsheet", buffer: await response.arrayBuffer() };
    }
    // DOC/DOCX render through their own viewer; drain the body so the
    // connection is reusable.
    await response.arrayBuffer().catch(() => {});
    return { type: "docx", buffer: null };
}

function evict() {
    const now = Date.now();
    let total = 0;
    for (const entry of cache.values()) total += entry.bytes;
    // Oldest first, until the caps hold. Stale entries always go.
    const keys = [...cache.entries()].sort((a, b) => a[1].at - b[1].at);
    for (const [key, entry] of keys) {
        const stale = now - entry.at > TTL_MS;
        const over =
            total > MAX_TOTAL_BYTES || cache.size > MAX_ENTRIES;
        if (!stale && !over) break;
        cache.delete(key);
        total -= entry.bytes;
    }
}

/**
 * The document's file, from the cache when it is fresh, downloading otherwise.
 * Concurrent callers share one download.
 */
export function fetchDocFile(
    documentId: string,
    versionId?: string | null,
): Promise<DocFile> {
    const key = cacheKey(documentId, versionId);
    const existing = cache.get(key);
    if (existing && Date.now() - existing.at <= TTL_MS) {
        return existing.promise;
    }
    const entry: Entry = {
        at: Date.now(),
        bytes: 0,
        promise: download(documentId, versionId).then(
            (file) => {
                entry.bytes = file.buffer?.byteLength ?? 0;
                evict();
                return file;
            },
            (err) => {
                // A failed download must not poison the cache — the next
                // attempt should try the network again.
                cache.delete(key);
                throw err;
            },
        ),
    };
    cache.set(key, entry);
    evict();
    return entry.promise;
}

/** Warm the cache in the background; failures are silent by design. */
export function prefetchDocFile(
    documentId: string,
    versionId?: string | null,
): void {
    void fetchDocFile(documentId, versionId).catch(() => {});
}

/**
 * Forget a document's cached file — call after uploading or restoring a
 * version so the panel shows the new copy, not the remembered one.
 */
export function invalidateDocFile(documentId: string): void {
    for (const key of [...cache.keys()]) {
        if (key.startsWith(`${documentId}:`)) cache.delete(key);
    }
}
