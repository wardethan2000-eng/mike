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
  type ParsedCitation,
} from "./citations";
import {
  applyMarkerRewrites,
  extractProseCitations,
  type MarkerRewrite,
} from "./proseCitations";
import {
  MAX_CITE_ATTEMPTS,
  readCiteCall,
  type CiteOutcome,
} from "./citeTool";
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
import {
  asksForCitationCheck,
  buildChecklistNote,
  coveredAuthorityKeys,
  extractAuthorities,
  isCovered,
  latestRequestText,
  newAuthorityChecklistState,
} from "./authorityChecklist";
import { newResearchNotesTurnState } from "./researchNotes";
import {
  carriedListSection,
  isFinished,
  lateStartNudge,
  newTaskListTurnState,
  outstandingNote,
  stalenessReminder,
  taskListContinuation,
  taskListEnabled,
  taskListSummary,
  type TaskStep,
} from "./taskList";
import { clearChatTaskList, loadChatTaskList, saveChatTaskList } from "./taskListStore";

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
  | {
      /**
       * The job list, as it stands. The stream carries every update so the
       * block on screen keeps up; only one of these is ever persisted per
       * message — see `recordTaskList` below.
       */
      type: "task_list";
      steps: TaskStep[];
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

/** No answer carries more small print than this. */
const MAX_TRAILING_NOTES = 3;

/**
 * The small print under an answer, as one italic block. An answer can carry
 * three of these — the authorities it never retrieved, the checklist of the
 * document's own authorities, and what is left on the job list — and three
 * separate paragraphs of it read as clutter. Returns "" when there is nothing
 * to say.
 */
export function buildTrailingNotesBlock(notes: string[]): string {
  const lines = notes
    .map((note) => note.trim())
    .filter((note) => note.length > 0)
    .slice(0, MAX_TRAILING_NOTES);
  if (lines.length === 0) return "";
  return "\n\n" + lines.map((note) => `*${note}*`).join("  \n");
}

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

/**
 * The answer is written and its citations have been filed and checked. The
 * turn ends here: anything the model wrote after filing them would come after
 * the answer the reader has already been given.
 */
class AssistantStreamCitationsFiled extends Error {
  constructor() {
    super("Citations filed.");
    this.name = "AssistantStreamCitationsFiled";
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
  const listEnabled = taskListEnabled();
  const conversationTools = TOOLS.filter(
    (tool) =>
      (includeAskInputs || tool.function.name !== "ask_inputs") &&
      (listEnabled || tool.function.name !== "task_list"),
  );
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
  const baseSystemPrompt =
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
  // Authorities cited by the documents read this turn, so the answer can be
  // held against the document's own list rather than the model's memory of it.
  const checklistTurnState = newAuthorityChecklistState();
  // The running notes document, if this turn keeps one. Held here so the
  // wrap-up can point the reader at it when the budget runs out mid-job.
  const researchNotesTurnState = newResearchNotesTurnState();
  // The job list this turn is working to, picked up from the chat so a
  // follow-up message and "Keep going" both continue the same list.
  const taskListTurnState = newTaskListTurnState(
    await loadChatTaskList(db, chatId),
  );
  // A list left open by an earlier message in this chat is put in front of the
  // model, which decides whether it still applies. The decision is visible in
  // the list itself.
  const carried = carriedListSection(taskListTurnState.steps);
  const systemPrompt = carried
    ? `${baseSystemPrompt}\n\n${carried}`
    : baseSystemPrompt;
  const checklistRequested = asksForCitationCheck(
    latestRequestText(
      chatMessages.filter((m) => m.role === "user").map((m) => m.content),
    ),
  );
  // Citations filed by the answer itself with cite_sources. These are checked
  // as they arrive, so they are preferred over anything parsed out of the text.
  let filedCitations: ParsedCitation[] = [];
  let citeAttempts = 0;
  let fullText = "";
  let iterText = "";
  let iterVisibleText = "";
  let iterReasoning = "";
  let visibleTailBuffer = "";
  let citationsOpenSeen = false;
  let streamingCitationsBuffer = "";
  let streamedCitationCount = 0;

  // Only one task_list event may end up in the persisted events. A long job
  // updates the list a dozen times; appending each one would render a dozen
  // checklists in reloaded history and bloat every chat_messages row. The
  // stream still carries every update, so the block animates live.
  const recordTaskList = (steps: TaskStep[]) => {
    const event: AssistantEvent = { type: "task_list", steps };
    const existing = events.findIndex((e) => e.type === "task_list");
    if (existing >= 0) events.splice(existing, 1);
    // Appended at its newest position rather than left where it first
    // appeared. The block is drawn above the working area either way, and the
    // position is what tells the reader which commentary came before the last
    // update to the list and is therefore working rather than the answer.
    events.push(event);
    write(`data: ${JSON.stringify(event)}\n\n`);
  };

  // The completion gate. The model has stopped calling tools and is trying to
  // finish; while steps are outstanding it is sent back instead. Its guards
  // live in taskList.ts so the rules exist once.
  const onBeforeFinish = (): string | null => {
    if (!listEnabled) return null;
    const message = taskListContinuation({
      steps: taskListTurnState.steps,
      continuations: taskListTurnState.continuations,
      aborted: signal?.aborted,
    });
    if (!message) return null;
    taskListTurnState.continuations += 1;
    devLog("[chat/stream] task list sent the turn back", {
      continuation: taskListTurnState.continuations,
      outstanding: taskListTurnState.steps.filter(
        (step) => step.status === "pending" || step.status === "doing",
      ).length,
    });
    return message;
  };

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
      researchNotes: researchNotesTurnState,
      taskList: taskListTurnState,
      onBeforeFinish,
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
        taskListTurnState.rounds += 1;
        taskListTurnState.roundsSinceTouched += 1;
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

        // Citations are filed by the answer rather than dispatched like an
        // ordinary tool: they are checked here against the documents, cases and
        // statutes this conversation actually opened, and against the markers
        // in the answer. Anything wrong goes straight back so it can be put
        // right while the turn is still running.
        const citeResults = new Map<string, string>();
        let citationsAccepted = false;
        for (const call of calls) {
          if (call.name !== "cite_sources") continue;
          citeAttempts += 1;
          const outcome: CiteOutcome = readCiteCall(call.input, {
            prose: fullText,
            docIndex,
            knownClusterIds: new Set(
              courtlistenerTurnState.casesByClusterId.keys(),
            ),
            knownLegIds: new Set(legislationTurnState.byId.keys()),
          });
          const lastChance = citeAttempts >= MAX_CITE_ATTEMPTS;
          if (outcome.problems.length && !lastChance) {
            citeResults.set(
              call.id,
              JSON.stringify({
                filed: false,
                problems: outcome.problems,
                instruction:
                  "Fix these and call cite_sources again. Do not rewrite the answer.",
              }),
            );
            devLog("[chat/stream] cite_sources sent back", {
              attempt: citeAttempts,
              problems: outcome.problems,
            });
            continue;
          }
          // Out of attempts: keep whatever checked out rather than losing every
          // citation over one bad entry.
          if (outcome.citations.length) {
            filedCitations = outcome.citations;
            citationsAccepted = true;
          }
          citeResults.set(
            call.id,
            JSON.stringify({
              filed: outcome.citations.length,
              ...(outcome.problems.length
                ? { ignored: outcome.problems }
                : {}),
            }),
          );
          devLog("[chat/stream] cite_sources filed", {
            attempt: citeAttempts,
            citationCount: outcome.citations.length,
            problems: outcome.problems,
          });
        }

        // The answer is complete and its citations are in order, so there is
        // nothing left for this turn to do.
        if (citationsAccepted && calls.every((c) => c.name === "cite_sources")) {
          // Filing citations is the other way a turn ends, so the gate runs
          // here too — otherwise a half-finished job escapes by citing.
          const continueWith = onBeforeFinish();
          if (!continueWith) throw new AssistantStreamCitationsFiled();
          return toolCalls.map((c) => ({
            tool_use_id: c.id,
            content: `${citeResults.get(c.id) ?? "{}"}\n\n${continueWith}`,
          }));
        }

        const dispatchCalls = toolCalls.filter(
          (c) => c.function.name !== "cite_sources",
        );
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
          taskListSteps,
        } = await runToolCalls(
          dispatchCalls,
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
          checklistTurnState,
          researchNotesTurnState,
          taskListTurnState,
        );
        throwIfAborted(signal);
        if (taskListSteps) {
          recordTaskList(taskListSteps);
          // Stored as it changes rather than only at the end, so a backend
          // restart or a stopped turn leaves the list behind. Not awaited:
          // the model is not kept waiting on a chat row.
          void saveChatTaskList(db, chatId, taskListSteps);
        }
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
        for (const [callId, content] of citeResults) {
          resultByCallId.set(callId, content);
        }
        // A turn that is running long with no list at all is told to write
        // one; a list left untouched while steps are outstanding gets a short
        // reminder naming them. Both ride back on the last tool result, so
        // they reach every provider without four copies of the code.
        const nudge =
          lateStartNudge(taskListTurnState) ??
          stalenessReminder(taskListTurnState);
        const lastCallId = toolCalls[toolCalls.length - 1]?.id;
        return toolCalls.map((c) => {
          const base =
            resultByCallId.get(c.id) ??
            JSON.stringify({
              error: `Tool '${c.function.name}' is not available.`,
            });
          return {
            tool_use_id: c.id,
            content:
              nudge && c.id === lastCallId ? `${base}\n\n${nudge}` : base,
          };
        });
      },
    });
  } catch (err) {
    if (err instanceof AssistantStreamCitationsFiled) {
      // The answer and its citations are both complete. Fall through to the
      // citation handling below, which will use what was filed.
      flushText();
    } else if (err instanceof AssistantStreamAskInputsPause) {
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
      message: stopReasonLabel(
        runResult.stopReason,
        runResult.stats,
        taskListTurnState.steps.length
          ? taskListSummary(taskListTurnState.steps)
          : null,
      ),
      resume_token: resumeToken,
      iterations: runResult.stats.iterations,
    };
    events.push(pausedEvent);
    write(`data: ${JSON.stringify(pausedEvent)}\n\n`);
  }

  // Parse and emit citations from <CITATIONS> block
  const { citations: parsedCitationsInitial, diagnostics: citationDiagnostics } =
    parseCitationsWithDiagnostics(fullText);
  // Citations filed with cite_sources were checked as they arrived, so they
  // win over anything read back out of the text afterwards.
  let parsedCitations = filedCitations.length
    ? filedCitations
    : parsedCitationsInitial;

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
  // Every note that follows the answer is collected here and emitted as one
  // italic block. An answer can carry three of them, and three separate
  // paragraphs of small print read as clutter.
  const trailingNotes: string[] = [];
  if (!buildCitations) {
    try {
      const covered = coveredAuthorityKeys({
        caseCitations: [...courtlistenerTurnState.casesByClusterId.values()]
          .flatMap((rec) => rec.citations),
        legislationIds: legislationTurnState.byId.keys(),
      });
      const missing = extractAuthorities(proseBeforeBlock).filter(
        (authority) => !isCovered(authority, covered),
      );
      if (missing.length > 0) {
        const shown = missing.slice(0, 8).map((a) => a.display);
        const suffix =
          missing.length > shown.length
            ? ` and ${missing.length - shown.length} more`
            : "";
        trailingNotes.push(
          `Not retrieved in this conversation, so the wording has not been checked: ${shown.join("; ")}${suffix}.`,
        );
      }
      // Citation checklist: the authorities the reviewed document itself
      // cites, and which of them this turn never pulled up. The list comes
      // from the document, not from the model, so an answer that quietly
      // stopped halfway through says so.
      if (checklistRequested) {
        const checklistNote = buildChecklistNote({
          state: checklistTurnState,
          covered,
          alreadyReported: new Set(missing.flatMap((a) => a.keys)),
        });
        // buildChecklistNote returns its own italic wrapper, which the
        // consolidated block now supplies.
        if (checklistNote) {
          trailingNotes.push(checklistNote.trim().replace(/^\*|\*$/g, ""));
        }
      }
    } catch (err) {
      devLog("[chat/stream] authority coverage check failed", err);
    }
  }

  // What the list says is still outstanding. "Marked" is the honest word: the
  // model ticks its own steps off.
  const stillToDo = outstandingNote(taskListTurnState.steps);
  if (stillToDo) trailingNotes.push(stillToDo);
  const block = buildTrailingNotesBlock(trailingNotes);
  if (block) {
    events.push({ type: "content", text: block });
    write(
      `data: ${JSON.stringify({ type: "content_delta", text: block })}\n\n`,
    );
  }

  // The list outlives the turn: a follow-up message picks it up. One that has
  // nothing left outstanding has done its job and is cleared.
  try {
    if (taskListTurnState.steps.length === 0) {
      if (taskListTurnState.dirty) await clearChatTaskList(db, chatId);
    } else if (isFinished(taskListTurnState.steps)) {
      await clearChatTaskList(db, chatId);
    } else if (taskListTurnState.dirty) {
      await saveChatTaskList(db, chatId, taskListTurnState.steps);
    }
  } catch (err) {
    devLog("[chat/stream] could not store the task list", err);
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
