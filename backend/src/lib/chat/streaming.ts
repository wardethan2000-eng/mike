import {
  streamChatWithTools,
  completeText,
  resolveModel,
  stopReasonLabel,
  DEFAULT_MAIN_MODEL,
  type LlmMessage,
  type OpenAIToolSchema,
  type ResumeState,
  type RunStopReason,
} from "../llm";
import { rememberResumeState } from "./runResume";
import { safeErrorMessage } from "../safeError";
import { createServerSupabase } from "../supabase";
import { buildUserMcpTools, type McpToolEvent } from "../mcpConnectors";
import type { SourceDocument } from "../sourceDocuments";
import {
  COURTLISTENER_TOOLS,
  type CaseCitationEvent,
  type CourtlistenerToolEvent,
} from "./tools/courtlistenerTools";
import {
  type DocStore,
  type DocIndex,
  type TabularCellStore,
  type WorkflowStore,
  type ToolCall,
  type AskInputsEvent,
  type EditAnnotation,
  devLog,
  resolveDocLabel,
} from "./types";
import { FORM_BANK_TOOLS, TOOLS, WORKFLOW_TOOLS } from "./tools/toolSchemas";
import {
  parseCitationsWithDiagnostics,
  parsePartialCitationObjects,
  createCitation,
  CITATIONS_OPEN_TAG,
} from "./citations";
import {
  applyMarkerRewrites,
  extractProseCitations,
  type MarkerRewrite,
} from "./proseCitations";
import { runToolCalls } from "./tools/toolDispatcher";
import { newLegislationTurnState } from "./tools/legislationTurnState";
import {
  getCachedCaseOpinionTexts,
  type CourtlistenerTurnState,
} from "./tools/courtlistenerTurnState";
import {
  readDocumentContent,
  type TurnEditState,
  type TurnReadState,
} from "./tools/documentOps";
import { verifyCitations } from "./verifyCitations";

export type AssistantEvent =
  | { type: "reasoning"; text: string }
  | AskInputsEvent
  | {
      type: "ask_inputs_response";
      responses: {
        id: string;
        kind: "choice" | "documents";
        question?: string;
        answer?: string;
        filenames?: string[];
        skipped?: boolean;
      }[];
    }
  | { type: "doc_read"; filename: string; document_id?: string }
  | {
      type: "doc_find";
      filename: string;
      document_id?: string;
      query: string;
      total_matches: number;
    }
  | {
      type: "doc_created";
      filename: string;
      download_url: string;
      document_id?: string;
      version_id?: string;
      version_number?: number | null;
    }
  | { type: "doc_download"; filename: string; download_url: string }
  | {
      type: "doc_replicated";
      /** Source document being copied. */
      filename: string;
      count: number;
      copies: {
        new_filename: string;
        document_id: string;
        version_id: string;
      }[];
    }
  | { type: "workflow_applied"; workflow_id: string; title: string }
  | {
      type: "doc_edited";
      filename: string;
      document_id: string;
      version_id: string;
      /** Per-document monotonic Vn; null if backend couldn't determine it. */
      version_number: number | null;
      download_url: string;
      annotations: EditAnnotation[];
    }
  | CaseCitationEvent
  | CourtlistenerToolEvent
  | McpToolEvent
  | {
      type: "case_opinions";
      cluster_id: number;
      document: SourceDocument;
    }
  | { type: "content"; text: string }
  | {
      /**
       * The turn stopped searching before it was finished — it ran out of
       * research steps, time, or room. The answer above is what it had.
       * The token lets the user pick the same turn back up.
       */
      type: "paused";
      reason: Exclude<RunStopReason, "complete">;
      message: string;
      resume_token: string;
      iterations: number;
    }
  | { type: "error"; message: string };

export class AssistantStreamError extends Error {
  fullText: string;
  events: AssistantEvent[];

  constructor(message: string, fullText: string, events: AssistantEvent[]) {
    super(message);
    this.name = "AssistantStreamError";
    this.fullText = fullText;
    this.events = events;
  }
}

export class AssistantStreamAbortError extends AssistantStreamError {
  constructor(fullText: string, events: AssistantEvent[]) {
    super("Stream aborted.", fullText, events);
    this.name = "AbortError";
  }
}

class AssistantStreamAskInputsPause extends Error {
  constructor() {
    super("Waiting for user input.");
    this.name = "AssistantStreamAskInputsPause";
  }
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: unknown; message?: unknown };
  return record.name === "AbortError" || record.message === "Stream aborted.";
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) return;
  const err = new Error("Stream aborted.");
  err.name = "AbortError";
  throw err;
}

export async function runLLMStream(params: {
  apiMessages: unknown[];
  docStore: DocStore;
  docIndex: DocIndex;
  userId: string;
  db: ReturnType<typeof createServerSupabase>;
  write: (s: string) => void;
  extraTools?: unknown[];
  includeResearchTools?: boolean;
  /** Expose ask_inputs only to clients that can render and answer it. */
  includeAskInputs?: boolean;
  workflowStore?: WorkflowStore;
  tabularStore?: TabularCellStore;
  buildCitations?: (fullText: string) => unknown[];
  model?: string;
  apiKeys?: import("../llm").UserApiKeys;
  signal?: AbortSignal;
  /** Let a route persist the completed turn before it signals stream success. */
  emitDone?: boolean;
  /** Needed to park a paused turn against the right chat. */
  chatId?: string | null;
  /** Set to pick up a turn that paused when its research budget ran out. */
  resumeState?: ResumeState | null;
  /**
   * If set, generate_docx will attach created docs to this project so
   * they appear in the project sidebar. Leave null for general chats —
   * generated docs still get persisted, but as standalone documents.
   */
  projectId?: string | null;
  /** Per-request spotlighting nonce — generated by the caller and passed
   *  here so that the same nonce fences both the system-prompt filenames
   *  (added by buildMessages) and the document bodies returned by tools. */
  nonce?: string;
}): Promise<{
  fullText: string;
  events: AssistantEvent[];
  citations: unknown[];
}> {
  const {
    apiMessages,
    docStore,
    docIndex,
    userId,
    db,
    write,
    extraTools,
    includeResearchTools = true,
    includeAskInputs = true,
    workflowStore,
    tabularStore,
    buildCitations,
    model,
    apiKeys,
    signal,
    projectId,
    nonce,
    chatId,
    resumeState,
  } = params;
  const researchTools = includeResearchTools ? COURTLISTENER_TOOLS : [];
  const mcpTools = await buildUserMcpTools(userId, db);
  const conversationTools = includeAskInputs
    ? TOOLS
    : TOOLS.filter((tool) => tool.function.name !== "ask_inputs");
  const baseTools = [
    ...conversationTools,
    ...researchTools,
    ...WORKFLOW_TOOLS,
    ...FORM_BANK_TOOLS,
  ];
  const activeTools = extraTools?.length
    ? [...baseTools, ...mcpTools, ...extraTools]
    : [...baseTools, ...mcpTools];

  // Extract system prompt; pass remaining turns to the adapter as
  // plain user/assistant messages.
  const rawMsgs = apiMessages as { role: string; content: string | null }[];
  const systemPrompt =
    rawMsgs[0]?.role === "system" ? (rawMsgs[0].content ?? "") : "";
  const chatMessages: LlmMessage[] = rawMsgs
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content ?? "",
    }));

  const events: AssistantEvent[] = [];
  // One assistant turn produces at most one document_versions row per
  // edited doc. `runToolCalls` fires once per tool-call batch; the model
  // may emit multiple batches in a single turn, so this map persists
  // across batches to let subsequent edit_document calls overwrite the
  // turn's existing version instead of creating a new one.
  const turnEditState: TurnEditState = new Map();
  // Suppress repeated full-document reads for the same document/version in
  // one assistant response. The guard is invalidated when edit_document
  // changes that document so a post-edit verification read can still happen.
  const turnReadState: TurnReadState = new Map();
  const courtlistenerTurnState: CourtlistenerTurnState = {
    casesByClusterId: new Map(),
  };
  const legislationTurnState = newLegislationTurnState();
  let fullText = "";
  let iterText = "";
  let iterVisibleText = "";
  let iterReasoning = "";
  let visibleTailBuffer = "";
  let citationsOpenSeen = false;
  let streamingCitationsBuffer = "";
  let streamedCitationCount = 0;

  const emitCitationStreamSnapshot = (
    status: "started" | "partial",
    citations: unknown[],
  ) => {
    if (buildCitations) return;
    write(
      `data: ${JSON.stringify({ type: "citations", status, citations })}\n\n`,
    );
  };

  const streamHiddenCitationContent = (delta: string) => {
    if (buildCitations || !delta) return;
    streamingCitationsBuffer += delta;
    const partial = parsePartialCitationObjects(streamingCitationsBuffer);
    if (partial.length <= streamedCitationCount) return;
    streamedCitationCount = partial.length;
    const citations = partial.map((c) =>
      createCitation(
        c,
        docIndex,
        courtlistenerTurnState.casesByClusterId,
        legislationTurnState.byId,
      ),
    );
    emitCitationStreamSnapshot("partial", citations);
  };

  const streamVisibleContent = (delta: string) => {
    if (!delta) return;
    if (citationsOpenSeen) {
      streamHiddenCitationContent(delta);
      return;
    }

    const combined = visibleTailBuffer + delta;
    const markerIdx = combined.indexOf(CITATIONS_OPEN_TAG);
    if (markerIdx >= 0) {
      const visible = combined.slice(0, markerIdx);
      if (visible) {
        iterVisibleText += visible;
        write(
          `data: ${JSON.stringify({ type: "content_delta", text: visible })}\n\n`,
        );
      }
      visibleTailBuffer = "";
      citationsOpenSeen = true;
      streamingCitationsBuffer = "";
      streamedCitationCount = 0;
      emitCitationStreamSnapshot("started", []);
      streamHiddenCitationContent(
        combined.slice(markerIdx + CITATIONS_OPEN_TAG.length),
      );
      return;
    }

    const keep = Math.min(CITATIONS_OPEN_TAG.length - 1, combined.length);
    const visible = combined.slice(0, combined.length - keep);
    visibleTailBuffer = combined.slice(combined.length - keep);
    if (visible) {
      iterVisibleText += visible;
      write(
        `data: ${JSON.stringify({ type: "content_delta", text: visible })}\n\n`,
      );
    }
  };

  const flushVisibleTail = (opts: { emit?: boolean } = {}) => {
    const emit = opts.emit ?? true;
    if (citationsOpenSeen || !visibleTailBuffer) {
      visibleTailBuffer = "";
      return;
    }
    iterVisibleText += visibleTailBuffer;
    if (emit) {
      write(
        `data: ${JSON.stringify({ type: "content_delta", text: visibleTailBuffer })}\n\n`,
      );
    }
    visibleTailBuffer = "";
  };

  const flushText = (opts: { emit?: boolean } = {}) => {
    if (!iterText) return;
    fullText += iterText;
    flushVisibleTail(opts);
    if (iterVisibleText) {
      events.push({ type: "content", text: iterVisibleText });
    }
    iterText = "";
    iterVisibleText = "";
    visibleTailBuffer = "";
    citationsOpenSeen = false;
    streamingCitationsBuffer = "";
    streamedCitationCount = 0;
  };

  const flushPartialTurn = (opts: { emit?: boolean } = {}) => {
    flushText(opts);
    if (iterReasoning) {
      events.push({ type: "reasoning", text: iterReasoning });
      iterReasoning = "";
    }
  };

  const selectedModel = resolveModel(model, DEFAULT_MAIN_MODEL);

  let runResult: Awaited<ReturnType<typeof streamChatWithTools>> | null = null;
  try {
    throwIfAborted(signal);
    runResult = await streamChatWithTools({
      model: selectedModel,
      systemPrompt,
      messages: chatMessages,
      tools: activeTools as OpenAIToolSchema[],
      resumeState,
      apiKeys,
      enableThinking: true,
      abortSignal: signal,
      callbacks: {
        onContentDelta: (delta) => {
          iterText += delta;
          streamVisibleContent(delta);
        },
        onReasoningDelta: (delta) => {
          iterReasoning += delta;
          write(
            `data: ${JSON.stringify({ type: "reasoning_delta", text: delta })}\n\n`,
          );
        },
        onReasoningBlockEnd: () => {
          if (!iterReasoning) return;
          events.push({ type: "reasoning", text: iterReasoning });
          write(`data: ${JSON.stringify({ type: "reasoning_block_end" })}\n\n`);
          iterReasoning = "";
        },
        // Fires after Claude's turn ends with stop_reason=tool_use, before
        // the tool actually runs. Flushes any buffered assistant text so
        // it's emitted in chronological order, then signals the client so
        // it can open a fresh PreResponseWrapper (shows "Working…") while
        // the tool executes — avoids the dead gap between message_stop
        // and the first tool-specific event.
        onToolCallStart: (call) => {
          flushText();
          write(
            `data: ${JSON.stringify({
              type: "tool_call_start",
              name: call.name,
            })}\n\n`,
          );
        },
      },
      runTools: async (calls) => {
        throwIfAborted(signal);
        // Emit any text the model produced before this tool turn so the
        // UI sees it before the tool results stream in.
        flushText();

        const toolCalls: ToolCall[] = calls.map((c) => ({
          id: c.id,
          function: {
            name: c.name,
            arguments: JSON.stringify(c.input),
          },
        }));
        const {
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
        } = await runToolCalls(
          toolCalls,
          docStore,
          userId,
          db,
          write,
          workflowStore,
          tabularStore,
          docIndex,
          turnEditState,
          turnReadState,
          projectId,
          courtlistenerTurnState,
          apiKeys,
          nonce,
          legislationTurnState,
          chatId,
        );
        throwIfAborted(signal);
        for (const r of docsRead) {
          events.push({
            type: "doc_read",
            filename: r.filename,
            document_id: r.document_id,
          });
        }
        for (const f of docsFound) {
          events.push({
            type: "doc_find",
            filename: f.filename,
            document_id: f.document_id,
            query: f.query,
            total_matches: f.total_matches,
          });
        }
        for (const dl of docsCreated) {
          events.push({
            type: "doc_created",
            filename: dl.filename,
            download_url: dl.download_url,
            document_id: dl.document_id,
            version_id: dl.version_id,
            version_number: dl.version_number ?? null,
          });
        }
        for (const r of docsReplicated) {
          events.push({
            type: "doc_replicated",
            filename: r.filename,
            count: r.count,
            copies: r.copies,
          });
        }
        for (const wf of workflowsApplied) {
          events.push({
            type: "workflow_applied",
            workflow_id: wf.workflow_id,
            title: wf.title,
          });
        }
        for (const e of docsEdited) {
          events.push({
            type: "doc_edited",
            filename: e.filename,
            document_id: e.document_id,
            version_id: e.version_id,
            version_number: e.version_number,
            download_url: e.download_url,
            annotations: e.annotations,
          });
        }
        for (const askInputsEvent of askInputsEvents) {
          write(`data: ${JSON.stringify(askInputsEvent)}\n\n`);
          events.push(askInputsEvent);
        }
        for (const event of courtlistenerEvents) {
          events.push(event);
        }
        for (const event of mcpEvents) {
          events.push(event);
        }
        for (const event of caseCitationEvents) {
          events.push(event);
        }

        if (askInputsEvents.length > 0) {
          throw new AssistantStreamAskInputsPause();
        }

        // Index alignment would break if any tool branch skips its
        // push (unhandled tool name, disabled store, guard failure).
        // Each tool_result already carries its tool_call_id, so key off
        // that directly — and fall back to an error result for any
        // tool_use that didn't produce one, so Claude's next request
        // has a tool_result for every tool_use it sent.
        const resultByCallId = new Map<string, string>();
        for (const r of toolResults) {
          const row = r as {
            tool_call_id: string;
            content?: unknown;
          };
          resultByCallId.set(row.tool_call_id, String(row.content ?? ""));
        }
        return toolCalls.map((c) => ({
          tool_use_id: c.id,
          content:
            resultByCallId.get(c.id) ??
            JSON.stringify({
              error: `Tool '${c.function.name}' is not available.`,
            }),
        }));
      },
    });
  } catch (err) {
    if (err instanceof AssistantStreamAskInputsPause) {
      // The ask_inputs event has already been emitted and persisted in `events`.
      // Stop this assistant turn here so the model does not add redundant
      // prose telling the user to answer the picker or attach documents.
    } else if (isAbortError(err)) {
      flushPartialTurn({ emit: false });
      throw new AssistantStreamAbortError(fullText, events);
    } else {
      flushPartialTurn();
      const message = safeErrorMessage(err, "Stream error");
      events.push({ type: "error", message });
      throw new AssistantStreamError(message, fullText, events);
    }
  }

  flushText();

  // The turn stopped searching before it was done. It has already written the
  // best answer it could; tell the client so it can offer to carry on.
  if (runResult && runResult.stopReason !== "complete" && runResult.resumeState) {
    const resumeToken = rememberResumeState({
      userId,
      chatId: chatId ?? "",
      state: runResult.resumeState,
    });
    const pausedEvent: AssistantEvent = {
      type: "paused",
      reason: runResult.stopReason,
      message: stopReasonLabel(runResult.stopReason, runResult.stats),
      resume_token: resumeToken,
      iterations: runResult.stats.iterations,
    };
    events.push(pausedEvent);
    write(`data: ${JSON.stringify(pausedEvent)}\n\n`);
  }

  // Parse and emit citations from <CITATIONS> block
  const { citations: parsedCitationsInitial, diagnostics: citationDiagnostics } =
    parseCitationsWithDiagnostics(fullText);
  let parsedCitations = parsedCitationsInitial;

  // Repair pass: the answer carries [N] markers but no usable <CITATIONS>
  // block (the model dropped it, or its JSON failed to parse). Without the
  // block every marker renders as dead text — nothing opens, nothing can be
  // checked, nothing can be filed — so ask the model once, off-stream, for
  // just the block and use that instead.
  const proseBeforeBlock = fullText.split(CITATIONS_OPEN_TAG)[0] ?? fullText;

  // The answer wrote its references into the prose — "[doc-3, p. 1]" — instead
  // of using numbered markers and the block. Everything a citation needs is in
  // there, so build them from what was written and renumber the prose to
  // match, rather than leaving the reader with dead text naming a document
  // they cannot open.
  let markerRewrites: MarkerRewrite[] = [];
  if (
    !buildCitations &&
    parsedCitations.length === 0 &&
    !/\[\d{1,2}\]/.test(proseBeforeBlock)
  ) {
    const fromProse = extractProseCitations(proseBeforeBlock, docIndex ?? {});
    if (fromProse.citations.length > 0) {
      parsedCitations = fromProse.citations;
      markerRewrites = fromProse.rewrites;
      fullText = applyMarkerRewrites(fullText, markerRewrites);
      for (let i = 0; i < events.length; i += 1) {
        const event = events[i];
        if (event.type === "content") {
          events[i] = {
            ...event,
            text: applyMarkerRewrites(event.text, markerRewrites),
          };
        }
      }
      // The answer on screen was streamed as it was written, so tell the
      // client what to put in place of each reference. Without this the
      // markers only come right when the chat is next opened.
      write(
        `data: ${JSON.stringify({ type: "citation_markers", replacements: markerRewrites })}\n\n`,
      );
      devLog("[chat/stream] citations rebuilt from prose references", {
        citationCount: parsedCitations.length,
        rewriteCount: markerRewrites.length,
      });
    }
  }

  if (
    !buildCitations &&
    parsedCitations.length === 0 &&
    /\[\d{1,2}\]/.test(proseBeforeBlock)
  ) {
    try {
      const sourceLines: string[] = [];
      for (const [label, doc] of Object.entries(docIndex ?? {})) {
        sourceLines.push(`document doc_id "${label}" = ${doc.filename}`);
      }
      for (const rec of courtlistenerTurnState.casesByClusterId.values()) {
        const opinions = getCachedCaseOpinionTexts(
          courtlistenerTurnState,
          rec.clusterId,
        );
        const opinionIds = (opinions ?? [])
          .map((o) => o.opinion_id)
          .filter((id): id is number => typeof id === "number");
        sourceLines.push(
          `case cluster_id ${rec.clusterId} = ${rec.caseName ?? "?"}${
            rec.citations[0] ? `, ${rec.citations[0]}` : ""
          }${opinionIds.length ? ` (opinion_ids: ${opinionIds.join(", ")})` : ""}`,
        );
      }
      const seenLegs = new Set<string>();
      for (const rec of legislationTurnState.byId.values()) {
        if (seenLegs.has(rec.legId)) continue;
        seenLegs.add(rec.legId);
        sourceLines.push(`legislation leg_id "${rec.label}"`);
      }
      if (sourceLines.length > 0) {
        const block = await completeText({
          model: selectedModel,
          systemPrompt:
            'A legal chat answer below uses [N] citation markers but is missing its machine-readable citations block, so none of its citations work. Reconstruct the block. Output ONLY a <CITATIONS>[ ... ]</CITATIONS> block containing a valid JSON array with exactly one entry per distinct [N] marker, matching each marker to the source it cites using the AVAILABLE SOURCES list. Entry shapes: document {"ref": N, "doc_id": "doc-0", "quotes": [{"page": 3, "quote": "exact text quoted in the answer"}]}; case {"ref": N, "cluster_id": 123, "quotes": [{"opinion_id": 456, "quote": "exact opinion text quoted in the answer"}]}; legislation {"ref": N, "leg_id": "K.S.A. 58-2540", "quotes": [{"quote": "exact statute text quoted in the answer"}]}. Use only sources from the list. Take quotes verbatim from quoted material near each marker in the answer; if no quote is given there, use a short phrase the answer attributes to that source. Output nothing before or after the block.',
          user: `AVAILABLE SOURCES:\n${sourceLines.join("\n")}\n\n--- ANSWER ---\n${proseBeforeBlock}`,
          maxTokens: 8000,
          apiKeys,
        });
        const reparsed = parseCitationsWithDiagnostics(block);
        if (reparsed.citations.length > 0) {
          parsedCitations = reparsed.citations;
        }
        devLog("[chat/stream] citations repair pass", {
          repairedCount: reparsed.citations.length,
          repairError: reparsed.diagnostics.error,
        });
      }
    } catch (err) {
      devLog("[chat/stream] citations repair pass failed", err);
    }
  }

  let citations: unknown[];
  if (buildCitations) {
    // Custom builders (tabular) bypass document-citation verification.
    citations = buildCitations(fullText);
  } else {
    const rawCitations = parsedCitations.map((c) =>
      createCitation(
        c,
        docIndex,
        courtlistenerTurnState.casesByClusterId,
        legislationTurnState.byId,
      ),
    );
    // Server-side quote verification. Fetch each document's extracted source
    // text at most once per turn (memoized by doc_id), reading only bytes
    // already in storage with emitEvents:false. Case citations are matched
    // against the opinion text cached during this turn.
    const sourceTextByDocId = new Map<string, Promise<string>>();
    const getSourceText = (docId: string): Promise<string> => {
      let pending = sourceTextByDocId.get(docId);
      if (!pending) {
        const label = resolveDocLabel(docId, docStore, docIndex);
        pending = label
          ? readDocumentContent(label, docStore, () => {}, docIndex, db, {
              emitEvents: false,
            })
          : Promise.resolve("");
        sourceTextByDocId.set(docId, pending);
      }
      return pending;
    };
    citations = await verifyCitations(
      rawCitations,
      getSourceText,
      async (clusterId) =>
        getCachedCaseOpinionTexts(courtlistenerTurnState, clusterId),
    );
  }
  // Diligence check: legal authorities named in the answer that were never
  // retrieved this turn. A cite written from memory or copied out of a
  // document is exactly where a wrong or hallucinated authority hides, so
  // the answer says plainly that its wording was never checked.
  if (!buildCitations) {
    try {
      const normCite = (s: string) => s.replace(/[\s.]/g, "").toUpperCase();
      const baseStatute = (s: string) => s.replace(/\(.*$/, "");
      const covered = new Set<string>();
      for (const rec of courtlistenerTurnState.casesByClusterId.values()) {
        for (const c of rec.citations) covered.add(normCite(c));
      }
      for (const key of legislationTurnState.byId.keys()) {
        covered.add(baseStatute(normCite(key)));
      }
      const reporterRe =
        /\b\d{1,4}\s+(?:U\.S\.|F\.(?:2d|3d|4th)|F\.\s?Supp\.(?:\s?[23]d)?|Kan\.\s?App\.\s?2d|Kan\.|P\.(?:2d|3d))\s+\d{1,5}\b/g;
      const statuteRe =
        /\bK\.S\.A\.\s?(?:\u00a7+\s?)?\d+[a-z]?-[\d]+[a-z0-9]*(?:\([^)\s]{1,8}\))*/g;
      const missing = new Map<string, string>();
      for (const match of proseBeforeBlock.matchAll(reporterRe)) {
        const key = normCite(match[0]);
        if (!covered.has(key) && !missing.has(key)) {
          missing.set(key, match[0].replace(/\s+/g, " "));
        }
      }
      for (const match of proseBeforeBlock.matchAll(statuteRe)) {
        const key = baseStatute(normCite(match[0]));
        if (!covered.has(key) && !missing.has(key)) {
          missing.set(key, match[0].replace(/\s+/g, " "));
        }
      }
      if (missing.size > 0) {
        const shown = [...missing.values()].slice(0, 8);
        const suffix =
          missing.size > shown.length
            ? ` and ${missing.size - shown.length} more`
            : "";
        const note = `\n\n*Not retrieved in this conversation, so the wording has not been checked: ${shown.join("; ")}${suffix}.*`;
        events.push({ type: "content", text: note });
        write(
          `data: ${JSON.stringify({ type: "content_delta", text: note })}\n\n`,
        );
      }
    } catch (err) {
      devLog("[chat/stream] authority coverage check failed", err);
    }
  }

  devLog("[chat/stream] final citations", {
    hasCitationsBlock: citationDiagnostics.hasBlock,
    citationsBlockLength: citationDiagnostics.rawLength,
    parseError: citationDiagnostics.error,
    parsedCitationCount: parsedCitations.length,
    emittedCitationCount: citations.length,
    usedCustomCitationBuilder: !!buildCitations,
  });
  write(
    `data: ${JSON.stringify({ type: "citations", status: "final", citations })}\n\n`,
  );
  if (params.emitDone !== false) {
    write("data: [DONE]\n\n");
  }

  return { fullText, events, citations };
}
