// @vitest-environment happy-dom

import { html, render, svg } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginActivationContext, SessionLabelContext, SessionUiMetadata } from "@jmfederico/pi-web/plugin-api";
import plugin from "./pi-web-plugin";
import { RELAY_METADATA_NAMESPACE } from "./relayIdentity";

const runtimePluginId = "remote-1:relay-package";
const metadata: SessionUiMetadata = {
  [RELAY_METADATA_NAMESPACE]: { version: 1, packetPath: "custom packets/workflow & notes", relayName: "workflow & notes", leg: "R1-a" },
};

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("Relay session-row contribution", () => {
  it.each([false, true])("opens the exact packet on the row's machine/workspace even after renaming (archived: %s)", (archived) => {
    const contribution = sessionContribution();
    const context = rowContext(metadata, archived);
    context.session = { ...context.session, name: "Renamed conversation" };
    const host = document.createElement("div");
    document.body.append(host);
    // Host row event isolation is owned by SessionList.labels.test.ts; this
    // package test exercises its public contribution and real rendered control.
    render(html`${contribution.items(context).map((item) => item.render())}`, host);

    const indicator = host.querySelector<HTMLButtonElement>("button");
    expect(indicator?.textContent.trim()).toBe("relay");
    expect(indicator?.getAttribute("title")).toBe("custom packets/workflow & notes");
    expect(indicator?.getAttribute("aria-label")).toBe("Open Relay workflow & notes, leg R1-a");
    indicator?.click();

    expect(context.navigate).toHaveBeenCalledExactlyOnceWith({
      machineId: "remote-1", projectId: "project & 1", workspaceId: "worktree/1", view: "workspace",
      tool: `${runtimePluginId}:workspace.relays`, query: { relay: "custom packets/workflow & notes" },
    }, { mode: "patch" });
    expect(context.files.listFiles).not.toHaveBeenCalled();
    expect(context.files.readFile).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    {},
    { [RELAY_METADATA_NAMESPACE]: { version: 2, packetPath: ".pi-web/relays/workflow", relayName: "workflow", leg: "1" } },
    { [RELAY_METADATA_NAMESPACE]: { version: 1, packetPath: "../workflow", relayName: "workflow", leg: "1" } },
  ] satisfies (SessionUiMetadata | undefined)[])("does not infer membership from a Relay-like title or invalid metadata", (value) => {
    const contribution = sessionContribution();
    const context = rowContext(value);
    expect(contribution.items(context)).toEqual([]);
    expect(context.files.listFiles).not.toHaveBeenCalled();
  });
});

function sessionContribution() {
  const activation: PluginActivationContext = {
    apiVersion: 4, pluginId: "@jmfederico/pi-relay", runtimePluginId, html, svg,
    signal: new AbortController().signal, lifetimeSignal: new AbortController().signal,
  };
  const result = plugin.activate(activation);
  const contribution = result.contributions.sessionLabels[0];
  if (contribution === undefined) throw new Error("Relay session contribution missing");
  return contribution;
}

function rowContext(value: SessionUiMetadata | undefined, archived = false) {
  return {
    machine: { id: "remote-1", name: "Remote", kind: "remote" },
    workspace: { id: "worktree/1", projectId: "project & 1", path: "/repo/tree", label: "Feature", isMain: false },
    session: { id: "relay-row", name: "Leg 1 – Relay workflow", cwd: "/repo/tree", ...(value === undefined ? {} : { metadata: value }), archived, pending: false },
    // Deliberately different selection: membership/navigation belongs to this row.
    state: { selectedMachine: { id: "local", name: "Local", kind: "local" } },
    navigate: vi.fn(() => Promise.resolve()),
    files: {
      listFiles: vi.fn(() => Promise.reject(new Error("not used"))),
      readFile: vi.fn(() => Promise.reject(new Error("not used"))),
      writeFile: () => Promise.reject(new Error("not used")),
      deleteFile: () => Promise.reject(new Error("not used")),
      moveFile: () => Promise.reject(new Error("not used")),
    },
    host: { requestRender: vi.fn() },
  } satisfies SessionLabelContext;
}
