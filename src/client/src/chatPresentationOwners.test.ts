import { describe, expect, it } from "vitest";
import { ChatPresentationOwners } from "./chatPresentationOwners";

describe("presentation address ownership", () => {
  it("keeps a provisional owner after commitment and later history-only hydration", () => {
    const owners = new ChatPresentationOwners();
    const streaming = owners.resolve("local/session", "stream/part");
    const committed = owners.resolve("local/session", "entry/part", "stream/part");
    expect(committed.owner).toBe(streaming.owner);
    expect(committed.canonical).not.toBe(streaming.canonical);
    expect(owners.resolve("local/session", "entry/part")).toEqual(committed);
    expect(owners.resolve("remote/session", "entry/part").owner).not.toBe(committed.owner);
  });

  it("can release old aliases without changing canonical source addresses", () => {
    const owners = new ChatPresentationOwners(2);
    const provisional = owners.resolve("scope", "stream");
    const committed = owners.resolve("scope", "entry", "stream");
    expect(committed.owner).toBe(provisional.owner);
    owners.resolve("scope", "new-1");
    owners.resolve("scope", "new-2");
    const reloaded = owners.resolve("scope", "entry");
    expect(reloaded.canonical).toBe(committed.canonical);
    expect(reloaded.owner).toBe(reloaded.canonical);
  });
});
