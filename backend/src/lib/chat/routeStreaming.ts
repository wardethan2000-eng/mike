import type { Response } from "express";
import type { createServerSupabase } from "../supabase";

type Db = ReturnType<typeof createServerSupabase>;
type AssistantMessageTable = "chat_messages" | "word_chat_messages";

export async function reserveAssistantMessage(args: {
  db: Db;
  table: AssistantMessageTable;
  id: string;
  chatId: string;
}): Promise<unknown | null> {
  const { error } = await args.db.from(args.table).insert({
    id: args.id,
    chat_id: args.chatId,
    role: "assistant",
    content: null,
    citations: null,
  });
  return error;
}

export function createReservedAssistantMessageUpdater(args: {
  db: Db;
  table: AssistantMessageTable;
  id: string;
  chatId: string;
  enabled?: boolean;
}): (content: unknown, citations: unknown) => Promise<unknown | null> {
  return async (content, citations) => {
    if (args.enabled === false) return null;
    let lastError: unknown | null = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const result = await args.db
        .from(args.table)
        .update({ content, citations })
        .eq("id", args.id)
        .eq("chat_id", args.chatId);
      lastError = result.error;
      if (!lastError) return null;
    }
    return lastError;
  };
}

export function withoutEmptyAssistantReservations<
  T extends { role?: unknown; content?: unknown },
>(messages: T[]): T[] {
  return messages.filter(
    (message) => !(message.role === "assistant" && message.content == null),
  );
}

/**
 * Keep a streaming answer's connection open while the model is quiet.
 *
 * Writing a long document is a single tool call that can take minutes to
 * compose, and nothing reaches the browser while it is being written. Proxies
 * (Cloudflare among them) hang up on a connection that sends nothing for a
 * couple of minutes, which the user sees as "network error" with the work
 * abandoned half-done. A comment line every 15 seconds keeps it alive; SSE
 * readers ignore any line that does not start with "data:".
 *
 * Returns a function that stops the heartbeat.
 */
export function startSseHeartbeat(
  res: Response,
  intervalMs = 15_000,
): () => void {
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    res.write(": keep-alive\n\n");
  }, intervalMs);
  // Never hold the process open for a heartbeat alone.
  timer.unref?.();
  const stop = () => clearInterval(timer);
  res.on("close", stop);
  return stop;
}

export function openAssistantSse(res: Response): {
  signal: AbortSignal;
  write: (line: string) => boolean;
  finish: () => void;
} {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const controller = new AbortController();
  let finished = false;
  res.on("close", () => {
    if (!finished) controller.abort();
  });
  const stopHeartbeat = startSseHeartbeat(res);

  return {
    signal: controller.signal,
    write: (line) => res.write(line),
    finish: () => {
      finished = true;
      stopHeartbeat();
      res.end();
    },
  };
}
