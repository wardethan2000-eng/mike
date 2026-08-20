/**
 * Reader-friendly names for the models Mike can answer with.
 *
 * The picker and the line under an answer must agree, so both read from here.
 * A model that is not listed — a locally run one, or a new id — shows its own
 * id rather than nothing, which is still an answer to "what wrote this?".
 */
const LABELS: Record<string, string> = {
    "claude-fable-5": "Claude Fable 5",
    "claude-opus-4-8": "Claude Opus 4.8",
    "claude-opus-4-7": "Claude Opus 4.7",
    "claude-sonnet-4-6": "Claude Sonnet 4.6",
    "claude-haiku-4-5": "Claude Haiku 4.5",
    "gemini-3.5-flash": "Gemini 3.5 Flash",
    "gemini-3.1-pro-preview": "Gemini 3.1 Pro",
    "gemini-3-flash-preview": "Gemini 3 Flash",
    "gemini-3.1-flash-lite-preview": "Gemini 3.1 Flash Lite",
    "gpt-5.5": "GPT-5.5",
    "gpt-5.4": "GPT-5.4",
    "gpt-5.4-lite": "GPT-5.4 Lite",
};

export function modelLabel(id: string | null | undefined): string {
    if (!id) return "";
    const known = LABELS[id];
    if (known) return known;
    // Locally run models are identified as "ollama/<name>:<tag>". The tag is
    // noise to a reader, the name is not.
    if (id.startsWith("ollama/")) {
        return id.slice("ollama/".length).split(":")[0];
    }
    return id;
}
