import { spawnSync } from "node:child_process";
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import gitPlugin from "../../../pi-web-plugins/git/server-plugin.js";
import type { Project, WorkspaceChangedEvent } from "../../shared/apiTypes.js";
import { ProjectPluginSettingsSnapshots } from "../plugins/projectPluginSettings.js";
import { createServerPluginExecFile } from "../plugins/serverPluginExec.js";
import { createServerPluginRuntime } from "../plugins/serverPluginRuntime.js";
import { WorkspaceProviderRegistry } from "../workspaces/workspaceProviderRegistry.js";
import { WorkspaceChangeNotifier } from "../workspaces/workspaceChangeNotifier.js";
import { createWorkspaceNotificationCommandFactory } from "../workspaces/workspaceNotificationCommand.js";
import { registerWorkspaceNotificationRoutes } from "./workspaceNotificationRoutes.js";

const run = promisify(execFile);
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
const namedHooks = spawnSync("git", ["-c", "hook.pi-web-test.command=:", "-c", "hook.pi-web-test.event=post-checkout", "hook", "list", "post-checkout"], { env: gitEnv, encoding: "utf8" });

// Real Git hook -> packaged helper -> separate CLI process -> isolated IPC
// ingress -> provider policy/authority -> core notification. No model or hosting
// daemon is started, stopped, or shared with this fixture.
it.skipIf(process.platform === "win32" || namedHooks.status !== 0 || !namedHooks.stdout.includes("pi-web-test"))(
  "discovers an agent-created worktree through the provider-owned integration and core notification pipeline",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pi-web-discovery-ipc-"));
    const repository = join(root, "repo");
    const socket = join(root, "sessiond.sock");
    const env = { ...gitEnv, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    const app = Fastify();
    let registry: WorkspaceProviderRegistry | undefined;
    let runtime: Awaited<ReturnType<typeof createServerPluginRuntime>> | undefined;
    try {
      await run("git", ["init", "-q", "-b", "main", repository], { env });
      await run("git", ["-C", repository, "-c", "user.name=Discovery", "-c", "user.email=discovery@example.invalid", "commit", "-q", "--allow-empty", "-m", "Initial"], { env });
      await copyFile(new URL("../../../pi-web-plugins/git/workspace-discovery-notify.cjs", import.meta.url), join(repository, "workspace-discovery-notify.cjs"));
      await mkdir(join(repository, ".pi-web"));
      // Proves actual project settings override the immutable global base.
      await writeFile(join(repository, ".pi-web", "config.json"), JSON.stringify({ plugins: { git: { settings: { workspaceDiscoveryHooks: true } } } }));
      const project: Project = { id: "project with spaces", name: "Repo", path: repository, createdAt: "2026-10-10T00:00:00.000Z" };
      const projects = { requireProject: (id: string) => id === project.id ? Promise.resolve(project) : Promise.reject(new Error("Project not found")) };
      const settings = new ProjectPluginSettingsSnapshots(projects);
      await settings.initialize([project]);
      const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      runtime = await createServerPluginRuntime({
        dataDir: join(root, "data"), enforceRequiredTerminal: false, logger,
        catalog: { snapshot: () => Promise.resolve({ diagnostics: [], plugins: [{
          id: "git", packageRoot: repository, source: "fixture", scope: "bundled", machineSpecific: true,
          enabled: true, settings: { workspaceDiscoveryHooks: false }, settingsRevision: "fixture",
          serverModule: { path: "server-plugin.js", filePath: join(repository, "server-plugin.js"), revision: "fixture" },
        }] }) },
        importer: () => Promise.resolve({ default: gitPlugin }),
        execFile: createServerPluginExecFile({ env }),
        projectSettingsResolver: (pluginId, base, scope, signal) => settings.resolve(pluginId, base, scope, signal),
        workspaceNotificationsFactory: createWorkspaceNotificationCommandFactory({ env: { ...env, PI_WEB_DATA_DIR: join(root, "data"), PI_WEB_SESSIOND_SOCKET: socket, PI_WEB_SESSIOND_PORT: "" } }),
      });
      registry = new WorkspaceProviderRegistry({ contributions: runtime.providerContributions(), logger });
      const publish = vi.fn<(event: WorkspaceChangedEvent) => void>();
      const invalidate = vi.fn();
      const notifyChanged = vi.fn();
      const changes = new WorkspaceChangeNotifier({ attribution: { invalidate }, status: { notifyChanged }, publish });
      registerWorkspaceNotificationRoutes(app, { projects, workspaces: registry, changes });
      await app.listen({ path: socket });
      await registry.reconcileProject(project);
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
        { pluginId: "git", apiVersion: 3 },
        "Server plugin API v3 is deprecated; migrate to API v5",
      );

      const feature = join(root, "feature with spaces");
      await run("git", ["-C", repository, "worktree", "add", "-q", "-b", "feature", feature], { env });

      expect(publish).toHaveBeenCalledExactlyOnceWith({ type: "workspaces.changed", projectId: project.id });
      expect(invalidate).toHaveBeenCalledOnce();
      expect(notifyChanged).toHaveBeenCalledOnce();
      expect((await registry.list(project)).map((workspace) => workspace.path)).toContain(feature);
    } finally {
      await app.close();
      await registry?.closeAll();
      await runtime?.stop();
      await rm(root, { recursive: true, force: true });
    }
  },
  15_000,
);
