import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppAction } from "../actions";
import { initialAppState } from "../appState";
import { PiWebApp } from "./PiWebApp";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PiWebApp secure input entry points", () => {
  it("adds the configured local-only action and opens the isolated dialog", () => {
    const app = createApp();
    setProperty(app, "secureInputStatus", { enabled: true, label: "Secret", maxBytes: 1024 });

    const action = secureInputActions(app)[0];
    expect(action).toMatchObject({ id: "app.secure-input", title: "Secret" });

    if (action === undefined) throw new Error("Expected secure input action");
    void Promise.resolve(action.run());
    expect(getProperty(app, "secureInputDialogOpen")).toBe(true);
    expect(callStringMethod(app, "secureInputLabelForSelectedMachine")).toBe("Secret");
  });

  it("does not expose secure input while a remote machine is selected", () => {
    const app = createApp();
    setProperty(app, "secureInputStatus", { enabled: true, label: "Secret", maxBytes: 1024 });
    setProperty(app, "state", {
      ...initialAppState(),
      selectedMachine: { id: "remote-a", name: "Remote", kind: "remote", baseUrl: "https://remote.example.test", createdAt: "now", updatedAt: "now" },
    });

    expect(secureInputActions(app)).toEqual([]);
    expect(callStringMethod(app, "secureInputLabelForSelectedMachine")).toBeUndefined();
  });
});

function createApp(): PiWebApp {
  const storage = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
  vi.stubGlobal("window", { location: { search: "" }, localStorage: storage });
  return new PiWebApp();
}

function secureInputActions(app: PiWebApp): AppAction[] {
  const result = callMethod(app, "secureInputActions");
  if (!Array.isArray(result) || !result.every(isAppAction)) throw new Error("Expected secure input actions");
  return result;
}

function callStringMethod(target: object, name: string): string | undefined {
  const result = callMethod(target, name);
  if (result !== undefined && typeof result !== "string") throw new Error(`Expected optional string from ${name}`);
  return result;
}

function callMethod(target: object, name: string): unknown {
  const method: unknown = Reflect.get(target, name);
  if (typeof method !== "function") throw new Error(`Expected method ${name}`);
  return Reflect.apply(method, target, []);
}

function isAppAction(value: unknown): value is AppAction {
  return typeof value === "object" && value !== null && typeof Reflect.get(value, "id") === "string" && typeof Reflect.get(value, "run") === "function";
}

function setProperty(target: object, name: string, value: unknown): void {
  if (!Reflect.set(target, name, value)) throw new Error(`Could not set ${name}`);
}

function getProperty(target: object, name: string): unknown {
  return Reflect.get(target, name);
}
