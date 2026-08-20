/**
 * Mike API client — all requests to the Node.js backend.
 * Attaches the Supabase auth token for user authentication.
 */

import { supabase } from "@/app/lib/supabase";
import { isPanelDocument } from "@/app/components/shared/types";
import type {
    AssistantEvent,
    Chat,
    ChatDetailOut,
    Citation,
    Document,
    Folder,
    LibraryFolder,
    Message,
    PanelDocument,
    OpenSourceWorkflowContributorMode,
    OpenSourceWorkflowResponse,
    Project,
    ProjectVisibility,
    QuickAction,
    Workflow,
    WorkflowAddon,
    WorkflowReferenceDocument,
    WorkflowContributor,
    TabularReview,
    TabularReviewDetailOut,
} from "@/app/components/shared/types";

// Server-side shape before mapping
interface ServerMessage {
    id: string;
    chat_id: string;
    role: "user" | "assistant";
    content: string | AssistantEvent[] | null;
    files?: { filename: string; document_id?: string }[] | null;
    workflow?: { id: string; title: string } | null;
    citations?: Citation[] | null;
    created_at: string;
}
interface ServerChatDetailOut {
    chat: Chat;
    messages: ServerMessage[];
}

const API_BASE =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
const isDev = process.env.NODE_ENV !== "production";
const devLog = (...args: Parameters<typeof console.log>) => {
    if (isDev) console.log(...args);
};

export class MikeApiError extends Error {
    status: number;
    code: string | null;

    constructor(args: {
        message: string;
        status: number;
        code?: string | null;
    }) {
        super(args.message);
        this.name = "MikeApiError";
        this.status = args.status;
        this.code = args.code ?? null;
    }
}

export function isMfaRequiredError(error: unknown) {
    return (
        error instanceof MikeApiError &&
        error.status === 403 &&
        error.code === "mfa_verification_required"
    );
}

async function getAuthHeader(): Promise<Record<string, string>> {
    const {
        data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) return {};
    return { Authorization: `Bearer ${session.access_token}` };
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
    const authHeaders = await getAuthHeader();
    const { headers: initHeaders, ...restInit } = init ?? {};
    const response = await fetch(`${API_BASE}${path}`, {
        cache: "no-store",
        ...restInit,
        headers: {
            Accept: "application/json",
            ...authHeaders,
            ...(initHeaders as Record<string, string> | undefined),
        },
    });

    if (!response.ok) {
        throw await toApiError(response, path);
    }

    if (
        response.status === 204 ||
        response.headers.get("content-length") === "0"
    ) {
        return undefined as T;
    }

    return (await response.json()) as T;
}

async function apiBlobRequest(path: string): Promise<{
    blob: Blob;
    filename: string | null;
}> {
    const authHeaders = await getAuthHeader();
    const response = await fetch(`${API_BASE}${path}`, {
        cache: "no-store",
        headers: {
            Accept: "application/json",
            ...authHeaders,
        },
    });

    if (!response.ok) {
        throw await toApiError(response, path);
    }

    const disposition = response.headers.get("content-disposition") ?? "";
    const filenameMatch = disposition.match(/filename="?([^";]+)"?/i);
    return {
        blob: await response.blob(),
        filename: filenameMatch?.[1] ?? null,
    };
}

async function toApiError(response: Response, path: string) {
    const text = await response.text();
    try {
        const parsed = JSON.parse(text) as {
            detail?: unknown;
            code?: unknown;
        };
        devLog("[mike-api] non-ok response", {
            path,
            status: response.status,
            code: parsed.code,
            detail: parsed.detail,
        });
        return new MikeApiError({
            status: response.status,
            code: typeof parsed.code === "string" ? parsed.code : null,
            message:
                typeof parsed.detail === "string" && parsed.detail
                    ? parsed.detail
                    : `API error: ${response.status}`,
        });
    } catch {
        devLog("[mike-api] non-ok non-json response", {
            path,
            status: response.status,
            bodyPreview: text.slice(0, 200),
        });
        return new MikeApiError({
            status: response.status,
            message: text || `API error: ${response.status}`,
        });
    }
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function listProjects(options?: {
    includeDocuments?: boolean;
}): Promise<Project[]> {
    const query = options?.includeDocuments ? "?include=documents" : "";
    return apiRequest<Project[]>(`/projects${query}`);
}

// Paginated overview sibling of listProjects(), used by ProjectsOverview.tsx.
// Deliberately a separate function, not an overload of listProjects — the
// backend route decides whether to paginate based on whether any of these
// query params are present at all, so listProjects() must keep sending none
// of them (legacy project pickers still need the full unpaginated list).
export async function listProjectsPage(pagination?: {
    limit?: number;
    offset?: number;
    search?: string;
    sortKey?: string;
    sortDirection?: "asc" | "desc";
    scope?: "all" | "mine" | "shared";
    practice?: string;
    ownerUserId?: string;
    signal?: AbortSignal;
}): Promise<Project[]> {
    const params = new URLSearchParams();
    if (pagination?.limit) params.set("limit", String(pagination.limit));
    if (pagination?.offset) params.set("offset", String(pagination.offset));
    if (pagination?.search) params.set("search", pagination.search);
    if (pagination?.sortKey) params.set("sort_key", pagination.sortKey);
    if (pagination?.sortDirection)
        params.set("sort_direction", pagination.sortDirection);
    if (pagination?.scope && pagination.scope !== "all")
        params.set("scope", pagination.scope);
    if (pagination?.practice) params.set("practice", pagination.practice);
    if (pagination?.ownerUserId)
        params.set("owner_user_id", pagination.ownerUserId);

    const qs = params.toString() ? `?${params.toString()}` : "";
    return apiRequest<Project[]>(`/projects${qs}`, {
        signal: pagination?.signal,
    });
}

export async function listProjectSummaries(pagination?: {
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
}): Promise<Project[]> {
    const params = new URLSearchParams();
    if (pagination?.limit != null)
        params.set("limit", String(pagination.limit));
    if (pagination?.offset != null)
        params.set("offset", String(pagination.offset));
    params.set("view", "summary");
    return apiRequest<Project[]>(`/projects?${params.toString()}`, {
        signal: pagination?.signal,
    });
}

export interface ProjectDirectoryLevel {
    documents: Document[];
    folders: Folder[];
    documentsHasMore: boolean;
}

export async function getProjectDirectoryLevel(
    projectId: string,
    options?: {
        parentFolderId?: string | null;
        limit?: number;
        offset?: number;
        signal?: AbortSignal;
    },
): Promise<ProjectDirectoryLevel> {
    const params = new URLSearchParams();
    if (options?.parentFolderId)
        params.set("parent_folder_id", options.parentFolderId);
    if (options?.limit != null) params.set("limit", String(options.limit));
    if (options?.offset != null) params.set("offset", String(options.offset));
    const query = params.toString();
    return apiRequest<ProjectDirectoryLevel>(
        `/projects/${projectId}/directory${query ? `?${query}` : ""}`,
        {
            signal: options?.signal,
        },
    );
}

export async function searchProjectDirectory(options: {
    search: string;
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
}): Promise<Project[]> {
    const params = new URLSearchParams({
        view: "directory-search",
        search: options.search,
    });
    if (options.limit != null) params.set("limit", String(options.limit));
    if (options.offset != null) params.set("offset", String(options.offset));
    return apiRequest<Project[]>(`/projects?${params}`, {
        signal: options.signal,
    });
}

export async function listProjectIds(options?: {
    search?: string;
    scope?: "all" | "mine" | "shared";
    practice?: string;
    ownerUserId?: string;
    signal?: AbortSignal;
}): Promise<{ id: string; user_id: string }[]> {
    const params = new URLSearchParams();
    if (options?.search) params.set("search", options.search);
    if (options?.scope && options.scope !== "all")
        params.set("scope", options.scope);
    if (options?.practice) params.set("practice", options.practice);
    if (options?.ownerUserId) params.set("owner_user_id", options.ownerUserId);

    const qs = params.toString() ? `?${params.toString()}` : "";
    return apiRequest<{ id: string; user_id: string }[]>(`/projects/ids${qs}`, {
        signal: options?.signal,
    });
}

export interface ProjectFilterOptions {
    practices: string[];
    owners: { value: string; label: string }[];
}

export type MatterSearchHit = {
    documentId: string;
    filename: string;
    page: number | null;
    content: string;
    fromOcr: boolean;
    fromFilename: boolean;
    matchedBy: "words" | "meaning" | "similar";
};

// Search a matter's documents by word and by meaning. Returns the best
// passages with their document and page (the search box's counterpart to the
// assistant's search_matter tool).
export async function searchMatter(
    projectId: string,
    query: string,
    options?: { limit?: number; signal?: AbortSignal },
): Promise<{ query: string; results: MatterSearchHit[] }> {
    const params = new URLSearchParams({ q: query });
    if (options?.limit != null) params.set("limit", String(options.limit));
    return apiRequest<{ query: string; results: MatterSearchHit[] }>(
        `/projects/${projectId}/search?${params.toString()}`,
        { signal: options?.signal },
    );
}

export type MatterAnswerSource = {
    documentId: string;
    filename: string;
    page: number | null;
    /** The passage itself, so the document can open with it highlighted. */
    content: string;
    matchedBy: "words" | "meaning" | "similar";
    fromFilename: boolean;
};

// A citation written inside an answer, tied back to the document and passage it
// came from so the reader can click it and see the words in the file.
export type MatterAnswerCitation = {
    /** The exact run of text in the answer that should be clickable. */
    text: string;
    documentId: string;
    filename: string;
    page: number | null;
    quote: string;
};

export type MatterAnswer = {
    question: string;
    answer: string;
    sources: MatterAnswerSource[];
    citations: MatterAnswerCitation[];
};

// Ask a whole matter a question and get one consolidated answer that cites the
// document and page, drawn only from the matter's own documents.
export async function answerMatter(
    projectId: string,
    question: string,
    options?: { model?: string; signal?: AbortSignal },
): Promise<MatterAnswer> {
    return apiRequest<MatterAnswer>(`/projects/${projectId}/search/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, model: options?.model }),
        signal: options?.signal,
    });
}

export async function getProjectFilterOptions(
    signal?: AbortSignal,
): Promise<ProjectFilterOptions> {
    return apiRequest<ProjectFilterOptions>("/projects/filter-options", {
        signal,
    });
}

export async function createProject(
    name: string,
    cm_number?: string,
    practice?: string,
    shared_with?: string[],
    visibility?: ProjectVisibility,
): Promise<Project> {
    return apiRequest<Project>("/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name,
            cm_number,
            practice,
            shared_with,
            visibility,
        }),
    });
}

export async function deleteAccount(): Promise<void> {
    return apiRequest<void>("/user/account", { method: "DELETE" });
}

export async function deleteAllChats(): Promise<void> {
    return apiRequest<void>("/user/chats", { method: "DELETE" });
}

export async function deleteAllProjects(): Promise<void> {
    return apiRequest<void>("/user/projects", { method: "DELETE" });
}

export async function deleteAllTabularReviews(): Promise<void> {
    return apiRequest<void>("/user/tabular-reviews", { method: "DELETE" });
}

export async function exportAccountData(): Promise<{
    blob: Blob;
    filename: string | null;
}> {
    return apiBlobRequest("/user/export");
}

export async function exportChatData(): Promise<{
    blob: Blob;
    filename: string | null;
}> {
    return apiBlobRequest("/user/chats/export");
}

export async function exportTabularReviewsData(): Promise<{
    blob: Blob;
    filename: string | null;
}> {
    return apiBlobRequest("/user/tabular-reviews/export");
}

export interface UserProfile {
    displayName: string | null;
    organisation: string | null;
    messageCreditsUsed: number;
    creditsResetDate: string;
    creditsRemaining: number;
    tier: string;
    titleModel: string;
    tabularModel: string;
    mfaOnLogin: boolean;
    legalResearchUs: boolean;
    quickActionsVisible: boolean;
    apiKeyStatus: ApiKeyStatus;
    /** How this person signs: title, bar admissions and signature block. */
    profTitle: string | null;
    profPhone: string | null;
    practiceAreas: string[];
    barAdmissions: BarAdmission[];
    signatureBlock: string | null;
    /** The firm this person belongs to, and what they may do in it. */
    firm: { id: string; name: string } | null;
    firm_role: "admin" | "attorney" | "paralegal" | null;
    firm_status: "active" | "deactivated" | null;
    can_edit_firm_library: boolean;
    /** The models the firm allows. Null means all of them. */
    allowed_models: string[] | null;
}

/** Where an attorney is admitted to practise, and under what number. */
export interface BarAdmission {
    state: string;
    bar_number: string;
    status?: string;
}

export interface UserLookupResult {
    exists: boolean;
    email: string;
    display_name: string | null;
}

// ---------------------------------------------------------------------------
// Audit history
// ---------------------------------------------------------------------------

export interface AuditEvent {
    id: string;
    created_at: string;
    user_display_name: string | null;
    user_email: string | null;
    action: string;
    status: string;
    title: string | null;
    surface: string | null;
    project_id: string | null;
    chat_id: string | null;
    document_id: string | null;
    review_id: string | null;
    model: string | null;
    detail: Record<string, unknown> | null;
}

export async function getAuditHistory(
    params: {
        q?: string;
        action?: string;
        status?: string;
        surface?: string;
        from?: string;
        to?: string;
        sortBy?: "created_at" | "user_email" | "title" | "model";
        sortDirection?: "asc" | "desc";
        page?: number;
    },
    signal?: AbortSignal,
): Promise<{
    events: AuditEvent[];
    total: number;
    page: number;
    pageSize: number;
}> {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.action) qs.set("action", params.action);
    if (params.status) qs.set("status", params.status);
    if (params.surface) qs.set("surface", params.surface);
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    if (params.sortBy) qs.set("sort_by", params.sortBy);
    if (params.sortDirection) qs.set("sort_dir", params.sortDirection);
    if (params.page) qs.set("page", String(params.page));
    return apiRequest(`/audit?${qs.toString()}`, { signal });
}

export async function exportAuditHistory(params: {
    q?: string;
    action?: string;
    status?: string;
    surface?: string;
    from?: string;
    to?: string;
    sortBy?: "created_at" | "user_email" | "title" | "model";
    sortDirection?: "asc" | "desc";
}): Promise<{ blob: Blob; filename: string | null }> {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.action) qs.set("action", params.action);
    if (params.status) qs.set("status", params.status);
    if (params.surface) qs.set("surface", params.surface);
    if (params.from) qs.set("from", params.from);
    if (params.to) qs.set("to", params.to);
    if (params.sortBy) qs.set("sort_by", params.sortBy);
    if (params.sortDirection) qs.set("sort_dir", params.sortDirection);
    return apiBlobRequest(`/audit/export?${qs.toString()}`);
}

export async function getUserProfile(): Promise<UserProfile> {
    return apiRequest<UserProfile>("/user/profile");
}

// ---------------------------------------------------------------------------
// The firm
// ---------------------------------------------------------------------------

export type FirmRole = "admin" | "attorney" | "paralegal";
export type FirmMemberStatus = "active" | "deactivated";

/** How the firm likes a document to look when Mike builds one from nothing. */
export interface FirmDraftingDefaults {
    font?: string;
    font_size_pt?: number;
    line_spacing?: "single" | "1.5" | "double";
    paragraph_style_notes?: string;
}

export interface Firm {
    id: string;
    name: string;
    address_lines: string[] | null;
    phone: string | null;
    website: string | null;
    default_jurisdiction: string | null;
    citation_style: string | null;
    /** Sent quietly with every chat anyone at the firm has. */
    standing_instructions: string | null;
    drafting_defaults: FirmDraftingDefaults | null;
    /** The models the firm allows. Null means all of them. */
    allowed_models: string[] | null;
}

/** One of the workflows the firm has published for everyone to run. */
export interface FirmWorkflow {
    id: string;
    user_id: string | null;
    title: string | null;
    type: string | null;
    practice: string | null;
    language: string | null;
    created_at: string;
    author_name: string;
}

export interface FirmMember {
    user_id: string;
    email: string | null;
    display_name: string | null;
    role: FirmRole;
    status: FirmMemberStatus;
    can_edit_firm_library: boolean;
    /** How many matters this person is responsible for. */
    matter_count: number;
    joined_at: string;
    is_you: boolean;
}

export interface FirmInvite {
    id: string;
    email: string;
    role: FirmRole;
    token: string;
    /** The link to pass on. Mike does not send the invitation itself. */
    link: string;
    expires_at: string;
    accepted_at: string | null;
    created_at: string;
}

export interface FirmMatterSummary {
    id: string;
    name: string;
    cm_number: string | null;
    user_id: string;
    visibility: ProjectVisibility;
    updated_at: string;
}

export async function getFirm(): Promise<Firm> {
    return apiRequest<Firm>("/admin/firm");
}

export async function updateFirm(updates: {
    name?: string;
    address_lines?: string[];
    phone?: string | null;
    website?: string | null;
    default_jurisdiction?: string | null;
    citation_style?: string | null;
    standing_instructions?: string | null;
    drafting_defaults?: FirmDraftingDefaults | null;
    allowed_models?: string[] | null;
}): Promise<Firm> {
    return apiRequest<Firm>("/admin/firm", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
    });
}

/** Which providers the firm holds an account with. Never the key itself. */
export interface FirmApiKeyStatus {
    provider: string;
    firm_key_set: boolean;
    server_key_set: boolean;
}

export async function getFirmApiKeys(): Promise<FirmApiKeyStatus[]> {
    return apiRequest<FirmApiKeyStatus[]>("/admin/api-keys");
}

export async function saveFirmApiKey(
    provider: string,
    key: string,
): Promise<{ ok: boolean }> {
    return apiRequest(`/admin/api-keys/${provider}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
    });
}

export async function removeFirmApiKey(provider: string): Promise<void> {
    await apiRequest(`/admin/api-keys/${provider}`, { method: "DELETE" });
}

/** One thing somebody did, as the history records it. */
export interface AuditEvent {
    id: string;
    created_at: string;
    user_id: string;
    user_email: string | null;
    action: string;
    status: string;
    title: string | null;
    surface: string | null;
    project_id: string | null;
    chat_id: string | null;
    document_id: string | null;
    model: string | null;
}

export async function getFirmAudit(options: {
    userId?: string | null;
    action?: string | null;
    projectId?: string | null;
    from?: string | null;
    to?: string | null;
    limit?: number;
    offset?: number;
}): Promise<{ events: AuditEvent[]; hasMore: boolean }> {
    const params = new URLSearchParams();
    if (options.userId) params.set("user_id", options.userId);
    if (options.action) params.set("action", options.action);
    if (options.projectId) params.set("project_id", options.projectId);
    if (options.from) params.set("from", options.from);
    if (options.to) params.set("to", options.to);
    if (options.limit != null) params.set("limit", String(options.limit));
    if (options.offset != null) params.set("offset", String(options.offset));
    const query = params.toString();
    return apiRequest(`/admin/audit${query ? `?${query}` : ""}`);
}

export async function getFirmAuditActions(): Promise<{ actions: string[] }> {
    return apiRequest("/admin/audit/actions");
}

/** How much each person used Mike in one month. */
export interface FirmUsagePerson {
    user_id: string;
    email: string;
    display_name: string | null;
    messages: number;
    by_model: { model: string; count: number }[];
}

export async function getFirmUsage(
    month?: string,
): Promise<{ month: string; people: FirmUsagePerson[] }> {
    return apiRequest(`/admin/usage${month ? `?month=${month}` : ""}`);
}

// ---------------------------------------------------------------------------
// The firm's form bank — notes about the firm's own model documents, so Mike
// can start a draft from them without anybody attaching anything.
// ---------------------------------------------------------------------------

export type FormUsageMode = "precedent" | "fill";
export type FormStatus = "draft" | "approved";
export type FormFieldSource = "ask" | "matter" | "attorney" | "firm";

export interface FormRequiredField {
    key: string;
    label: string;
    source: FormFieldSource;
    hint?: string;
}

export interface FirmForm {
    id: string;
    firm_id: string;
    document_id: string;
    title: string;
    document_type: string;
    usage_mode: FormUsageMode;
    variant_notes: string | null;
    practice: string | null;
    jurisdictions: string[];
    description: string | null;
    drafting_guidance: string | null;
    required_fields: FormRequiredField[];
    status: FormStatus;
    created_by: string | null;
    created_at?: string;
    updated_at?: string;
    /** The name of the document on the firm's shelves this is about. */
    filename?: string | null;
}

/** What Mike suggests the notes should say, for a person to correct. */
export interface FirmFormProposal {
    title: string;
    document_type: string;
    usage_mode: FormUsageMode;
    variant_notes: string;
    description: string;
    drafting_guidance: string;
    practice: string;
    jurisdictions: string[];
    required_fields: FormRequiredField[];
}

export interface FirmFormInput {
    title?: string;
    document_type?: string;
    usage_mode?: FormUsageMode;
    variant_notes?: string | null;
    practice?: string | null;
    jurisdictions?: string[];
    description?: string | null;
    drafting_guidance?: string | null;
    required_fields?: FormRequiredField[];
    status?: FormStatus;
}

export async function getFirmForms(): Promise<FirmForm[]> {
    const result = await apiRequest<{ forms: FirmForm[] }>("/admin/forms");
    return result.forms;
}

export async function addFirmForm(
    documentId: string,
    notes: FirmFormInput,
): Promise<FirmForm> {
    return apiRequest<FirmForm>("/admin/forms", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_id: documentId, ...notes }),
    });
}

export async function updateFirmForm(
    formId: string,
    notes: FirmFormInput,
): Promise<FirmForm> {
    return apiRequest<FirmForm>(`/admin/forms/${formId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(notes),
    });
}

export async function removeFirmForm(formId: string): Promise<void> {
    await apiRequest(`/admin/forms/${formId}`, { method: "DELETE" });
}

/** Read a banked document and suggest its notes. Nothing is saved. */
export async function suggestFirmFormNotes(
    documentId: string,
): Promise<FirmFormProposal> {
    return apiRequest<FirmFormProposal>("/admin/forms/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document_id: documentId }),
    });
}

export async function getFirmWorkflows(): Promise<FirmWorkflow[]> {
    return apiRequest<FirmWorkflow[]>("/admin/workflows");
}

export async function renameFirmWorkflow(
    workflowId: string,
    title: string,
): Promise<{ id: string; title: string }> {
    return apiRequest(`/admin/workflows/${workflowId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
    });
}

export async function removeFirmWorkflow(workflowId: string): Promise<void> {
    await apiRequest(`/admin/workflows/${workflowId}`, { method: "DELETE" });
}

export async function getFirmMembers(): Promise<FirmMember[]> {
    return apiRequest<FirmMember[]>("/admin/members");
}

export async function updateFirmMember(
    userId: string,
    updates: {
        role?: FirmRole;
        status?: FirmMemberStatus;
        can_edit_firm_library?: boolean;
    },
): Promise<{ ok: boolean }> {
    return apiRequest(`/admin/members/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
    });
}

export async function getFirmInvites(): Promise<FirmInvite[]> {
    return apiRequest<FirmInvite[]>("/admin/invites");
}

export async function createFirmInvite(
    email: string,
    role: FirmRole,
): Promise<FirmInvite> {
    return apiRequest<FirmInvite>("/admin/invites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, role }),
    });
}

export async function cancelFirmInvite(id: string): Promise<void> {
    await apiRequest(`/admin/invites/${id}`, { method: "DELETE" });
}

export async function getFirmMatters(
    ownerUserId?: string,
): Promise<FirmMatterSummary[]> {
    const qs = ownerUserId
        ? `?owner_user_id=${encodeURIComponent(ownerUserId)}`
        : "";
    return apiRequest<FirmMatterSummary[]>(`/admin/projects${qs}`);
}

export async function reassignFirmMatter(
    projectId: string,
    newOwnerUserId: string,
): Promise<{ ok: boolean }> {
    return apiRequest(`/admin/projects/${projectId}/owner`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: newOwnerUserId }),
    });
}

// --- Joining the firm. These two answer before anyone is signed in. ---

export interface InviteDetails {
    email: string;
    role: FirmRole;
    firm_name: string | null;
}

export async function lookUpInvite(token: string): Promise<InviteDetails> {
    const response = await fetch(
        `${API_BASE}/auth/invite/${encodeURIComponent(token)}`,
        { cache: "no-store", headers: { Accept: "application/json" } },
    );
    if (!response.ok) throw await toApiError(response, "/auth/invite");
    return (await response.json()) as InviteDetails;
}

export async function acceptInvite(input: {
    token: string;
    password: string;
    displayName?: string;
}): Promise<{ ok: boolean; email: string }> {
    const response = await fetch(`${API_BASE}/auth/invite/accept`, {
        method: "POST",
        headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            token: input.token,
            password: input.password,
            display_name: input.displayName,
        }),
    });
    if (!response.ok) throw await toApiError(response, "/auth/invite/accept");
    return (await response.json()) as { ok: boolean; email: string };
}

/**
 * Small personal display settings, such as how the panels in a project
 * conversation are arranged. Stored per person so they follow them to any
 * computer they sign in from.
 */
export async function getUiPreferences(): Promise<Record<string, unknown>> {
    const result = await apiRequest<{ preferences?: Record<string, unknown> }>(
        "/user/ui-preferences",
    );
    return result.preferences ?? {};
}

export async function saveUiPreferences(
    preferences: Record<string, unknown>,
): Promise<Record<string, unknown>> {
    const result = await apiRequest<{ preferences?: Record<string, unknown> }>(
        "/user/ui-preferences",
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ preferences }),
        },
    );
    return result.preferences ?? preferences;
}

export async function lookupUserByEmail(
    email: string,
): Promise<UserLookupResult> {
    return apiRequest<UserLookupResult>(
        `/user/lookup?email=${encodeURIComponent(email)}`,
    );
}

export async function updateUserProfile(payload: {
    displayName?: string | null;
    organisation?: string | null;
    titleModel?: string;
    tabularModel?: string;
    legalResearchUs?: boolean;
    quickActionsVisible?: boolean;
    profTitle?: string | null;
    profPhone?: string | null;
    practiceAreas?: string[];
    barAdmissions?: BarAdmission[];
    signatureBlock?: string | null;
}): Promise<UserProfile> {
    return apiRequest<UserProfile>("/user/profile", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function updateUserMfaOnLogin(
    enabled: boolean,
): Promise<UserProfile> {
    return apiRequest<UserProfile>("/user/security/mfa-login", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
    });
}

export type ApiKeyProvider =
    "claude" | "gemini" | "openai" | "openrouter" | "courtlistener";
export type ApiKeySource = "user" | "firm" | "env" | null;
export type ApiKeyState = Record<
    ApiKeyProvider,
    {
        configured: boolean;
        source: ApiKeySource;
    }
>;

export type ApiKeyStatus = Record<ApiKeyProvider, boolean> & {
    sources?: Partial<Record<ApiKeyProvider, ApiKeySource>>;
};

export async function getApiKeyStatus(): Promise<ApiKeyStatus> {
    return apiRequest<ApiKeyStatus>("/user/api-keys");
}

export interface OllamaModelOption {
    id: string;
    label: string;
    group: "Local";
}

export async function getOllamaModels(): Promise<OllamaModelOption[]> {
    const { models } = await apiRequest<{ models: OllamaModelOption[] }>(
        "/models/ollama",
    );
    return models;
}

export async function saveApiKey(
    provider: ApiKeyProvider,
    apiKey: string | null,
): Promise<ApiKeyStatus> {
    return apiRequest<ApiKeyStatus>(`/user/api-keys/${provider}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: apiKey }),
    });
}

export interface McpToolSummary {
    id: string;
    toolName: string;
    openaiToolName: string;
    title: string | null;
    description: string | null;
    enabled: boolean;
    readOnly: boolean;
    destructive: boolean;
    requiresConfirmation: boolean;
    lastSeenAt: string;
}

export interface McpConnectorSummary {
    id: string;
    name: string;
    transport: "streamable_http";
    serverUrl: string;
    authType: "none" | "bearer" | "oauth";
    enabled: boolean;
    hasAuthConfig: boolean;
    customHeaderKeys: string[];
    oauthConnected: boolean;
    toolPolicy: Record<string, unknown>;
    tools: McpToolSummary[];
    toolCount: number;
    createdAt: string;
    updatedAt: string;
}

export async function listMcpConnectors(): Promise<McpConnectorSummary[]> {
    return apiRequest<McpConnectorSummary[]>("/user/mcp-connectors");
}

export async function getMcpConnector(
    connectorId: string,
): Promise<McpConnectorSummary> {
    return apiRequest<McpConnectorSummary>(
        `/user/mcp-connectors/${connectorId}`,
    );
}

export async function createMcpConnector(payload: {
    name: string;
    serverUrl: string;
    bearerToken?: string | null;
    headers?: Record<string, string>;
}): Promise<McpConnectorSummary> {
    return apiRequest<McpConnectorSummary>("/user/mcp-connectors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function updateMcpConnector(
    connectorId: string,
    payload: {
        name?: string;
        serverUrl?: string;
        enabled?: boolean;
        bearerToken?: string | null;
        headers?: Record<string, string>;
    },
): Promise<McpConnectorSummary> {
    return apiRequest<McpConnectorSummary>(
        `/user/mcp-connectors/${connectorId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        },
    );
}

export async function deleteMcpConnector(connectorId: string): Promise<void> {
    return apiRequest<void>(`/user/mcp-connectors/${connectorId}`, {
        method: "DELETE",
    });
}

export async function refreshMcpConnectorTools(
    connectorId: string,
): Promise<McpConnectorSummary> {
    return apiRequest<McpConnectorSummary>(
        `/user/mcp-connectors/${connectorId}/refresh-tools`,
        { method: "POST" },
    );
}

export async function startMcpConnectorOAuth(
    connectorId: string,
): Promise<{ authorizationUrl: string | null; alreadyAuthorized: boolean }> {
    return apiRequest<{
        authorizationUrl: string | null;
        alreadyAuthorized: boolean;
    }>(`/user/mcp-connectors/${connectorId}/oauth/start`, { method: "POST" });
}

export async function setMcpToolEnabled(
    connectorId: string,
    toolId: string,
    enabled: boolean,
): Promise<McpConnectorSummary> {
    return apiRequest<McpConnectorSummary>(
        `/user/mcp-connectors/${connectorId}/tools/${toolId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled }),
        },
    );
}

export async function getProject(projectId: string): Promise<Project> {
    return apiRequest<Project>(`/projects/${projectId}`);
}

export async function updateProject(
    projectId: string,
    payload: {
        name?: string;
        cm_number?: string;
        practice?: string | null;
        overview?: string | null;
        /** Let Mike save the facts it finds without asking first. */
        auto_remember?: boolean;
        /** Whether Mike looks for facts worth remembering at all. */
        suggest_facts?: boolean;
        /** Whether the whole firm can open this matter, or only its own people. */
        visibility?: ProjectVisibility;
        shared_with?: string[];
    },
): Promise<Project> {
    return apiRequest<Project>(`/projects/${projectId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

/**
 * The case overview and how this matter handles suggested facts.
 *
 * Separate from updateProject on purpose: renaming a matter or changing who it
 * is shared with belongs to whoever owns it, but the standing instructions for
 * the case are work product, and anyone working the matter can fix them.
 */
export async function updateCaseContext(
    projectId: string,
    payload: {
        overview?: string | null;
        auto_remember?: boolean;
        suggest_facts?: boolean;
    },
): Promise<{
    id: string;
    overview: string | null;
    auto_remember: boolean;
    suggest_facts: boolean;
}> {
    return apiRequest(`/projects/${projectId}/case-context`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function deleteProject(projectId: string): Promise<void> {
    await apiRequest(`/projects/${projectId}`, { method: "DELETE" });
}

/**
 * Case memory — the short facts a matter picks up as work goes on. They are
 * sent to the assistant with every question asked in that matter.
 */
export type MemoryCategory =
    | "parties"
    | "dates"
    | "position"
    | "decisions"
    | "questions"
    | "drafting";

export interface ProjectMemory {
    id: string;
    project_id: string;
    user_id: string;
    category: MemoryCategory;
    body: string;
    pinned: boolean;
    /**
     * accepted — in force, and sent with every question.
     * proposed — Mike suggested it and nobody has looked at it yet.
     * dismissed — turned down. Kept only so it is not suggested again.
     */
    status: "accepted" | "proposed" | "dismissed";
    /** Whether someone typed this fact or Mike suggested it. */
    origin: "manual" | "assistant";
    /** Where the fact came from, when it came from somewhere checkable. */
    source_document_id: string | null;
    source_page: number | null;
    source_chat_id: string | null;
    /** Set once a newer wording replaces this one. */
    superseded_by: string | null;
    superseded_at: string | null;
    created_at: string;
    updated_at: string;
}

export async function listProjectMemories(
    projectId: string,
    options?: { status?: "accepted" | "proposed"; includeReplaced?: boolean },
): Promise<ProjectMemory[]> {
    const params = new URLSearchParams();
    if (options?.status) params.set("status", options.status);
    if (options?.includeReplaced) params.set("include", "replaced");
    const query = params.toString() ? `?${params}` : "";
    return apiRequest<ProjectMemory[]>(
        `/projects/${projectId}/memories${query}`,
    );
}

/** Keep a suggested fact, optionally tidying its wording on the way through. */
export async function acceptProjectMemory(
    projectId: string,
    memoryId: string,
    payload?: { body?: string; category?: MemoryCategory },
): Promise<ProjectMemory> {
    return apiRequest<ProjectMemory>(
        `/projects/${projectId}/memories/${memoryId}/accept`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload ?? {}),
        },
    );
}

/** Turn a suggested fact down. It is never sent to the assistant. */
export async function dismissProjectMemory(
    projectId: string,
    memoryId: string,
): Promise<void> {
    await apiRequest(`/projects/${projectId}/memories/${memoryId}/dismiss`, {
        method: "POST",
    });
}

export async function createProjectMemory(
    projectId: string,
    payload: {
        body: string;
        category: MemoryCategory;
        pinned?: boolean;
        source_document_id?: string | null;
        source_page?: number | null;
    },
): Promise<ProjectMemory> {
    return apiRequest<ProjectMemory>(`/projects/${projectId}/memories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

/** Small corrections — a typo, the wrong grouping, pinning. */
export async function updateProjectMemory(
    projectId: string,
    memoryId: string,
    payload: {
        body?: string;
        category?: MemoryCategory;
        pinned?: boolean;
        source_document_id?: string | null;
        source_page?: number | null;
    },
): Promise<ProjectMemory> {
    return apiRequest<ProjectMemory>(
        `/projects/${projectId}/memories/${memoryId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        },
    );
}

/**
 * The fact itself has changed — a date moved, a position shifted. Writes the
 * new wording and keeps the old one readable behind it.
 */
export async function supersedeProjectMemory(
    projectId: string,
    memoryId: string,
    payload: {
        body: string;
        category?: MemoryCategory;
        source_document_id?: string | null;
        source_page?: number | null;
    },
): Promise<ProjectMemory> {
    return apiRequest<ProjectMemory>(
        `/projects/${projectId}/memories/${memoryId}/supersede`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        },
    );
}

export async function deleteProjectMemory(
    projectId: string,
    memoryId: string,
): Promise<void> {
    await apiRequest(`/projects/${projectId}/memories/${memoryId}`, {
        method: "DELETE",
    });
}

export interface ProjectPeople {
    owner: {
        user_id: string;
        email: string | null;
        display_name: string | null;
    };
    members: { email: string; display_name: string | null }[];
}

export async function getProjectPeople(
    projectId: string,
): Promise<ProjectPeople> {
    return apiRequest<ProjectPeople>(`/projects/${projectId}/people`);
}

// ---------------------------------------------------------------------------
// Documents
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------

export async function createProjectFolder(
    projectId: string,
    name: string,
    parentFolderId?: string | null,
): Promise<Folder> {
    return apiRequest<Folder>(`/projects/${projectId}/folders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name,
            parent_folder_id: parentFolderId ?? null,
        }),
    });
}

export async function renameProjectFolder(
    projectId: string,
    folderId: string,
    name: string,
): Promise<Folder> {
    return apiRequest<Folder>(`/projects/${projectId}/folders/${folderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
    });
}

export async function deleteProjectFolder(
    projectId: string,
    folderId: string,
): Promise<void> {
    await apiRequest(`/projects/${projectId}/folders/${folderId}`, {
        method: "DELETE",
    });
}

export async function moveSubfolderToFolder(
    projectId: string,
    folderId: string,
    parentFolderId: string | null,
): Promise<Folder> {
    return apiRequest<Folder>(`/projects/${projectId}/folders/${folderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ parent_folder_id: parentFolderId }),
    });
}

export async function moveDocumentToFolder(
    projectId: string,
    documentId: string,
    folderId: string | null,
): Promise<Document> {
    return apiRequest<Document>(
        `/projects/${projectId}/documents/${documentId}/folder`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folder_id: folderId }),
        },
    );
}

export async function renameProjectDocument(
    projectId: string,
    documentId: string,
    filename: string,
): Promise<Document> {
    return apiRequest<Document>(
        `/projects/${projectId}/documents/${documentId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename }),
        },
    );
}

export type LibraryKind = "files" | "templates";

/**
 * Whose shelves a library call is about: your own, or the firm's shared ones.
 * Leaving it out means your own, which is how the library behaved before the
 * firm had one.
 */
export type LibraryScope = "personal" | "firm";

function scopeParam(scope?: LibraryScope): string | null {
    return scope === "firm" ? "firm" : null;
}

/**
 * Only says "firm" when it means it. A personal request sends nothing extra,
 * so it looks on the wire exactly as it did before the firm had a library.
 */
function scopeBody(scope?: LibraryScope): { scope?: string } {
    return scope === "firm" ? { scope: "firm" } : {};
}

export interface LibraryCollection {
    documents: Document[];
    folders: LibraryFolder[];
    documentsHasMore: boolean;
}

export interface LibraryPagination {
    limit?: number;
    offset?: number;
}

export interface LibrarySearchParams extends LibraryPagination {
    search?: string;
    fileType?: string;
    sortKey?: "name" | "type" | "size" | "version" | "created" | "updated";
    sortDirection?: "asc" | "desc";
    signal?: AbortSignal;
}

export interface LibrarySearchResults {
    documents: Document[];
    documentsHasMore: boolean;
}

function libraryPaginationQuery(
    pagination?: LibraryPagination,
    scope?: LibraryScope,
): string {
    const params = new URLSearchParams();
    if (pagination?.limit != null)
        params.set("limit", String(pagination.limit));
    if (pagination?.offset != null)
        params.set("offset", String(pagination.offset));
    const which = scopeParam(scope);
    if (which) params.set("scope", which);
    const qs = params.toString();
    return qs ? `?${qs}` : "";
}

export async function getLibrary(
    kind: LibraryKind,
    pagination?: LibraryPagination,
    scope?: LibraryScope,
): Promise<LibraryCollection> {
    return apiRequest<LibraryCollection>(
        `/library/${kind}${libraryPaginationQuery(pagination, scope)}`,
    );
}

export async function getLibraryFolderChildren(
    kind: LibraryKind,
    folderId: string,
    pagination?: LibraryPagination,
    scope?: LibraryScope,
): Promise<LibraryCollection> {
    const params = new URLSearchParams({ parent_folder_id: folderId });
    if (pagination?.limit != null)
        params.set("limit", String(pagination.limit));
    if (pagination?.offset != null)
        params.set("offset", String(pagination.offset));
    const which = scopeParam(scope);
    if (which) params.set("scope", which);
    return apiRequest<LibraryCollection>(
        `/library/${kind}?${params.toString()}`,
    );
}

export async function getLibraryFolderPath(
    kind: LibraryKind,
    folderId: string,
    scope?: LibraryScope,
): Promise<{ folders: LibraryFolder[] }> {
    const which = scopeParam(scope);
    return apiRequest<{ folders: LibraryFolder[] }>(
        `/library/${kind}/folders/${folderId}${which ? `?scope=${which}` : ""}`,
    );
}

export async function getLibraryLevels(
    kind: LibraryKind,
    levels: { parentId: string | null; limit: number }[],
    scope?: LibraryScope,
): Promise<{
    levels: Array<LibraryCollection & { parentId: string | null }>;
}> {
    return apiRequest(`/library/${kind}/levels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ levels, ...scopeBody(scope) }),
    });
}

export async function searchLibraryDocuments(
    kind: LibraryKind,
    options: LibrarySearchParams,
    scope?: LibraryScope,
): Promise<LibrarySearchResults> {
    const params = new URLSearchParams({ view: "search" });
    const which = scopeParam(scope);
    if (which) params.set("scope", which);
    if (options.limit != null) params.set("limit", String(options.limit));
    if (options.offset != null) params.set("offset", String(options.offset));
    if (options.search) params.set("search", options.search);
    if (options.fileType) params.set("file_type", options.fileType);
    if (options.sortKey) params.set("sort_key", options.sortKey);
    if (options.sortDirection)
        params.set("sort_direction", options.sortDirection);
    return apiRequest<LibrarySearchResults>(
        `/library/${kind}?${params.toString()}`,
        { signal: options.signal },
    );
}

export async function getLibraryFilterOptions(
    kind: LibraryKind,
    scope?: LibraryScope,
): Promise<{ fileTypes: string[] }> {
    const which = scopeParam(scope);
    return apiRequest<{ fileTypes: string[] }>(
        `/library/${kind}/filter-options${which ? `?scope=${which}` : ""}`,
    );
}

export async function listLibraryDocumentIds(
    kind: LibraryKind,
    options?: { search?: string; fileType?: string; signal?: AbortSignal },
    scope?: LibraryScope,
): Promise<string[]> {
    const params = new URLSearchParams();
    if (options?.search) params.set("search", options.search);
    if (options?.fileType) params.set("file_type", options.fileType);
    const which = scopeParam(scope);
    if (which) params.set("scope", which);
    const query = params.toString();
    return apiRequest<string[]>(
        `/library/${kind}/ids${query ? `?${query}` : ""}`,
        { signal: options?.signal },
    );
}

export async function bulkDeleteLibraryDocuments(
    kind: LibraryKind,
    ids: string[],
    scope?: LibraryScope,
): Promise<{ deletedIds: string[] }> {
    return apiRequest<{ deletedIds: string[] }>(
        `/library/${kind}/documents/bulk-delete`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ids, ...scopeBody(scope) }),
        },
    );
}

/** Put a copy of a document on the firm's shelves. The original stays put. */
export async function publishDocumentToFirm(
    documentId: string,
    options?: { libraryKind?: "file" | "template"; folderId?: string | null },
): Promise<{ id: string; filename: string }> {
    return apiRequest<{ id: string; filename: string }>(
        `/library/documents/${documentId}/publish`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                library_kind: options?.libraryKind ?? "template",
                folder_id: options?.folderId ?? null,
            }),
        },
    );
}

export async function uploadLibraryDocument(
    kind: LibraryKind,
    file: File,
    scope?: LibraryScope,
): Promise<Document> {
    const authHeaders = await getAuthHeader();
    const form = new FormData();
    form.append("file", file);
    const which = scopeParam(scope);
    if (which) form.append("scope", which);
    const response = await fetch(`${API_BASE}/library/${kind}/documents`, {
        method: "POST",
        headers: { ...authHeaders },
        body: form,
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<Document>;
}

export async function createLibraryFolder(
    kind: LibraryKind,
    name: string,
    parentFolderId?: string | null,
    scope?: LibraryScope,
): Promise<LibraryFolder> {
    return apiRequest<LibraryFolder>(`/library/${kind}/folders`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            name,
            parent_folder_id: parentFolderId ?? null,
            ...scopeBody(scope),
        }),
    });
}

export async function renameLibraryFolder(
    kind: LibraryKind,
    folderId: string,
    name: string,
    scope?: LibraryScope,
): Promise<LibraryFolder> {
    return apiRequest<LibraryFolder>(`/library/${kind}/folders/${folderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, ...scopeBody(scope) }),
    });
}

export async function deleteLibraryFolder(
    kind: LibraryKind,
    folderId: string,
    scope?: LibraryScope,
): Promise<void> {
    const which = scopeParam(scope);
    await apiRequest(
        `/library/${kind}/folders/${folderId}${which ? `?scope=${which}` : ""}`,
        { method: "DELETE" },
    );
}

export async function moveLibraryFolder(
    kind: LibraryKind,
    folderId: string,
    parentFolderId: string | null,
    scope?: LibraryScope,
): Promise<LibraryFolder> {
    return apiRequest<LibraryFolder>(`/library/${kind}/folders/${folderId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            parent_folder_id: parentFolderId,
            ...scopeBody(scope),
        }),
    });
}

export async function moveLibraryDocument(
    kind: LibraryKind,
    documentId: string,
    folderId: string | null,
    scope?: LibraryScope,
): Promise<Document> {
    return apiRequest<Document>(
        `/library/${kind}/documents/${documentId}/folder`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                folder_id: folderId,
                ...scopeBody(scope),
            }),
        },
    );
}

export async function renameLibraryDocument(
    kind: LibraryKind,
    documentId: string,
    filename: string,
    scope?: LibraryScope,
): Promise<Document> {
    return apiRequest<Document>(`/library/${kind}/documents/${documentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, ...scopeBody(scope) }),
    });
}

export async function addDocumentToProject(
    projectId: string,
    documentId: string,
): Promise<Document> {
    return apiRequest<Document>(
        `/projects/${projectId}/documents/${documentId}`,
        { method: "POST" },
    );
}

export interface DocumentVersion {
    id: string;
    version_number: number | null;
    source: string;
    created_at: string;
    filename: string | null;
    file_type?: string | null;
    size_bytes?: number | null;
    page_count?: number | null;
    deleted_at?: string | null;
    deleted_by?: string | null;
}

export async function listDocumentVersions(documentId: string): Promise<{
    current_version_id: string | null;
    versions: DocumentVersion[];
}> {
    return apiRequest(`/single-documents/${documentId}/versions`);
}

export async function uploadDocumentVersion(
    documentId: string,
    file: File,
    filename?: string,
): Promise<DocumentVersion> {
    const authHeaders = await getAuthHeader();
    const form = new FormData();
    form.append("file", file);
    if (filename) form.append("filename", filename);
    const response = await fetch(
        `${API_BASE}/single-documents/${documentId}/versions`,
        {
            method: "POST",
            headers: { ...authHeaders },
            body: form,
        },
    );
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<DocumentVersion>;
}

export async function replaceDocumentVersionFile(
    documentId: string,
    versionId: string,
    file: File,
    filename?: string,
): Promise<DocumentVersion> {
    const authHeaders = await getAuthHeader();
    const form = new FormData();
    form.append("file", file);
    if (filename) form.append("filename", filename);
    const response = await fetch(
        `${API_BASE}/single-documents/${documentId}/versions/${versionId}/file`,
        {
            method: "PUT",
            headers: { ...authHeaders },
            body: form,
        },
    );
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<DocumentVersion>;
}

export async function copyDocumentVersionFromDocument(
    documentId: string,
    sourceDocumentId: string,
    filename?: string,
): Promise<DocumentVersion> {
    return apiRequest<DocumentVersion>(
        `/single-documents/${documentId}/versions/from-document`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                source_document_id: sourceDocumentId,
                filename,
            }),
        },
    );
}

export async function renameDocumentVersion(
    documentId: string,
    versionId: string,
    filename: string | null,
): Promise<DocumentVersion> {
    return apiRequest<DocumentVersion>(
        `/single-documents/${documentId}/versions/${versionId}`,
        {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ filename }),
        },
    );
}

export async function deleteDocumentVersion(
    documentId: string,
    versionId: string,
): Promise<{
    deleted_version_id: string;
    current_version_id: string | null;
}> {
    return apiRequest(`/single-documents/${documentId}/versions/${versionId}`, {
        method: "DELETE",
    });
}

export async function uploadProjectDocument(
    projectId: string,
    file: File,
): Promise<Document> {
    const authHeaders = await getAuthHeader();
    const form = new FormData();
    form.append("file", file);
    const response = await fetch(
        `${API_BASE}/projects/${projectId}/documents`,
        {
            method: "POST",
            headers: { ...authHeaders },
            body: form,
        },
    );
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<Document>;
}

export async function uploadStandaloneDocument(file: File): Promise<Document> {
    const authHeaders = await getAuthHeader();
    const form = new FormData();
    form.append("file", file);
    const response = await fetch(`${API_BASE}/single-documents`, {
        method: "POST",
        headers: { ...authHeaders },
        body: form,
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json() as Promise<Document>;
}

export async function listStandaloneDocuments(): Promise<Document[]> {
    return apiRequest<Document[]>("/single-documents");
}

export async function deleteDocument(documentId: string): Promise<void> {
    await apiRequest(`/single-documents/${documentId}`, { method: "DELETE" });
}

export interface DocumentEditResolution {
    ok: boolean;
    already_resolved?: boolean;
    status?: "accepted" | "rejected";
    version_id: string | null;
    download_url: string | null;
    remaining_pending?: number;
}

export async function resolveDocumentEdit(
    documentId: string,
    editId: string,
    verb: "accept" | "reject",
): Promise<DocumentEditResolution> {
    return apiRequest<DocumentEditResolution>(
        `/single-documents/${encodeURIComponent(documentId)}/edits/${encodeURIComponent(editId)}/${verb}`,
        { method: "POST" },
    );
}

export async function getDocumentText(documentId: string): Promise<string> {
    const authHeaders = await getAuthHeader();
    const response = await fetch(
        `${API_BASE}/single-documents/${documentId}/text`,
        { headers: { ...authHeaders }, cache: "no-store" },
    );
    if (!response.ok) throw new Error(await response.text());
    return response.text();
}

export async function getDocumentUrl(
    documentId: string,
    versionId?: string | null,
): Promise<{ url: string; filename: string; version_id: string | null }> {
    const qs = versionId ? `?version_id=${encodeURIComponent(versionId)}` : "";
    return apiRequest(`/single-documents/${documentId}/url${qs}`);
}

export async function downloadDocumentsZip(
    documentIds: string[],
): Promise<Blob> {
    const authHeaders = await getAuthHeader();
    const response = await fetch(`${API_BASE}/single-documents/download-zip`, {
        method: "POST",
        cache: "no-store",
        headers: {
            "Content-Type": "application/json",
            ...authHeaders,
        },
        body: JSON.stringify({ document_ids: documentIds }),
    });
    if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || `API error: ${response.status}`);
    }
    return response.blob();
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

export async function createChat(payload?: {
    project_id?: string;
}): Promise<{ id: string }> {
    return apiRequest<{ id: string }>("/chat/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload ?? {}),
    });
}

export async function listChats(options?: {
    limit?: number;
    offset?: number;
}): Promise<Chat[]> {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.offset) params.set("offset", String(options.offset));
    const query = params.toString();
    return apiRequest<Chat[]>(`/chat${query ? `?${query}` : ""}`);
}

export async function listProjectChats(projectId: string): Promise<Chat[]> {
    return apiRequest<Chat[]>(`/projects/${projectId}/chats`);
}

export async function getChat(chatId: string): Promise<ChatDetailOut> {
    const raw = await apiRequest<ServerChatDetailOut>(`/chat/${chatId}`);
    const messages: Message[] = raw.messages.map((m) => {
        if (m.role === "user") {
            return {
                id: m.id,
                role: "user",
                content: typeof m.content === "string" ? m.content : "",
                files: m.files ?? undefined,
                workflow: m.workflow ?? undefined,
            };
        }
        const events = Array.isArray(m.content)
            ? (m.content as AssistantEvent[])
            : undefined;
        return {
            id: m.id,
            role: "assistant",
            content:
                events
                    ?.filter((e) => e.type === "content")
                    .map((e) => (e as { type: "content"; text: string }).text)
                    .join("") ?? "",
            citations: m.citations ?? undefined,
            events,
        };
    });
    return { chat: raw.chat, messages };
}

export async function renameChat(chatId: string, title: string): Promise<void> {
    await apiRequest(`/chat/${chatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
    });
}

export async function deleteChat(chatId: string): Promise<void> {
    await apiRequest(`/chat/${chatId}`, { method: "DELETE" });
}

export async function generateChatTitle(
    chatId: string,
    message: string,
): Promise<{ title: string }> {
    return apiRequest<{ title: string }>(`/chat/${chatId}/generate-title`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
    });
}

const panelDocumentRequests = new Map<string, Promise<PanelDocument>>();

export async function getPanelDocument(
    documentId: string,
): Promise<PanelDocument> {
    let request = panelDocumentRequests.get(documentId);
    if (!request) {
        request = apiRequest<unknown>(
            `/documents/${encodeURIComponent(documentId)}`,
        )
            .then((value) => {
                if (!isPanelDocument(value)) {
                    throw new Error("Invalid source document response");
                }
                return value;
            })
            .finally(() => panelDocumentRequests.delete(documentId));
        panelDocumentRequests.set(documentId, request);
    }
    return request;
}

export async function streamChat(payload: {
    messages: {
        role: string;
        content: string;
        files?: { filename: string; document_id?: string }[];
        workflow?: { id: string; title: string };
    }[];
    chat_id?: string;
    project_id?: string;
    model?: string;
    ask_inputs_response?: {
        responses: (
            | {
                  id: string;
                  kind: "choice";
                  question: string;
                  answer?: string;
                  skipped?: boolean;
              }
            | {
                  id: string;
                  kind: "documents";
                  filenames: string[];
                  skipped?: boolean;
              }
        )[];
    };
    /** Carry on a turn that stopped searching before it finished. */
    resume?: { token: string; condense?: boolean };
    signal?: AbortSignal;
}): Promise<Response> {
    const { signal, ...body } = payload;
    const authHeaders = await getAuthHeader();
    return fetch(`${API_BASE}/chat`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...authHeaders,
        },
        body: JSON.stringify(body),
        signal,
    });
}

type StreamChatMessage = {
    role: string;
    content: string;
    files?: { filename: string; document_id?: string }[];
    workflow?: { id: string; title: string };
};

export async function streamProjectChat(payload: {
    projectId: string;
    messages: StreamChatMessage[];
    chat_id?: string;
    model?: string;
    displayed_doc?: { filename: string; document_id: string };
    attached_documents?: { filename: string; document_id: string }[];
    ask_inputs_response?: {
        responses: (
            | {
                  id: string;
                  kind: "choice";
                  question: string;
                  answer?: string;
                  skipped?: boolean;
              }
            | {
                  id: string;
                  kind: "documents";
                  filenames: string[];
                  skipped?: boolean;
              }
        )[];
    };
    /** Carry on a turn that stopped searching before it finished. */
    resume?: { token: string; condense?: boolean };
    signal?: AbortSignal;
}): Promise<Response> {
    const { projectId, signal, ...body } = payload;
    const authHeaders = await getAuthHeader();
    return fetch(`${API_BASE}/projects/${projectId}/chat`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
            ...authHeaders,
        },
        body: JSON.stringify(body),
        signal,
    });
}

// ---------------------------------------------------------------------------
// Tabular Review
// ---------------------------------------------------------------------------

export async function listTabularReviews(
    projectId?: string,
    pagination?: {
        limit?: number;
        offset?: number;
        search?: string;
        sortKey?: string;
        sortDirection?: "asc" | "desc";
        scope?: "all" | "in-project" | "standalone";
        signal?: AbortSignal;
    },
): Promise<TabularReview[]> {
    const params = new URLSearchParams();
    if (projectId) params.set("project_id", projectId);
    if (pagination?.limit) params.set("limit", String(pagination.limit));
    if (pagination?.offset) params.set("offset", String(pagination.offset));
    if (pagination?.search) params.set("search", pagination.search);
    if (pagination?.sortKey) params.set("sort_key", pagination.sortKey);
    if (pagination?.sortDirection)
        params.set("sort_direction", pagination.sortDirection);
    if (pagination?.scope && pagination.scope !== "all")
        params.set("scope", pagination.scope);

    const qs = params.toString() ? `?${params.toString()}` : "";
    return apiRequest<TabularReview[]>(`/tabular-review${qs}`, {
        signal: pagination?.signal,
    });
}

export async function listTabularReviewIds(
    projectId?: string,
    options?: {
        search?: string;
        scope?: "all" | "in-project" | "standalone";
        signal?: AbortSignal;
    },
): Promise<{ id: string; user_id: string }[]> {
    const params = new URLSearchParams();
    if (projectId) params.set("project_id", projectId);
    if (options?.search) params.set("search", options.search);
    if (options?.scope && options.scope !== "all")
        params.set("scope", options.scope);

    const qs = params.toString() ? `?${params.toString()}` : "";
    return apiRequest<{ id: string; user_id: string }[]>(
        `/tabular-review/ids${qs}`,
        { signal: options?.signal },
    );
}

export async function createTabularReview(payload: {
    title?: string;
    document_ids: string[];
    columns_config: { index: number; name: string; prompt: string }[];
    workflow_id?: string;
    project_id?: string;
    document_grouping?: "document" | "folder";
}): Promise<TabularReview> {
    return apiRequest<TabularReview>("/tabular-review", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function getTabularReview(
    reviewId: string,
): Promise<TabularReviewDetailOut> {
    return apiRequest<TabularReviewDetailOut>(`/tabular-review/${reviewId}`);
}

export async function updateTabularReview(
    reviewId: string,
    payload: {
        title?: string;
        columns_config?: { index: number; name: string; prompt: string }[];
        document_ids?: string[];
        project_id?: string | null;
        document_grouping?: "document" | "folder";
        shared_with?: string[];
    },
): Promise<TabularReview> {
    return apiRequest<TabularReview>(`/tabular-review/${reviewId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function getTabularReviewPeople(
    reviewId: string,
): Promise<ProjectPeople> {
    return apiRequest<ProjectPeople>(`/tabular-review/${reviewId}/people`);
}

export async function generateTabularColumnPrompt(
    title: string,
    options?: { format?: string; documentName?: string; tags?: string[] },
): Promise<{ prompt: string; source: "preset" | "llm" | "fallback" }> {
    return apiRequest<{
        prompt: string;
        source: "preset" | "llm" | "fallback";
    }>("/tabular-review/prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            title,
            format: options?.format,
            documentName: options?.documentName,
            tags: options?.tags,
        }),
    });
}

export async function uploadReviewDocument(
    reviewId: string,
    file: File,
    options?: {
        projectId?: string;
        documentIds?: string[];
        columnsConfig?: { index: number; name: string; prompt: string }[];
    },
): Promise<Document> {
    const uploaded = options?.projectId
        ? await uploadProjectDocument(options.projectId, file)
        : await uploadStandaloneDocument(file);

    await updateTabularReview(reviewId, {
        columns_config: options?.columnsConfig,
        document_ids: [...(options?.documentIds ?? []), uploaded.id],
    });

    return uploaded;
}

/**
 * Writes the grid into the matter it belongs to, as a spreadsheet filed with
 * the rest of the case documents.
 */
export async function saveTabularReviewToMatter(reviewId: string) {
    return apiRequest<{
        filename?: string;
        document_id?: string;
    }>(`/tabular-review/${reviewId}/save-to-matter`, { method: "POST" });
}

export async function deleteTabularReview(reviewId: string): Promise<void> {
    await apiRequest(`/tabular-review/${reviewId}`, { method: "DELETE" });
}

export async function streamTabularGeneration(
    reviewId: string,
): Promise<Response> {
    const authHeaders = await getAuthHeader();
    return fetch(`${API_BASE}/tabular-review/${reviewId}/generate`, {
        method: "POST",
        headers: { ...authHeaders },
    });
}

export async function streamTabularChat(
    reviewId: string,
    messages: { role: string; content: string }[],
    chat_id?: string | null,
    signal?: AbortSignal,
    context?: { reviewTitle?: string | null; projectName?: string | null },
): Promise<Response> {
    const authHeaders = await getAuthHeader();
    return fetch(`${API_BASE}/tabular-review/${reviewId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
            messages,
            chat_id: chat_id ?? undefined,
            review_title: context?.reviewTitle ?? undefined,
            project_name: context?.projectName ?? undefined,
        }),
        signal: signal ?? undefined,
    });
}

export interface TRCitationAnnotation {
    type: "tabular_citation";
    ref: number;
    col_index: number;
    row_index: number;
    col_name: string;
    doc_name: string;
    quote: string;
}

interface RawTRMessage {
    id: string;
    chat_id: string;
    role: "user" | "assistant";
    content: string | AssistantEvent[] | null;
    annotations?: TRCitationAnnotation[] | null;
    created_at: string;
}

export interface TRDisplayMessage {
    role: "user" | "assistant";
    content: string;
    events?: AssistantEvent[];
    annotations?: TRCitationAnnotation[];
}

export interface TRChat {
    id: string;
    title: string | null;
    created_at: string;
    updated_at: string;
}

export function mapTRMessages(raw: RawTRMessage[]): TRDisplayMessage[] {
    return raw.map((m) => {
        if (m.role === "user") {
            return {
                role: "user" as const,
                content: typeof m.content === "string" ? m.content : "",
            };
        }
        const events = Array.isArray(m.content)
            ? (m.content as AssistantEvent[])
            : undefined;
        const content =
            events
                ?.filter((e) => e.type === "content")
                .map((e) => (e as { type: "content"; text: string }).text)
                .join("") ?? "";
        return {
            role: "assistant" as const,
            content,
            events,
            annotations: m.annotations ?? undefined,
        };
    });
}

export async function getTabularChats(reviewId: string): Promise<TRChat[]> {
    return apiRequest<TRChat[]>(`/tabular-review/${reviewId}/chats`);
}

export async function getTabularChatMessages(
    reviewId: string,
    chatId: string,
): Promise<RawTRMessage[]> {
    return apiRequest<RawTRMessage[]>(
        `/tabular-review/${reviewId}/chats/${chatId}/messages`,
    );
}

export async function deleteTabularChat(
    reviewId: string,
    chatId: string,
): Promise<void> {
    await apiRequest(`/tabular-review/${reviewId}/chats/${chatId}`, {
        method: "DELETE",
    });
}

export async function renameTabularChat(
    reviewId: string,
    chatId: string,
    title: string,
): Promise<void> {
    await apiRequest(`/tabular-review/${reviewId}/chats/${chatId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
    });
}

export async function regenerateTabularCell(
    reviewId: string,
    rowId: string,
    columnIndex: number,
): Promise<{
    summary: string;
    flag: "green" | "grey" | "yellow" | "red";
    reasoning: string;
}> {
    return apiRequest(`/tabular-review/${reviewId}/regenerate-cell`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            row_id: rowId,
            column_index: columnIndex,
        }),
    });
}

export async function clearTabularCells(
    reviewId: string,
    rowIds: string[],
): Promise<void> {
    await apiRequest(`/tabular-review/${reviewId}/clear-cells`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ row_ids: rowIds }),
    });
}

// ---------------------------------------------------------------------------
// Workflows
// ---------------------------------------------------------------------------

type WorkflowType = Workflow["metadata"]["type"];

export async function listWorkflows(type?: WorkflowType): Promise<Workflow[]> {
    return apiRequest<Workflow[]>(
        type ? `/workflows?type=${type}` : "/workflows",
    );
}

// Paginated sibling of listWorkflows() used only by WorkflowList.tsx.
// Deliberately a separate function, not an overload — the backend route
// decides whether to paginate based on whether any of these query params
// are present at all, so listWorkflows() must keep sending none of them
// (every other caller — the workflow picker modal, the chat slash-menu
// picker, UseWorkflowModal's own independent fetch — needs the exact legacy
// response shape, system workflows included). Returns DB-backed rows only
// (always is_system: false) — system workflows come from listSystemWorkflows.
export async function listWorkflowsPage(pagination?: {
    limit?: number;
    offset?: number;
    search?: string;
    sortKey?: string;
    sortDirection?: "asc" | "desc";
    scope?: "all" | "owned" | "shared";
    type?: WorkflowType;
    practice?: string;
    language?: string;
    jurisdiction?: string;
    signal?: AbortSignal;
}): Promise<Workflow[]> {
    const params = new URLSearchParams();
    if (pagination?.type) params.set("type", pagination.type);
    if (pagination?.limit) params.set("limit", String(pagination.limit));
    if (pagination?.offset) params.set("offset", String(pagination.offset));
    if (pagination?.search) params.set("search", pagination.search);
    if (pagination?.sortKey) params.set("sort_key", pagination.sortKey);
    if (pagination?.sortDirection)
        params.set("sort_direction", pagination.sortDirection);
    if (pagination?.scope && pagination.scope !== "all")
        params.set("scope", pagination.scope);
    if (pagination?.practice) params.set("practice", pagination.practice);
    if (pagination?.language) params.set("language", pagination.language);
    if (pagination?.jurisdiction)
        params.set("jurisdiction", pagination.jurisdiction);

    const qs = params.toString() ? `?${params.toString()}` : "";
    return apiRequest<Workflow[]>(`/workflows${qs}`, {
        signal: pagination?.signal,
    });
}

export async function listWorkflowIds(options?: {
    search?: string;
    scope?: "all" | "owned" | "shared";
    type?: WorkflowType;
    practice?: string;
    language?: string;
    jurisdiction?: string;
    signal?: AbortSignal;
}): Promise<{ id: string; user_id: string }[]> {
    const params = new URLSearchParams();
    if (options?.type) params.set("type", options.type);
    if (options?.search) params.set("search", options.search);
    if (options?.scope && options.scope !== "all")
        params.set("scope", options.scope);
    if (options?.practice) params.set("practice", options.practice);
    if (options?.language) params.set("language", options.language);
    if (options?.jurisdiction) params.set("jurisdiction", options.jurisdiction);

    const qs = params.toString() ? `?${params.toString()}` : "";
    return apiRequest<{ id: string; user_id: string }[]>(
        `/workflows/ids${qs}`,
        {
            signal: options?.signal,
        },
    );
}

// Always-unpaginated: the static, code-generated system-workflow list (37
// entries, zero user-data growth). Fetched once by usePaginatedWorkflows and
// kept fully in memory rather than folded into the paginated RPC above.
export async function listSystemWorkflows(
    type?: WorkflowType,
): Promise<Workflow[]> {
    const qs = type ? `?type=${type}` : "";
    return apiRequest<Workflow[]>(`/workflows/system${qs}`);
}

export interface WorkflowFilterOptions {
    practices: string[];
    languages: string[];
    jurisdictions: string[];
}

export async function getWorkflowFilterOptions(options?: {
    type?: WorkflowType;
    scope?: "all" | "owned" | "shared";
    signal?: AbortSignal;
}): Promise<WorkflowFilterOptions> {
    const params = new URLSearchParams();
    if (options?.type) params.set("type", options.type);
    if (options?.scope && options.scope !== "all")
        params.set("scope", options.scope);
    const query = params.toString();
    return apiRequest<WorkflowFilterOptions>(
        `/workflows/filter-options${query ? `?${query}` : ""}`,
        {
            signal: options?.signal,
        },
    );
}

export async function getWorkflow(workflowId: string): Promise<Workflow> {
    return apiRequest<Workflow>(`/workflows/${workflowId}`);
}

export async function createWorkflow(payload: {
    metadata: {
        title: string;
        type: "assistant" | "tabular";
        language?: string | null;
        practice?: string | null;
        jurisdictions?: string[] | null;
    };
    skill_md?: string;
    columns_config?: { index: number; name: string; prompt: string }[];
}): Promise<Workflow> {
    return apiRequest<Workflow>("/workflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function updateWorkflow(
    workflowId: string,
    payload: {
        metadata?: {
            title?: string;
            language?: string | null;
            practice?: string | null;
            jurisdictions?: string[] | null;
        };
        skill_md?: string;
        columns_config?: { index: number; name: string; prompt: string }[];
    },
): Promise<Workflow> {
    return apiRequest<Workflow>(`/workflows/${workflowId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function deleteWorkflow(workflowId: string): Promise<void> {
    await apiRequest(`/workflows/${workflowId}`, { method: "DELETE" });
}

/**
 * Copy one of your own workflows onto the firm's list so everyone there can
 * run it. Yours stays yours; the firm's copy is separate.
 */
export async function publishWorkflowToFirm(
    workflowId: string,
): Promise<Workflow> {
    return apiRequest<Workflow>(`/workflows/${workflowId}/publish-to-firm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
    });
}

export async function openSourceWorkflow(
    workflowId: string,
    payload: {
        contributor_mode: OpenSourceWorkflowContributorMode;
        contributor?: WorkflowContributor | null;
    },
): Promise<OpenSourceWorkflowResponse> {
    return apiRequest<OpenSourceWorkflowResponse>(
        `/workflows/${workflowId}/open-source`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        },
    );
}

export async function listHiddenWorkflows(): Promise<string[]> {
    return apiRequest<string[]>("/workflows/hidden");
}

export async function hideWorkflow(workflowId: string): Promise<void> {
    await apiRequest("/workflows/hidden", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflow_id: workflowId }),
    });
}

export async function unhideWorkflow(workflowId: string): Promise<void> {
    await apiRequest(`/workflows/hidden/${workflowId}`, { method: "DELETE" });
}

export async function shareWorkflow(
    workflowId: string,
    payload: { emails: string[]; allow_edit: boolean },
): Promise<void> {
    await apiRequest<void>(`/workflows/${workflowId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function listWorkflowShares(workflowId: string): Promise<
    {
        id: string;
        shared_with_email: string;
        allow_edit: boolean;
        created_at: string;
    }[]
> {
    return apiRequest(`/workflows/${workflowId}/shares`);
}

export async function deleteWorkflowShare(
    workflowId: string,
    shareId: string,
): Promise<void> {
    await apiRequest(`/workflows/${workflowId}/shares/${shareId}`, {
        method: "DELETE",
    });
}

export async function listQuickActions(): Promise<QuickAction[]> {
    return apiRequest<QuickAction[]>("/quick-actions");
}

export async function createQuickAction(payload: {
    workflow_id: string;
    name: string;
    prompt: string;
    document_upload: boolean;
    enabled?: boolean;
    sort_order?: number;
}): Promise<QuickAction> {
    return apiRequest<QuickAction>("/quick-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function updateQuickAction(
    quickActionId: string,
    payload: Partial<
        Pick<
            QuickAction,
            | "workflow_id"
            | "name"
            | "prompt"
            | "document_upload"
            | "enabled"
            | "sort_order"
        >
    >,
): Promise<QuickAction> {
    return apiRequest<QuickAction>(`/quick-actions/${quickActionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });
}

export async function deleteQuickAction(quickActionId: string): Promise<void> {
    await apiRequest(`/quick-actions/${quickActionId}`, { method: "DELETE" });
}

export async function listWorkflowAddons(): Promise<WorkflowAddon[]> {
    return apiRequest<WorkflowAddon[]>("/workflow-addons");
}

export async function getWorkflowAddon(
    addonId: string,
): Promise<WorkflowAddon> {
    return apiRequest<WorkflowAddon>(`/workflow-addons/${addonId}`);
}

export async function importWorkflowAddon(addonId: string): Promise<Workflow> {
    return apiRequest<Workflow>(`/workflow-addons/${addonId}/import`, {
        method: "POST",
    });
}

export async function listWorkflowReferenceFiles(
    workflowId: string,
): Promise<WorkflowReferenceDocument[]> {
    return apiRequest<WorkflowReferenceDocument[]>(
        `/workflows/${workflowId}/reference-files`,
    );
}

export async function uploadWorkflowReferenceFile(
    workflowId: string,
    file: File,
): Promise<WorkflowReferenceDocument> {
    const authHeaders = await getAuthHeader();
    const form = new FormData();
    form.append("file", file);
    const response = await fetch(
        `${API_BASE}/workflows/${workflowId}/reference-files`,
        { method: "POST", headers: { ...authHeaders }, body: form },
    );
    if (!response.ok)
        throw await toApiError(response, "/workflows/reference-files");
    return response.json() as Promise<WorkflowReferenceDocument>;
}

export async function replaceWorkflowReferenceFile(
    workflowId: string,
    referenceId: string,
    file: File,
): Promise<WorkflowReferenceDocument> {
    const authHeaders = await getAuthHeader();
    const form = new FormData();
    form.append("file", file);
    const path = `/workflows/${workflowId}/reference-files/${referenceId}`;
    const response = await fetch(`${API_BASE}${path}`, {
        method: "PUT",
        headers: { ...authHeaders },
        body: form,
    });
    if (!response.ok) throw await toApiError(response, path);
    return response.json() as Promise<WorkflowReferenceDocument>;
}

export async function getWorkflowReferenceUrl(
    workflowId: string,
    referenceId: string,
): Promise<{ url: string; filename: string }> {
    return apiRequest<{ url: string; filename: string }>(
        `/workflows/${workflowId}/reference-files/${referenceId}/url`,
    );
}

export async function deleteWorkflowReferenceFile(
    workflowId: string,
    referenceId: string,
): Promise<void> {
    await apiRequest(
        `/workflows/${workflowId}/reference-files/${referenceId}`,
        {
            method: "DELETE",
        },
    );
}

// ---------------------------------------------------------------------------
// Legal sources saved out of a chat
// ---------------------------------------------------------------------------

export type SaveLegalSourceBody =
    | {
          kind: "case";
          cluster_id: number;
          case_name?: string | null;
          citation?: string | null;
          date_filed?: string | null;
          url?: string | null;
          pdf_url?: string | null;
      }
    | { kind: "legislation"; leg_id: string; chat_id: string };

export type SavedLegalSource = {
    status: "saved" | "exists";
    document_id: string;
    filename: string;
    folder_id: string | null;
    folder_name: string;
    title: string;
};

/** File a case or statute into a matter's Law folder. */
/** Which cases and statutes are already in a matter's Law folder. */
export async function listSavedLegalSources(
    projectId: string,
): Promise<{ kind: string; ref: string }[]> {
    const result = await apiRequest<{
        sources?: { kind: string; ref: string }[];
    }>(`/projects/${projectId}/legal-sources`);
    return result.sources ?? [];
}

export async function saveLegalSource(
    projectId: string,
    body: SaveLegalSourceBody,
): Promise<SavedLegalSource> {
    return apiRequest<SavedLegalSource>(`/projects/${projectId}/legal-sources`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
}
