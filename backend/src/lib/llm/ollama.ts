// Ollama provider — talks to Ollama's OpenAI-compatible /v1/chat/completions.
// No API key (local). Base URL + model are overridable per-instance:
//   OLLAMA_BASE_URL (default http://localhost:11434/v1)
//   OLLAMA_MODEL    (default: the tag after "ollama/" in the model id)
import type {
  StreamChatParams,
  StreamChatResult,
  NormalizedToolCall,
  LlmMessage,
  OpenAIToolSchema,
} from "./types";
import {
  RESUME_INSTRUCTION,
  RunBudget,
  wrapUpInstruction,
  type RunStopReason,
} from "./runBudget";

function baseUrl(): string {
  return (process.env.OLLAMA_BASE_URL?.trim() || "http://localhost:11434/v1").replace(/\/$/, "");
}

// Optional bearer auth — bare Ollama needs none, but OpenAI-compatible servers
// behind a gateway (vLLM --api-key, Open WebUI, LiteLLM) require it.
export function authHeaders(): Record<string, string> {
  const key = process.env.OLLAMA_API_KEY?.trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function modelName(modelId: string): string {
  // The id's tag (e.g. "ollama/qwen3.6:latest" -> "qwen3.6:latest") wins; the
  // OLLAMA_MODEL env is only a fallback for a bare "ollama" id.
  const tag = modelId.replace(/^ollama\/?/, "");
  return tag || process.env.OLLAMA_MODEL?.trim() || "qwen3.6";
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Request aborted");
}

// Chat-completions message shape (superset of LlmMessage with tool roles).
type ChatMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | {
      role: "assistant";
      content: string;
      tool_calls: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

function initialMessages(systemPrompt: string, messages: LlmMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (systemPrompt.trim()) out.push({ role: "system", content: systemPrompt });
  for (const m of messages) out.push({ role: m.role, content: m.content });
  return out;
}

// Accumulates streamed tool-call deltas (id/name arrive once, arguments stream).
type PartialToolCall = { id: string; name: string; arguments: string };

async function postChat(
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const response = await fetch(`${baseUrl()}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Ollama request failed (${response.status}): ${text || response.statusText}`,
    );
  }
  return response;
}

export async function streamOllama(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const { model, systemPrompt, tools = [], callbacks = {}, runTools } = params;
  const budget = new RunBudget(
    params.budget,
    params.resumeState?.iterationsUsed ?? 0,
  );
  const baseMessages = params.resumeState?.baseMessages ?? params.messages;
  const messages: ChatMessage[] = params.resumeState
    ? [
        ...(params.resumeState.transcript as ChatMessage[]),
        { role: "user", content: RESUME_INSTRUCTION },
      ]
    : initialMessages(systemPrompt, params.messages);
  let fullText = "";
  // Some small local models reject the `tools` param. Drop it and carry on
  // (the model just can't call tools) rather than failing the whole chat.
  let useTools = tools.length > 0;
  let stopReason: RunStopReason = "complete";
  // The final round after a budget runs out: tools off, answer required.
  let wrappingUp = false;

  for (;;) {
    throwIfAborted(params.abortSignal);
    if (!wrappingUp) {
      const stop = budget.checkBeforeRound(messages);
      if (stop) {
        stopReason = stop;
        wrappingUp = true;
        messages.push({
          role: "user",
          content: wrapUpInstruction(
                stop,
                budget.repeatedToolName,
                params.researchNotes?.document?.filename ?? null,
                params.taskList?.steps ?? null,
              ),
        });
      } else {
        budget.startRound();
      }
    }
    const roundUsesTools = useTools && !wrappingUp;
    const sendBody = () => ({
      model: modelName(model),
      messages,
      tools: roundUsesTools ? tools : undefined,
      stream: true,
    });
    let response: Response;
    try {
      response = await postChat(sendBody(), params.abortSignal);
    } catch (err) {
      if (
        roundUsesTools &&
        /does not support tools/i.test(String((err as Error)?.message))
      ) {
        useTools = false;
        response = await postChat(sendBody(), params.abortSignal);
      } else {
        throw err;
      }
    }
    if (!response.body) throw new Error("Ollama response had no body");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const partials = new Map<number, PartialToolCall>();
    let assistantText = "";
    let buffer = "";

    while (true) {
      throwIfAborted(params.abortSignal);
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE: events are newline-delimited "data: {json}" lines.
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;

        const delta = JSON.parse(data)?.choices?.[0]?.delta;
        if (!delta) continue;

        if (typeof delta.content === "string" && delta.content) {
          assistantText += delta.content;
          fullText += delta.content;
          callbacks.onContentDelta?.(delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          const acc = partials.get(idx) ?? { id: "", name: "", arguments: "" };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name = tc.function.name;
          if (tc.function?.arguments) acc.arguments += tc.function.arguments;
          partials.set(idx, acc);
        }
      }
    }

    // The wrap-up round is always the last one, tool calls or not.
    if (wrappingUp) {
      messages.push({ role: "assistant", content: assistantText });
      break;
    }

    const toolCalls: NormalizedToolCall[] = [...partials.values()].map((p) => {
      let input: Record<string, unknown> = {};
      try {
        input = p.arguments ? JSON.parse(p.arguments) : {};
      } catch {
        input = {};
      }
      return { id: p.id || p.name, name: p.name, input };
    });

    if (!toolCalls.length || !runTools) {
      // The model is trying to finish. If it wrote a list and left steps
      // outstanding, it is sent back to finish them instead.
      const continueWith = params.onBeforeFinish?.();
      if (continueWith) {
        messages.push({ role: "assistant", content: assistantText });
        messages.push({ role: "user", content: continueWith });
        continue;
      }
      break;
    }
    budget.noteToolCalls(toolCalls);

    // Echo the assistant turn (with tool_calls) then feed tool results back.
    messages.push({
      role: "assistant",
      content: assistantText,
      tool_calls: toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.input) },
      })),
    });
    for (const call of toolCalls) callbacks.onToolCallStart?.(call);

    throwIfAborted(params.abortSignal);
    const results = await runTools(toolCalls);
    for (const r of results) {
      messages.push({ role: "tool", tool_call_id: r.tool_use_id, content: r.content });
    }
  }

  const stats = budget.stats();
  if (stopReason === "complete") return { fullText, stopReason, stats };
  return {
    fullText,
    stopReason,
    stats,
    resumeState: {
      provider: "ollama",
      model,
      baseMessages,
      transcript: messages,
      iterationsUsed: stats.iterations,
    },
  };
}

export async function completeOllamaText(params: {
  model: string;
  systemPrompt?: string;
  user: string;
  maxTokens?: number;
}): Promise<string> {
  const response = await postChat(
    {
      model: modelName(params.model),
      messages: initialMessages(params.systemPrompt ?? "", [
        { role: "user", content: params.user },
      ]),
      max_tokens: params.maxTokens ?? 2048,
      stream: false,
    },
    undefined,
  );
  const json = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return json.choices?.[0]?.message?.content ?? "";
}
