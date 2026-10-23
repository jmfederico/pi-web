import { describe, expect, it } from "vitest";
import { completeRefreshBatch } from "./refreshBatch";

describe("refresh batch completion", () => {
  it("does not report a batch finished while sibling refreshes are still running after a failure", async () => {
    const failure = new Error("Topology unavailable");
    let finish: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    let settled = false;
    const batch = completeRefreshBatch([Promise.reject(failure), pending]).finally(() => { settled = true; });
    const checked = expect(batch).rejects.toBe(failure);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await checked;
    expect(settled).toBe(true);
  });

  it("retains every independent failure instead of reporting whichever happened first", async () => {
    const first = new Error("Topology unavailable");
    const second = new Error("Panel unavailable");
    await expect(completeRefreshBatch([Promise.reject(first), Promise.resolve(), Promise.reject(second)]))
      .rejects.toMatchObject({ errors: [first, second], message: "Topology unavailable; Panel unavailable" });
  });

  it("completes successful and empty batches", async () => {
    await expect(completeRefreshBatch([Promise.resolve("list"), Promise.resolve("panel")])).resolves.toBeUndefined();
    await expect(completeRefreshBatch([])).resolves.toBeUndefined();
  });
});
