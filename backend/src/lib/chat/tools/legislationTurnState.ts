// Captures statute lookups made through the connected law MCP tools so the
// assistant can cite them the same way it cites CourtListener cases. New file
// (kept out of upstream sources) so upstream merges stay clean.

export type LegislationRecord = {
  legId: string;
  label: string;
  url: string | null;
  text: string;
};

export type LegislationTurnState = {
  byId: Map<string, LegislationRecord>;
};

// MCP tool names whose results are a single statute section we can cite.
// Extend this as more state statute tools are added to the law MCP server.
export const LEGISLATION_TOOL_NAMES = new Set<string>([
  "kansas_statute",
  "missouri_statute",
]);

// A statute tool result looks like:
//   K.S.A. 58-2540
//   Source: https://ksrevisor.gov/...
//
//   <section text>
// Normalising the label collapses whitespace and case so the model can cite it
// by the human-readable citation it sees at the top of the result.
export function normalizeLegId(label: string): string {
  return label.trim().replace(/\s+/g, " ").toUpperCase();
}

// Tool results now arrive wrapped by the MCP layer as pretty-printed JSON:
//   { "result": { "content": [ { "type": "text", "text": "<the tool output>" } ] },
//     "note": "External MCP tool result..." }
// The statute's own newlines are escaped inside that JSON, so the raw
// "LABEL\nSource: URL\n\n<text>" the parser below expects is buried in a
// text block. Pull the concatenated text blocks back out; fall back to the
// content as-is when it is already plain text (older/raw shape).
function unwrapMcpText(content: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return content;
  }
  const blocks = collectTextBlocks(parsed);
  return blocks.length ? blocks.join("\n") : content;
}

function collectTextBlocks(value: unknown): string[] {
  if (value == null) return [];
  if (typeof value === "string") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectTextBlocks(item));
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // An MCP text content block: { type: "text", text: "..." }.
    if (obj.type === "text" && typeof obj.text === "string") {
      return [obj.text];
    }
    // Otherwise walk into the wrapper (result / content / etc.) but skip the
    // untrusted-data note we add ourselves.
    return Object.entries(obj).flatMap(([key, child]) =>
      key === "note" ? [] : collectTextBlocks(child),
    );
  }
  return [];
}

// A statute label like "K.S.A. 17-12a501" or "RSMo 407.020" is stored under
// its normalized self AND under its number stripped of the state prefix, so a
// model that cites just "17-12a501" still resolves to the captured text.
function legAliases(label: string): string[] {
  const full = normalizeLegId(label);
  const stripped = full.replace(/^[A-Z.]+\s+/, "").trim();
  return stripped && stripped !== full ? [full, stripped] : [full];
}

export function newLegislationTurnState(): LegislationTurnState {
  return { byId: new Map() };
}

// Parse a statute tool result and remember it. Silently ignores anything that
// does not look like a statute section (errors, refusals) so a bad lookup never
// becomes a broken citation.
export function ingestLegislationToolResult(
  state: LegislationTurnState,
  toolName: string,
  content: unknown,
): void {
  if (!LEGISLATION_TOOL_NAMES.has(toolName)) return;
  if (typeof content !== "string") return;
  const lines = unwrapMcpText(content).split("\n");
  const label = (lines[0] ?? "").trim();
  if (!label) return;
  const sourceLine = lines.find((line) => line.trim().startsWith("Source:"));
  if (!sourceLine) return;
  const url = sourceLine.trim().slice("Source:".length).trim() || null;
  // Body is everything after the first blank line.
  const blankIndex = lines.findIndex((line, i) => i > 0 && line.trim() === "");
  const text =
    blankIndex >= 0 ? lines.slice(blankIndex + 1).join("\n").trim() : "";
  if (!text) return;
  const legId = normalizeLegId(label);
  const rec = { legId, label, url, text };
  for (const key of legAliases(label)) {
    // Do not let a bare-number alias clobber a full record already stored
    // under that key by a different statute in the same turn.
    if (!state.byId.has(key) || key === legId) state.byId.set(key, rec);
  }
}
