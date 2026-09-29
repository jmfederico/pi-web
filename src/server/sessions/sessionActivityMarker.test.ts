import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionActivityMarker } from "./sessionActivityMarker.js";

describe("SessionActivityMarker", () => {
  let directory: string;
  let file: string;
  let sidecar: string;
  let now: number;
  let services: SessionActivityMarker[];

  function service(owner?: string, onError?: (error: unknown) => void): SessionActivityMarker {
    const marker = new SessionActivityMarker({
      ...(owner === undefined ? {} : { owner }),
      ...(onError === undefined ? {} : { onError }),
      now: () => now,
    });
    services.push(marker);
    return marker;
  }

  async function contents(): Promise<{ owner: string; updatedAt: number }> {
    const value: unknown = JSON.parse(await readFile(sidecar, "utf8"));
    if (typeof value !== "object" || value === null ||
        !("owner" in value) || typeof value.owner !== "string" ||
        !("updatedAt" in value) || typeof value.updatedAt !== "number") {
      throw new Error("Expected a valid activity marker");
    }
    return { owner: value.owner, updatedAt: value.updatedAt };
  }

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "session-activity-"));
    file = join(directory, "session.jsonl");
    sidecar = `${file}.pi-web-activity.json`;
    await writeFile(file, "transcript\n");
    now = 100_000;
    services = [];
  });

  afterEach(async () => {
    await Promise.all(services.map((marker) => marker.dispose()));
    await rm(directory, { recursive: true, force: true });
  });

  it("lets idle observers see another owner without claiming or disturbing its marker", async () => {
    const owner = service("owner");
    const observer = service("observer");
    await observer.refresh(file, false);
    await expect(stat(sidecar)).rejects.toMatchObject({ code: "ENOENT" });
    await owner.refresh(file, true);
    now += 2_000;
    await observer.refresh(file, false);
    expect(observer.isActiveElsewhere(file)).toBe(true);
    expect(owner.isActiveElsewhere(file)).toBe(false);
    await observer.refresh(file, true);
    expect(observer.isActiveElsewhere(file)).toBe(true);
    expect(await contents()).toEqual({ owner: "owner", updatedAt: 100_000 });
    await observer.refresh(file, false);
    await observer.release(file);
    expect(observer.isActiveElsewhere(file)).toBe(false);
    expect(await contents()).toEqual({ owner: "owner", updatedAt: 100_000 });
    await owner.refresh(file, false);
    await expect(stat(sidecar)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(file, "utf8")).toBe("transcript\n");
  });

  it("throttles repeated refreshes but refreshes timestamps at two seconds and bypasses on busy changes", async () => {
    const marker = service("owner");
    await marker.refresh(file, true);
    now += 1_999;
    await Promise.all(Array.from({ length: 20 }, () => marker.refresh(file, true)));
    expect((await contents()).updatedAt).toBe(100_000);
    now += 1;
    await marker.refresh(file, true);
    expect((await contents()).updatedAt).toBe(102_000);
    await marker.refresh(file, false);
    await expect(stat(sidecar)).rejects.toMatchObject({ code: "ENOENT" });
    await marker.refresh(file, true);
    expect((await contents()).updatedAt).toBe(now);
  });

  it("expires crashed owners after fifteen seconds, without idle observers claiming stale markers", async () => {
    await writeFile(sidecar, JSON.stringify({ owner: "crashed", updatedAt: now }));
    const observer = service("observer");
    now += 15_000;
    await observer.refresh(file, false);
    expect(observer.isActiveElsewhere(file)).toBe(true);
    now += 2_000;
    await observer.refresh(file, false);
    expect(observer.isActiveElsewhere(file)).toBe(false);
    expect((await contents()).owner).toBe("crashed");
    await observer.refresh(file, true);
    expect(await contents()).toEqual({ owner: "observer", updatedAt: now });
  });

  it("preserves the last known activity while a filesystem refresh is pending", async () => {
    const observer = service("observer");
    await writeFile(sidecar, JSON.stringify({ owner: "foreign", updatedAt: now }));
    await observer.refresh(file, false);
    expect(observer.isActiveElsewhere(file)).toBe(true);

    await rm(sidecar);
    now += 2_000;
    const refresh = observer.refresh(file, false);
    try {
      // Let the queued refresh start; filesystem IO cannot finish in this microtask.
      await Promise.resolve();
      expect(observer.isActiveElsewhere(file)).toBe(true);
    } finally {
      await refresh;
    }
    expect(observer.isActiveElsewhere(file)).toBe(false);
  });

  it("keeps renewed owners visible beyond their original expiry", async () => {
    const owner = service("owner");
    const observer = service("observer");
    await owner.refresh(file, true);
    now += 14_000;
    await owner.refresh(file, true);
    now += 2_000;
    await observer.refresh(file, false);
    expect(observer.isActiveElsewhere(file)).toBe(true);
  });

  it("serializes busy transitions and release behind pending writes", async () => {
    const marker = service("owner");
    await Promise.all([
      marker.refresh(file, true),
      marker.refresh(file, false),
      marker.refresh(file, true),
      marker.release(file),
    ]);
    await expect(stat(sidecar)).rejects.toMatchObject({ code: "ENOENT" });
    expect(marker.isActiveElsewhere(file)).toBe(false);
    await marker.refresh(file, true);
    expect((await contents()).owner).toBe("owner");
  });

  it("rechecks ownership on release rather than removing a replacement", async () => {
    const marker = service("owner");
    await marker.refresh(file, true);
    await writeFile(sidecar, JSON.stringify({ owner: "replacement", updatedAt: now }));
    await marker.release(file);
    expect((await contents()).owner).toBe("replacement");
  });

  it("disposes all tracked paths after pending refreshes and remains disposed", async () => {
    const marker = service("owner");
    const other = join(directory, "other.jsonl");
    await writeFile(other, "");
    const first = marker.refresh(file, true);
    const second = marker.refresh(other, true);
    await Promise.all([first, second, marker.dispose(), marker.dispose()]);
    await marker.refresh(file, true);
    await expect(stat(sidecar)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(`${other}.pi-web-activity.json`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("ignores undefined and missing transcripts without creating directories or reporting ENOENT", async () => {
    const onError = vi.fn();
    const marker = service("owner", onError);
    const missing = join(directory, "absent", "session.jsonl");
    await marker.refresh(undefined, true);
    await marker.release(undefined);
    expect(marker.isActiveElsewhere(undefined)).toBe(false);
    await marker.refresh(missing, true);
    await marker.refresh(join(directory, "missing.jsonl"), true);
    expect(marker.isActiveElsewhere(missing)).toBe(false);
    await marker.release(missing);
    await expect(stat(join(directory, "absent"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(directory, "missing.jsonl.pi-web-activity.json"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(onError).not.toHaveBeenCalled();
  });

  it.each(["{", "null", "[]", "{}", '{"owner":42,"updatedAt":100000}', '{"owner":"foreign","updatedAt":"100000"}', '{"owner":"foreign","updatedAt":1e999}'])(
    "treats malformed or invalid markers as advisory noise: %s",
    async (text) => {
      const onError = vi.fn();
      const marker = service("owner", onError);
      await writeFile(sidecar, text);
      await marker.refresh(file, false);
      expect(marker.isActiveElsewhere(file)).toBe(false);
      await marker.refresh(file, true);
      expect(await contents()).toEqual({ owner: "owner", updatedAt: now });
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it("reports IO errors, clears cached foreign activity, and recovers on refresh", async () => {
    const onError = vi.fn();
    const marker = service("owner", onError);
    await writeFile(sidecar, JSON.stringify({ owner: "foreign", updatedAt: now }));
    await marker.refresh(file, false);
    expect(marker.isActiveElsewhere(file)).toBe(true);
    await rm(sidecar);
    await mkdir(sidecar);
    now += 2_000;
    await expect(marker.refresh(file, false)).resolves.toBeUndefined();
    expect(marker.isActiveElsewhere(file)).toBe(false);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: "EISDIR" }));
    await expect(marker.release(file)).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(2);
    await rm(sidecar, { recursive: true });
    await marker.refresh(file, true);
    expect((await contents()).owner).toBe("owner");
  });

  it("does not let a throwing error callback break sessions", async () => {
    const marker = service("owner", () => { throw new Error("reporter failed"); });
    await mkdir(sidecar);
    await expect(marker.refresh(file, true)).resolves.toBeUndefined();
    await expect(marker.dispose()).resolves.toBeUndefined();
  });

  it("assigns a distinct default owner to each service", async () => {
    const first = service();
    const second = service();
    await first.refresh(file, true);
    const firstOwner = (await contents()).owner;
    expect(firstOwner).toMatch(/^[\da-f-]{36}$/);
    await second.refresh(file, true);
    expect(second.isActiveElsewhere(file)).toBe(true);
    await first.release(file);
    now += 2_000;
    await second.refresh(file, true);
    expect((await contents()).owner).not.toBe(firstOwner);
  });
});
