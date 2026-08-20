/**
 * Mike writes down what it noticed only after an answer has been sent, and how
 * long that takes depends on the model and the length of the exchange. Two
 * fixed checks used to miss a slow one, and the suggestion then sat unseen
 * until the page was reloaded.
 *
 * So look several times over the minute or so that follows, further apart each
 * time, and stop the moment something new turns up.
 */
const CHECK_DELAYS_MS = [
    2000, 4000, 7000, 11000, 16000, 22000, 30000, 40000, 55000, 75000,
];

/**
 * Look for new suggestions until one of them finds something.
 *
 * `check` reads the list and answers whether anything changed. Returns a
 * function that calls the whole thing off, for an effect to clean up with.
 */
export function watchForNewSuggestions(
    check: () => Promise<boolean>,
): () => void {
    const timers: number[] = [];
    let stopped = false;

    function stop() {
        stopped = true;
        for (const timer of timers) window.clearTimeout(timer);
        timers.length = 0;
    }

    for (const delay of CHECK_DELAYS_MS) {
        timers.push(
            window.setTimeout(() => {
                if (stopped) return;
                void check()
                    .then((found) => {
                        if (found) stop();
                    })
                    .catch(() => {
                        // A check that could not be made is not worth stopping for.
                    });
            }, delay),
        );
    }

    return stop;
}

/** Two looks closer together than this are the same look. */
const RETURN_REFRESH_GAP_MS = 3000;

/**
 * Look again when the reader comes back to the page, so a tab left open in the
 * background is not showing yesterday's list.
 */
export function refreshOnReturn(run: () => void): () => void {
    let last = 0;
    const maybeRun = () => {
        if (document.visibilityState !== "visible") return;
        const now = Date.now();
        if (now - last < RETURN_REFRESH_GAP_MS) return;
        last = now;
        run();
    };
    document.addEventListener("visibilitychange", maybeRun);
    window.addEventListener("focus", maybeRun);
    return () => {
        document.removeEventListener("visibilitychange", maybeRun);
        window.removeEventListener("focus", maybeRun);
    };
}
