import { describe, expect, it } from "vitest";
import { ChatRenderKeys } from "./chatRenderKeys";

describe("transcript render ownership", () => {
  it("retains an activity owner when either edge grows and gives split groups distinct owners", () => {
    const keys = new ChatRenderKeys();
    const owner = keys.reconcile("session", [{ slot: "10", identity: "middle", identities: ["middle"] }])[0];
    expect(keys.reconcile("session", [{ slot: "9", identity: "earlier", identities: ["earlier", "middle", "later"] }])).toEqual([owner]);
    const split = keys.reconcile("session", [
      { slot: "9", identity: "earlier", identities: ["earlier"] },
      { slot: "10", identity: "middle", identities: ["middle", "later"] },
    ]);
    expect(split[0]).toBe(owner);
    expect(split[1]).not.toBe(owner);
  });

  it("keeps distinct mounted owners for legacy slices sharing one entry identity", () => {
    const keys = new ChatRenderKeys();
    const slices = [{ slot: "0", identity: "entry" }, { slot: "1", identity: "entry" }];
    const owners = keys.reconcile("session", slices);
    expect(new Set(owners).size).toBe(2);
    expect(keys.reconcile("session", slices)).toEqual(owners);
  });

  it("finalizes provisional owners but never reuses a different committed entry by position", () => {
    const keys = new ChatRenderKeys();
    const provisional = keys.reconcile("session", [{ slot: "0" }])[0];
    expect(keys.reconcile("session", [{ slot: "0", identity: "first" }])).toEqual([provisional]);
    expect(keys.reconcile("session", [{ slot: "0", identity: "replacement" }])[0]).not.toBe(provisional);
  });
});
