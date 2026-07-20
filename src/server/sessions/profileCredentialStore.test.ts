import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Credential } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProfileCredentialStore,
  ProfileCredentialStoreMalformedFileError,
  type ProfileCredentialStoreLogger,
} from "./profileCredentialStore.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("ProfileCredentialStore", () => {
  it("durably merges and deletes one provider without losing unknown records or OAuth extensions", async () => {
    const { agentDir, authPath } = await tempAgentDir();
    const oauth = {
      type: "oauth",
      refresh: "refresh-token",
      access: "access-token",
      expires: 123,
      accountId: "account-1",
      nested: { future: true },
    } as const;
    const unknown = { type: "future_credential", opaque: { keep: true } };
    await writeAuth(authPath, { oauth, unknown, existing: { type: "api_key", key: "keep-me" } });
    const store = await ProfileCredentialStore.create({ agentDir });

    await store.modify("new-provider", () => Promise.resolve({
      type: "api_key",
      key: "new-key",
      env: { TENANT: "tenant-1" },
    }));

    expect(await readAuth(authPath)).toEqual({
      oauth,
      unknown,
      existing: { type: "api_key", key: "keep-me" },
      "new-provider": { type: "api_key", key: "new-key", env: { TENANT: "tenant-1" } },
    });
    await expect(store.read("oauth")).resolves.toEqual(oauth);

    await store.delete("new-provider");
    expect(await readAuth(authPath)).toEqual({ oauth, unknown, existing: { type: "api_key", key: "keep-me" } });
  });

  it("lists metadata without resolving secrets or executing commands", async () => {
    const { agentDir, authPath } = await tempAgentDir();
    await writeAuth(authPath, {
      command: { type: "api_key", key: "!never-run-during-list" },
      oauth: { type: "oauth", refresh: "r", access: "a", expires: 1, extension: "kept" },
      ignored: { type: "future" },
    });
    const runCommand = vi.fn(() => Promise.reject(new Error("must not execute")));
    const store = await ProfileCredentialStore.create({ agentDir, runCommand });

    await expect(store.list()).resolves.toEqual([
      { providerId: "command", type: "api_key" },
      { providerId: "oauth", type: "oauth" },
    ]);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("resolves interpolation from credential env before process env and honors escapes", async () => {
    const { agentDir } = await tempAgentDir();
    const store = await ProfileCredentialStore.create({
      agentDir,
      env: { SHARED: "process", PROCESS_ONLY: "ambient" },
    });
    await store.modify("provider", () => Promise.resolve({
      type: "api_key",
      key: "prefix-$SHARED-${PROCESS_ONLY}-$$dollar-$!bang",
      env: { SHARED: "credential" },
    }));

    await expect(store.read("provider")).resolves.toEqual({
      type: "api_key",
      key: "prefix-credential-ambient-$dollar-!bang",
      env: { SHARED: "credential" },
    });
  });

  it("makes a missing interpolation unavailable instead of returning the expression literally", async () => {
    const { agentDir, authPath } = await tempAgentDir();
    const store = await ProfileCredentialStore.create({ agentDir, env: {} });
    await store.modify("provider", () => Promise.resolve({ type: "api_key", key: "before-$MISSING-after", env: { OTHER: "value" } }));

    await expect(store.read("provider")).resolves.toEqual({ type: "api_key", env: { OTHER: "value" } });
    expect(await readAuth(authPath)).toEqual({
      provider: { type: "api_key", key: "before-$MISSING-after", env: { OTHER: "value" } },
    });
  });

  it("coalesces and caches successful commands while failed commands stay unavailable and retryable", async () => {
    const { agentDir } = await tempAgentDir();
    const successfulCommand = `successful-${crypto.randomUUID()}`;
    const failingCommand = `failing-${crypto.randomUUID()}`;
    const concurrentCommand = `concurrent-${crypto.randomUUID()}`;
    const runCommand = vi.fn((command: string) => command === failingCommand
      ? Promise.reject(new Error("command failed"))
      : Promise.resolve("  resolved-secret\n"));
    const store = await ProfileCredentialStore.create({ agentDir, runCommand });
    await store.modify("provider", () => Promise.resolve({ type: "api_key", key: `!${successfulCommand}` }));

    await expect(store.read("provider")).resolves.toEqual({ type: "api_key", key: "resolved-secret" });
    await expect(store.read("provider")).resolves.toEqual({ type: "api_key", key: "resolved-secret" });
    expect(runCommand).toHaveBeenCalledTimes(1);

    await store.modify("provider", () => Promise.resolve({ type: "api_key", key: `!${failingCommand}` }));
    await expect(store.read("provider")).resolves.toEqual({ type: "api_key" });
    await expect(store.read("provider")).resolves.toEqual({ type: "api_key" });
    expect(runCommand).toHaveBeenCalledTimes(3);

    await store.modify("provider", () => Promise.resolve({ type: "api_key", key: `!${concurrentCommand}` }));
    await expect(Promise.all([store.read("provider"), store.read("provider")])).resolves.toEqual([
      { type: "api_key", key: "resolved-secret" },
      { type: "api_key", key: "resolved-secret" },
    ]);
    expect(runCommand).toHaveBeenCalledTimes(4);
  });

  it.skipIf(process.platform === "win32")("enforces private directory and file permissions", async () => {
    const { agentDir, authPath } = await tempAgentDir();
    await chmod(agentDir, 0o755);
    await writeFile(authPath, "{}\n", { encoding: "utf8", mode: 0o644 });
    await chmod(authPath, 0o644);

    const store = await ProfileCredentialStore.create({ agentDir });
    await store.modify("provider", () => Promise.resolve({ type: "api_key", key: "secret" }));

    expect((await stat(agentDir)).mode & 0o777).toBe(0o700);
    expect((await stat(authPath)).mode & 0o777).toBe(0o600);
  });

  it("serves the last valid snapshot and refuses to overwrite malformed external JSON", async () => {
    const { agentDir, authPath } = await tempAgentDir();
    await writeAuth(authPath, { provider: { type: "api_key", key: "last-valid" } });
    const store = await ProfileCredentialStore.create({ agentDir });
    const validRevision = store.revision;
    await expect(store.read("provider")).resolves.toEqual({ type: "api_key", key: "last-valid" });

    await writeFile(authPath, "{ malformed", "utf8");
    await expect(store.read("provider")).resolves.toEqual({ type: "api_key", key: "last-valid" });
    expect(store.revision).toBe(validRevision);
    expect(store.reloadError).toBeInstanceOf(ProfileCredentialStoreMalformedFileError);
    const callback = vi.fn(() => Promise.resolve<Credential | undefined>({ type: "api_key", key: "replacement" }));
    await expect(store.modify("provider", callback)).rejects.toBeInstanceOf(ProfileCredentialStoreMalformedFileError);
    expect(callback).not.toHaveBeenCalled();
    await expect(readFile(authPath, "utf8")).resolves.toBe("{ malformed");

    await writeAuth(authPath, { provider: { type: "api_key", key: "repaired" } });
    await expect(store.reload()).resolves.toMatchObject({ changed: true });
    await expect(store.read("provider")).resolves.toEqual({ type: "api_key", key: "repaired" });
    expect(store.reloadError).toBeUndefined();
  });

  it("serializes same-provider callbacks and merges concurrent mutations from separate store instances", async () => {
    const { agentDir, authPath } = await tempAgentDir();
    await writeAuth(authPath, {
      counter: { type: "oauth", refresh: "r", access: "a", expires: 1, count: 0 },
      untouched: { type: "api_key", key: "keep" },
    });
    const first = await ProfileCredentialStore.create({ agentDir });
    const second = await ProfileCredentialStore.create({ agentDir });
    let callbacksInFlight = 0;
    let maxCallbacksInFlight = 0;

    const increment = (store: ProfileCredentialStore) => store.modify("counter", async (current) => {
      callbacksInFlight += 1;
      maxCallbacksInFlight = Math.max(maxCallbacksInFlight, callbacksInFlight);
      await Promise.resolve();
      const count = oauthCount(current);
      callbacksInFlight -= 1;
      if (current?.type !== "oauth") throw new Error("Expected OAuth credential");
      return { ...current, count: count + 1 };
    });

    await Promise.all(Array.from({ length: 12 }, (_, index) => increment(index % 2 === 0 ? first : second)));

    expect(maxCallbacksInFlight).toBe(1);
    expect(await readAuth(authPath)).toEqual({
      counter: { type: "oauth", refresh: "r", access: "a", expires: 1, count: 12 },
      untouched: { type: "api_key", key: "keep" },
    });
  });

  it("waits for a long cross-instance lock owner instead of failing with ELOCKED", async () => {
    const { agentDir, authPath } = await tempAgentDir();
    const first = await ProfileCredentialStore.create({ agentDir });
    const second = await ProfileCredentialStore.create({ agentDir });
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const firstMutation = first.modify("first", async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
      return { type: "api_key", key: "one" };
    });
    await firstStarted.promise;
    let secondSettled = false;
    const secondMutation = second.modify("second", () => Promise.resolve({ type: "api_key", key: "two" }));
    void secondMutation.then(
      () => { secondSettled = true; },
      () => { secondSettled = true; },
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 2_750));
    const settledWhileFirstOwnedLock = secondSettled;
    releaseFirst.resolve();
    await Promise.all([firstMutation, secondMutation]);

    expect(settledWhileFirstOwnedLock).toBe(false);
    expect(await readAuth(authPath)).toEqual({
      first: { type: "api_key", key: "one" },
      second: { type: "api_key", key: "two" },
    });
  });

  it("checks a scoped generation guard at the durable rename boundary", async () => {
    const { agentDir, authPath } = await tempAgentDir();
    await writeAuth(authPath, { provider: { type: "api_key", key: "current" } });
    const store = await ProfileCredentialStore.create({ agentDir });

    await expect(store.modifyGuarded(
      "provider",
      () => Promise.resolve({ type: "api_key", key: "stale" }),
      () => { throw new Error("runtime invalidated"); },
    )).rejects.toThrow("runtime invalidated");

    expect(await readAuth(authPath)).toEqual({ provider: { type: "api_key", key: "current" } });
    expect(store.revision).toBe(1);
  });

  it("publishes durable revisions and isolates listener failures from committed mutations", async () => {
    const { agentDir, authPath } = await tempAgentDir();
    const error = vi.fn();
    const logger: ProfileCredentialStoreLogger = { error };
    const store = await ProfileCredentialStore.create({ agentDir, logger });
    const changes: unknown[] = [];
    store.subscribe((change) => { changes.push(change); });
    store.subscribe(() => { throw new Error("sync listener failed"); });
    store.subscribe(() => Promise.reject(new Error("async listener failed")));

    await expect(store.modify("provider", () => Promise.resolve({ type: "api_key", key: "committed" }))).resolves.toEqual({
      type: "api_key",
      key: "committed",
    });
    await Promise.resolve();

    expect(await readAuth(authPath)).toEqual({ provider: { type: "api_key", key: "committed" } });
    expect(changes).toEqual([{ revision: 1, source: "modify", providerId: "provider" }]);
    expect(error).toHaveBeenCalledTimes(2);

    await store.modify("provider", (current) => Promise.resolve(current));
    expect(changes).toContainEqual({ revision: 2, source: "modify", providerId: "provider" });

    await writeAuth(authPath, { provider: { type: "api_key", key: "external" } });
    await expect(store.reload()).resolves.toEqual({ revision: 3, changed: true });
    expect(changes).toContainEqual({ revision: 3, source: "reload" });
  });

  it("observes valid external replacements while retaining the last valid snapshot through malformed edits", async () => {
    const { agentDir, authPath } = await tempAgentDir();
    const store = await ProfileCredentialStore.create({ agentDir });
    await store.modify("provider", () => Promise.resolve({ type: "api_key", key: "initial" }));
    await store.startExternalObservation({ debounceMs: 1, pollIntervalMs: 10 });

    try {
      await writeAuth(authPath, { provider: { type: "api_key", key: "external" } });
      await vi.waitFor(() => { expect(store.revision).toBe(2); });
      await expect(store.read("provider")).resolves.toEqual({ type: "api_key", key: "external" });

      await writeFile(authPath, "{not-json", "utf8");
      await vi.waitFor(() => { expect(store.reloadError).toBeInstanceOf(ProfileCredentialStoreMalformedFileError); });
      expect(store.revision).toBe(2);
      await expect(store.read("provider")).resolves.toEqual({ type: "api_key", key: "external" });

      await writeAuth(authPath, { provider: { type: "api_key", key: "repaired" } });
      await vi.waitFor(() => {
        expect(store.revision).toBe(3);
        expect(store.reloadError).toBeUndefined();
      });
      await expect(store.read("provider")).resolves.toEqual({ type: "api_key", key: "repaired" });
    } finally {
      store.dispose();
    }
  });
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

async function tempAgentDir(): Promise<{ agentDir: string; authPath: string }> {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-web-profile-credentials-"));
  tempRoots.push(agentDir);
  return { agentDir, authPath: join(agentDir, "auth.json") };
}

function writeAuth(path: string, value: Record<string, unknown>): Promise<void> {
  return writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readAuth(path: string): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(parsed)) throw new Error("Expected auth object");
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function oauthCount(credential: Credential | undefined): number {
  if (credential?.type !== "oauth") throw new Error("Expected OAuth credential");
  return typeof credential["count"] === "number" ? credential["count"] : 0;
}
