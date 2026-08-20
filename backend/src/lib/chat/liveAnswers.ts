// An answer is written over minutes, straight down an open connection. If the
// server goes away in the middle of one — a deploy, a restart, a crash — the
// connection dies with it: the writing stops mid-sentence, the citations are
// never filed, and nothing is saved. The reader is left with text on screen
// that vanishes when they reload.
//
// So every answer in progress is known here. On the way down they are stopped
// deliberately, which takes each one through the same path as a cancelled
// answer: what has been written so far is saved, with a line saying why it
// stops there. Losing the end of an answer is a nuisance; losing the whole
// thing, silently, is not.

type LiveAnswer = { stop: () => void; startedAt: number };

const live = new Set<LiveAnswer>();
let stoppingForRestart = false;

/**
 * Note an answer that is being written. Returns the function to call when it
 * is finished, whichever way it finished.
 */
export function registerLiveAnswer(stop: () => void): () => void {
  const entry: LiveAnswer = { stop, startedAt: Date.now() };
  live.add(entry);
  return () => {
    live.delete(entry);
  };
}

/** How many answers are being written right now. */
export function liveAnswerCount(): number {
  return live.size;
}

/** True once the server has begun shutting down. */
export function isStoppingForRestart(): boolean {
  return stoppingForRestart;
}

/**
 * What to write at the end of an answer that stopped early, in the reader's
 * words rather than the server's.
 */
export function cancellationNote(): string {
  return stoppingForRestart
    ? "Mike was restarted while this answer was being written, so it stops here. Ask again to get the rest."
    : "Cancelled by user.";
}

/** Stop every answer in progress, so each one saves what it has. */
export function stopLiveAnswersForRestart(): void {
  stoppingForRestart = true;
  for (const entry of [...live]) {
    try {
      entry.stop();
    } catch {
      // One answer that will not stop must not hold up the others.
    }
  }
}

/**
 * Wait for the answers in progress to finish saving, up to a limit. Returns
 * how many were still going when the wait ran out — zero means everything got
 * written down.
 */
export async function waitForLiveAnswers(timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (live.size > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return live.size;
}

/** Test seam: forget everything known about answers in progress. */
export function resetLiveAnswers(): void {
  live.clear();
  stoppingForRestart = false;
}
