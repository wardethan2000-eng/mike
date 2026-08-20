// Working out which matter a conversation is about, when nobody has said.
//
// The Word add-in has no notion of a matter: it is attached to whatever
// document happens to be open in Word. But someone drafting in Word pulls in
// the files they are drafting against, and those files belong to a matter — so
// the matter can be read off them rather than asked for.
//
// The rule is deliberately strict. If every attached file that belongs to a
// matter belongs to the SAME matter, that is the matter. If they span two
// matters, or none belongs to one, the answer is nothing at all — better no
// case context than the wrong case's.
import { checkProjectAccess } from "./access";
import type { createServerSupabase } from "./supabase";

type Db = ReturnType<typeof createServerSupabase>;

export async function matterFromDocuments(
  db: Db,
  documentIds: string[],
  userId: string,
  userEmail: string | null | undefined,
): Promise<string | null> {
  const unique = [...new Set(documentIds.filter(Boolean))];
  if (unique.length === 0) return null;
  try {
    const { data, error } = await db
      .from("documents")
      .select("project_id")
      .in("id", unique);
    if (error || !data) return null;

    const matters = new Set(
      (data as unknown as { project_id: string | null }[])
        .map((row) => row.project_id)
        .filter((id): id is string => !!id),
    );
    // Nothing to go on, or two matters at once — say nothing rather than guess.
    if (matters.size !== 1) return null;

    const projectId = [...matters][0];
    const access = await checkProjectAccess(projectId, userId, userEmail, db);
    return access.ok ? projectId : null;
  } catch {
    return null;
  }
}
