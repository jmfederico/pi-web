import { describe, expect, it, vi } from "vitest";
import type { PluginSessionLifecycle } from "../../../plugin-api";
import { PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY } from "../../../shared/pluginSessionLifecycleTypes";
import { HttpRequestError } from "../api/http";
import { createPluginSessionLifecycle, type PluginSessionLifecycleRequester } from "./sessionLifecycle";

const selection = { projectId: "p/a%", workspaceId: "w/b?", sessionId: "s/c#" };
const state = { sessionId: selection.sessionId, pinned: true, archived: false };
const base = "api/machines/remote%2Fa%25/plugin-sessions/projects/p%2Fa%25/workspaces/w%2Fb%3F/sessions/s%2Fc%23";

describe("machine-bound plugin session lifecycle", () => {
  it("encodes explicit targets once and sends every lifecycle method without selection or navigation", async () => {
    const requester = vi.fn<PluginSessionLifecycleRequester>(() => Promise.resolve({ ...state, privatePath: "/secret" }));
    const sessions = createPluginSessionLifecycle("remote/a%", undefined, requester);
    expect(await sessions.get(selection)).toEqual(state);
    if (sessions.abort === undefined) throw new Error("Expected browser abort support");
    for (const operation of ["pin", "unpin", "archive", "restore", "delete"] as const) {
      await expect(sessions[operation](selection)).resolves.toBeUndefined();
    }
    await expect(sessions.abort(selection)).resolves.toBeUndefined();
    if (sessions.close === undefined) throw new Error("Expected browser close support");
    await expect(sessions.close(selection)).resolves.toBeUndefined();
    expect(requester.mock.calls).toEqual([
      [base, { method: "GET", cache: "no-store" }],
      ...["pin", "unpin", "archive", "restore"].map((operation) => [`${base}/${operation}`, { method: "POST", cache: "no-store" }]),
      [base, { method: "DELETE", cache: "no-store" }],
      [`${base}/abort`, { method: "POST", cache: "no-store" }],
      [`${base}/close`, { method: "POST", cache: "no-store" }],
    ]);
    expect(sessions.version).toBe(1);
    expect(sessions.machineId).toBe("remote/a%");
    const legacy: PluginSessionLifecycle = { ...PI_WEB_HOST_SESSION_LIFECYCLE_CAPABILITY.parse(sessions), machineId: sessions.machineId };
    expect(legacy.abort).toBeUndefined();
    expect(legacy.close).toBeUndefined();
    expect(Object.isFrozen(sessions)).toBe(true);
  });

  it("rejects invalid scope before transport and does not substitute host authority", async () => {
    const requester = vi.fn<PluginSessionLifecycleRequester>(() => Promise.resolve({ ...state, sessionId: "other" }));
    const sessions = createPluginSessionLifecycle("remote/a%", undefined, requester);
    await expect(sessions.pin({ ...selection, workspaceId: "" })).rejects.toThrow();
    const pathAuthority = { ...selection, cwd: "/outside" };
    for (const operation of ["abort", "close"] as const) {
      const command = sessions[operation];
      if (command === undefined) throw new Error(`Expected browser ${operation} support`);
      await expect(command(pathAuthority)).rejects.toThrow();
    }
    expect(requester).not.toHaveBeenCalled();
    await expect(sessions.get(selection)).rejects.toThrow();
    expect(requester).toHaveBeenCalledExactlyOnceWith(base, { method: "GET", cache: "no-store" });
    expect(() => createPluginSessionLifecycle("")).toThrow();
  });

  it.each(["abort", "close"] as const)("combines caller cancellation with lifetime revocation for retained %s", async (operation) => {
    const lifetime = new AbortController();
    const caller = new AbortController();
    const requester = vi.fn<PluginSessionLifecycleRequester>(() => Promise.resolve(state));
    const sessions = createPluginSessionLifecycle("remote", lifetime.signal, requester);
    const retained = sessions[operation];
    if (retained === undefined) throw new Error(`Expected browser ${operation} support`);
    await retained(selection, { signal: caller.signal });
    const signal = requester.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);
    caller.abort();
    expect(signal?.aborted).toBe(true);
    await expect(retained(selection, { signal: caller.signal })).rejects.toThrow();
    await sessions.get(selection);
    const lifetimeOnly = requester.mock.calls[1]?.[1]?.signal;
    lifetime.abort();
    expect(lifetimeOnly?.aborted).toBe(true);
    await expect(retained(selection)).rejects.toThrow();
    expect(requester).toHaveBeenCalledTimes(2);
  });

  it.each(["restore", "abort", "close"] as const)("rejects late %s results after disposal even when the requester ignores cancellation", async (operation) => {
    const lifetime = new AbortController();
    let resolve!: (value: unknown) => void;
    const requester = vi.fn<PluginSessionLifecycleRequester>(() => new Promise((done) => { resolve = done; }));
    const sessions = createPluginSessionLifecycle("remote", lifetime.signal, requester);
    const command = sessions[operation];
    if (command === undefined) throw new Error(`Expected browser ${operation} support`);
    const pending = command(selection);
    lifetime.abort();
    resolve({ ok: true });
    await expect(pending).rejects.toThrow();
  });

  it.each(["abort", "close"] as const)("surfaces unsupported remote %s without retry or lifecycle fallback", async (operation) => {
    const error = new HttpRequestError("Endpoint unavailable", 404);
    const requester = vi.fn<PluginSessionLifecycleRequester>(() => Promise.reject(error));
    const sessions = createPluginSessionLifecycle("remote/a%", undefined, requester);
    const command = sessions[operation];
    if (command === undefined) throw new Error(`Expected browser ${operation} support`);
    await expect(command(selection)).rejects.toBe(error);
    expect(requester).toHaveBeenCalledExactlyOnceWith(`${base}/${operation}`, { method: "POST", cache: "no-store" });
  });

  it("preserves observable transport failures rather than reporting mutation success", async () => {
    const error = new HttpRequestError("Session has active work", 409);
    const requester = vi.fn<PluginSessionLifecycleRequester>(() => Promise.reject(error));
    const sessions = createPluginSessionLifecycle("remote", undefined, requester);
    await expect(sessions.delete(selection)).rejects.toBe(error);
    expect(requester).toHaveBeenCalledTimes(1);
  });
});
