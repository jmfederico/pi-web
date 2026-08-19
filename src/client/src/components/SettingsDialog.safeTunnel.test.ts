// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configApi, piPackagesApi, pluginsApi } from "../api";
import { settleRenderedDialog } from "./modalSurfaceTestSupport";
import { activeSettingsPanelTag, SettingsDialog } from "./SettingsDialog";
import { configResponse, pluginsResponse } from "./SettingsDialog.testSupport";

beforeEach(() => {
  vi.spyOn(configApi, "config").mockResolvedValue(configResponse({}));
  vi.spyOn(pluginsApi, "plugins").mockResolvedValue(pluginsResponse([]));
  vi.spyOn(piPackagesApi, "packages").mockResolvedValue({ packages: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
  localStorage.clear();
});

describe("settings-dialog Safe Tunnel gate", () => {
  it("routes unavailable and unresolved Safe Tunnel requests to General without loading feature code", async () => {
    const loader = vi.fn(() => Promise.resolve());
    const dialog = new SettingsDialog();
    dialog.section = "safe-tunnel";
    dialog.safeTunnelAvailable = false;
    dialog.safeTunnelPanelLoader = loader;

    document.body.append(dialog);
    await settleRenderedDialog(dialog);

    expect(activeSettingsPanelTag("safe-tunnel", false)).toBe("settings-general-panel");
    expect(navButton(dialog, "Safe Tunnel")).toBeUndefined();
    expect(dialog.shadowRoot?.querySelector("settings-general-panel")).not.toBeNull();
    expect(dialog.shadowRoot?.querySelector("settings-safe-tunnel-panel")).toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });

  it("shows enabled navigation and mounts the panel only after its lazy module loads", async () => {
    const load = deferred<undefined>();
    const loader = vi.fn(() => load.promise);
    const dialog = new SettingsDialog();
    dialog.section = "safe-tunnel";
    dialog.safeTunnelAvailable = true;
    dialog.safeTunnelPanelLoader = loader;

    document.body.append(dialog);
    await dialog.updateComplete;
    await vi.waitFor(() => { expect(loader).toHaveBeenCalledOnce(); });

    expect(navButton(dialog, "Safe Tunnel")).toBeDefined();
    expect(dialog.shadowRoot?.textContent).toContain("Loading Safe Tunnel settings");
    expect(dialog.shadowRoot?.querySelector("settings-safe-tunnel-panel")).toBeNull();

    load.resolve(undefined);
    await load.promise;
    await dialog.updateComplete;

    expect(activeSettingsPanelTag("safe-tunnel", true)).toBe("settings-safe-tunnel-panel");
    expect(dialog.shadowRoot?.querySelector("settings-safe-tunnel-panel")).not.toBeNull();
    expect(loader).toHaveBeenCalledOnce();
  });

  it("unmounts the panel and removes navigation when the active gateway capability disappears", async () => {
    const loader = vi.fn(() => Promise.resolve());
    const dialog = new SettingsDialog();
    dialog.section = "safe-tunnel";
    dialog.safeTunnelAvailable = true;
    dialog.safeTunnelPanelLoader = loader;

    document.body.append(dialog);
    await vi.waitFor(() => { expect(loader).toHaveBeenCalledOnce(); });
    await dialog.updateComplete;
    expect(dialog.shadowRoot?.querySelector("settings-safe-tunnel-panel")).not.toBeNull();

    dialog.safeTunnelAvailable = false;
    await dialog.updateComplete;

    expect(navButton(dialog, "Safe Tunnel")).toBeUndefined();
    expect(dialog.shadowRoot?.querySelector("settings-safe-tunnel-panel")).toBeNull();
    expect(dialog.shadowRoot?.querySelector("settings-general-panel")).not.toBeNull();
  });
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { resolvePromise = resolve; });
  if (resolvePromise === undefined) throw new Error("Deferred promise was not initialized");
  return { promise, resolve: resolvePromise };
}

function navButton(dialog: SettingsDialog, text: string): HTMLButtonElement | undefined {
  return [...(dialog.shadowRoot?.querySelectorAll<HTMLButtonElement>(".settings-nav button") ?? [])]
    .find((button) => button.textContent.includes(text));
}
