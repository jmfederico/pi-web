import { describe, expect, it } from "vitest";
import type { SessionLocation } from "../../shared/apiTypes";
import { isSessionOnlyRoute, resolveSessionLink, sessionLinkMachineOrder, type SessionLocator } from "./sessionLinkResolution";

const route = { machineId: undefined, projectId: undefined, workspaceId: undefined, sessionId: "s1", tool: undefined, view: undefined };

function locator(answers: Record<string, SessionLocation | "unreachable" | "pending" | undefined>, aborted: string[] = []): SessionLocator {
  return (_sessionId, machineId, signal) => {
    const answer = answers[machineId];
    if (answer === "unreachable") return Promise.reject(new Error("offline"));
    if (answer === "pending") {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => { aborted.push(machineId); reject(new Error("aborted")); });
      });
    }
    return Promise.resolve(answer);
  };
}

const inWorkspace = (projectId: string): SessionLocation => ({ sessionId: "s1", projectId, workspaceId: "w1" });

describe("session-only links", () => {
  it("applies only to links that name a session without its workspace", () => {
    expect(isSessionOnlyRoute(route)).toBe(true);
    expect(isSessionOnlyRoute({ ...route, machineId: "remote" })).toBe(true);
    expect(isSessionOnlyRoute({ ...route, projectId: "p1" })).toBe(false);
    expect(isSessionOnlyRoute({ ...route, sessionId: "creating:abc" })).toBe(false);
    expect(isSessionOnlyRoute({ ...route, sessionId: undefined })).toBe(false);
  });

  it("asks this machine first, then remote machines, or only the machine the link names", () => {
    const machines = [{ id: "remote-a", kind: "remote" as const }, { id: "local", kind: "local" as const }, { id: "remote-b", kind: "remote" as const }];
    expect(sessionLinkMachineOrder(machines, undefined)).toEqual(["local", "remote-a", "remote-b"]);
    expect(sessionLinkMachineOrder(machines, "remote-b")).toEqual(["remote-b"]);
  });

  it("prefers the earliest machine and stops waiting on later ones", async () => {
    const aborted: string[] = [];
    const resolution = await resolveSessionLink("s1", ["local", "slow"], locator({ local: inWorkspace("p-local"), slow: "pending" }, aborted));

    expect(resolution).toEqual({ kind: "workspace", machineId: "local", projectId: "p-local", workspaceId: "w1" });
    expect(aborted).toEqual(["slow"]);
  });

  it("opens the session from a later machine when earlier ones do not know it", async () => {
    const resolution = await resolveSessionLink("s1", ["local", "remote"], locator({ local: undefined, remote: inWorkspace("p-remote") }));

    expect(resolution).toEqual({ kind: "workspace", machineId: "remote", projectId: "p-remote", workspaceId: "w1" });
  });

  it("reports machines that could not be asked when the session is not found", async () => {
    const resolution = await resolveSessionLink("s1", ["local", "remote"], locator({ local: undefined, remote: "unreachable" }));

    expect(resolution).toEqual({ kind: "not-found", uncheckedMachineIds: ["remote"] });
  });
});
