// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { initialAppState, type AppState } from "../appState";
import { SessionController } from "../controllers/sessionController";
import { isTemplateResult, templateValueAfterMarker } from "../templateInspection.testSupport";
import { PiWebApp } from "./PiWebApp";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

type StartSessionHandler = (backend?: string) => Promise<void>;

describe("PiWebApp session-backend wiring", () => {
  it("threads a chosen backend from the navigation panel's start callback all the way to SessionController.startSession", async () => {
    const app = createApp();
    setAppState(app, { ...initialAppState(), selectedWorkspace: workspace() });
    const startSession = vi.spyOn(SessionController.prototype, "startSession").mockResolvedValue(undefined);

    const onStartSession = navigationPanelStartHandler(app);
    await onStartSession("omp");

    expect(startSession).toHaveBeenCalledExactlyOnceWith("omp");
  });

  it("disables OMP only when the selected machine's runtime authoritatively lacks the capability", () => {
    const selectedMachine = remoteMachine();
    const cases: { name: string; machineRuntimes: AppState["machineRuntimes"]; expected: boolean }[] = [
      { name: "runtime unknown", machineRuntimes: {}, expected: true },
      {
        name: "runtime offline",
        machineRuntimes: { [selectedMachine.id]: { machineId: selectedMachine.id, ok: false, checkedAt: "now", capabilities: [] } },
        expected: true,
      },
      {
        name: "authoritative runtime without OMP",
        machineRuntimes: { [selectedMachine.id]: { machineId: selectedMachine.id, ok: true, checkedAt: "now", capabilities: [] } },
        expected: false,
      },
      {
        name: "authoritative runtime with OMP",
        machineRuntimes: {
          [selectedMachine.id]: {
            machineId: selectedMachine.id,
            ok: true,
            checkedAt: "now",
            capabilities: ["sessions.backend.omp"],
          },
        },
        expected: true,
      },
    ];

    for (const scenario of cases) {
      const app = createApp();
      setAppState(app, {
        ...initialAppState(),
        machines: [selectedMachine],
        selectedMachine,
        selectedWorkspace: workspace(),
        machineRuntimes: scenario.machineRuntimes,
      });

      expect(navigationPanelProperty(app, ".ompBackendSelectable="), scenario.name).toBe(scenario.expected);
    }
  });
});

function createApp(): PiWebApp {
  const storage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  vi.stubGlobal("window", { location: { search: "" }, localStorage: storage });
  const app = new PiWebApp();
  // This test is not about focus/scroll behavior, but it reaches
  // `startSessionAndOpenChat`'s post-create `focusChatComposer()` call, which
  // awaits a real `requestAnimationFrame` that never fires for an element
  // that was never connected to the document. Mirrors the same stub
  // PiWebApp.tree.test.ts uses for the same production method.
  if (!Reflect.set(app, "focusChatComposer", () => Promise.resolve())) throw new Error("Could not replace prompt focus boundary");
  return app;
}

function setAppState(app: PiWebApp, state: AppState): void {
  if (!Reflect.set(app, "state", state)) throw new Error("Could not set PiWebApp state");
}

function workspace() {
  return { id: "w1", projectId: "p1", path: "/repo", label: "repo", isMain: true, effectiveConfig: {} };
}

function remoteMachine() {
  return {
    id: "remote-a",
    name: "Remote A",
    kind: "remote" as const,
    baseUrl: "http://remote-a.test",
    createdAt: "2026-06-04T00:00:00.000Z",
    updatedAt: "2026-06-04T00:00:00.000Z",
  };
}

function navigationPanelStartHandler(app: PiWebApp): StartSessionHandler {
  const method: unknown = Reflect.get(app, "renderNavigationPanel");
  if (typeof method !== "function") throw new Error("PiWebApp.renderNavigationPanel was unavailable");
  const rendered: unknown = Reflect.apply(method, app, []);
  if (!isTemplateResult(rendered)) throw new Error("Expected a rendered navigation panel");
  const handler = templateValueAfterMarker(rendered, ".onStartSession=");
  if (!isStartSessionHandler(handler)) throw new Error("Expected an onStartSession handler");
  return handler;
}

function navigationPanelProperty(app: PiWebApp, marker: string): unknown {
  const method: unknown = Reflect.get(app, "renderNavigationPanel");
  if (typeof method !== "function") throw new Error("PiWebApp.renderNavigationPanel was unavailable");
  const rendered: unknown = Reflect.apply(method, app, []);
  if (!isTemplateResult(rendered)) throw new Error("Expected a rendered navigation panel");
  return templateValueAfterMarker(rendered, marker);
}

function isStartSessionHandler(value: unknown): value is StartSessionHandler {
  return typeof value === "function";
}
