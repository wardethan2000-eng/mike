import { describe, expect, it } from "vitest";
import {
  MAX_FACTS_IN_PROMPT,
  SEND_EVERYTHING_BELOW,
  parseEmbedding,
  selectMemoriesForQuery,
  type SelectableMemory,
} from "../memorySelection";
import type { MemoryCategory } from "../memoryCategories";

function fact(
  id: string,
  body: string,
  category: MemoryCategory = "dates",
  pinned = false,
  embedding: number[] | null = null,
): SelectableMemory {
  return { id, body, category, pinned, embedding };
}

/** A matter of `count` unremarkable dated facts, none like the others. */
function manyDates(count: number): SelectableMemory[] {
  return Array.from({ length: count }, (_, i) =>
    fact(`d${i}`, `Filing number ${i} is due on day ${i}.`),
  );
}

describe("selectMemoriesForQuery", () => {
  it("sends everything while a matter holds few facts", () => {
    const memories = manyDates(SEND_EVERYTHING_BELOW);
    const { chosen, omitted } = selectMemoriesForQuery(memories, "anything", null);
    expect(chosen).toHaveLength(SEND_EVERYTHING_BELOW);
    expect(omitted).toBe(0);
  });

  it("starts picking once a matter holds more than fit", () => {
    const memories = manyDates(SEND_EVERYTHING_BELOW + 40);
    const { chosen, omitted } = selectMemoriesForQuery(memories, "day 3", null);
    expect(chosen.length).toBeLessThanOrEqual(MAX_FACTS_IN_PROMPT);
    expect(chosen.length + omitted).toBe(memories.length);
    expect(omitted).toBeGreaterThan(0);
  });

  it("always sends who the parties are, whatever was asked", () => {
    const memories = [
      fact("who", "We act for the landlord, Acme Holdings LLC.", "parties"),
      ...manyDates(80),
    ];
    const { chosen } = selectMemoriesForQuery(memories, "when is the hearing", null);
    expect(chosen.map((m) => m.id)).toContain("who");
  });

  it("always sends a pinned fact, whatever was asked", () => {
    const memories = [
      fact("pin", "Never contact the client directly.", "decisions", true),
      ...manyDates(80),
    ];
    const { chosen } = selectMemoriesForQuery(memories, "when is the hearing", null);
    expect(chosen.map((m) => m.id)).toContain("pin");
  });

  it("picks the fact sharing the question's words over one that does not", () => {
    const memories = [
      fact("mediation", "The mediation is set for 3 December 2026."),
      ...manyDates(80),
    ];
    const { chosen } = selectMemoriesForQuery(
      memories,
      "when is the mediation happening",
      null,
    );
    expect(chosen.map((m) => m.id)).toContain("mediation");
  });

  it("picks the fact closest in meaning when the words do not match", () => {
    // Two facts that share nothing with the question in words; only their
    // fingerprints separate them.
    const near = [1, 0];
    const far = [0, 1];
    const memories = [
      fact("near", "Zzz qqq wwx.", "dates", false, near),
      ...manyDates(80).map((m) => ({ ...m, embedding: far })),
    ];
    const { chosen } = selectMemoriesForQuery(memories, "vvv uuu", near);
    expect(chosen.map((m) => m.id)).toContain("near");
  });

  it("still sends the standing facts when they alone fill the budget", () => {
    const memories = Array.from({ length: MAX_FACTS_IN_PROMPT + 20 }, (_, i) =>
      fact(`p${i}`, `Party number ${i} is a defendant.`, "parties"),
    );
    const { chosen, omitted } = selectMemoriesForQuery(memories, "anything", null);
    expect(chosen).toHaveLength(MAX_FACTS_IN_PROMPT);
    expect(omitted).toBe(20);
  });

  it("keeps the order it was given, so the grouping still reads", () => {
    const memories = [
      fact("a", "Alpha is due on day 1."),
      fact("b", "Beta is due on day 2."),
      ...manyDates(80),
    ];
    const { chosen } = selectMemoriesForQuery(memories, "alpha beta", null);
    const ids = chosen.map((m) => m.id);
    expect(ids.indexOf("a")).toBeLessThan(ids.indexOf("b"));
  });
});

describe("parseEmbedding", () => {
  it("reads the text form pgvector hands back", () => {
    expect(parseEmbedding("[0.5,-0.25,1]")).toEqual([0.5, -0.25, 1]);
  });

  it("passes an array straight through", () => {
    expect(parseEmbedding([1, 2])).toEqual([1, 2]);
  });

  it("treats anything else as no fingerprint at all", () => {
    expect(parseEmbedding(null)).toBeNull();
    expect(parseEmbedding("")).toBeNull();
    expect(parseEmbedding("[]")).toBeNull();
    expect(parseEmbedding("[not,a,number]")).toBeNull();
  });
});
