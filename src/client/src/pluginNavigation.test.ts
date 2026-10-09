import { describe, expect, it } from "vitest";
import type { PluginNavigationDestination, PluginNavigationPatchDestination, PluginNavigationOptions } from "../../plugin-api";
import type { ContributionQueryRecord } from "./namespacedQueryArgs";
import { resolvePluginNavigation } from "./pluginNavigation";
import type { ParsedAppRoute } from "./route";

const current: ParsedAppRoute = {
  machineId: "url-machine",
  projectId: "project-1",
  workspaceId: "workspace-1",
  sessionId: "session-1",
  tool: "files:workspace.files",
  view: "workspace",
};
const currentQuery: ContributionQueryRecord = {
  "files.workspace.files--file": "old.ts",
  "files.workspace.files--mode": "preview",
  "files.workspace.files--tag": ["one", "two"],
  "terminal.workspace.terminal--terminal": "terminal-1",
};
const defaultMachineId = "selected-machine";

describe("resolvePluginNavigation", () => {
  it.each([
    undefined, {}, { mode: "replace" }, { history: "push" }, { history: "replace" },
    { mode: "replace", history: "push" }, { mode: "replace", history: "replace" },
  ] satisfies (PluginNavigationOptions | undefined)[])("uses a complete destination and selected-machine fallback with options %j", (options) => {
    expect(resolvePluginNavigation({}, options, current, currentQuery, defaultMachineId)).toEqual({
      route: {
        machineId: defaultMachineId,
        projectId: undefined,
        workspaceId: undefined,
        sessionId: undefined,
        tool: undefined,
        view: undefined,
      },
      contributionQuery: {},
    });
  });

  it("honors every explicit field in a complete destination", () => {
    const destination: PluginNavigationDestination = {
      machineId: "next-machine", projectId: "next-project", workspaceId: "next-workspace",
      sessionId: "next-session", tool: "terminal:workspace.terminal", view: "chat",
    };
    expect(resolvePluginNavigation(destination, undefined, current, currentQuery, defaultMachineId)).toEqual({
      route: destination, contributionQuery: {},
    });
  });

  it("normalizes empty replacement fields and resets an empty machine to local", () => {
    const plan: unknown = Reflect.apply(resolvePluginNavigation, undefined, [
      { machineId: "", projectId: "", workspaceId: "", sessionId: "", tool: "" },
      undefined, current, currentQuery, defaultMachineId,
    ]);
    expect(plan).toEqual({
      route: { machineId: "local", projectId: undefined, workspaceId: undefined, sessionId: undefined, tool: undefined, view: undefined },
      contributionQuery: {},
    });
  });

  it("starts replacement query state empty even when the explicit scope matches the URL", () => {
    const destination: PluginNavigationDestination = {
      machineId: "url-machine", projectId: "project-1", workspaceId: "workspace-1",
      tool: "files:workspace.files", query: { file: "next.ts" },
    };
    expect(resolvePluginNavigation(destination, undefined, current, currentQuery, defaultMachineId)).toEqual({
      route: { ...current, sessionId: undefined, view: undefined },
      contributionQuery: { "files.workspace.files--file": "next.ts" },
    });
  });

  it.each([
    { mode: "patch" }, { mode: "patch", history: "push" }, { mode: "patch", history: "replace" },
  ] satisfies PluginNavigationOptions[])("patches the raw URL rather than selected-machine state with options %j", (options) => {
    expect(resolvePluginNavigation({}, options, current, currentQuery, defaultMachineId)).toEqual({
      route: current, contributionQuery: currentQuery,
    });
  });

  it.each([
    { mode: "replace", capturedMachineId: "captured-machine", expectedMachineId: "captured-machine" },
    { mode: "patch", capturedMachineId: "captured-machine", expectedMachineId: "captured-machine" },
    { mode: "patch", capturedMachineId: "url-machine", expectedMachineId: "url-machine" },
  ] satisfies { mode: "replace" | "patch"; capturedMachineId: string; expectedMachineId: string }[])("defaults an omitted machine to the captured context in $mode mode ($capturedMachineId)", ({ mode, capturedMachineId, expectedMachineId }) => {
    const plan = resolvePluginNavigation({}, { mode }, current, currentQuery, defaultMachineId, undefined, capturedMachineId);
    const preservesScope = mode === "patch" && capturedMachineId === current.machineId;
    expect(plan).toEqual({
      route: preservesScope ? current : {
        machineId: expectedMachineId, projectId: undefined, workspaceId: undefined,
        sessionId: undefined, tool: undefined, view: mode === "patch" ? current.view : undefined,
      },
      contributionQuery: preservesScope ? currentQuery : {},
    });
  });

  it.each([
    { mode: "replace", machineId: "explicit-machine", expectedMachineId: "explicit-machine" },
    { mode: "patch", machineId: "explicit-machine", expectedMachineId: "explicit-machine" },
    { mode: "patch", machineId: null, expectedMachineId: "local" },
    { mode: "patch", machineId: "", expectedMachineId: "local" },
  ] satisfies { mode: "replace" | "patch"; machineId: string | null; expectedMachineId: string }[])("honors explicit machine $machineId over the captured context in $mode mode", ({ mode, machineId, expectedMachineId }) => {
    expect(resolvePluginNavigation({ machineId }, { mode }, current, currentQuery, defaultMachineId, undefined, "captured-machine")).toEqual({
      route: {
        machineId: expectedMachineId, projectId: undefined, workspaceId: undefined,
        sessionId: undefined, tool: undefined, view: mode === "patch" ? current.view : undefined,
      },
      contributionQuery: {},
    });
  });

  it.each([{}, { machineId: "local" }, { machineId: null }] satisfies PluginNavigationPatchDestination[])("treats an omitted current machine as local without changing scope: %j", (destination) => {
    expect(resolvePluginNavigation(destination, { mode: "patch" }, { ...current, machineId: undefined }, currentQuery, defaultMachineId)).toEqual({
      route: { ...current, machineId: "local" }, contributionQuery: currentQuery,
    });
  });

  it.each([
    {
      destination: { machineId: "next-machine" },
      changes: { machineId: "next-machine", projectId: undefined, workspaceId: undefined, sessionId: undefined, tool: undefined },
    },
    {
      destination: { projectId: "next-project" },
      changes: { projectId: "next-project", workspaceId: undefined, sessionId: undefined },
    },
    { destination: { workspaceId: "next-workspace" }, changes: { workspaceId: "next-workspace", sessionId: undefined } },
    {
      destination: { machineId: "next-machine", projectId: "project-1", workspaceId: "workspace-1" },
      changes: { machineId: "next-machine", sessionId: undefined, tool: undefined },
    },
    {
      destination: { projectId: "next-project", workspaceId: "workspace-1" },
      changes: { projectId: "next-project", sessionId: undefined },
    },
  ])("invalidates inherited descendants and all query namespaces on scope change: $destination", ({ destination, changes }) => {
    expect(resolvePluginNavigation(destination, { mode: "patch" }, current, currentQuery, defaultMachineId)).toEqual({
      route: { ...current, ...changes }, contributionQuery: {},
    });
  });

  it("lets explicit children win after a parent change, retains view, and applies only fresh query state", () => {
    const destination: PluginNavigationDestination = {
      machineId: "next-machine", projectId: "project-1", workspaceId: "workspace-1",
      sessionId: "session-1", tool: "files:workspace.files", query: { file: "next.ts" },
    };
    expect(resolvePluginNavigation(destination, { mode: "patch" }, current, currentQuery, defaultMachineId)).toEqual({
      route: { ...current, machineId: "next-machine" },
      contributionQuery: { "files.workspace.files--file": "next.ts" },
    });
  });

  it.each([
    { field: "machineId", values: [null, ""], changes: { machineId: "local", projectId: undefined, workspaceId: undefined, sessionId: undefined, tool: undefined }, clearsQuery: true },
    { field: "projectId", values: [null, ""], changes: { projectId: undefined, workspaceId: undefined, sessionId: undefined }, clearsQuery: true },
    { field: "workspaceId", values: [null, ""], changes: { workspaceId: undefined, sessionId: undefined }, clearsQuery: true },
    { field: "sessionId", values: [null, ""], changes: { sessionId: undefined }, clearsQuery: false },
    { field: "tool", values: [null, ""], changes: { tool: undefined }, clearsQuery: false },
    { field: "view", values: [null], changes: { view: undefined }, clearsQuery: false },
  ])("clears patch $field using null or supported empty strings", ({ field, values, changes, clearsQuery }) => {
    for (const value of values) {
      // Empty tool strings are runtime input outside the qualified public type.
      const plan: unknown = Reflect.apply(resolvePluginNavigation, undefined, [
        { [field]: value }, { mode: "patch" }, current, currentQuery, defaultMachineId,
      ]);
      expect(plan).toEqual({ route: { ...current, ...changes }, contributionQuery: clearsQuery ? {} : currentQuery });
    }
  });

  it.each([
    { sessionId: "next-session" }, { tool: "terminal:workspace.terminal" },
    { view: "navigation" }, { view: "chat" }, { view: "workspace" },
  ] satisfies PluginNavigationDestination[])("retains scope query state for a non-scope patch: %j", (destination) => {
    expect(resolvePluginNavigation(destination, { mode: "patch" }, current, currentQuery, defaultMachineId)).toEqual({
      route: { ...current, ...destination }, contributionQuery: currentQuery,
    });
  });

  it("merges local query keys using inherited scope, removes null keys, and preserves other tool state", () => {
    const destination: PluginNavigationPatchDestination = {
      query: { file: "next.ts", mode: null, line: 7, enabled: false, tag: ["next", 2, true] },
    };
    expect(resolvePluginNavigation(destination, { mode: "patch" }, current, currentQuery, defaultMachineId)).toEqual({
      route: current,
      contributionQuery: {
        "files.workspace.files--file": "next.ts",
        "files.workspace.files--line": "7",
        "files.workspace.files--enabled": "false",
        "files.workspace.files--tag": ["next", "2", "true"],
        "terminal.workspace.terminal--terminal": "terminal-1",
      },
    });
  });

  it("uses the explicit effective tool for query patches without clearing other namespaces", () => {
    expect(resolvePluginNavigation({
      tool: "terminal:workspace.terminal", query: { terminal: "terminal-2" },
    }, { mode: "patch" }, current, currentQuery, defaultMachineId)).toEqual({
      route: { ...current, tool: "terminal:workspace.terminal" },
      contributionQuery: { ...currentQuery, "terminal.workspace.terminal--terminal": "terminal-2" },
    });
  });

  it.each(["files", "core:workspace.files", "bad tool", "unavailable:workspace.panel"])("preserves omitted raw tool %j and invalid view without destination normalization", (tool) => {
    const rawCurrent = { ...current, tool, view: "legacy-view" };
    expect(resolvePluginNavigation({ sessionId: "next-session" }, { mode: "patch" }, rawCurrent, currentQuery, defaultMachineId)).toEqual({
      route: { ...rawCurrent, sessionId: "next-session" }, contributionQuery: currentQuery,
    });
  });

  it("returns detached data without mutating any inputs or needing browser globals", () => {
    const tags = ["one", "two"];
    Object.freeze(tags);
    const frozenRoute = Object.freeze({ ...current });
    const frozenQuery = Object.freeze({ ...currentQuery, "files.workspace.files--tag": tags });
    const destination = Object.freeze({ query: Object.freeze({ file: "next.ts" }) });
    const options = Object.freeze({ mode: "patch" } satisfies PluginNavigationOptions);
    const plan = resolvePluginNavigation(destination, options, frozenRoute, frozenQuery, defaultMachineId);

    expect(plan.route).toEqual(current);
    expect(plan.route).not.toBe(frozenRoute);
    expect(plan.contributionQuery).toEqual({ ...frozenQuery, "files.workspace.files--file": "next.ts" });
    expect(plan.contributionQuery).not.toBe(frozenQuery);
    expect(plan.contributionQuery["files.workspace.files--tag"]).not.toBe(tags);
  });

  it.each([
    { destination: undefined, options: undefined }, { destination: null, options: undefined },
    { destination: [], options: undefined }, { destination: "files", options: undefined },
    { destination: 42, options: undefined }, { destination: false, options: undefined },
    { destination: {}, options: null }, { destination: {}, options: [] }, { destination: {}, options: "patch" },
    { destination: {}, options: 42 }, { destination: {}, options: false },
    { destination: {}, options: { mode: "merge" } }, { destination: {}, options: { mode: null } },
    { destination: {}, options: { mode: 1 } }, { destination: {}, options: { history: "pop" } },
    { destination: {}, options: { history: null } }, { destination: {}, options: { history: false } },
  ])("rejects malformed destination or options with TypeError: %j", ({ destination, options }) => {
    for (const capturedMachineId of [undefined, "captured-machine"]) {
      expect(() => {
        Reflect.apply(resolvePluginNavigation, undefined, [destination, options, current, currentQuery, defaultMachineId, undefined, capturedMachineId]);
      }).toThrow(TypeError);
    }
  });

  it.each(["machineId", "projectId", "workspaceId", "sessionId", "tool", "view"])("rejects non-string %s and replace-mode null fields", (field) => {
    for (const value of [42, false, {}, []]) {
      expect(() => {
        Reflect.apply(resolvePluginNavigation, undefined, [{ [field]: value }, { mode: "patch" }, current, currentQuery, defaultMachineId]);
      }).toThrow(TypeError);
    }
    expect(() => {
      Reflect.apply(resolvePluginNavigation, undefined, [{ [field]: null }, undefined, current, currentQuery, defaultMachineId]);
    }).toThrow(TypeError);
  });

  it.each(["", "files", "Chat"])("rejects invalid explicit view %j rather than accepting raw URL values", (view) => {
    expect(() => {
      Reflect.apply(resolvePluginNavigation, undefined, [{ view }, { mode: "patch" }, current, currentQuery, defaultMachineId]);
    }).toThrow(TypeError);
  });

  it.each([
    { query: null }, { query: [] }, { query: "file" },
    { query: { "Bad Key": "next.ts" } }, { query: { "files:workspace.files--file": "next.ts" } },
    { query: { file: {} } }, { query: { file: ["ok", null] } }, { query: { file: [{}] } },
  ])("rejects malformed query objects, local keys, or values with TypeError: %j", ({ query }) => {
    expect(() => {
      Reflect.apply(resolvePluginNavigation, undefined, [
        { tool: "files:workspace.files", projectId: "project-1", workspaceId: "workspace-1", query },
        undefined, current, currentQuery, defaultMachineId,
      ]);
    }).toThrow(TypeError);
  });

  it.each([
    { query: { file: "next.ts" } },
    { tool: "files:workspace.files", projectId: "project-1", query: { file: "next.ts" } },
    { tool: "files:workspace.files", workspaceId: "workspace-1", query: { file: "next.ts" } },
    { projectId: "project-1", workspaceId: "workspace-1", query: { file: "next.ts" } },
  ] satisfies PluginNavigationDestination[])("requires explicit query scope in replace mode: %j", (destination) => {
    expect(() => resolvePluginNavigation(destination, undefined, current, currentQuery, defaultMachineId)).toThrow(TypeError);
  });

  it.each([
    { machineId: "next-machine", query: { file: "next.ts" } },
    { projectId: "next-project", query: { file: "next.ts" } },
    { workspaceId: null, query: { file: "next.ts" } },
    { tool: null, query: { file: "next.ts" } },
  ] satisfies PluginNavigationPatchDestination[])("rejects query patches whose effective scope is cleared: %j", (destination) => {
    expect(() => resolvePluginNavigation(destination, { mode: "patch" }, current, currentQuery, defaultMachineId)).toThrow(TypeError);
  });

  it.each(["files", "bad tool"])("rejects query patches for unqualified inherited tool %j", (tool) => {
    expect(() => resolvePluginNavigation({ query: { file: "next.ts" } }, { mode: "patch" }, { ...current, tool }, currentQuery, defaultMachineId)).toThrow(TypeError);
  });
});
