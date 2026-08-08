import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPiSessionManagerGateway } from "./piSessionManagerGateway.js";
import { PiSessionService } from "./piSessionService.js";
import { CapturingSessionEventHub, createTestModelRuntime } from "./piSessionService.testSupport.js";

/**
 * Acceptance coverage for `respectProjectTrust`: opening a workspace that ships
 * a project-local `.pi/` extension must honor pi's project-trust settings only
 * when the operator opts in, and otherwise stay backward compatible (loading it
 * unconditionally). The observable is whether the project extension's command
 * reaches the session — a `.pi/extensions/` directory is trust-requiring, so an
 * untrusted project drops it.
 */

const tempDirs: string[] = [];
const services: PiSessionService[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(services.splice(0).map((service) => service.dispose()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** An agent dir, optionally pinning `defaultProjectTrust` in its settings.json. */
async function agentDir(defaultProjectTrust?: "always" | "never" | "ask"): Promise<string> {
  const dir = await tempDir("pi-web-trust-agent-");
  if (defaultProjectTrust !== undefined) {
    await writeFile(join(dir, "settings.json"), `${JSON.stringify({ defaultProjectTrust })}\n`);
  }
  return dir;
}

/** A workspace whose `.pi/extensions/` registers an observable command. */
async function projectWithCommandExtension(): Promise<string> {
  const cwd = await tempDir("pi-web-trust-project-");
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(join(cwd, ".pi", "extensions", "probe.js"), `
    export default function (pi) {
      pi.registerCommand("project-probe", {
        description: "project trust acceptance probe",
        async handler() {}
      });
    }
  `);
  return cwd;
}

/** Start a session for a fresh trust-requiring project and list its command names. */
async function projectCommandNames(options: { agentDir: string; respectProjectTrust: boolean }): Promise<string[]> {
  // Isolate Pi's per-user resource discovery (~/.agents/skills et al.) so only
  // the explicit agent/project dirs contribute resources.
  vi.stubEnv("HOME", await tempDir("pi-web-trust-home-"));
  const runtime = await createTestModelRuntime();
  const service = new PiSessionService(new CapturingSessionEventHub(), {
    agentDir: options.agentDir,
    modelRuntime: runtime,
    sessionManager: createPiSessionManagerGateway({ agentDir: options.agentDir, env: {}, sessionDirEnvKeys: [] }),
    heartbeatIntervalMs: 60_000,
    respectProjectTrust: options.respectProjectTrust,
  });
  services.push(service);
  const cwd = await projectWithCommandExtension();
  const session = await service.start(cwd);
  const commands = await service.commands({ id: session.id, cwd });
  return commands.map((command) => command.name);
}

describe("project trust acceptance", () => {
  it("loads a project extension by default even when defaultProjectTrust is never (backward compatible)", async () => {
    const commands = await projectCommandNames({ agentDir: await agentDir("never"), respectProjectTrust: false });
    expect(commands).toContain("project-probe");
  });

  it("drops a project extension when respectProjectTrust is on and defaultProjectTrust is never", async () => {
    const commands = await projectCommandNames({ agentDir: await agentDir("never"), respectProjectTrust: true });
    expect(commands).not.toContain("project-probe");
  });

  it("drops a project extension when respectProjectTrust is on and trust is left to ask (no browser prompt)", async () => {
    const commands = await projectCommandNames({ agentDir: await agentDir("ask"), respectProjectTrust: true });
    expect(commands).not.toContain("project-probe");
  });

  it("loads a project extension when respectProjectTrust is on and defaultProjectTrust is always", async () => {
    const commands = await projectCommandNames({ agentDir: await agentDir("always"), respectProjectTrust: true });
    expect(commands).toContain("project-probe");
  });
});
