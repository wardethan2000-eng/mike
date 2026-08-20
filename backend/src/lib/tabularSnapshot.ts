import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

export type ReviewSnapshotColumn = { index: number; name: string };

export type ReviewSnapshotCell = {
    columnIndex: number;
    summary: string;
    reasoning: string;
};

export type ReviewSnapshotRow = {
    id: string;
    label: string;
    documentIds: string[];
    cells: ReviewSnapshotCell[];
};

export type ReviewSnapshot = {
    id: string;
    title: string;
    userId: string;
    projectId: string | null;
    columns: ReviewSnapshotColumn[];
    rows: ReviewSnapshotRow[];
    documents: { id: string; filename: string }[];
};

/**
 * A whole tabular review — its columns, its rows and every filled cell —
 * read in one go. Two things need this: saving the grid into a matter as a
 * spreadsheet, and letting the assistant read a grid it has been pointed at.
 * Neither wants to re-implement the row/source/cell joins.
 */
export async function loadReviewSnapshot(
    db: Db,
    reviewId: string,
): Promise<ReviewSnapshot | null> {
    const { data: review } = await db
        .from("tabular_reviews")
        .select("id, title, user_id, project_id, columns_config, shared_with")
        .eq("id", reviewId)
        .single();
    if (!review) return null;

    const columns = normalizeColumns(review.columns_config);

    const { data: rowRecords } = await db
        .from("tabular_review_rows")
        .select("id, label, document_id, sort_index")
        .eq("review_id", reviewId)
        .order("sort_index", { ascending: true });
    const rows = (rowRecords ?? []) as {
        id: string;
        label: string | null;
        document_id: string | null;
    }[];

    const sourcesByRow = new Map<string, string[]>();
    if (rows.length > 0) {
        const { data: sources } = await db
            .from("tabular_review_row_sources")
            .select("row_id, document_id, sort_index")
            .in(
                "row_id",
                rows.map((row) => row.id),
            )
            .order("sort_index", { ascending: true });
        for (const source of sources ?? []) {
            const existing = sourcesByRow.get(source.row_id) ?? [];
            existing.push(source.document_id);
            sourcesByRow.set(source.row_id, existing);
        }
    }

    const { data: cellRecords } = await db
        .from("tabular_cells")
        .select("row_id, column_index, content, status")
        .eq("review_id", reviewId);
    const cellsByRow = new Map<string, ReviewSnapshotCell[]>();
    for (const cell of cellRecords ?? []) {
        // A cell still waiting, still being written, or one that failed has
        // nothing to say.
        if (cell.status !== "done") continue;
        const content = parseContent(cell.content);
        if (!content) continue;
        const existing = cellsByRow.get(cell.row_id) ?? [];
        existing.push({
            columnIndex: Number(cell.column_index),
            summary: content.summary,
            reasoning: content.reasoning,
        });
        cellsByRow.set(cell.row_id, existing);
    }

    const documentIds = [
        ...new Set(
            rows.flatMap(
                (row) =>
                    sourcesByRow.get(row.id) ??
                    (row.document_id ? [row.document_id] : []),
            ),
        ),
    ];
    const { data: documentRecords } =
        documentIds.length > 0
            ? await db
                  .from("documents")
                  .select("id, filename")
                  .in("id", documentIds)
            : { data: [] };

    return {
        id: review.id,
        title: review.title || "Untitled grid",
        userId: review.user_id,
        projectId: review.project_id ?? null,
        columns,
        rows: rows.map((row) => ({
            id: row.id,
            label: row.label || "Untitled row",
            documentIds:
                sourcesByRow.get(row.id) ??
                (row.document_id ? [row.document_id] : []),
            cells: (cellsByRow.get(row.id) ?? []).sort(
                (a, b) => a.columnIndex - b.columnIndex,
            ),
        })),
        documents: (documentRecords ?? []) as { id: string; filename: string }[],
    };
}

function normalizeColumns(raw: unknown): ReviewSnapshotColumn[] {
    if (!Array.isArray(raw)) return [];
    return raw
        .map((entry, fallbackIndex) => {
            if (!entry || typeof entry !== "object") return null;
            const column = entry as { index?: unknown; name?: unknown };
            return {
                index:
                    typeof column.index === "number"
                        ? column.index
                        : fallbackIndex,
                name: String(column.name ?? `Column ${fallbackIndex + 1}`),
            };
        })
        .filter((column): column is ReviewSnapshotColumn => column !== null)
        .sort((a, b) => a.index - b.index);
}

function parseContent(
    raw: unknown,
): { summary: string; reasoning: string } | null {
    let value = raw;
    if (typeof value === "string") {
        const text = value;
        try {
            value = JSON.parse(text) as unknown;
        } catch {
            return { summary: text, reasoning: "" };
        }
    }
    if (!value || typeof value !== "object") return null;
    const content = value as { summary?: unknown; reasoning?: unknown };
    return {
        summary: String(content.summary ?? ""),
        reasoning: String(content.reasoning ?? ""),
    };
}

/**
 * Citations are markers the web page turns into links. A spreadsheet cannot
 * follow a link back into a document, so they come out; plain double-bracket
 * tags such as [[Yes]] keep their word and lose the brackets.
 */
export function stripCitations(text: string): string {
    return text
        .replace(/\[\[document:[\s\S]*?\]\]/g, "")
        .replace(/§\d+§/g, "")
        .replace(/\[\[([^\]]+)\]\]/g, "$1")
        .replace(/[ \t]+/g, " ")
        .trim();
}

/**
 * The grid as workbook sheets: the grid itself, then which documents each
 * row was read from, so the saved copy still says where a figure came from.
 */
export function snapshotToSheets(snapshot: ReviewSnapshot): {
    name: string;
    columns: string[];
    rows: string[][];
}[] {
    const filenames = new Map(
        snapshot.documents.map((document) => [document.id, document.filename]),
    );
    const grid = {
        name: "Grid",
        columns: [
            "Folder / document",
            ...snapshot.columns.map((column) => column.name),
        ],
        rows: snapshot.rows.map((row) => {
            const byIndex = new Map(
                row.cells.map((cell) => [cell.columnIndex, cell]),
            );
            return [
                row.label,
                ...snapshot.columns.map((column) =>
                    stripCitations(byIndex.get(column.index)?.summary ?? ""),
                ),
            ];
        }),
    };
    const sources = {
        name: "Sources",
        columns: ["Row", "Document"],
        rows: snapshot.rows.flatMap((row) =>
            row.documentIds.length > 0
                ? row.documentIds.map((id) => [
                      row.label,
                      filenames.get(id) ?? id,
                  ])
                : [[row.label, ""]],
        ),
    };
    return [grid, sources];
}

const MAX_REASONING = 700;
const MAX_TEXT = 60000;

/**
 * The grid written out for the assistant to read. Citations are kept exactly
 * as they are, so a draft built from the grid can carry them through to the
 * answer and still open the right page of the right document.
 */
export function snapshotToText(snapshot: ReviewSnapshot): string {
    const filenames = new Map(
        snapshot.documents.map((document) => [document.id, document.filename]),
    );
    const lines: string[] = [];
    lines.push(`Grid: ${snapshot.title}`);
    lines.push(
        `${snapshot.rows.length} row(s), ${snapshot.columns.length} column(s).`,
    );
    lines.push(
        `Columns: ${snapshot.columns.map((column) => column.name).join(" | ")}`,
    );
    for (const row of snapshot.rows) {
        const documents = row.documentIds
            .map((id) => filenames.get(id) ?? id)
            .join(", ");
        lines.push("");
        lines.push(`Row: ${row.label}${documents ? ` (${documents})` : ""}`);
        const byIndex = new Map(
            row.cells.map((cell) => [cell.columnIndex, cell]),
        );
        for (const column of snapshot.columns) {
            const cell = byIndex.get(column.index);
            if (!cell) continue;
            lines.push(`  ${column.name}: ${cell.summary || "(blank)"}`);
            if (cell.reasoning) {
                const reasoning =
                    cell.reasoning.length > MAX_REASONING
                        ? `${cell.reasoning.slice(0, MAX_REASONING)}…`
                        : cell.reasoning;
                lines.push(`    basis: ${reasoning}`);
            }
        }
    }
    const text = lines.join("\n");
    return text.length > MAX_TEXT
        ? `${text.slice(0, MAX_TEXT)}\n… (grid truncated)`
        : text;
}
