// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiWebConfigResponse } from "../../api";
import { SettingsGeneralPanel } from "./SettingsGeneralPanel";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("settings-general-panel managed allowed hosts", () => {
  it("renders the Safe Tunnel hostname read-only without adding it to saved config", async () => {
    const onSave = vi.fn(() => Promise.resolve());
    const panel = new SettingsGeneralPanel();
    panel.configResponse = configResponse();
    panel.machineConfigResponse = configResponse();
    panel.onSave = onSave;
    document.body.append(panel);
    await panel.updateComplete;

    const gateway = panel.shadowRoot?.querySelector<HTMLElement>(
      'section[aria-label="Gateway server settings"]',
    );
    const managed = gateway?.querySelector<HTMLElement>(
      'section[aria-label="Managed allowed hosts"]',
    );
    const textarea = gateway?.querySelector<HTMLTextAreaElement>("textarea");
    const form = gateway?.querySelector<HTMLFormElement>("form");
    if (managed === undefined || managed === null || textarea === undefined || textarea === null || form === undefined || form === null) {
      throw new Error("Expected rendered gateway host controls");
    }

    expect(managed.textContent).toContain("Managed hosts — read-only");
    expect(managed.textContent).toContain("machine.namespace.tunnels.example.test");
    expect(textarea.value).toBe("operator.example.test");
    expect(textarea.value).not.toContain("machine.namespace.tunnels.example.test");

    textarea.value = "operator.example.test\nproxy.example.test";
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await panel.updateComplete;

    expect(onSave).toHaveBeenCalledWith({
      allowedHosts: ["operator.example.test", "proxy.example.test"],
    });
  });
});

function configResponse(): PiWebConfigResponse {
  return {
    path: "/tmp/pi-web/config.json",
    exists: true,
    config: { allowedHosts: ["operator.example.test"] },
    effectiveConfig: { allowedHosts: ["operator.example.test"] },
    envOverrides: { host: false, port: false, allowedHosts: false, safeTunnel: false, spawnSessions: false, subsessions: false, askUser: false },
    managedAllowedHosts: [{
      source: "safe-tunnel",
      hostname: "machine.namespace.tunnels.example.test",
    }],
  };
}
