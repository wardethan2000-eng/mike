import { Router } from "express";
import { requireAuth } from "../middleware/auth";
import { createServerSupabase } from "../lib/supabase";
import { deleteFile } from "../lib/storage";
import {
  attachActiveVersionPaths,
  attachLatestVersionNumbers,
} from "../lib/documentVersions";
import { singleFileUpload } from "../lib/upload";
import { handleDocumentUpload } from "./documents";
import { parsePaginationQuery, type PaginationParams } from "../lib/pagination";
import { normalizeSearchTerm } from "../lib/search";
import {
  applyLibraryScope,
  publishDocumentToFirm,
  resolveLibraryScope,
  type ResolvedLibraryScope,
} from "../lib/firmLibrary";
import { checkProjectAccess } from "../lib/access";
import { recordAudit } from "../lib/audit";

export const libraryRouter = Router();

const NOT_IN_THE_FIRM = {
  detail: "The firm library is only for people at the firm.",
};
const NOT_ALLOWED_TO_EDIT = {
  detail: "Only an administrator can change the firm library.",
};

type LibraryKind = "file" | "template";
type LibraryDocumentSortKey =
  | "name"
  | "type"
  | "size"
  | "version"
  | "created"
  | "updated";

const LIBRARY_DOCUMENT_SORT_KEYS: LibraryDocumentSortKey[] = [
  "name",
  "type",
  "size",
  "version",
  "created",
  "updated",
];
const LIBRARY_IDS_PAGE_SIZE = 1000;
const LIBRARY_IDS_MAX_PAGES = 50;
const LIBRARY_BULK_DELETE_BATCH_SIZE = 100;

function parseLibraryDocumentSort(query: Record<string, unknown>): {
  key: LibraryDocumentSortKey;
  direction: "asc" | "desc";
} {
  const rawKey = typeof query.sort_key === "string" ? query.sort_key : null;
  return {
    key:
      rawKey && LIBRARY_DOCUMENT_SORT_KEYS.includes(rawKey as LibraryDocumentSortKey)
        ? (rawKey as LibraryDocumentSortKey)
        : "updated",
    direction: query.sort_direction === "asc" ? "asc" : "desc",
  };
}

function normalizeLibraryKind(value: unknown): LibraryKind | null {
  if (value === "file" || value === "files") return "file";
  if (value === "template" || value === "templates") return "template";
  return null;
}

function normalizeDocumentFilename(nextName: unknown, currentName: string) {
  if (typeof nextName !== "string") return null;
  const trimmed = nextName.trim().slice(0, 200);
  if (!trimmed) return null;
  if (/\.[a-z0-9]{1,6}$/i.test(trimmed)) return trimmed;
  const ext = currentName.match(/\.[a-z0-9]{1,6}$/i)?.[0] ?? "";
  return `${trimmed}${ext}`;
}

function mapLibraryDocument<T extends Record<string, unknown>>(
  doc: T,
  scope: LibraryScopeName = "personal",
) {
  return {
    ...doc,
    folder_id: (doc.library_folder_id as string | null | undefined) ?? null,
    scope,
  };
}

type LibraryScopeName = "personal" | "firm";

async function loadLibraryFolder(
  db: ReturnType<typeof createServerSupabase>,
  userId: string,
  kind: LibraryKind,
  folderId: string,
  scope: ResolvedLibraryScope,
): Promise<{ id: string; parent_folder_id: string | null } | null> {
  const { data } = await applyLibraryScope(
    db
      .from("library_folders")
      .select("id, parent_folder_id")
      .eq("id", folderId)
      .eq("library_kind", kind),
    scope,
    userId,
  ).maybeSingle();
  return (
    (data as { id: string; parent_folder_id: string | null } | null) ?? null
  );
}

async function deleteLibraryDocumentsAndVersionFiles(
  db: ReturnType<typeof createServerSupabase>,
  userId: string,
  kind: LibraryKind,
  documentIds: string[],
  scope: ResolvedLibraryScope,
) {
  if (documentIds.length === 0) return { error: null, deletedIds: [] };
  let eligibleQuery = applyLibraryScope(
    db.from("documents").select("id"),
    scope,
    userId,
  ).is("project_id", null);
  eligibleQuery =
    kind === "file"
      ? eligibleQuery.or("library_kind.eq.file,library_kind.is.null")
      : eligibleQuery.eq("library_kind", kind);
  const { data: eligibleDocuments, error: eligibleError } =
    await eligibleQuery.in("id", documentIds);
  if (eligibleError) return { error: eligibleError, deletedIds: [] };
  const eligibleIds = (eligibleDocuments ?? []).map(
    (document) => document.id as string,
  );
  if (eligibleIds.length === 0) return { error: null, deletedIds: [] };

  const { data: versions, error: versionsError } = await db
    .from("document_versions")
    .select("storage_path, pdf_storage_path")
    .in("document_id", eligibleIds);
  if (versionsError) return { error: versionsError, deletedIds: [] };

  const paths = new Set<string>();
  for (const version of versions ?? []) {
    if (typeof version.storage_path === "string" && version.storage_path) {
      paths.add(version.storage_path);
    }
    if (
      typeof version.pdf_storage_path === "string" &&
      version.pdf_storage_path
    ) {
      paths.add(version.pdf_storage_path);
    }
  }
  await Promise.all([...paths].map((path) => deleteFile(path).catch(() => {})));

  let deleteQuery = applyLibraryScope(
    db.from("documents").delete(),
    scope,
    userId,
  ).is("project_id", null);
  deleteQuery =
    kind === "file"
      ? deleteQuery.or("library_kind.eq.file,library_kind.is.null")
      : deleteQuery.eq("library_kind", kind);
  const { error } = await deleteQuery.in("id", eligibleIds);
  return { error: error ?? null, deletedIds: error ? [] : eligibleIds };
}

// Folders per level are assumed to stay small (organizational containers,
// not user data that grows unbounded) and are always returned in full.
// Documents are the part that can grow into the thousands, so only they're
// paginated — one extra row is fetched over `limit` to detect `hasMore`
// without a separate count query.
async function loadLibraryLevel(
  db: ReturnType<typeof createServerSupabase>,
  userId: string,
  kind: LibraryKind,
  parentFolderId: string | null,
  pagination: PaginationParams,
  scope: ResolvedLibraryScope,
) {
  let documentsQuery = applyLibraryScope(
    db.from("documents").select("*"),
    scope,
    userId,
  ).is("project_id", null);
  documentsQuery =
    parentFolderId === null
      ? documentsQuery.is("library_folder_id", null)
      : documentsQuery.eq("library_folder_id", parentFolderId);
  documentsQuery =
    kind === "file"
      ? documentsQuery.or("library_kind.eq.file,library_kind.is.null")
      : documentsQuery.eq("library_kind", kind);
  documentsQuery = documentsQuery.range(
    pagination.offset,
    pagination.offset + pagination.limit,
  );

  let foldersQuery = applyLibraryScope(
    db.from("library_folders").select("*").eq("library_kind", kind),
    scope,
    userId,
  );
  foldersQuery =
    parentFolderId === null
      ? foldersQuery.is("parent_folder_id", null)
      : foldersQuery.eq("parent_folder_id", parentFolderId);

  const [
    { data: docs, error: docsError },
    { data: folders, error: foldersError },
  ] = await Promise.all([
      documentsQuery.order("updated_at", { ascending: false }),
      foldersQuery.order("updated_at", { ascending: false }),
    ]);
  if (docsError)
    return {
      error: docsError.message,
      documents: [],
      folders: [],
      documentsHasMore: false,
    };
  if (foldersError)
    return {
      error: foldersError.message,
      documents: [],
      folders: [],
      documentsHasMore: false,
    };

  const rawDocs = docs ?? [];
  const documentsHasMore = rawDocs.length > pagination.limit;
  const pageDocs = documentsHasMore
    ? rawDocs.slice(0, pagination.limit)
    : rawDocs;

  const docsTyped = pageDocs.map((doc) =>
    mapLibraryDocument(doc, scope.scope),
  ) as {
    id: string;
    current_version_id?: string | null;
  }[];
  await attachLatestVersionNumbers(db, docsTyped);
  await attachActiveVersionPaths(db, docsTyped);
  return {
    error: null,
    documents: docsTyped,
    folders: (folders ?? []).map((folder) => ({
      ...folder,
      scope: scope.scope,
    })),
    documentsHasMore,
  };
}

// POST /library/documents/:documentId/publish
// Put a copy of one of your own documents — or one out of a matter — on the
// firm's shelves, where everyone still working at the firm can read it. It is
// always a copy: the original stays exactly where it was.
libraryRouter.post(
  "/documents/:documentId/publish",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const userEmail = res.locals.userEmail as string | undefined;
    const db = createServerSupabase();

    const scope = await resolveLibraryScope(db, userId, "firm");
    if (!scope || !scope.firmId)
      return void res.status(403).json(NOT_IN_THE_FIRM);

    const { documentId } = req.params;
    const { data: doc } = await db
      .from("documents")
      .select("id, user_id, project_id, firm_id")
      .eq("id", documentId)
      .maybeSingle();
    if (!doc) return void res.status(404).json({ detail: "Document not found" });
    const source = doc as {
      id: string;
      user_id: string;
      project_id: string | null;
      firm_id: string | null;
    };

    // You may publish what you can already read: your own files, and anything
    // in a matter you can open.
    let mayRead = source.user_id === userId;
    if (!mayRead && source.project_id) {
      const access = await checkProjectAccess(
        source.project_id,
        userId,
        userEmail,
        db,
      );
      mayRead = access.ok;
    }
    if (!mayRead && source.firm_id === scope.firmId) mayRead = true;
    if (!mayRead)
      return void res.status(404).json({ detail: "Document not found" });

    if (source.firm_id === scope.firmId && !source.project_id) {
      return void res
        .status(409)
        .json({ detail: "That is already in the firm library." });
    }

    const libraryKind =
      normalizeLibraryKind(req.body?.library_kind) ?? "template";
    const folderId =
      typeof req.body?.folder_id === "string" && req.body.folder_id
        ? req.body.folder_id
        : null;
    if (folderId) {
      const folder = await loadLibraryFolder(
        db,
        userId,
        libraryKind,
        folderId,
        scope,
      );
      if (!folder)
        return void res.status(404).json({ detail: "Folder not found" });
    }

    const result = await publishDocumentToFirm(db, {
      documentId,
      firmId: scope.firmId,
      userId,
      libraryKind,
      libraryFolderId: folderId,
      filename:
        typeof req.body?.filename === "string" ? req.body.filename : null,
    });
    if (!result.ok)
      return void res.status(result.status).json({ detail: result.detail });

    await recordAudit(db, {
      userId,
      userEmail: userEmail ?? "",
      action: "firm_library_publish",
      surface: "library",
      title: `Added "${result.filename}" to the firm library`,
      documentId: result.documentId,
      projectId: source.project_id,
      detail: { library_kind: libraryKind, from_document_id: documentId },
    });

    res.status(201).json({
      id: result.documentId,
      filename: result.filename,
      library_kind: libraryKind,
      scope: "firm",
    });
  },
);

// GET /library/:kind
// Directory mode is the default. Pass parent_folder_id to load one folder
// level, or view=search for flat search/filter/sort results.
libraryRouter.get("/:kind", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const kind = normalizeLibraryKind(req.params.kind);
  if (!kind) return void res.status(404).json({ detail: "Library not found" });

  const db = createServerSupabase();
  const scope = await resolveLibraryScope(db, userId, req.query.scope);
  if (!scope) return void res.status(403).json(NOT_IN_THE_FIRM);
  const pagination = parsePaginationQuery(req.query as Record<string, unknown>);
  if (req.query.view === "search") {
    const searchTerm = normalizeSearchTerm(req.query.search);
    const fileType =
      normalizeSearchTerm(req.query.file_type)?.toLowerCase() ?? null;
    const sort = parseLibraryDocumentSort(
      req.query as Record<string, unknown>,
    );
    const { data, error } = await db.rpc("search_library_documents", {
      p_user_id: userId,
      p_library_kind: kind,
      p_limit: pagination.limit + 1,
      p_offset: pagination.offset,
      p_search_term: searchTerm,
      p_file_type: fileType,
      p_sort_key: sort.key,
      p_sort_direction: sort.direction,
      p_firm_id: scope.firmId,
    });
    if (error) return void res.status(500).json({ detail: error.message });

    const rows = (data ?? []) as Record<string, unknown>[];
    return void res.json({
      documents: rows
        .slice(0, pagination.limit)
        .map((row) => mapLibraryDocument(row, scope.scope)),
      documentsHasMore: rows.length > pagination.limit,
    });
  }

  const parentFolderId = normalizeSearchTerm(req.query.parent_folder_id);
  if (parentFolderId) {
    const folder = await loadLibraryFolder(
      db,
      userId,
      kind,
      parentFolderId,
      scope,
    );
    if (!folder)
      return void res.status(404).json({ detail: "Folder not found" });
  }
  const result = await loadLibraryLevel(
    db,
    userId,
    kind,
    parentFolderId,
    pagination,
    scope,
  );
  if (result.error) return void res.status(500).json({ detail: result.error });
  res.json({
    documents: result.documents,
    folders: result.folders,
    documentsHasMore: result.documentsHasMore,
  });
});

// POST /library/:kind/levels
// Refresh several already-open directory levels through one bounded API call.
libraryRouter.post("/:kind/levels", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const kind = normalizeLibraryKind(req.params.kind);
  if (!kind) return void res.status(404).json({ detail: "Library not found" });
  const rawLevels: unknown[] = Array.isArray(req.body?.levels)
    ? req.body.levels
    : [];
  const seen = new Set<string>();
  const levels = rawLevels.flatMap((value: unknown) => {
    if (!value || typeof value !== "object") return [];
    const row = value as { parentId?: unknown; limit?: unknown };
    const parentId = typeof row.parentId === "string" ? row.parentId : null;
    const key = parentId ?? "root";
    if (seen.has(key)) return [];
    seen.add(key);
    const requestedLimit = Number(row.limit);
    return [
      {
        parentId,
        limit: Number.isFinite(requestedLimit)
          ? Math.max(1, Math.min(500, Math.floor(requestedLimit)))
          : 40,
      },
    ];
  });
  if (levels.length === 0 || levels.length > 100) {
    return void res
      .status(400)
      .json({ detail: "1 to 100 levels are required" });
  }

  const db = createServerSupabase();
  const scope = await resolveLibraryScope(db, userId, req.body?.scope);
  if (!scope) return void res.status(403).json(NOT_IN_THE_FIRM);
  const results: Array<{
    parentId: string | null;
    result: Awaited<ReturnType<typeof loadLibraryLevel>>;
  }> = new Array(levels.length);
  let nextLevelIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(8, levels.length) }, async () => {
      while (nextLevelIndex < levels.length) {
        const index = nextLevelIndex++;
        const level = levels[index];
        results[index] = {
          parentId: level.parentId,
          result: await loadLibraryLevel(
            db,
            userId,
            kind,
            level.parentId,
            { limit: level.limit, offset: 0 },
            scope,
          ),
        };
      }
    }),
  );
  const failed = results.find(({ result }) => result.error);
  if (failed?.result.error) {
    return void res.status(500).json({ detail: failed.result.error });
  }
  res.json({
    levels: results.map(({ parentId, result }) => ({
      parentId,
      documents: result.documents,
      folders: result.folders,
      documentsHasMore: result.documentsHasMore,
    })),
  });
});

// GET /library/:kind/filter-options
libraryRouter.get("/:kind/filter-options", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const kind = normalizeLibraryKind(req.params.kind);
  if (!kind) return void res.status(404).json({ detail: "Library not found" });

  const db = createServerSupabase();
  const scope = await resolveLibraryScope(db, userId, req.query.scope);
  if (!scope) return void res.status(403).json(NOT_IN_THE_FIRM);
  const { data, error } = await db.rpc("get_library_filter_options", {
    p_user_id: userId,
    p_library_kind: kind,
    p_firm_id: scope.firmId,
  });
  if (error) return void res.status(500).json({ detail: error.message });
  const row = (data?.[0] ?? {}) as { file_types?: unknown };
  res.json({
    fileTypes: Array.isArray(row.file_types)
      ? row.file_types.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  });
});

// GET /library/:kind/ids
// Complete ID-only result set for select-all across unloaded pages/folders.
libraryRouter.get("/:kind/ids", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const kind = normalizeLibraryKind(req.params.kind);
  if (!kind) return void res.status(404).json({ detail: "Library not found" });

  const db = createServerSupabase();
  const scope = await resolveLibraryScope(db, userId, req.query.scope);
  if (!scope) return void res.status(403).json(NOT_IN_THE_FIRM);
  const searchTerm = normalizeSearchTerm(req.query.search);
  const fileType = normalizeSearchTerm(req.query.file_type)?.toLowerCase() ?? null;
  const ids: string[] = [];
  let offset = 0;
  for (let page = 0; page < LIBRARY_IDS_MAX_PAGES; page++) {
    const { data, error } = await db.rpc("get_library_document_ids", {
      p_user_id: userId,
      p_library_kind: kind,
      p_search_term: searchTerm,
      p_file_type: fileType,
      p_limit: LIBRARY_IDS_PAGE_SIZE,
      p_offset: offset,
      p_firm_id: scope.firmId,
    });
    if (error) return void res.status(500).json({ detail: error.message });
    const rows = (data ?? []) as { id: string }[];
    if (rows.length === 0) break;
    ids.push(...rows.map((row) => row.id));
    offset += rows.length;
  }
  res.json(ids);
});

// POST /library/:kind/documents/bulk-delete
// One bounded backend operation replaces an unbounded browser request burst.
libraryRouter.post(
  "/:kind/documents/bulk-delete",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const kind = normalizeLibraryKind(req.params.kind);
    if (!kind)
      return void res.status(404).json({ detail: "Library not found" });
    const ids: string[] = Array.from(
      new Set<string>(
        (Array.isArray(req.body?.ids) ? req.body.ids : []).filter(
          (id: unknown): id is string =>
            typeof id === "string" && id.length > 0,
        ),
      ),
    );
    if (ids.length === 0) return void res.json({ deletedIds: [] });

    const db = createServerSupabase();
    const scope = await resolveLibraryScope(db, userId, req.body?.scope);
    if (!scope) return void res.status(403).json(NOT_IN_THE_FIRM);
    if (!scope.canWrite)
      return void res.status(403).json(NOT_ALLOWED_TO_EDIT);
    const deletedIds: string[] = [];
    for (
      let offset = 0;
      offset < ids.length;
      offset += LIBRARY_BULK_DELETE_BATCH_SIZE
    ) {
      const batch = ids.slice(offset, offset + LIBRARY_BULK_DELETE_BATCH_SIZE);
      const result = await deleteLibraryDocumentsAndVersionFiles(
        db,
        userId,
        kind,
        batch,
        scope,
      );
      if (result.error)
        return void res.status(500).json({ detail: result.error.message });
      deletedIds.push(...result.deletedIds);
    }
    res.json({ deletedIds });
  },
);

// POST /library/:kind/documents
libraryRouter.post(
  "/:kind/documents",
  requireAuth,
  singleFileUpload("file"),
  async (req, res) => {
    const userId = res.locals.userId as string;
    const kind = normalizeLibraryKind(req.params.kind);
    if (!kind)
      return void res.status(404).json({ detail: "Library not found" });
    const db = createServerSupabase();
    const scope = await resolveLibraryScope(db, userId, req.body?.scope);
    if (!scope) return void res.status(403).json(NOT_IN_THE_FIRM);
    if (!scope.canWrite)
      return void res.status(403).json(NOT_ALLOWED_TO_EDIT);
    await handleDocumentUpload(req, res, userId, null, db, {
      libraryKind: kind,
      firmId: scope.firmId,
    });
  },
);

// GET /library/:kind/folders/:folderId
libraryRouter.get(
  "/:kind/folders/:folderId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const kind = normalizeLibraryKind(req.params.kind);
    if (!kind)
      return void res.status(404).json({ detail: "Library not found" });

    const db = createServerSupabase();
    const scope = await resolveLibraryScope(db, userId, req.query.scope);
    if (!scope) return void res.status(403).json(NOT_IN_THE_FIRM);
    const { data, error } = await applyLibraryScope(
      db.from("library_folders").select("*").eq("library_kind", kind),
      scope,
      userId,
    );
    if (error) return void res.status(500).json({ detail: error.message });

    const folders = data ?? [];
    const foldersById = new Map(
      folders.map((folder) => [folder.id as string, folder]),
    );
    const path: typeof folders = [];
    const visited = new Set<string>();
    let current = foldersById.get(req.params.folderId);
    if (!current)
      return void res.status(404).json({ detail: "Folder not found" });

    while (current && !visited.has(current.id as string)) {
      visited.add(current.id as string);
      path.unshift(current);
      current = current.parent_folder_id
        ? foldersById.get(current.parent_folder_id as string)
        : undefined;
    }

    res.json({ folders: path });
  },
);

// POST /library/:kind/folders
libraryRouter.post("/:kind/folders", requireAuth, async (req, res) => {
  const userId = res.locals.userId as string;
  const kind = normalizeLibraryKind(req.params.kind);
  if (!kind) return void res.status(404).json({ detail: "Library not found" });

  const { name, parent_folder_id } = req.body as {
    name?: string;
    parent_folder_id?: string | null;
  };
  if (!name?.trim())
    return void res.status(400).json({ detail: "name is required" });

  const db = createServerSupabase();
  const scope = await resolveLibraryScope(db, userId, req.body?.scope);
  if (!scope) return void res.status(403).json(NOT_IN_THE_FIRM);
  if (!scope.canWrite) return void res.status(403).json(NOT_ALLOWED_TO_EDIT);
  if (parent_folder_id) {
    const parent = await loadLibraryFolder(
      db,
      userId,
      kind,
      parent_folder_id,
      scope,
    );
    if (!parent)
      return void res.status(404).json({ detail: "Parent folder not found" });
  }

  const { data, error } = await db
    .from("library_folders")
    .insert({
      user_id: userId,
      firm_id: scope.firmId,
      library_kind: kind,
      name: name.trim(),
      parent_folder_id: parent_folder_id ?? null,
    })
    .select("*")
    .single();
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(201).json({ ...data, scope: scope.scope });
});

// PATCH /library/:kind/folders/:folderId
libraryRouter.patch(
  "/:kind/folders/:folderId",
  requireAuth,
  async (req, res) => {
  const userId = res.locals.userId as string;
  const kind = normalizeLibraryKind(req.params.kind);
    if (!kind)
      return void res.status(404).json({ detail: "Library not found" });

  const { folderId } = req.params;
    const body = req.body as {
      name?: string;
      parent_folder_id?: string | null;
      scope?: string;
    };
  const db = createServerSupabase();
  const scope = await resolveLibraryScope(db, userId, body.scope);
  if (!scope) return void res.status(403).json(NOT_IN_THE_FIRM);
  if (!scope.canWrite) return void res.status(403).json(NOT_ALLOWED_TO_EDIT);
  const folder = await loadLibraryFolder(db, userId, kind, folderId, scope);
    if (!folder)
      return void res.status(404).json({ detail: "Folder not found" });

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
  };
  if (body.name != null) {
    const trimmed = body.name.trim();
    if (!trimmed)
      return void res.status(400).json({ detail: "name is required" });
    updates.name = trimmed;
  }
  if ("parent_folder_id" in body) {
    if (body.parent_folder_id) {
      let cur: string | null = body.parent_folder_id;
      while (cur) {
        if (cur === folderId) {
          return void res.status(400).json({
            detail: "Cannot move a folder into itself or a descendant",
          });
        }
        const parent = await loadLibraryFolder(db, userId, kind, cur, scope);
        if (!parent)
            return void res
              .status(404)
              .json({ detail: "Parent folder not found" });
        cur = parent.parent_folder_id ?? null;
      }
    }
    updates.parent_folder_id = body.parent_folder_id ?? null;
  }

  const { data, error } = await applyLibraryScope(
    db
      .from("library_folders")
      .update(updates)
      .eq("id", folderId)
      .eq("library_kind", kind),
    scope,
    userId,
  )
    .select("*")
    .single();
  if (error || !data)
    return void res.status(404).json({ detail: "Folder not found" });
  res.json({ ...data, scope: scope.scope });
  },
);

// DELETE /library/:kind/folders/:folderId
libraryRouter.delete(
  "/:kind/folders/:folderId",
  requireAuth,
  async (req, res) => {
  const userId = res.locals.userId as string;
  const kind = normalizeLibraryKind(req.params.kind);
    if (!kind)
      return void res.status(404).json({ detail: "Library not found" });

  const { folderId } = req.params;
  const db = createServerSupabase();
  const scope = await resolveLibraryScope(
    db,
    userId,
    req.body?.scope ?? req.query.scope,
  );
  if (!scope) return void res.status(403).json(NOT_IN_THE_FIRM);
  if (!scope.canWrite) return void res.status(403).json(NOT_ALLOWED_TO_EDIT);
  const { data: allFolders, error: foldersError } = await applyLibraryScope(
    db
      .from("library_folders")
      .select("id, parent_folder_id")
      .eq("library_kind", kind),
    scope,
    userId,
  );
  if (foldersError)
    return void res.status(500).json({ detail: foldersError.message });
  if (!(allFolders ?? []).some((folder) => folder.id === folderId)) {
    return void res.status(404).json({ detail: "Folder not found" });
  }

  const childrenByParent = new Map<string, string[]>();
  for (const folder of allFolders ?? []) {
    const parentId = folder.parent_folder_id as string | null;
    if (!parentId) continue;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(folder.id as string);
    childrenByParent.set(parentId, children);
  }

  const folderIds = new Set<string>();
  const stack = [folderId];
  while (stack.length > 0) {
    const id = stack.pop()!;
    if (folderIds.has(id)) continue;
    folderIds.add(id);
    stack.push(...(childrenByParent.get(id) ?? []));
  }

  let documentsInFolderQuery = applyLibraryScope(
    db.from("documents").select("id"),
    scope,
    userId,
  ).is("project_id", null);
  documentsInFolderQuery =
    kind === "file"
      ? documentsInFolderQuery.or("library_kind.eq.file,library_kind.is.null")
      : documentsInFolderQuery.eq("library_kind", kind);
  const { data: docs, error: docsError } = await documentsInFolderQuery.in(
    "library_folder_id",
    [...folderIds],
  );
    if (docsError)
      return void res.status(500).json({ detail: docsError.message });

  const docIds = (docs ?? []).map((doc) => doc.id as string);
    const deleteDocsResult = await deleteLibraryDocumentsAndVersionFiles(
    db,
    userId,
    kind,
    docIds,
    scope,
  );
    if (deleteDocsResult.error)
      return void res
        .status(500)
        .json({ detail: deleteDocsResult.error.message });

  const { error } = await applyLibraryScope(
    db
      .from("library_folders")
      .delete()
      .eq("id", folderId)
      .eq("library_kind", kind),
    scope,
    userId,
  );
  if (error) return void res.status(500).json({ detail: error.message });
  res.status(204).send();
  },
);

// PATCH /library/:kind/documents/:documentId/folder
libraryRouter.patch(
  "/:kind/documents/:documentId/folder",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const kind = normalizeLibraryKind(req.params.kind);
    if (!kind)
      return void res.status(404).json({ detail: "Library not found" });

    const { documentId } = req.params;
    const { folder_id } = req.body as {
      folder_id: string | null;
      scope?: string;
    };
    const db = createServerSupabase();
    const scope = await resolveLibraryScope(db, userId, req.body?.scope);
    if (!scope) return void res.status(403).json(NOT_IN_THE_FIRM);
    if (!scope.canWrite) return void res.status(403).json(NOT_ALLOWED_TO_EDIT);

    if (folder_id) {
      const folder = await loadLibraryFolder(db, userId, kind, folder_id, scope);
      if (!folder)
        return void res.status(404).json({ detail: "Folder not found" });
    }

    let moveQuery = applyLibraryScope(
      db.from("documents").update({
        library_folder_id: folder_id ?? null,
        updated_at: new Date().toISOString(),
      }),
      scope,
      userId,
    )
      .eq("id", documentId)
      .is("project_id", null);
    moveQuery =
      kind === "file"
        ? moveQuery.or("library_kind.eq.file,library_kind.is.null")
        : moveQuery.eq("library_kind", kind);
    const { data, error } = await moveQuery.select("*").single();
    if (error || !data)
      return void res.status(404).json({ detail: "Document not found" });
    res.json(mapLibraryDocument(data, scope.scope));
  },
);

// PATCH /library/:kind/documents/:documentId
libraryRouter.patch(
  "/:kind/documents/:documentId",
  requireAuth,
  async (req, res) => {
    const userId = res.locals.userId as string;
    const kind = normalizeLibraryKind(req.params.kind);
    if (!kind)
      return void res.status(404).json({ detail: "Library not found" });

    const { documentId } = req.params;
    const db = createServerSupabase();
    const scope = await resolveLibraryScope(db, userId, req.body?.scope);
    if (!scope) return void res.status(403).json(NOT_IN_THE_FIRM);
    if (!scope.canWrite) return void res.status(403).json(NOT_ALLOWED_TO_EDIT);
    let docQuery = applyLibraryScope(
      db.from("documents").select("id, current_version_id"),
      scope,
      userId,
    )
      .eq("id", documentId)
      .is("project_id", null);
    docQuery =
      kind === "file"
        ? docQuery.or("library_kind.eq.file,library_kind.is.null")
        : docQuery.eq("library_kind", kind);
    const { data: doc } = await docQuery.single();
    if (!doc)
      return void res.status(404).json({ detail: "Document not found" });

    const active = doc.current_version_id
      ? await db
          .from("document_versions")
          .select("filename")
          .eq("id", doc.current_version_id)
          .eq("document_id", documentId)
          .single()
      : null;
    const currentName =
      typeof active?.data?.filename === "string" && active.data.filename.trim()
        ? active.data.filename.trim()
        : "Untitled document";
    const filename = normalizeDocumentFilename(req.body?.filename, currentName);
    if (!filename)
      return void res.status(400).json({ detail: "filename is required" });

    let updateQuery = applyLibraryScope(
      db.from("documents").update({ updated_at: new Date().toISOString() }),
      scope,
      userId,
    )
      .eq("id", documentId)
      .is("project_id", null);
    updateQuery =
      kind === "file"
        ? updateQuery.or("library_kind.eq.file,library_kind.is.null")
        : updateQuery.eq("library_kind", kind);
    const { data: updated, error } = await updateQuery.select("*").single();
    if (error || !updated)
      return void res.status(404).json({ detail: "Document not found" });

    if (doc.current_version_id) {
      await db
        .from("document_versions")
        .update({ filename })
        .eq("id", doc.current_version_id)
        .eq("document_id", documentId);
    }

    res.json(mapLibraryDocument({ ...updated, filename }, scope.scope));
  },
);
