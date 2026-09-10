import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionArchiveStore } from "../sessionArchiveStore.js";
import { OmpSessionService } from "./ompSessionService.js";
import {
  CapturingSessionEventHub,
  fakeRpcClientFactory,
  FakeOmpSessionStore,
  ompSessionId,
  TEST_AGENT_DIR,
  TEST_NATIVE_ID_A,
  TEST_NATIVE_ID_B,
} from "./ompSessionService.testSupport.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function archiveFixture(): Promise<{ cwd: string; archiveStore: SessionArchiveStore }> {
  const root = await mkdtemp(join(tmpdir(), "pi-web-omp-archive-validation-"));
  tempRoots.push(root);
  const cwd = resolve("/workspace");
  const metadataPath = join(root, "archived-sessions.json");
  const common = {
    archivedAt: "2020-01-01T00:00:00.000Z",
    originalPath: "/workspace/original.jsonl",
    archivePath: "/workspace/archive.jsonl",
    created: "2020-01-01T00:00:00.000Z",
    modified: "2020-01-01T00:00:00.000Z",
    messageCount: 1,
    firstMessage: "hello",
  };
  await writeFile(metadataPath, `${JSON.stringify({
    sessions: [
      { ...common, sessionId: ompSessionId(TEST_NATIVE_ID_A), cwd },
      { ...common, sessionId: "raw-pi-shaped-id", cwd },
      { ...common, sessionId: "omp:not-a-uuid", cwd },
      { ...common, sessionId: ompSessionId(TEST_NATIVE_ID_B), cwd: "" },
    ],
  })}\n`, "utf8");
  return { cwd, archiveStore: new SessionArchiveStore(metadataPath, join(root, "archive")) };
}

describe("OmpSessionService: hostile archive metadata ownership", () => {
  it("exposes only valid OMP archive records for the requested workspace", async () => {
    const { cwd, archiveStore } = await archiveFixture();
    const service = new OmpSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      createRpcClient: fakeRpcClientFactory(),
      store: new FakeOmpSessionStore(),
      archiveStore,
    });

    const sessions = await service.list(cwd);

    expect(sessions.map((session) => session.id)).toEqual([ompSessionId(TEST_NATIVE_ID_A)]);
    expect(sessions[0]).toMatchObject({ backend: "omp", cwd, archived: true });
  });

  it("never plans raw, malformed, or invalid-workspace archive records as OMP cleanup", async () => {
    const { archiveStore } = await archiveFixture();
    const service = new OmpSessionService(new CapturingSessionEventHub(), {
      agentDir: TEST_AGENT_DIR,
      createRpcClient: fakeRpcClientFactory(),
      store: new FakeOmpSessionStore(),
      archiveStore,
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });

    const preview = await service.cleanupPreview({ thresholds: { deleteArchivedDays: 30 } });

    expect(preview.totals).toEqual({ archiveCount: 0, deleteCount: 1 });
    expect(preview.projects).toEqual([
      { cwd: resolve("/workspace"), archiveCount: 0, deleteCount: 1 },
    ]);
  });
});
