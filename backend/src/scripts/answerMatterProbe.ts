// A live probe for the consolidated-answer path — run against the real DB and
// model without disturbing the running server:
//   docker compose run --rm --no-deps backend node dist/scripts/answerMatterProbe.js "your question"
import { createServerSupabase } from "../lib/supabase";
import { answerMatter } from "../lib/matterAnswer";
import { getUserModelSettings } from "../lib/userSettings";

async function main() {
  const db = createServerSupabase();
  const { data } = await db.from("document_passages").select("user_id").limit(1);
  if (!data || data.length === 0) throw new Error("no passages to search");
  const userId = data[0].user_id as string;
  let apiKeys;
  try {
    apiKeys = (await getUserModelSettings(userId, db)).api_keys;
  } catch {
    apiKeys = undefined;
  }
  const question =
    process.argv[2] ?? "Who is responsible if someone is injured on the property?";
  const r = await answerMatter(db, { userId, question, apiKeys, limit: 10 });
  console.log("Q:", r.question);
  console.log("\nANSWER:\n" + r.answer);
  console.log(
    "\nSOURCES: " +
      r.sources.map((s) => `${s.filename} p${s.page} [${s.matchedBy}]`).join(" | "),
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
