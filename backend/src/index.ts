import { app } from "./app";
import { manifestPublicKey } from "./lib/manifestSigning";
import {
  liveAnswerCount,
  stopLiveAnswersForRestart,
  waitForLiveAnswers,
} from "./lib/chat/liveAnswers";

const PORT = process.env.PORT ?? 3001;

// Surface a malformed MANIFEST_SIGNING_KEY at boot rather than when someone's
// first export fails. Unset is a valid choice and means manifests go out
// unsigned; malformed is a misconfiguration, so stop rather than serve a
// deployment whose exports will fail later.
try {
  const signingKey = manifestPublicKey();
  if (signingKey) {
    console.log(`Export manifests signed with key ${signingKey.key_id}`);
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

const server = app.listen(PORT, () => {
  console.log(`Mike backend running on port ${PORT}`);
});

/**
 * An answer is written over minutes down an open connection, so a restart in
 * the middle of one used to throw it away: the writing stopped mid-sentence
 * and nothing was saved. On the way down, every answer in progress is stopped
 * deliberately and given a moment to write down what it has, with a line
 * saying why it stops there.
 */
const SAVE_IN_PROGRESS_ANSWERS_MS = 20_000;
let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  const answers = liveAnswerCount();
  console.log(
    `Mike backend stopping (${signal}) with ${answers} answer${answers === 1 ? "" : "s"} in progress`,
  );
  // Stop taking new work first, so nothing new starts while the rest save.
  server.close();
  stopLiveAnswersForRestart();
  const unsaved = await waitForLiveAnswers(SAVE_IN_PROGRESS_ANSWERS_MS);
  if (unsaved > 0) {
    console.error(
      `Mike backend stopping with ${unsaved} answer${unsaved === 1 ? "" : "s"} unsaved`,
    );
  } else if (answers > 0) {
    console.log("Mike backend saved every answer in progress");
  }
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
