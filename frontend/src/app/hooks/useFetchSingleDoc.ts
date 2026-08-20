"use client";

import { useEffect, useRef, useState } from "react";
import { fetchDocFile } from "@/app/lib/docFileCache";

/**
 * /display returns PDF bytes (when the active version has a PDF rendition),
 * raw spreadsheet bytes (xlsx/xlsm/xls — never converted to PDF), or raw DOCX
 * bytes otherwise. Reporting the type lets the caller swap between PdfView
 * (PDF.js), SpreadsheetView (Fortune-sheet), and DocxView (docx-preview).
 *
 * Files come through a small in-memory cache (see docFileCache), so a document
 * that was prefetched by a search result — or opened moments ago — appears
 * without a fresh download.
 */
export type DocResult =
    | { type: "pdf"; buffer: ArrayBuffer }
    | { type: "spreadsheet"; buffer: ArrayBuffer }
    | { type: "docx" }
    | null;

export function useFetchSingleDoc(
    documentId: string | null | undefined,
    versionId?: string | null,
) {
    const [result, setResult] = useState<DocResult>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const prevKeyRef = useRef<string | null>(null);

    useEffect(() => {
        if (!documentId) return;
        const requestKey = `${documentId}:${versionId ?? "current"}`;
        if (requestKey === prevKeyRef.current) return;
        prevKeyRef.current = requestKey;

        setLoading(true);
        setError(null);
        setResult(null);

        let cancelled = false;

        (async () => {
            try {
                const file = await fetchDocFile(documentId, versionId);
                if (cancelled) return;
                if (file.type === "docx") {
                    setResult({ type: "docx" });
                } else {
                    // PDF.js takes ownership of the bytes it is given and
                    // leaves them unusable, so every reader gets its own copy
                    // and the cached original stays whole.
                    setResult({
                        type: file.type,
                        buffer: file.buffer.slice(0),
                    });
                }
            } catch {
                if (!cancelled) setError("Failed to load document.");
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => {
            cancelled = true;
            prevKeyRef.current = null;
        };
    }, [documentId, versionId]);

    return { result, loading, error };
}
