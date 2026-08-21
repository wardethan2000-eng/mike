// Where a chat's job list is kept between turns.
//
// A long job may span several user messages, a pause, a restart and a day, so
// the list lives on the chat row rather than in memory with the paused-turn
// store. Split out from taskList.ts, which stays free of database imports so
// its rules unit-test on their own.

import type { createServerSupabase } from "../supabase";
import { devLog } from "./types";
import { readStoredTaskList, type TaskStep } from "./taskList";

type Db = ReturnType<typeof createServerSupabase>;

/** The list this chat is working to, or an empty list. Never throws: a chat
 * must still answer if the column cannot be read. */
export async function loadChatTaskList(
  db: Db,
  chatId: string | null | undefined,
): Promise<TaskStep[]> {
  if (!chatId) return [];
  try {
    const { data } = await db
      .from("chats")
      .select("task_list")
      .eq("id", chatId)
      .maybeSingle();
    return readStoredTaskList(data?.task_list);
  } catch (err) {
    devLog("[task-list] could not read the stored list", err);
    return [];
  }
}

export async function saveChatTaskList(
  db: Db,
  chatId: string | null | undefined,
  steps: TaskStep[],
): Promise<void> {
  if (!chatId) return;
  try {
    await db
      .from("chats")
      .update({
        task_list: { steps },
        task_list_updated_at: new Date().toISOString(),
      })
      .eq("id", chatId);
  } catch (err) {
    devLog("[task-list] could not store the list", err);
  }
}

/** A list with nothing outstanding has done its job, so the next question in
 * the chat starts clean. */
export async function clearChatTaskList(
  db: Db,
  chatId: string | null | undefined,
): Promise<void> {
  if (!chatId) return;
  try {
    await db
      .from("chats")
      .update({ task_list: null, task_list_updated_at: new Date().toISOString() })
      .eq("id", chatId);
  } catch (err) {
    devLog("[task-list] could not clear the list", err);
  }
}
