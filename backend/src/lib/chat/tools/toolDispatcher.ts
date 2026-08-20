import {
  getCourtlistenerCases,
  searchCourtlistenerCaseLaw,
  verifyCourtlistenerCitations,
} from "../../courtlistener";
import { normalizeCaseDocument } from "../../sourceDocuments";
import {
  COURTLISTENER_TOOL_NAMES,
  type CaseCitationEvent,
  type CourtlistenerToolEvent,
} from "./courtlistenerTools";
import { executeMcpToolCall, type McpToolEvent } from "../../mcpConnectors";
import { createServerSupabase } from "../../supabase";
import { recordAudit } from "../../audit";
import {
  formMetadataForModel,
  listApprovedFormsOfType,
  loadApprovedForm,
  readableFirmId,
  searchApprovedForms,
} from "../../formBank";
import { searchMatter, formatForAssistant } from "../../matterSearch";
import {
  type DocStore,
  type DocIndex,
  type TabularCellStore,
  type WorkflowStore,
  type ToolCall,
  type AskInputItem,
  type AskInputOption,
  type AskInputsEvent,
  devLog,
  resolveDocLabel,
} from "../types";
import { downloadFile, storageKey, uploadFile } from "../../storage";
import { convertedPdfKey, docxToPdf } from "../../convert";
import {
  contentTypeForDocumentType,
  shouldConvertToPdf,
} from "../../documentTypes";
import {
  loadReviewSnapshot,
  snapshotToText,
} from "../../tabularSnapshot";
import { buildDownloadUrl } from "../../downloadTokens";
import { safeErrorMessage } from "../../safeError";
import { contentSha256, loadActiveVersion } from "../../documentVersions";
import { type EditInput } from "../../docxTrackedChanges";
import {
  citationReminder,
  generateDocx,
  docxBytesFromParagraphs,
  extractPdfParagraphs,
  type DocxStyle,
  generateExcel,
  generatePpt,
  getTurnReadIdentity,
  duplicateReadDocumentResult,
  clearTurnReadsForDocument,
  readDocumentContent,
  findInDocumentContent,
  findTextMatches,
  runEditDocument,
  runWriteDocument,
  type WriteBlock,
  safeGeneratedFilename,
  type DocEditedResult,
  type TurnEditState,
  type TurnReadState,
  type DocCreatedResult,
  type DocReplicatedResult,
  type TextMatch,
} from "./documentOps";
import {
  spotlight,
  spotlightFilename,
  spotlightWorkflow,
} from "../contextBuilders";
import {
  cachedCaseOpinionTexts,
  caseCitationEventFromRecord,
  courtlistenerCaseInputFromFetchedCase,
  courtlistenerFetchedCaseMetadata,
  courtlistenerOpinionCount,
  courtlistenerOpinionMetadata,
  recordFromUnknown,
  stringField,
  upsertCourtlistenerCases,
  type CourtlistenerTurnState,
} from "./courtlistenerTurnState";
import {
  ingestLegislationToolResult,
  newLegislationTurnState,
  normalizeLegId,
  type LegislationTurnState,
} from "./legislationTurnState";
import { saveLegalSourceToProject } from "../../legalSources";

function sourceMaterialNotice(
  sourceKind: "document" | "library_template" | "workflow_asset" | undefined,
) {
  if (sourceKind === "library_template") {
    return "Source type: Library Template (immutable). If this template will be edited or filled in, call replicate_document with a new_filename and work from the returned copy; reading it for information needs no copy.";
  }
  if (sourceKind === "workflow_asset") {
    return "Source type: Workflow asset (immutable). If this file will be used as a template — edited or filled in — call replicate_document with a new_filename and work from the returned copy; reading it for information needs no copy.";
  }
  return null;
}

function cleanAskInputString(value: unknown, fallback = ""): string {
  const text = typeof value === "string" ? value.trim() : "";
  return text || fallback;
}

function normalizeAskInputsEvent(
  args: Record<string, unknown>,
): AskInputsEvent {
  const rawItems = Array.isArray(args.items) ? args.items : [];
  const items = rawItems
    .map((item, index): AskInputItem | null => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const row = item as Record<string, unknown>;
      const id =
        cleanAskInputString(row.id) ||
        `${row.kind === "documents" ? "documents" : "choice"}-${index + 1}`;
      const responsePrefix = cleanAskInputString(row.response_prefix);

      if (row.kind === "documents") {
        const rawDocumentTypes = Array.isArray(row.document_types)
          ? row.document_types
          : [];
        const documentTypes = rawDocumentTypes
          .filter((type): type is string => typeof type === "string")
          .map((type) => type.trim())
          .filter(Boolean)
          .map((type) => type.slice(0, 300))
          .slice(0, 8);
        return {
          id: id.slice(0, 80),
          kind: "documents",
          document_types: documentTypes,
          ...(responsePrefix
            ? { response_prefix: responsePrefix.slice(0, 200) }
            : {}),
        };
      }

      const question = cleanAskInputString(
        row.question,
        "Please choose an option.",
      );
      const rawOptions = Array.isArray(row.options) ? row.options : [];
      const options = rawOptions
        .map((option): AskInputOption | null => {
          if (!option || typeof option !== "object") return null;
          const optionRow = option as Record<string, unknown>;
          const value =
            cleanAskInputString(optionRow.value) ||
            cleanAskInputString(optionRow.label);
          if (!value) return null;
          return {
            value: value.slice(0, 500),
          };
        })
        .filter((option): option is AskInputOption => !!option)
        .slice(0, 8);
      const normalizedOptions =
        options.length > 0 ? options : [{ value: "Continue" }];
      const otherLabel = cleanAskInputString(row.other_label, "Other");
      return {
        id: id.slice(0, 80),
        kind: "choice",
        question: question.slice(0, 500),
        options: normalizedOptions,
        allow_other: row.allow_other !== false,
        other_label: otherLabel.slice(0, 80),
        ...(responsePrefix
          ? { response_prefix: responsePrefix.slice(0, 200) }
          : {}),
      };
    })
    .filter((item): item is AskInputItem => !!item)
    .slice(0, 12);

  return { type: "ask_inputs", items };
}

function requestedCourtlistenerOpinionIds(args: Record<string, unknown>) {
  const rawIds = Array.isArray(args.opinionIds)
    ? args.opinionIds
    : Array.isArray(args.opinion_ids)
      ? args.opinion_ids
      : typeof args.opinionId === "number"
        ? [args.opinionId]
        : typeof args.opinion_id === "number"
          ? [args.opinion_id]
          : [];
  return Array.from(
    new Set(
      rawIds
        .filter((value): value is number => typeof value === "number")
        .filter((value) => Number.isFinite(value) && value > 0)
        .map((value) => Math.floor(value)),
    ),
  );
}

type FindInCaseArgs = {
  clusterId: number | null;
  query: string;
  maxResults: number;
  contextChars: number;
};

function parseFindInCaseArgs(args: Record<string, unknown>): FindInCaseArgs {
  return {
    clusterId:
      typeof args.clusterId === "number" && Number.isFinite(args.clusterId)
        ? Math.floor(args.clusterId)
        : typeof args.cluster_id === "number" &&
            Number.isFinite(args.cluster_id)
          ? Math.floor(args.cluster_id)
          : null,
    query: typeof args.query === "string" ? args.query : "",
    maxResults:
      typeof args.max_results === "number"
        ? Math.max(0, Math.floor(args.max_results))
        : 20,
    contextChars:
      typeof args.context_chars === "number"
        ? Math.max(0, Math.floor(args.context_chars))
        : 160,
  };
}

function findInCaseSearchSummary(
  event: Extract<
    CourtlistenerToolEvent,
    { type: "courtlistener_find_in_case" }
  >,
) {
  return {
    cluster_id: event.cluster_id,
    query: event.query,
    total_matches: event.total_matches,
    case_name: event.case_name,
    citation: event.citation,
    error: event.error,
  };
}

function cachedCaseNotFetchedResult(clusterId: number | null) {
  return {
    ok: false,
    cluster_id: clusterId,
    error:
      "Case has not been fetched in this turn. Call courtlistener_get_cases first.",
  };
}

export async function runToolCalls(
  toolCalls: ToolCall[],
  docStore: DocStore,
  userId: string,
  db: ReturnType<typeof createServerSupabase>,
  write: (s: string) => void,
  workflowStore?: WorkflowStore,
  tabularStore?: TabularCellStore,
  docIndex?: DocIndex,
  turnEditState?: TurnEditState,
  turnReadState?: TurnReadState,
  projectId?: string | null,
  courtlistenerState?: CourtlistenerTurnState,
  apiKeys?: import("../../llm").UserApiKeys,
  nonce?: string,
  legislationState?: LegislationTurnState,
  chatId?: string | null,
): Promise<{
  toolResults: unknown[];
  docsRead: { filename: string; document_id?: string }[];
  docsFound: {
    filename: string;
    document_id?: string;
    query: string;
    total_matches: number;
  }[];
  docsCreated: DocCreatedResult[];
  docsReplicated: DocReplicatedResult[];
  workflowsApplied: { workflow_id: string; title: string }[];
  docsEdited: DocEditedResult[];
  askInputsEvents: AskInputsEvent[];
  courtlistenerEvents: CourtlistenerToolEvent[];
  caseCitationEvents: CaseCitationEvent[];
  mcpEvents: McpToolEvent[];
}> {
  const toolResults: unknown[] = [];
  const docsRead: { filename: string; document_id?: string }[] = [];
  const docsFound: {
    filename: string;
    document_id?: string;
    query: string;
    total_matches: number;
  }[] = [];
  const docsCreated: DocCreatedResult[] = [];
  const docsReplicated: DocReplicatedResult[] = [];
  const workflowsApplied: { workflow_id: string; title: string }[] = [];
  const docsEdited: DocEditedResult[] = [];
  const askInputsEvents: AskInputsEvent[] = [];
  const courtlistenerEvents: CourtlistenerToolEvent[] = [];
  const caseCitationEvents: CaseCitationEvent[] = [];
  const mcpEvents: McpToolEvent[] = [];
  const courtState: CourtlistenerTurnState = courtlistenerState ?? {
    casesByClusterId: new Map(),
  };
  const legState: LegislationTurnState =
    legislationState ?? newLegislationTurnState();
  const groupedFindInCaseSearches = toolCalls
    .filter((tc) => tc.function.name === COURTLISTENER_TOOL_NAMES.findInCase)
    .map((tc) => {
      let rawArgs: Record<string, unknown> = {};
      try {
        rawArgs = JSON.parse(tc.function.arguments || "{}");
      } catch {
        /* ignore */
      }
      const parsed = parseFindInCaseArgs(rawArgs);
      return {
        cluster_id: parsed.clusterId,
        query: parsed.query,
        total_matches: 0,
      };
    });
  const shouldGroupFindInCase = groupedFindInCaseSearches.length > 1;
  let groupedFindInCaseStarted = false;
  const groupedFindInCaseEvents: Extract<
    CourtlistenerToolEvent,
    { type: "courtlistener_find_in_case" }
  >[] = [];

  const registerGeneratedDocument = (
    tc: ToolCall,
    result: Record<string, unknown>,
    previewFilename: string,
    fileType: string,
  ) => {
    let newDocLabel: string | null = null;
    if ("filename" in result && "download_url" in result) {
      const dlFilename = result.filename as string;
      const dlUrl = result.download_url as string;
      const documentId = (result as { document_id?: string }).document_id;
      const versionId = (result as { version_id?: string }).version_id;
      const versionNumber =
        (result as { version_number?: number }).version_number ?? null;
      const storagePath = (result as { storage_path?: string }).storage_path;

      if (documentId && storagePath && docIndex) {
        const existingLabels = new Set(Object.keys(docIndex));
        let i = 0;
        while (existingLabels.has(`doc-${i}`)) i++;
        newDocLabel = `doc-${i}`;
        docIndex[newDocLabel] = {
          document_id: documentId,
          filename: dlFilename,
        };
        docStore.set(newDocLabel, {
          storage_path: storagePath,
          file_type: fileType,
          filename: dlFilename,
        });
      }

      write(
        `data: ${JSON.stringify({
          type: "doc_created",
          filename: dlFilename,
          download_url: dlUrl,
          document_id: documentId,
          version_id: versionId,
          version_number: versionNumber,
        })}\n\n`,
      );
      docsCreated.push({
        filename: dlFilename,
        download_url: dlUrl,
        document_id: documentId,
        version_id: versionId,
        version_number: versionNumber,
      });
    } else {
      write(
        `data: ${JSON.stringify({ type: "doc_created", filename: previewFilename, download_url: "" })}\n\n`,
      );
    }

    const { download_url, storage_path, ...safeToolResult } = result;
    const toolResultPayload = newDocLabel
      ? {
          ...safeToolResult,
          doc_id: newDocLabel,
          next_required_action: [
            `Before writing your final response, call read_document with doc_id "${newDocLabel}".`,
            `Base your description on the generated document's actual returned text, not on memory of what you intended to generate.`,
            `Do not include download links, URLs, or markdown links to the document in your prose response; the document card is shown automatically by the UI.`,
            `Give a concise description of the generated document and, if you make factual claims about its contents, cite it with [N] markers and a final <CITATIONS> block using doc_id "${newDocLabel}", not any source/template document.`,
          ].join(" "),
        }
      : safeToolResult;
    toolResults.push({
      role: "tool",
      tool_call_id: tc.id,
      content: JSON.stringify(toolResultPayload),
    });
  };

  for (const tc of toolCalls) {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(tc.function.arguments || "{}");
    } catch {
      /* ignore */
    }

    if (tc.function.name.startsWith("mcp_")) {
      write(
        `data: ${JSON.stringify({
          type: "mcp_tool_start",
          name: tc.function.name,
        })}\n\n`,
      );
      const { content, event } = await executeMcpToolCall(
        userId,
        tc.function.name,
        args,
        db,
      );
      // Remember statute lookups so the assistant can cite them like cases.
      ingestLegislationToolResult(legState, event.tool_name, content);
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content,
      });
      mcpEvents.push(event);
      write(
        `data: ${JSON.stringify({
          type: "mcp_tool_result",
          name: tc.function.name,
          connector_name: event.connector_name,
          tool_name: event.tool_name,
          status: event.status,
          error: event.error,
        })}\n\n`,
      );
      continue;
    }

    if (tc.function.name === "ask_inputs") {
      const event = normalizeAskInputsEvent(args);
      if (event.items.length > 0) askInputsEvents.push(event);
      continue;
    }

    if (tc.function.name === "read_document") {
      const rawDocId = args.doc_id as string;
      const docId = resolveDocLabel(rawDocId, docStore, docIndex) ?? rawDocId;
      const readIdentity = await getTurnReadIdentity({
        docLabel: docId,
        docStore,
        docIndex,
        db,
      });
      if (readIdentity && turnReadState?.has(readIdentity.key)) {
        const promptFilename = spotlightFilename(readIdentity.filename, nonce);
        const sourceNotice = sourceMaterialNotice(
          docStore.get(docId)?.source_kind,
        );
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: `Document filename: ${promptFilename}${sourceNotice ? `\n${sourceNotice}` : ""}\n\n${duplicateReadDocumentResult(readIdentity)}`,
        });
        continue;
      }
      const content = await readDocumentContent(
        docId,
        docStore,
        write,
        docIndex,
        db,
      );
      const filename = docStore.get(docId)?.filename;
      const documentId = docIndex?.[docId]?.document_id;
      if (readIdentity && turnReadState) {
        turnReadState.set(readIdentity.key, readIdentity);
      }
      if (filename) docsRead.push({ filename, document_id: documentId });
      // Wrap document content in the spotlight fence: the document body
      // is entirely user-controlled and may contain injected instructions.
      const fencedContent = nonce ? spotlight(content, nonce) : content;
      const promptFilename = spotlightFilename(filename ?? "", nonce);
      const sourceNotice = sourceMaterialNotice(
        docStore.get(docId)?.source_kind,
      );
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content: filename
          ? `${citationReminder(docId, filename, promptFilename)}${sourceNotice ? `\n${sourceNotice}` : ""}\n\n${fencedContent}`
          : fencedContent,
      });
    } else if (tc.function.name === "find_in_document") {
      const rawDocId = args.doc_id as string;
      const docId = resolveDocLabel(rawDocId, docStore, docIndex) ?? rawDocId;
      const docInfo = docStore.get(docId);
      // Request-scoped inline documents (currently the active Word document)
      // must enter model context only through read_document/fetch_documents.
      // Those paths emit the visible read lifecycle and nonce-fence the entire
      // body. find_in_document otherwise returns raw, user-controlled snippets
      // and would silently bypass both guarantees.
      if (docInfo?.inline_text !== undefined) {
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({
            ok: false,
            error:
              "Request-scoped documents must be opened with read_document before they can be searched.",
            next_required_action: `Call read_document with doc_id "${docId}".`,
          }),
        });
        continue;
      }
      const query = (args.query as string) ?? "";
      const maxResults =
        typeof args.max_results === "number" ? args.max_results : undefined;
      const contextChars =
        typeof args.context_chars === "number" ? args.context_chars : undefined;
      const content = await findInDocumentContent({
        docLabel: docId,
        query,
        maxResults,
        contextChars,
        docStore,
        write,
        docIndex,
        db,
      });
      const filename = docInfo?.filename;
      if (filename) {
        let totalMatches = 0;
        try {
          const parsed = JSON.parse(content) as {
            total_matches?: number;
          };
          totalMatches = parsed.total_matches ?? 0;
        } catch {
          /* ignore — still record the find attempt */
        }
        docsFound.push({
          filename,
          document_id: docIndex?.[docId]?.document_id,
          query,
          total_matches: totalMatches,
        });
      }
      toolResults.push({ role: "tool", tool_call_id: tc.id, content });
    } else if (tc.function.name === "list_documents") {
      const list = Array.from(docStore.entries()).map(([doc_id, info]) => ({
        doc_id,
        filename: info.filename,
        file_type: info.file_type,
      }));
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(list),
      });
    } else if (tc.function.name === "search_matter") {
      const query = typeof args.query === "string" ? args.query : "";
      const limit =
        typeof args.limit === "number" && Number.isFinite(args.limit)
          ? args.limit
          : 20;
      const hits = await searchMatter(db, {
        userId,
        projectId: projectId ?? null,
        query,
        limit,
      });
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content: formatForAssistant(query, hits),
      });
    } else if (tc.function.name === "save_to_law") {
      // File cases/statutes pulled in this conversation into the matter's
      // documents (the "law bank"), optionally into a named folder.
      const rawSources = Array.isArray(args.sources) ? args.sources : [];
      const folder =
        typeof args.folder === "string" && args.folder.trim()
          ? args.folder.trim()
          : null;
      const results: unknown[] = [];
      if (!projectId) {
        results.push({
          error: "Sources can only be filed from a chat inside a matter.",
        });
      }
      for (const raw of rawSources) {
        if (!projectId) break;
        const src = recordFromUnknown(raw) ?? {};
        const clusterId =
          typeof src.cluster_id === "number" && Number.isFinite(src.cluster_id)
            ? Math.floor(src.cluster_id)
            : null;
        const statute =
          typeof src.statute === "string" && src.statute.trim()
            ? src.statute.trim()
            : null;
        try {
          let input: import("../../legalSources").SaveLegalSourceInput | null =
            null;
          if (clusterId) {
            const caseRecord = courtState.casesByClusterId.get(clusterId);
            input = {
              kind: "case",
              clusterId,
              caseName: caseRecord?.caseName ?? null,
              citation: caseRecord?.citations?.[0] ?? null,
              dateFiled: caseRecord?.dateFiled ?? null,
              url: caseRecord?.url ?? null,
              pdfUrl: caseRecord?.pdfUrl ?? null,
            };
          } else if (statute) {
            const record = legState.byId.get(normalizeLegId(statute)) ?? null;
            input = {
              kind: "legislation",
              legId: record?.label ?? statute,
              chatId: chatId ?? "",
              direct: record
                ? { title: record.label, url: record.url, text: record.text }
                : undefined,
            };
          }
          if (!input) {
            results.push({
              error: "Each source needs a cluster_id or a statute citation.",
            });
          } else {
            const saved = await saveLegalSourceToProject({
              db,
              userId,
              projectId,
              input,
              courtlistenerToken: apiKeys?.courtlistener ?? null,
              folderName: folder,
            });
            results.push(
              "error" in saved
                ? { source: statute ?? clusterId, error: saved.error }
                : {
                    source: statute ?? clusterId,
                    status: saved.status,
                    filename: saved.filename,
                    folder: saved.folderName,
                  },
            );
          }
        } catch (err) {
          results.push({
            source: statute ?? clusterId,
            error:
              err instanceof Error
                ? err.message
                : "Could not save this source",
          });
        }
      }
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify({ results }),
      });
    } else if (tc.function.name === "fetch_documents") {
      const rawDocIds = (args.doc_ids as string[]) ?? [];
      const docIds = rawDocIds.map(
        (id) => resolveDocLabel(id, docStore, docIndex) ?? id,
      );
      const parts: string[] = [];
      for (const docId of docIds) {
        const readIdentity = await getTurnReadIdentity({
          docLabel: docId,
          docStore,
          docIndex,
          db,
        });
        if (readIdentity && turnReadState?.has(readIdentity.key)) {
          const filename = docStore.get(docId)?.filename ?? docId;
          const promptFilename = spotlightFilename(filename, nonce);
          const sourceNotice = sourceMaterialNotice(
            docStore.get(docId)?.source_kind,
          );
          parts.push(
            `--- ${docId} ---\nDocument filename: ${promptFilename}${sourceNotice ? `\n${sourceNotice}` : ""}\n\n${duplicateReadDocumentResult(
              readIdentity,
            )}`,
          );
          continue;
        }
        const content = await readDocumentContent(
          docId,
          docStore,
          write,
          docIndex,
          db,
        );
        const filename = docStore.get(docId)?.filename ?? docId;
        if (readIdentity && turnReadState) {
          turnReadState.set(readIdentity.key, readIdentity);
        }
        // Document body is user-controlled; spotlight it.
        const fencedContent = nonce ? spotlight(content, nonce) : content;
        const promptFilename = spotlightFilename(filename, nonce);
        const sourceNotice = sourceMaterialNotice(
          docStore.get(docId)?.source_kind,
        );
        parts.push(
          `--- ${docId} ---\n${citationReminder(docId, filename, promptFilename)}${sourceNotice ? `\n${sourceNotice}` : ""}\n\n${fencedContent}`,
        );
        if (docStore.get(docId)) {
          const documentId = docIndex?.[docId]?.document_id;
          docsRead.push({ filename, document_id: documentId });
        }
      }
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content: parts.join("\n\n"),
      });
    } else if (tc.function.name === "list_workflows") {
      const list = workflowStore
        ? Array.from(workflowStore.entries())
            .filter(([, workflow]) => workflow.listed !== false)
            .map(([id, w]) => ({
              id,
              title: w.title,
            }))
        : [];
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(list),
      });
    } else if (tc.function.name === "read_workflow") {
      const wfId = args.workflow_id as string;
      const wf = workflowStore?.get(wfId);
      if (wf) {
        write(
          `data: ${JSON.stringify({ type: "workflow_applied", workflow_id: wfId, title: wf.title })}\n\n`,
        );
        workflowsApplied.push({ workflow_id: wfId, title: wf.title });
      }
      const referenceHandles: { doc_id: string; filename: string }[] = [];
      if (wf) {
        for (const [index, reference] of (wf.reference_files ?? []).entries()) {
          const docId = `workflow-ref-${wfId}-${index + 1}`;
          docStore.set(docId, {
            storage_path: reference.storage_path,
            file_type: reference.file_type,
            filename: reference.filename,
            source_kind: "workflow_asset",
          });
          referenceHandles.push({
            doc_id: docId,
            filename: reference.filename,
          });
        }
      }
      // Workflow bodies are instructions the user installed to be FOLLOWED,
      // so they get the semi-trusted <workflow-instructions> fence (follow,
      // but never override system policy) rather than <untrusted-content>
      // (data only) — wrapping instructions in a data-only fence would either
      // break workflow execution or teach the model to ignore the fence.
      const wfContent = wf ? wf.skill_md : `Workflow '${wfId}' not found.`;
      const instructions =
        nonce && wf ? spotlightWorkflow(wfContent, nonce) : wfContent;
      const referenceNotice =
        referenceHandles.length > 0
          ? `\n\nAvailable immutable workflow reference files (open relevant files with read_document; if a file will be used as a template — edited or filled in — call replicate_document with a new_filename and work from the copy; reading one for information needs no copy):\n${referenceHandles
              .map(
                (reference) =>
                  `- ${reference.doc_id}: ${spotlightFilename(reference.filename, nonce)}`,
              )
              .join("\n")}`
          : "";
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content: `${instructions}${referenceNotice}`,
      });
    } else if (
      tc.function.name === "open_firm_form" ||
      tc.function.name === "find_firm_form"
    ) {
      // The firm's own model documents. Comparing the versions of one kind of
      // document costs nothing — only opening one loads a file.
      const respond = (payload: Record<string, unknown>) => {
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(payload),
        });
      };
      const firmId = await readableFirmId(db, userId);
      if (!firmId) {
        respond({
          ok: false,
          error: "The firm's form bank is only for people at the firm.",
        });
      } else if (tc.function.name === "find_firm_form") {
        const query = typeof args.query === "string" ? args.query : "";
        const matches = await searchApprovedForms(db, firmId, query);
        respond({
          ok: true,
          forms: matches.map(formMetadataForModel),
          ...(matches.length
            ? {}
            : {
                note: "The firm banks nothing matching that. Draft as you otherwise would.",
              }),
        });
      } else {
        const formId =
          typeof args.form_id === "string" ? args.form_id.trim() : "";
        const documentType =
          typeof args.document_type === "string"
            ? args.document_type.trim()
            : "";

        if (!formId && !documentType) {
          respond({
            ok: false,
            error:
              "Give either a form_id to open one entry, or a document_type to compare every version of that kind.",
          });
        } else if (!formId) {
          const variants = await listApprovedFormsOfType(
            db,
            firmId,
            documentType,
          );
          respond(
            variants.length
              ? {
                  ok: true,
                  document_type: variants[0].document_type,
                  forms: variants.map(formMetadataForModel),
                  next_step:
                    "Pick the version that matches this matter's facts and open it with open_firm_form and its form_id. If two fit equally and the difference matters, ask which situation applies.",
                }
              : {
                  ok: false,
                  error: `The firm banks nothing of the kind '${documentType}'.`,
                },
          );
        } else {
          const form = await loadApprovedForm(db, firmId, formId);
          const active = form
            ? await loadActiveVersion(form.document_id, db)
            : null;
          if (!form) {
            respond({
              ok: false,
              error: "That entry is not in the firm's form bank.",
            });
          } else if (!docIndex || !active?.storage_path) {
            respond({
              ok: false,
              error: "That entry's document could not be opened.",
              ...formMetadataForModel(form),
            });
          } else {
            const existingLabels = new Set(Object.keys(docIndex));
            let index = 0;
            while (existingLabels.has(`doc-${index}`)) index++;
            const docLabel = `doc-${index}`;
            const filename =
              active.filename?.trim() || form.title || "Firm document";
            docIndex[docLabel] = {
              document_id: form.document_id,
              filename,
              version_id: active.id,
              version_number: active.version_number ?? null,
            };
            docStore.set(docLabel, {
              storage_path: active.storage_path,
              file_type: active.file_type ?? "",
              filename,
              source_kind: "library_template",
            });
            respond({
              ok: true,
              doc_id: docLabel,
              filename,
              ...formMetadataForModel(form),
              next_step:
                "This is one of the firm's own documents and must not be changed. Copy it with replicate_document under a descriptive new_filename, then work on the copy.",
            });
            // Worth recording: over time this says which of the firm's
            // documents actually get used.
            await recordAudit(db, {
              userId,
              action: "form_used",
              title: form.title,
              surface: projectId ? "project" : "assistant",
              projectId: projectId ?? null,
              documentId: form.document_id,
              detail: {
                form_id: form.id,
                document_type: form.document_type,
                usage_mode: form.usage_mode,
              },
            });
          }
        }
      }
    } else if (tc.function.name === "read_table_cells" && tabularStore) {
      const colIndices = args.col_indices as number[] | undefined;
      const rowIndices = args.row_indices as number[] | undefined;

      const filteredCols = colIndices?.length
        ? tabularStore.columns.filter((_, i) => colIndices.includes(i))
        : tabularStore.columns;
      const filteredDocs = rowIndices?.length
        ? tabularStore.documents.filter((_, i) => rowIndices.includes(i))
        : tabularStore.documents;

      const label = `${filteredCols.length} ${filteredCols.length === 1 ? "column" : "columns"} × ${filteredDocs.length} ${filteredDocs.length === 1 ? "row" : "rows"}`;
      write(
        `data: ${JSON.stringify({ type: "doc_read_start", filename: label })}\n\n`,
      );

      const lines: string[] = [];
      for (const col of filteredCols) {
        const colPos = tabularStore.columns.findIndex(
          (c) => c.index === col.index,
        );
        for (const doc of filteredDocs) {
          const rowPos = tabularStore.documents.findIndex(
            (d) => d.id === doc.id,
          );
          const cell = tabularStore.cells.get(`${col.index}:${doc.id}`);
          lines.push(
            `[COL:${colPos} "${col.name}" | ROW:${rowPos} "${doc.filename}"]`,
          );
          if (cell?.summary) {
            lines.push(`Summary: ${cell.summary}`);
            if (cell.flag) lines.push(`Flag: ${cell.flag}`);
            if (cell.reasoning) lines.push(`Reasoning: ${cell.reasoning}`);
          } else {
            lines.push(`(not yet generated)`);
          }
          lines.push("");
        }
      }

      write(
        `data: ${JSON.stringify({ type: "doc_read", filename: label })}\n\n`,
      );
      docsRead.push({ filename: label });
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content: lines.join("\n") || "No cells found.",
      });
    } else if (tc.function.name === COURTLISTENER_TOOL_NAMES.searchCaseLaw) {
      const query = typeof args.query === "string" ? args.query : "";
      write(
        `data: ${JSON.stringify({ type: "courtlistener_search_case_law_start", query })}\n\n`,
      );
      try {
        const result = await searchCourtlistenerCaseLaw({
          query: query || undefined,
          court: typeof args.court === "string" ? args.court : undefined,
          filedAfter:
            typeof args.filedAfter === "string" ? args.filedAfter : undefined,
          filedBefore:
            typeof args.filedBefore === "string" ? args.filedBefore : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
          apiToken: apiKeys?.courtlistener,
        });
        const resultCount =
          result &&
          typeof result === "object" &&
          Array.isArray((result as { results?: unknown }).results)
            ? (result as { results: unknown[] }).results.length
            : 0;
        const error =
          result &&
          typeof result === "object" &&
          typeof (result as { error?: unknown }).error === "string"
            ? (result as { error: string }).error
            : undefined;
        const event: CourtlistenerToolEvent = {
          type: "courtlistener_search_case_law",
          query,
          result_count: resultCount,
          ...(error ? { error } : {}),
        };
        write(`data: ${JSON.stringify(event)}\n\n`);
        courtlistenerEvents.push(event);
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        });
      } catch (err) {
        const event: CourtlistenerToolEvent = {
          type: "courtlistener_search_case_law",
          query,
          result_count: 0,
          error:
            err instanceof Error ? err.message : "CourtListener search failed.",
        };
        write(`data: ${JSON.stringify(event)}\n\n`);
        courtlistenerEvents.push(event);
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({
            error:
              err instanceof Error
                ? err.message
                : "CourtListener search failed.",
          }),
        });
      }
    } else if (tc.function.name === COURTLISTENER_TOOL_NAMES.getCases) {
      const rawClusterIds = Array.isArray(args.clusterIds)
        ? args.clusterIds
        : Array.isArray(args.cluster_ids)
          ? args.cluster_ids
          : typeof args.clusterId === "number"
            ? [args.clusterId]
            : [];
      const clusterIds = Array.from(
        new Set(
          rawClusterIds
            .filter((value): value is number => typeof value === "number")
            .filter((value) => Number.isFinite(value) && value > 0)
            .map((value) => Math.floor(value)),
        ),
      );
      write(
        `data: ${JSON.stringify({ type: "courtlistener_get_cases_start", cluster_ids: clusterIds })}\n\n`,
      );
      try {
        const result = await getCourtlistenerCases({
          clusterIds,
          db,
          apiToken: apiKeys?.courtlistener,
        });
        const fetchedCases =
          result &&
          typeof result === "object" &&
          Array.isArray((result as { cases?: unknown }).cases)
            ? (result as { cases: unknown[] }).cases
            : [];
        fetchedCases.forEach((fetchedCase, index) => {
          const input = courtlistenerCaseInputFromFetchedCase(
            clusterIds[index] ?? 0,
            fetchedCase,
          );
          const clusterId = input.clusterId ?? 0;
          if (clusterId) {
            write(
              `data: ${JSON.stringify({
                type: "case_opinions",
                cluster_id: clusterId,
                document: normalizeCaseDocument({
                  clusterId,
                  caseName: input.caseName,
                  citations: input.citations,
                  url: input.url,
                  pdfUrl: input.pdfUrl,
                  dateFiled: input.dateFiled,
                  opinions: input.opinions,
                }),
              })}\n\n`,
            );
          }
        });
        const caseRecords = upsertCourtlistenerCases(
          courtState,
          fetchedCases.map((fetchedCase, index) =>
            courtlistenerCaseInputFromFetchedCase(
              clusterIds[index] ?? 0,
              fetchedCase,
            ),
          ),
        );
        const opinionCount = fetchedCases.reduce<number>(
          (sum, fetchedCase) => sum + courtlistenerOpinionCount(fetchedCase),
          0,
        );
        const caseOpinionCountByClusterId = new Map<number, number>();
        fetchedCases.forEach((fetchedCase, index) => {
          const clusterId =
            courtlistenerCaseInputFromFetchedCase(
              clusterIds[index] ?? 0,
              fetchedCase,
            ).clusterId ?? 0;
          if (clusterId) {
            caseOpinionCountByClusterId.set(
              clusterId,
              courtlistenerOpinionCount(fetchedCase),
            );
          }
        });
        const errors = fetchedCases
          .map((fetchedCase) =>
            stringField(recordFromUnknown(fetchedCase), "error"),
          )
          .filter((error): error is string => !!error);
        const resultError =
          result &&
          typeof result === "object" &&
          typeof (result as { error?: unknown }).error === "string"
            ? (result as { error: string }).error
            : undefined;
        const hasMultipleOpinionCase = caseRecords.some(
          (record) =>
            (caseOpinionCountByClusterId.get(record.clusterId) ?? 0) > 1,
        );
        const event: CourtlistenerToolEvent = {
          type: "courtlistener_get_cases",
          cluster_ids: clusterIds,
          case_count: fetchedCases.length,
          opinion_count: opinionCount,
          cases: caseRecords.map((record) => ({
            cluster_id: record.clusterId,
            case_name: record.caseName,
            citation: record.citations[0] ?? null,
            dateFiled: record.dateFiled,
            url: record.url,
          })),
          ...(resultError || errors.length
            ? { error: resultError ?? errors.join("; ") }
            : {}),
        };
        write(`data: ${JSON.stringify(event)}\n\n`);
        courtlistenerEvents.push(event);
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({
            ok: !resultError && errors.length === 0,
            cluster_ids: clusterIds,
            case_count: fetchedCases.length,
            opinion_count: opinionCount,
            cases: caseRecords.map((record) =>
              courtlistenerFetchedCaseMetadata(
                record,
                caseOpinionCountByClusterId.get(record.clusterId) ?? 0,
              ),
            ),
            ...(resultError || errors.length
              ? { error: resultError ?? errors.join("; ") }
              : {}),
            next_required_action: hasMultipleOpinionCase
              ? "Opinion text is cached server-side only. Use courtlistener_find_in_case with short 1-3 word keyword probes for relevant passages. At least one fetched case has multiple opinions; if snippets are insufficient, choose the needed opinion_id(s) from the text-free opinion metadata and call courtlistener_read_case with only those IDs. Do not read all opinions unless the question requires it."
              : "Opinion text is cached server-side only. Use courtlistener_find_in_case with short 1-3 word keyword probes for relevant passages, or courtlistener_read_case if snippets are insufficient.",
          }),
        });
      } catch (err) {
        const event: CourtlistenerToolEvent = {
          type: "courtlistener_get_cases",
          cluster_ids: clusterIds,
          case_count: 0,
          opinion_count: 0,
          error:
            err instanceof Error
              ? err.message
              : "CourtListener case fetch failed.",
        };
        write(`data: ${JSON.stringify(event)}\n\n`);
        courtlistenerEvents.push(event);
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({
            error:
              err instanceof Error
                ? err.message
                : "CourtListener case fetch failed.",
          }),
        });
      }
    } else if (tc.function.name === COURTLISTENER_TOOL_NAMES.findInCase) {
      const { clusterId, query, maxResults, contextChars } =
        parseFindInCaseArgs(args);
      if (shouldGroupFindInCase) {
        if (!groupedFindInCaseStarted) {
          write(
            `data: ${JSON.stringify({
              type: "courtlistener_find_in_case_start",
              cluster_id: null,
              query: "",
              searches: groupedFindInCaseSearches,
            })}\n\n`,
          );
          groupedFindInCaseStarted = true;
        }
      } else {
        write(
          `data: ${JSON.stringify({ type: "courtlistener_find_in_case_start", cluster_id: clusterId, query })}\n\n`,
        );
      }

      const record =
        typeof clusterId === "number"
          ? courtState.casesByClusterId.get(clusterId)
          : undefined;
      if (!record) {
        const payload = cachedCaseNotFetchedResult(clusterId);
        const event: CourtlistenerToolEvent = {
          type: "courtlistener_find_in_case",
          cluster_id: clusterId,
          query,
          total_matches: 0,
          error: payload.error,
        };
        if (shouldGroupFindInCase) {
          groupedFindInCaseEvents.push(event);
        } else {
          write(`data: ${JSON.stringify(event)}\n\n`);
          courtlistenerEvents.push(event);
        }
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(payload),
        });
        continue;
      }

      const opinions = cachedCaseOpinionTexts(record);
      const hits: Array<
        TextMatch & {
          opinion_id: number | null;
          type: string | null;
          author: string | null;
          url: string | null;
        }
      > = [];
      let totalMatches = 0;
      for (const opinion of opinions) {
        const remaining = Math.max(0, maxResults - hits.length);
        const result = findTextMatches({
          text: opinion.text,
          query,
          maxResults: remaining,
          contextChars,
          startIndex: hits.length,
        });
        totalMatches += result.totalMatches;
        hits.push(
          ...result.hits.map((hit) => ({
            ...hit,
            opinion_id: opinion.opinion_id,
            type: opinion.type,
            author: opinion.author,
            url: opinion.url,
          })),
        );
      }

      const event: CourtlistenerToolEvent = {
        type: "courtlistener_find_in_case",
        cluster_id: record.clusterId,
        query,
        total_matches: totalMatches,
        case_name: record.caseName,
        citation: record.citations[0] ?? null,
      };
      if (shouldGroupFindInCase) {
        groupedFindInCaseEvents.push(event);
      } else {
        write(`data: ${JSON.stringify(event)}\n\n`);
        courtlistenerEvents.push(event);
      }
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify({
          ok: true,
          cluster_id: record.clusterId,
          case_name: record.caseName,
          citation: record.citations[0] ?? null,
          query,
          total_matches: totalMatches,
          returned: hits.length,
          truncated: totalMatches > hits.length,
          hits,
        }),
      });
    } else if (tc.function.name === COURTLISTENER_TOOL_NAMES.readCase) {
      const clusterId =
        typeof args.clusterId === "number" && Number.isFinite(args.clusterId)
          ? Math.floor(args.clusterId)
          : typeof args.cluster_id === "number" &&
              Number.isFinite(args.cluster_id)
            ? Math.floor(args.cluster_id)
            : null;
      write(
        `data: ${JSON.stringify({ type: "courtlistener_read_case_start", cluster_id: clusterId })}\n\n`,
      );

      const record =
        typeof clusterId === "number"
          ? courtState.casesByClusterId.get(clusterId)
          : undefined;
      if (!record) {
        const payload = cachedCaseNotFetchedResult(clusterId);
        const event: CourtlistenerToolEvent = {
          type: "courtlistener_read_case",
          cluster_id: clusterId,
          opinion_count: 0,
          error: payload.error,
        };
        write(`data: ${JSON.stringify(event)}\n\n`);
        courtlistenerEvents.push(event);
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(payload),
        });
        continue;
      }

      const opinions = cachedCaseOpinionTexts(record);
      const requestedOpinionIds = requestedCourtlistenerOpinionIds(args);
      const selectedOpinions =
        requestedOpinionIds.length > 0
          ? opinions.filter(
              (opinion) =>
                typeof opinion.opinion_id === "number" &&
                requestedOpinionIds.includes(opinion.opinion_id),
            )
          : opinions.length === 1
            ? opinions
            : [];
      if (!selectedOpinions.length) {
        const multipleOpinions = opinions.length > 1;
        const payload = {
          ok: false,
          cluster_id: record.clusterId,
          case_name: record.caseName,
          citations: record.citations,
          url: record.url,
          dateFiled: record.dateFiled,
          opinion_count: opinions.length,
          opinions: (record.opinions ?? [])
            .map(courtlistenerOpinionMetadata)
            .filter(
              (opinion): opinion is NonNullable<typeof opinion> => !!opinion,
            ),
          error: multipleOpinions
            ? "Multiple opinions are available. Call courtlistener_read_case again with the opinionId or opinionIds needed."
            : "No matching opinion_id was found for this fetched case.",
        };
        const event: CourtlistenerToolEvent = {
          type: "courtlistener_read_case",
          cluster_id: record.clusterId,
          case_name: record.caseName,
          citation: record.citations[0] ?? null,
          opinion_count: 0,
          error: payload.error,
        };
        write(`data: ${JSON.stringify(event)}\n\n`);
        courtlistenerEvents.push(event);
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(payload),
        });
        continue;
      }

      const event: CourtlistenerToolEvent = {
        type: "courtlistener_read_case",
        cluster_id: record.clusterId,
        case_name: record.caseName,
        citation: record.citations[0] ?? null,
        opinion_count: selectedOpinions.length,
      };
      write(`data: ${JSON.stringify(event)}\n\n`);
      courtlistenerEvents.push(event);
      toolResults.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify({
          ok: true,
          cluster_id: record.clusterId,
          case_name: record.caseName,
          citations: record.citations,
          url: record.url,
          dateFiled: record.dateFiled,
          opinion_count: opinions.length,
          returned_opinion_count: selectedOpinions.length,
          opinions: selectedOpinions,
        }),
      });
    } else if (tc.function.name === COURTLISTENER_TOOL_NAMES.verifyCitations) {
      const citations = Array.isArray(args.citations)
        ? args.citations.filter(
            (value): value is string => typeof value === "string",
          )
        : [];
      const citationCount = citations.length;
      write(
        `data: ${JSON.stringify({ type: "courtlistener_verify_citations_start", citation_count: citationCount })}\n\n`,
      );
      try {
        const result = (await verifyCourtlistenerCitations({
          citations,
          db,
          apiToken: apiKeys?.courtlistener,
        })) as {
          citationLinks?: {
            clusterId?: number | null;
            citation?: string | null;
            caseName?: string | null;
            dateFiled?: string | null;
            pdfUrl?: string | null;
            url?: string | null;
            markdown?: string;
          }[];
          results?: unknown[];
          error?: string;
          source?: string;
          [key: string]: unknown;
        };
        if (Array.isArray(result.citationLinks)) {
          const caseRecords = upsertCourtlistenerCases(
            courtState,
            result.citationLinks.map((link) => ({
              clusterId: link.clusterId,
              caseName: link.caseName,
              citation: link.citation,
              url: link.url,
              pdfUrl: link.pdfUrl,
              dateFiled: link.dateFiled,
            })),
          );
          const recordsByClusterId = new Map(
            caseRecords.map((record) => [record.clusterId, record]),
          );
          result.citationLinks = result.citationLinks.map((link) => {
            if (!link.url) return link;
            const href =
              typeof link.clusterId === "number"
                ? `us-case-${link.clusterId}`
                : link.url;
            const label = [link.caseName, link.citation]
              .filter(Boolean)
              .join(", ");
            const record =
              typeof link.clusterId === "number"
                ? recordsByClusterId.get(link.clusterId)
                : undefined;
            if (record) {
              const event = caseCitationEventFromRecord(record);
              if (event) {
                caseCitationEvents.push(event);
                write(`data: ${JSON.stringify(event)}\n\n`);
              }
            }
            return {
              ...link,
              markdown: `[${label || link.url}](${href})`,
            };
          });
        }
        const rows =
          result &&
          typeof result === "object" &&
          Array.isArray((result as { results?: unknown }).results)
            ? (result as { results: unknown[] }).results
            : [];
        const matchCount = rows.reduce<number>((count, row) => {
          if (!row || typeof row !== "object") return count;
          const clusters = (row as { clusters?: unknown }).clusters;
          return count + (Array.isArray(clusters) ? clusters.length : 0);
        }, 0);
        const error =
          result &&
          typeof result === "object" &&
          typeof (result as { error?: unknown }).error === "string"
            ? (result as { error: string }).error
            : undefined;
        const event: CourtlistenerToolEvent = {
          type: "courtlistener_verify_citations",
          citation_count: citationCount,
          match_count: matchCount,
          ...(error ? { error } : {}),
        };
        write(`data: ${JSON.stringify(event)}\n\n`);
        courtlistenerEvents.push(event);
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify(result),
        });
      } catch (err) {
        const event: CourtlistenerToolEvent = {
          type: "courtlistener_verify_citations",
          citation_count: citationCount,
          match_count: 0,
          error:
            err instanceof Error
              ? err.message
              : "CourtListener citation lookup failed.",
        };
        write(`data: ${JSON.stringify(event)}\n\n`);
        courtlistenerEvents.push(event);
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({
            error:
              err instanceof Error
                ? err.message
                : "CourtListener citation lookup failed.",
          }),
        });
      }
    } else if (tc.function.name === "write_document" && docIndex) {
      const rawDocId = args.doc_id as string;
      const paragraphsRaw = args.paragraphs as unknown[] | undefined;
      const docId = resolveDocLabel(rawDocId, docStore, docIndex) ?? rawDocId;
      const docInfo = docStore.get(docId);
      const indexed = docIndex?.[docId];

      const failWrite = (
        filename: string,
        documentId: string,
        error: string,
      ) => {
        write(
          `data: ${JSON.stringify({ type: "doc_edited_start", filename })}\n\n`,
        );
        write(
          `data: ${JSON.stringify({
            type: "doc_edited",
            filename,
            document_id: documentId,
            version_id: "",
            download_url: "",
            annotations: [],
            error,
          })}\n\n`,
        );
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({ error }),
        });
      };

      if (
        docInfo?.source_kind === "library_template" ||
        docInfo?.source_kind === "workflow_asset"
      ) {
        failWrite(
          docInfo.filename,
          indexed?.document_id ?? "",
          "Templates and workflow assets cannot be written over. Call replicate_document with a new_filename, then write the returned copy.",
        );
      } else if (!docInfo || !indexed) {
        failWrite(
          docId,
          indexed?.document_id ?? "",
          `Document '${docId}' not found in this chat's attachments.`,
        );
      } else if (docInfo.file_type !== "docx") {
        failWrite(
          docInfo.filename,
          indexed.document_id,
          "write_document only supports .docx files.",
        );
      } else if (
        !Array.isArray(paragraphsRaw) ||
        paragraphsRaw.length === 0
      ) {
        failWrite(
          docInfo.filename,
          indexed.document_id,
          "paragraphs is required and must not be empty.",
        );
      } else {
        write(
          `data: ${JSON.stringify({
            type: "doc_edited_start",
            filename: docInfo.filename,
          })}\n\n`,
        );
        const paragraphs = paragraphsRaw.map((block) =>
          block && typeof block === "object"
            ? (block as WriteBlock)
            : String(block ?? ""),
        );
        const result = await runWriteDocument({
          documentId: indexed.document_id,
          userId,
          paragraphs,
          db,
          trackChanges: args.track_changes === true,
          reuseVersion: turnEditState?.get(indexed.document_id),
        });

        if (result.ok) {
          turnEditState?.set(indexed.document_id, {
            versionId: result.version_id,
            versionNumber: result.version_number,
            storagePath: result.storage_path,
          });
          clearTurnReadsForDocument(turnReadState, indexed.document_id);
          if (docIndex[docId]) {
            docIndex[docId] = {
              ...docIndex[docId],
              version_id: result.version_id,
              version_number: result.version_number,
            };
          }
          const currentDocStore = docStore.get(docId);
          if (currentDocStore) {
            docStore.set(docId, {
              ...currentDocStore,
              storage_path: result.storage_path,
            });
          }
          const payload: DocEditedResult = {
            filename: docInfo.filename,
            document_id: indexed.document_id,
            version_id: result.version_id,
            version_number: result.version_number,
            download_url: result.download_url,
            annotations: result.annotations ?? [],
          };
          docsEdited.push(payload);
          write(
            `data: ${JSON.stringify({ type: "doc_edited", ...payload })}\n\n`,
          );
          toolResults.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({
              ok: true,
              doc_id: docId,
              document_id: indexed.document_id,
              version_id: result.version_id,
              version_number: result.version_number,
              paragraphs_written: result.paragraph_count,
              tracked_changes: !!result.tracked,
              ...(result.tracked ? { changes: result.changes } : {}),
              next_required_action: [
                result.tracked
                  ? `The rewrite is waiting as tracked changes for the user to accept or reject.`
                  : `The document now says what you just wrote; it is finished, not a set of suggestions.`,
                `It remains available as doc_id "${docId}".`,
                `Do not include download links or URLs in your prose response; the document card is shown automatically by the UI.`,
              ].join(" "),
            }),
          });
        } else {
          write(
            `data: ${JSON.stringify({
              type: "doc_edited",
              filename: docInfo.filename,
              document_id: indexed.document_id,
              version_id: "",
              download_url: "",
              annotations: [],
              error: result.error,
            })}\n\n`,
          );
          toolResults.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({ error: result.error }),
          });
        }
      }
    } else if (tc.function.name === "edit_document" && docIndex) {
      const rawDocId = args.doc_id as string;
      const editsRaw = args.edits as unknown[] | undefined;
      const docId = resolveDocLabel(rawDocId, docStore, docIndex) ?? rawDocId;
      const docInfo = docStore.get(docId);
      const indexed = docIndex?.[docId];

      const emitEditError = (
        filename: string,
        documentId: string,
        error: string,
      ) => {
        // Surface the failure as a failed "Edited" block in the UI
        // (start → done-with-error) so it matches the shape the
        // success/late-failure paths already use.
        write(
          `data: ${JSON.stringify({
            type: "doc_edited_start",
            filename,
          })}\n\n`,
        );
        write(
          `data: ${JSON.stringify({
            type: "doc_edited",
            filename,
            document_id: documentId,
            version_id: "",
            download_url: "",
            annotations: [],
            error,
          })}\n\n`,
        );
      };

      if (
        docInfo?.source_kind === "library_template" ||
        docInfo?.source_kind === "workflow_asset"
      ) {
        const err =
          "Templates and workflow assets cannot be edited directly. Call replicate_document with a new_filename, then edit the returned copy.";
        emitEditError(docInfo.filename, indexed?.document_id ?? "", err);
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({ error: err }),
        });
      } else if (!docInfo || !indexed) {
        const err = `Document '${docId}' not found in this chat's attachments.`;
        emitEditError(docId, indexed?.document_id ?? "", err);
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({ error: err }),
        });
      } else if (!Array.isArray(editsRaw) || editsRaw.length === 0) {
        const err = "edits array is required and must not be empty.";
        emitEditError(docInfo.filename, indexed.document_id, err);
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({ error: err }),
        });
      } else if (docInfo.file_type !== "docx") {
        const err = "edit_document only supports .docx files.";
        emitEditError(docInfo.filename, indexed.document_id, err);
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({ error: err }),
        });
      } else {
        write(
          `data: ${JSON.stringify({
            type: "doc_edited_start",
            filename: docInfo.filename,
          })}\n\n`,
        );
        const edits: EditInput[] = (editsRaw as Record<string, unknown>[]).map(
          (e) => ({
            find: String(e.find ?? ""),
            replace: String(e.replace ?? ""),
            context_before: String(e.context_before ?? ""),
            context_after: String(e.context_after ?? ""),
            reason: e.reason ? String(e.reason) : undefined,
          }),
        );
        const reuseVersion = turnEditState?.get(indexed.document_id);
        const result = await runEditDocument({
          documentId: indexed.document_id,
          userId,
          edits,
          db,
          reuseVersion,
          trackChanges:
            typeof args.track_changes === "boolean"
              ? (args.track_changes as boolean)
              : undefined,
        });

        if (result.ok) {
          turnEditState?.set(indexed.document_id, {
            versionId: result.version_id,
            versionNumber: result.version_number,
            storagePath: result.storage_path,
          });
          clearTurnReadsForDocument(turnReadState, indexed.document_id);
          // Keep the chat-local doc label pointed at the latest
          // edited version so any follow-up read_document call in
          // the same assistant turn reads and cites the same bytes.
          if (docIndex[docId]) {
            docIndex[docId] = {
              ...docIndex[docId],
              version_id: result.version_id,
              version_number: result.version_number,
            };
          }
          const currentDocStore = docStore.get(docId);
          if (currentDocStore) {
            docStore.set(docId, {
              ...currentDocStore,
              storage_path: result.storage_path,
            });
          }
          const payload: DocEditedResult = {
            filename: docInfo.filename,
            document_id: indexed.document_id,
            version_id: result.version_id,
            version_number: result.version_number,
            download_url: result.download_url,
            annotations: result.annotations,
          };
          docsEdited.push(payload);
          write(
            `data: ${JSON.stringify({
              type: "doc_edited",
              ...payload,
            })}\n\n`,
          );
          toolResults.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({
              ok: true,
              doc_id: docId,
              document_id: indexed.document_id,
              version_id: result.version_id,
              version_number: result.version_number,
              applied: result.applied_count,
              tracked_changes: result.tracked,
              errors: result.errors,
              next_required_action: [
                result.tracked
                  ? `The edits are tracked changes for the user to accept or reject.`
                  : `The edits are written into the document; there is nothing for the user to accept. Do not describe them as suggested, proposed or pending changes.`,
                `The edited document remains available as doc_id "${docId}".`,
                `Before making factual claims about the edited document's final contents, call read_document with doc_id "${docId}" and base the response on that returned text.`,
                `Do not include download links or URLs in your prose response; the edited document card is shown automatically by the UI.`,
                `If you describe specific content from the edited document, cite it with [N] markers and a final <CITATIONS> block using doc_id "${docId}".`,
              ].join(" "),
            }),
          });
        } else {
          write(
            `data: ${JSON.stringify({
              type: "doc_edited",
              filename: docInfo.filename,
              document_id: indexed.document_id,
              version_id: "",
              download_url: "",
              annotations: [],
              error: result.error,
            })}\n\n`,
          );
          toolResults.push({
            role: "tool",
            tool_call_id: tc.id,
            content: JSON.stringify({
              ok: false,
              error: result.error,
            }),
          });
        }
      }
    } else if (tc.function.name === "replicate_document" && docIndex) {
      const rawDocId = args.doc_id as string;
      const requestedFilename =
        typeof args.new_filename === "string" && args.new_filename.trim()
          ? args.new_filename.trim()
          : null;
      const requestedCount =
        typeof args.count === "number" && Number.isFinite(args.count)
          ? Math.max(1, Math.min(20, Math.floor(args.count)))
          : 1;
      const sourceLabel =
        resolveDocLabel(rawDocId, docStore, docIndex) ?? rawDocId;
      const sourceInfo = docStore.get(sourceLabel);
      const sourceIndexed = docIndex[sourceLabel];
      const sourceFilename = sourceInfo?.filename ?? rawDocId;

      write(
        `data: ${JSON.stringify({
          type: "doc_replicate_start",
          filename: sourceFilename,
          count: requestedCount,
        })}\n\n`,
      );

      const fail = (error: string) => {
        write(
          `data: ${JSON.stringify({
            type: "doc_replicated",
            filename: sourceFilename,
            count: requestedCount,
            copies: [],
            error,
          })}\n\n`,
        );
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({ ok: false, error }),
        });
      };

      const isImmutableSource =
        sourceInfo?.source_kind === "library_template" ||
        sourceInfo?.source_kind === "workflow_asset";

      if (!sourceInfo) {
        fail(`Document '${rawDocId}' is not available in this chat.`);
      } else if (
        !sourceIndexed &&
        sourceInfo.source_kind !== "workflow_asset"
      ) {
        fail(`Document '${rawDocId}' is not available in this chat.`);
      } else if (isImmutableSource && !requestedFilename) {
        fail(
          "A new_filename is required when copying a Library Template or workflow asset.",
        );
      } else {
        try {
          // Pull the active version once — every copy gets the
          // same starting bytes (with any accepted tracked
          // changes rolled in), no point re-fetching per copy.
          const active = sourceIndexed
            ? await loadActiveVersion(sourceIndexed.document_id, db)
            : null;
          const sourcePath = active?.storage_path ?? sourceInfo.storage_path;
          const sourcePdfPath = active?.pdf_storage_path ?? null;
          const raw = await downloadFile(sourcePath);
          let pdfBytes = sourcePdfPath
            ? await downloadFile(sourcePdfPath)
            : null;
          // A PDF cannot be edited paragraph by paragraph, so a PDF
          // precedent is copied as a fresh, fully editable .docx built from
          // its text. The wording carries over; the layout is approximated
          // (standard legal formatting), which the tool result says plainly.
          let copyBytes = raw;
          let copyFileType = (
            active?.file_type ?? sourceInfo.file_type
          ).toLowerCase();
          let pdfApproximated = false;
          let pdfNoText = false;
          if (raw && copyFileType === "pdf") {
            let lines: string[] = [];
            try {
              // pdfjs transfers (detaches) the buffer it is handed — give it
              // a copy so the original bytes stay usable for the upload.
              lines = await extractPdfParagraphs(raw.slice(0));
            } catch {
              lines = [];
            }
            if (lines.length === 0) {
              // A scan with no text layer stays a byte-for-byte PDF copy —
              // nothing to build a Word file from. The result says so.
              pdfNoText = true;
            } else {
              const built = await docxBytesFromParagraphs(lines);
              copyBytes = built.buffer.slice(
                built.byteOffset,
                built.byteOffset + built.byteLength,
              ) as ArrayBuffer;
              copyFileType = "docx";
              pdfApproximated = true;
              pdfBytes = null; // rendition of the new docx, not the old PDF
            }
          }

          if (!raw || !copyBytes) {
            fail("Could not read the source document's bytes from storage.");
          } else {
            if (!pdfBytes && copyFileType === "pdf") {
              pdfBytes = copyBytes;
            } else if (!pdfBytes && shouldConvertToPdf(copyFileType)) {
              try {
                const converted = await docxToPdf(Buffer.from(copyBytes));
                pdfBytes = converted.buffer.slice(
                  converted.byteOffset,
                  converted.byteOffset + converted.byteLength,
                ) as ArrayBuffer;
              } catch (conversionError) {
                devLog(
                  `[replicate_document] Office→PDF conversion failed for ${sourceFilename}:`,
                  conversionError,
                );
              }
            }
            // Build N filenames. With count=1 keep the
            // pre-existing "(copy)" suffix; with count>1 use
            // numbered "(1)", "(2)" suffixes.
            const srcExt = pdfApproximated
              ? ".docx"
              : (sourceInfo.filename.match(/\.[^./\\]+$/)?.[0] ?? "");
            const baseStem = (() => {
              if (requestedFilename) {
                return requestedFilename.replace(/\.[^./\\]+$/, "");
              }
              return sourceInfo.filename.replace(/\.[^./\\]+$/, "");
            })();
            const filenames: string[] = [];
            for (let n = 1; n <= requestedCount; n++) {
              const suffix =
                requestedCount === 1
                  ? requestedFilename
                    ? ""
                    : " (copy)"
                  : ` (${n})`;
              filenames.push(`${baseStem}${suffix}${srcExt}`);
            }

            // Pre-generate the document ids client-side (mirrors
            // persistGeneratedFile) so every copy's bytes can be
            // uploaded BEFORE any documents row exists: a failure
            // mid-flight then leaves orphaned storage objects, never
            // a user-visible "ready" library row without content.
            const newDocs = filenames.map((fn) => ({
              id: crypto.randomUUID(),
              filename: fn,
            }));
            const contentType = contentTypeForDocumentType(copyFileType);

            // Parallel uploads: the doc bytes (and PDF
            // rendition if any) for every new copy.
            const uploadJobs: Promise<unknown>[] = [];
            const newKeys: string[] = [];
            const newPdfKeys: (string | null)[] = [];
            for (const d of newDocs) {
              const key = storageKey(userId, d.id, d.filename);
              newKeys.push(key);
              uploadJobs.push(uploadFile(key, copyBytes, contentType));
              if (pdfBytes) {
                const pdfKey = convertedPdfKey(userId, d.id);
                newPdfKeys.push(pdfKey);
                uploadJobs.push(
                  uploadFile(pdfKey, pdfBytes, "application/pdf"),
                );
              } else {
                newPdfKeys.push(null);
              }
            }
            await Promise.all(uploadJobs);

            // Bytes are durable; now record the rows in one
            // round-trip per table.
            const docRows = newDocs.map((d) => ({
              id: d.id,
              project_id: projectId ?? null,
              user_id: userId,
              status: "ready",
              library_kind: "file",
              library_folder_id: null,
              // Remember that this is a copy. The first edits to a copy that
              // has never been edited are written straight in, since a fresh
              // copy is a document being drafted, not one being marked up.
              is_replica: true,
            }));
            const { data: insertedDocs, error: docErr } = await db
              .from("documents")
              .insert(docRows)
              .select("id");
            if (
              docErr ||
              !insertedDocs ||
              insertedDocs.length !== newDocs.length
            ) {
              fail(
                `Failed to record replicated documents: ${safeErrorMessage(docErr?.message ?? "unknown")}`,
              );
            } else {
              // Bulk insert N versions in one round-trip.
              const versionRows = newDocs.map((d, idx) => ({
                document_id: d.id,
                storage_path: newKeys[idx],
                pdf_storage_path: newPdfKeys[idx],
                source: "upload",
                version_number: 1,
                filename: d.filename,
                file_type: copyFileType,
                // From the copy's actual bytes, so size and hash always
                // describe the same content. A verifier that stats a file
                // before hashing it must not see a size that disagrees with
                // content_sha256.
                size_bytes: copyBytes.byteLength,
                page_count: pdfApproximated
                  ? null
                  : (active?.page_count ?? null),
                content_sha256: contentSha256(copyBytes),
              }));
              const { data: insertedVersions, error: verErr } = await db
                .from("document_versions")
                .insert(versionRows)
                .select("id, document_id");
              if (
                verErr ||
                !insertedVersions ||
                insertedVersions.length !== newDocs.length
              ) {
                // Roll the documents rows back so no version-less
                // "ready" rows stay visible in the library
                // (best-effort; the bytes are already uploaded).
                await db
                  .from("documents")
                  .delete()
                  .in(
                    "id",
                    newDocs.map((d) => d.id),
                  );
                fail(
                  `Failed to record replicated document versions: ${safeErrorMessage(verErr?.message ?? "unknown")}`,
                );
              } else {
                const versionByDocId = new Map<string, string>();
                for (const v of insertedVersions as {
                  id: string;
                  document_id: string;
                }[]) {
                  versionByDocId.set(v.document_id, v.id);
                }

                // current_version_id has to be a per-row
                // value, so a single UPDATE statement
                // can't cover all N. Fan out in parallel,
                // but check every in-band result: Supabase
                // builders report failures in `error`, they
                // never reject.
                const updateResults = await Promise.all(
                  newDocs.map((d) =>
                    db
                      .from("documents")
                      .update({
                        current_version_id: versionByDocId.get(d.id),
                      })
                      .eq("id", d.id),
                  ),
                );
                const failedCopies: { filename: string; error: string }[] = [];
                const brokenDocIds: string[] = [];
                const linkedDocIds = new Set<string>();
                newDocs.forEach((d, idx) => {
                  const updateError = updateResults[idx]?.error;
                  if (!versionByDocId.get(d.id) || updateError) {
                    failedCopies.push({
                      filename: d.filename,
                      error: safeErrorMessage(
                        updateError?.message ??
                          "Failed to link the copy to its version",
                      ),
                    });
                    brokenDocIds.push(d.id);
                  } else {
                    linkedDocIds.add(d.id);
                  }
                });
                if (brokenDocIds.length > 0) {
                  // Best-effort: drop copies that never got a
                  // current_version_id rather than leaving them
                  // broken in the library.
                  await db.from("documents").delete().in("id", brokenDocIds);
                }

                // Register every successful copy under a fresh
                // doc-N slug so the model can edit/read any of
                // them in the same turn.
                const existingLabels = new Set(Object.keys(docIndex));
                let nextLabelIdx = 0;
                const copies: {
                  new_filename: string;
                  document_id: string;
                  version_id: string;
                  download_url: string;
                }[] = [];
                const toolPayloadCopies: {
                  doc_id: string;
                  document_id: string;
                  version_id: string;
                  filename: string;
                  download_url: string;
                }[] = [];
                for (let idx = 0; idx < newDocs.length; idx++) {
                  const d = newDocs[idx];
                  const newKey = newKeys[idx];
                  const versionId = versionByDocId.get(d.id);
                  if (!versionId || !linkedDocIds.has(d.id)) continue;
                  while (existingLabels.has(`doc-${nextLabelIdx}`))
                    nextLabelIdx++;
                  const slug = `doc-${nextLabelIdx}`;
                  existingLabels.add(slug);
                  docIndex[slug] = {
                    document_id: d.id,
                    filename: d.filename,
                  };
                  docStore.set(slug, {
                    storage_path: newKey,
                    file_type: copyFileType,
                    filename: d.filename,
                    source_kind: "document",
                  });
                  copies.push({
                    new_filename: d.filename,
                    document_id: d.id,
                    version_id: versionId,
                    download_url: buildDownloadUrl(newKey, d.filename),
                  });
                  toolPayloadCopies.push({
                    doc_id: slug,
                    document_id: d.id,
                    version_id: versionId,
                    filename: d.filename,
                    download_url: buildDownloadUrl(newKey, d.filename),
                  });
                }

                if (copies.length === 0) {
                  fail(
                    `Failed to finalize replicated copies: ${failedCopies[0]?.error ?? "unknown"}`,
                  );
                } else {
                  write(
                    `data: ${JSON.stringify({
                      type: "doc_replicated",
                      filename: sourceFilename,
                      count: copies.length,
                      copies,
                    })}\n\n`,
                  );
                  docsReplicated.push({
                    filename: sourceFilename,
                    count: copies.length,
                    copies,
                  });
                  toolResults.push({
                    role: "tool",
                    tool_call_id: tc.id,
                    content: JSON.stringify({
                      ok: true,
                      count: copies.length,
                      saved_to: projectId
                        ? "project_documents"
                        : "library_files",
                      copies: toolPayloadCopies,
                      ...(pdfApproximated
                        ? {
                            approximated_from_pdf: true,
                            note: "The source is a PDF, so each copy is a fresh .docx built from its text: the wording carried over, but the PDF's layout (fonts, columns, letterhead art) did not. Use write_document to restyle it — add [centered]/[heading N] tokens, **bold** markers, page breaks and tables to match the original's look where it matters. Tell the user the copy's formatting is approximated.",
                          }
                        : {}),
                      ...(pdfNoText
                        ? {
                            note: "This PDF has no extractable text (likely a scan without OCR), so the copy is a byte-for-byte PDF that cannot be edited. To adapt it, the user needs to OCR it first, or you can draft fresh with generate_docx.",
                          }
                        : {}),
                      // Copies that uploaded but could not be linked
                      // to their version are reported, not silently
                      // dropped from an ok:true result.
                      ...(failedCopies.length > 0
                        ? { failed_copies: failedCopies }
                        : {}),
                    }),
                  });
                }
              }
            }
          }
        } catch (e) {
          fail(`replicate_document failed: ${safeErrorMessage(e)}`);
        }
      }
    } else if (tc.function.name === "read_tabular_review") {
      // A grid the user has already built is the cheapest, best-cited source
      // of figures there is. Only grids on the matter being discussed are
      // readable, plus the caller's own; access to the matter itself was
      // settled before this chat began.
      const reviewId =
        typeof args.review_id === "string" ? args.review_id.trim() : "";
      if (!reviewId) {
        const { data: reviews } = projectId
          ? await db
              .from("tabular_reviews")
              .select("id, title, columns_config")
              .eq("project_id", projectId)
              .order("created_at", { ascending: false })
          : await db
              .from("tabular_reviews")
              .select("id, title, columns_config")
              .eq("user_id", userId)
              .order("created_at", { ascending: false })
              .limit(25);
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: JSON.stringify({
            reviews: (reviews ?? []).map((review) => ({
              review_id: review.id,
              title: review.title,
              columns: Array.isArray(review.columns_config)
                ? (review.columns_config as { name?: unknown }[]).map((column) =>
                    String(column?.name ?? ""),
                  )
                : [],
            })),
          }),
        });
      } else {
        const snapshot = await loadReviewSnapshot(db, reviewId);
        const readable =
          snapshot &&
          (snapshot.userId === userId ||
            (!!projectId && snapshot.projectId === projectId));
        toolResults.push({
          role: "tool",
          tool_call_id: tc.id,
          content: readable
            ? snapshotToText(snapshot)
            : JSON.stringify({
                error:
                  "No grid with that id on this matter. Call read_tabular_review with no arguments to see which grids exist.",
              }),
        });
      }
    } else if (tc.function.name === "generate_docx") {
      const title = args.title as string;
      const landscape = !!args.landscape;
      devLog(
        `[generate_docx] title="${title}" landscape=${landscape} args.landscape=${args.landscape}`,
      );
      const previewFilename = safeGeneratedFilename(title, "docx");
      write(
        `data: ${JSON.stringify({ type: "doc_created_start", filename: previewFilename })}\n\n`,
      );
      const result = await generateDocx(
        title,
        args.sections as unknown[],
        userId,
        db,
        {
          landscape,
          projectId: projectId ?? null,
          style: (args.style ?? undefined) as DocxStyle | undefined,
        },
      );
      registerGeneratedDocument(
        tc,
        result as Record<string, unknown>,
        previewFilename,
        "docx",
      );
    } else if (tc.function.name === "generate_excel") {
      const title = args.title as string;
      devLog(`[generate_excel] title="${title}"`);
      const previewFilename = safeGeneratedFilename(title, "xlsx");
      write(
        `data: ${JSON.stringify({ type: "doc_created_start", filename: previewFilename })}\n\n`,
      );
      const result = await generateExcel(
        title,
        args.sheets as unknown[],
        userId,
        db,
        { projectId: projectId ?? null },
      );
      registerGeneratedDocument(
        tc,
        result as Record<string, unknown>,
        previewFilename,
        "xlsx",
      );
    } else if (tc.function.name === "generate_ppt") {
      const title = args.title as string;
      devLog(`[generate_ppt] title="${title}"`);
      const previewFilename = safeGeneratedFilename(title, "pptx");
      write(
        `data: ${JSON.stringify({ type: "doc_created_start", filename: previewFilename })}\n\n`,
      );
      const result = await generatePpt(
        title,
        args.slides as unknown[],
        userId,
        db,
        { projectId: projectId ?? null },
      );
      registerGeneratedDocument(
        tc,
        result as Record<string, unknown>,
        previewFilename,
        "pptx",
      );
    }
  }

  if (shouldGroupFindInCase && groupedFindInCaseEvents.length > 0) {
    const errors = groupedFindInCaseEvents
      .map((event) => event.error)
      .filter((error): error is string => !!error);
    const groupEvent: CourtlistenerToolEvent = {
      type: "courtlistener_find_in_case",
      cluster_id: null,
      query: "",
      total_matches: groupedFindInCaseEvents.reduce(
        (sum, event) => sum + event.total_matches,
        0,
      ),
      searches: groupedFindInCaseEvents.map(findInCaseSearchSummary),
      ...(errors.length ? { error: errors.join("; ") } : {}),
    };
    write(`data: ${JSON.stringify(groupEvent)}\n\n`);
    courtlistenerEvents.push(groupEvent);
  }

  return {
    toolResults,
    docsRead,
    docsFound,
    docsCreated,
    docsReplicated,
    workflowsApplied,
    docsEdited,
    askInputsEvents,
    courtlistenerEvents,
    caseCitationEvents,
    mcpEvents,
  };
}
