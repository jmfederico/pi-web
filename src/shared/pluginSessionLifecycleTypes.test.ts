import { describe, expect, it, vi } from "vitest";
import { PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY, PI_WEB_HOST_SESSION_LIFECYCLE_V2_CAPABILITY, type PluginSessionLifecycleOptions } from "./pluginSessionLifecycleTypes.js";
import type { PluginSessionSelection } from "./pluginCatalogTypes.js";

const selection: PluginSessionSelection = { projectId: "project", workspaceId: "workspace", sessionId: "exact-session" };
function provider() {
  const command = () => vi.fn<(selection: PluginSessionSelection, options?: PluginSessionLifecycleOptions) => Promise<void>>(() => Promise.resolve());
  return {
    version: 1,
    get: vi.fn(() => Promise.resolve({ sessionId: selection.sessionId, pinned: true, archived: false, privatePath: "/private/session.jsonl" })),
    pin: command(),
    unpin: command(),
    archive: command(),
    restore: command(),
    delete: command(),
  };
}

describe("public session lifecycle capability", () => {
  it("snapshots public state and forwards exact selections and cancellation to every command", async () => {
    const source = provider();
    const lifecycle = PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY.parse(source);
    const controller = new AbortController();
    const options = { signal: controller.signal };
    const state = await lifecycle.get(selection, options);
    expect(state).toEqual({ sessionId: selection.sessionId, pinned: true, archived: false });
    expect(Object.isFrozen(state)).toBe(true);
    for (const command of ["pin", "unpin", "archive", "restore", "delete"] as const) {
      await lifecycle[command](selection, options);
      expect(source[command]).toHaveBeenCalledExactlyOnceWith(selection, options);
      expect(source[command].mock.calls[0]?.[0]).not.toBe(selection);
    }
  });

  it("keeps v1 parseable without runtime commands and requires exact versions and all v2 commands", () => {
    const legacy = provider();
    const modern = { ...legacy, version: 2, abort: vi.fn(), close: vi.fn() };
    for (const command of ["abort", "close"] as const) {
      expect(PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY.parse(legacy)).not.toHaveProperty(command);
      expect(PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY.parse({ ...modern, version: 1 })).not.toHaveProperty(command);
    }
    expect(() => PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY.parse({ ...legacy, version: 2 })).toThrow("Invalid");
    expect(() => PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY.parse({ ...legacy, delete: undefined })).toThrow("Invalid");
    expect(() => PI_WEB_HOST_SESSION_LIFECYCLE_V2_CAPABILITY.parse({ ...modern, version: 1 })).toThrow("Invalid");
    expect(() => PI_WEB_HOST_SESSION_LIFECYCLE_V2_CAPABILITY.parse({ ...modern, version: 3 })).toThrow("Invalid");
    for (const command of ["abort", "close", "delete"] as const) {
      expect(() => PI_WEB_HOST_SESSION_LIFECYCLE_V2_CAPABILITY.parse({ ...modern, [command]: undefined })).toThrow("Invalid");
    }
  });

  it.each(["abort", "close"] as const)("snapshots and binds v2 %s through repeated parsing without leaking native results", async (command) => {
    const native = vi.fn(function (this: object, target: PluginSessionSelection, options?: PluginSessionLifecycleOptions) {
      return Promise.resolve({ owner: this, target, options });
    });
    const source = { ...provider(), version: 2, abort: native, close: native };
    const lifecycle = PI_WEB_HOST_SESSION_LIFECYCLE_V2_CAPABILITY.parse(PI_WEB_HOST_SESSION_LIFECYCLE_V2_CAPABILITY.parse(source));
    source[command] = vi.fn(() => { throw new Error("replaced"); });
    const requested = { ...selection };
    const options = { signal: new AbortController().signal };
    const pending = lifecycle[command](requested, options);
    requested.sessionId = "replacement";
    await expect(pending).resolves.toBeUndefined();
    expect(native).toHaveBeenCalledExactlyOnceWith(selection, options);
    expect(native.mock.contexts[0]).toBe(source);
    expect(native.mock.calls[0]?.[0]).not.toBe(requested);
    expect(Object.isFrozen(native.mock.calls[0]?.[0])).toBe(true);
    expect(Object.isFrozen(lifecycle)).toBe(true);
    await expect(lifecycle.get(selection)).resolves.toEqual({ sessionId: selection.sessionId, pinned: true, archived: false });
  });

  it.each([
    { ...selection, cwd: "/outside" },
    { ...selection, projectId: "" },
    { ...selection, workspaceId: " " },
    { ...selection, sessionId: "x".repeat(513) },
  ])("rejects malformed runtime command selection before invoking the provider (%j)", async (target) => {
    const native = vi.fn(() => Promise.resolve());
    const lifecycle = PI_WEB_HOST_SESSION_LIFECYCLE_V2_CAPABILITY.parse({ ...provider(), version: 2, abort: native, close: native });
    for (const command of ["abort", "close"] as const) {
      await expect(lifecycle[command](target)).rejects.toThrow("Invalid");
    }
    expect(native).not.toHaveBeenCalled();
  });

  it("rejects path authority, invalid IDs, and mismatched state without mutating", async () => {
    const source = provider();
    const lifecycle = PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY.parse(source);
    const pathSelection = { ...selection, cwd: "/elsewhere" };
    await expect(lifecycle.pin(pathSelection)).rejects.toThrow("Invalid");
    await expect(lifecycle.delete({ ...selection, sessionId: "" })).rejects.toThrow("Invalid");
    expect(source.pin).not.toHaveBeenCalled();
    expect(source.delete).not.toHaveBeenCalled();
    source.get.mockResolvedValue({ sessionId: "other", pinned: true, archived: false, privatePath: "" });
    await expect(lifecycle.get(selection)).rejects.toThrow("Invalid");
  });

  it("does not retarget a command when its caller changes the selection during admission", async () => {
    const source = provider();
    const lifecycle = PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY.parse(source);
    const requested = { ...selection };
    const work = lifecycle.archive(requested);
    requested.sessionId = "replacement";
    await work;
    expect(source.archive).toHaveBeenCalledWith(selection, undefined);
  });
});
