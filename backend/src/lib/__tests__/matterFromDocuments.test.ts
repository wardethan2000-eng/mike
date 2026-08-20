import { describe, expect, it, vi } from "vitest";

const checkProjectAccess = vi.fn();
vi.mock("../access", () => ({
  checkProjectAccess: (...args: unknown[]) => checkProjectAccess(...args),
}));

import { matterFromDocuments } from "../matterFromDocuments";

/** A database that answers one question: which matter each document is in. */
function dbReturning(rows: { project_id: string | null }[] | null, error = false) {
  return {
    from: () => ({
      select: () => ({
        in: () => Promise.resolve({ data: error ? null : rows, error: error ? {} : null }),
      }),
    }),
  } as never;
}

describe("matterFromDocuments", () => {
  it("finds the matter when every attached file is in it", async () => {
    checkProjectAccess.mockResolvedValue({ ok: true, isOwner: true });
    const matter = await matterFromDocuments(
      dbReturning([{ project_id: "m1" }, { project_id: "m1" }]),
      ["d1", "d2"],
      "user",
      "user@example.com",
    );
    expect(matter).toBe("m1");
  });

  it("ignores attached files that belong to no matter", async () => {
    checkProjectAccess.mockResolvedValue({ ok: true, isOwner: true });
    const matter = await matterFromDocuments(
      dbReturning([{ project_id: null }, { project_id: "m1" }]),
      ["d1", "d2"],
      "user",
      "user@example.com",
    );
    expect(matter).toBe("m1");
  });

  it("picks nothing when the files span two matters", async () => {
    // The important one: better no case context than the wrong case's.
    checkProjectAccess.mockResolvedValue({ ok: true, isOwner: true });
    const matter = await matterFromDocuments(
      dbReturning([{ project_id: "m1" }, { project_id: "m2" }]),
      ["d1", "d2"],
      "user",
      "user@example.com",
    );
    expect(matter).toBeNull();
  });

  it("picks nothing when no file belongs to a matter", async () => {
    const matter = await matterFromDocuments(
      dbReturning([{ project_id: null }]),
      ["d1"],
      "user",
      "user@example.com",
    );
    expect(matter).toBeNull();
  });

  it("picks nothing when nothing is attached", async () => {
    const matter = await matterFromDocuments(
      dbReturning([]),
      [],
      "user",
      "user@example.com",
    );
    expect(matter).toBeNull();
  });

  it("refuses a matter this person may not work in", async () => {
    checkProjectAccess.mockResolvedValue({ ok: false });
    const matter = await matterFromDocuments(
      dbReturning([{ project_id: "m1" }]),
      ["d1"],
      "user",
      "user@example.com",
    );
    expect(matter).toBeNull();
  });

  it("says nothing rather than throwing when the lookup fails", async () => {
    const matter = await matterFromDocuments(
      dbReturning(null, true),
      ["d1"],
      "user",
      "user@example.com",
    );
    expect(matter).toBeNull();
  });
});
