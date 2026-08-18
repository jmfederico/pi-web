import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  claimSessiondStateOwnership,
  isOwnershipRecordAlive,
  parseOwnershipRecord,
  readProcessStartTime,
  SessiondStateOwnershipConflictError,
  SESSIOND_OWNER_MARKER_FILENAME,
  type SessiondStateOwnershipRecord,
} from "./sessiondStateOwnership.js";

const DEAD_PID = 2 ** 30;
const OTHER_LIVE_PID = 424_242;

let dataDir: string;
let markerPath: string;

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "pi-web-ownership-test-"));
  markerPath = join(dataDir, SESSIOND_OWNER_MARKER_FILENAME);
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function env(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PI_WEB_DATA_DIR: dataDir, ...overrides };
}

async function writeMarker(record: Partial<SessiondStateOwnershipRecord> & Pick<SessiondStateOwnershipRecord, "pid">): Promise<SessiondStateOwnershipRecord> {
  const full: SessiondStateOwnershipRecord = {
    startedAt: "2026-01-01T00:00:00.000Z",
    endpoint: join(dataDir, "sessiond.sock"),
    ...record,
  };
  await writeFile(markerPath, `${JSON.stringify(full)}\n`, "utf8");
  return full;
}

async function readMarker(): Promise<SessiondStateOwnershipRecord> {
  const parsed = parseOwnershipRecord(await readFile(markerPath, "utf8"));
  if (parsed === "invalid") throw new Error("expected a valid ownership marker");
  return parsed;
}

function collectingLogger(): { entries: { level: string; message: string }[]; info: (d: Record<string, unknown>, m: string) => void; warn: (d: Record<string, unknown>, m: string) => void } {
  const entries: { level: string; message: string }[] = [];
  return {
    entries,
    info: (_details, message) => { entries.push({ level: "info", message }); },
    warn: (_details, message) => { entries.push({ level: "warn", message }); },
  };
}

describe("claimSessiondStateOwnership", () => {
  it("claims unowned state, records the owner, and releases on request", async () => {
    const ownership = await claimSessiondStateOwnership({ env: env() });

    expect(ownership.markerPath).toBe(markerPath);
    const record = await readMarker();
    expect(record.pid).toBe(process.pid);
    expect(record.endpoint).toBe(join(dataDir, "sessiond.sock"));
    expect(Date.parse(record.startedAt)).not.toBeNaN();

    await ownership.release();
    await expect(readFile(markerPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("describes a TCP endpoint when a session daemon port is configured", async () => {
    const ownership = await claimSessiondStateOwnership({
      env: env({ PI_WEB_SESSIOND_PORT: "7800", PI_WEB_SESSIOND_HOST: "0.0.0.0" }),
    });

    expect(ownership.record.endpoint).toBe("0.0.0.0:7800");
  });

  it("takes over from a dead owner's stale marker", async () => {
    const stale = await writeMarker({ pid: DEAD_PID });
    const logger = collectingLogger();

    await claimSessiondStateOwnership({ env: env(), logger });

    const record = await readMarker();
    expect(record.pid).toBe(process.pid);
    expect(record.startedAt).not.toBe(stale.startedAt);
    expect(logger.entries.some((entry) => entry.level === "info" && entry.message.includes("stale marker"))).toBe(true);
  });

  it("reclaims its own previous marker without waiting", async () => {
    await writeMarker({ pid: process.pid });

    const ownership = await claimSessiondStateOwnership({ env: env(), graceMs: 50, pollIntervalMs: 10 });

    expect(ownership.record.pid).toBe(process.pid);
    expect((await readMarker()).startedAt).toBe(ownership.record.startedAt);
  });

  it("waits out the grace window for a live owner that releases, then claims", async () => {
    await writeMarker({ pid: OTHER_LIVE_PID });
    const logger = collectingLogger();
    // The simulated owner exits and its shutdown removes the marker shortly
    // after the claim starts waiting.
    const ownerReleases = setTimeout(() => { void rm(markerPath, { force: true }); }, 60);

    const ownership = await claimSessiondStateOwnership({
      env: env(),
      isAlive: () => true,
      graceMs: 2_000,
      pollIntervalMs: 20,
      logger,
    });
    clearTimeout(ownerReleases);

    expect((await readMarker()).pid).toBe(process.pid);
    expect(ownership.record.pid).toBe(process.pid);
    expect(logger.entries.filter((entry) => entry.message.includes("waiting briefly"))).toHaveLength(1);
  });

  it("fails loudly and actionably when a live owner persists past the grace window", async () => {
    const owner = await writeMarker({ pid: OTHER_LIVE_PID });

    const failure = await claimSessiondStateOwnership({
      env: env(),
      isAlive: () => true,
      graceMs: 250,
      pollIntervalMs: 20,
    }).then(
      () => { throw new Error("expected the claim to fail"); },
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(SessiondStateOwnershipConflictError);
    if (!(failure instanceof SessiondStateOwnershipConflictError)) throw new Error("expected an ownership conflict");
    expect(failure.owner).toEqual(owner);
    expect(failure.dataDir).toBe(dataDir);
    expect(failure.message).toContain(`pid ${String(OTHER_LIVE_PID)}`);
    expect(failure.message).toContain(owner.startedAt);
    expect(failure.message).toContain(dataDir);
    expect(failure.message).toContain("PI_WEB_DATA_DIR");
    expect(failure.message).toContain("PI_WEB_SESSIOND_SOCKET");
    expect(failure.message).toContain("PI_WEB_PORT");
    expect(failure.message).toContain("stale marker");
    // The live owner is untouched.
    expect((await readMarker()).pid).toBe(OTHER_LIVE_PID);
  });

  it("discards an unreadable marker only after the grace window", async () => {
    await writeFile(markerPath, "not json {{{", "utf8");
    const logger = collectingLogger();

    const ownership = await claimSessiondStateOwnership({ env: env(), graceMs: 200, pollIntervalMs: 20, logger });

    expect((await readMarker()).pid).toBe(ownership.record.pid);
    expect(logger.entries.some((entry) => entry.level === "warn" && entry.message.includes("unreadable"))).toBe(true);
  });

  it("does not release a marker another owner has taken over", async () => {
    const ownership = await claimSessiondStateOwnership({ env: env() });
    const takeover = await writeMarker({ pid: OTHER_LIVE_PID, startedAt: "2026-02-02T00:00:00.000Z" });

    await ownership.release();

    expect(await readMarker()).toEqual(takeover);
  });
});

describe("parseOwnershipRecord", () => {
  it("parses a record and tolerates unknown fields", () => {
    const parsed = parseOwnershipRecord(JSON.stringify({
      pid: 123,
      startedAt: "2026-01-01T00:00:00.000Z",
      processStartTime: "4567",
      endpoint: "/data/pi-web/sessiond.sock",
      futureField: { anything: true },
    }));

    expect(parsed).toEqual({
      pid: 123,
      startedAt: "2026-01-01T00:00:00.000Z",
      processStartTime: "4567",
      endpoint: "/data/pi-web/sessiond.sock",
    });
  });

  it("rejects content that is not a readable ownership record", () => {
    expect(parseOwnershipRecord("not json")).toBe("invalid");
    expect(parseOwnershipRecord('"just a string"')).toBe("invalid");
    expect(parseOwnershipRecord(JSON.stringify({ pid: "123", startedAt: "x", endpoint: "y" }))).toBe("invalid");
    expect(parseOwnershipRecord(JSON.stringify({ pid: 123, endpoint: "y" }))).toBe("invalid");
    expect(parseOwnershipRecord(JSON.stringify({ pid: 123, startedAt: "x", endpoint: "y", processStartTime: 42 }))).toBe("invalid");
  });
});

describe("isOwnershipRecordAlive", () => {
  it("reports a nonexistent pid as dead", () => {
    expect(isOwnershipRecordAlive({ pid: DEAD_PID })).toBe(false);
  });

  it("reports a running process without a recorded start time as alive", () => {
    expect(isOwnershipRecordAlive({ pid: process.pid })).toBe(true);
  });

  it.skipIf(process.platform !== "linux")("matches a recorded start time against the live process", () => {
    const processStartTime = readProcessStartTime(process.pid);
    if (processStartTime === undefined) throw new Error("expected a /proc start time on Linux");

    expect(isOwnershipRecordAlive({ pid: process.pid, processStartTime })).toBe(true);
    // A reused pid reports a different start time than the recorded owner.
    expect(isOwnershipRecordAlive({ pid: process.pid, processStartTime: "1" })).toBe(false);
  });
});

describe("readProcessStartTime", () => {
  it.skipIf(process.platform !== "linux")("reads the current process's start-time ticks on Linux", () => {
    expect(readProcessStartTime(process.pid)).toMatch(/^\d+$/);
  });

  it("returns undefined for a nonexistent pid", () => {
    expect(readProcessStartTime(DEAD_PID)).toBeUndefined();
  });
});
