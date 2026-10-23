// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import type { PiWebConfigResponse } from "../../api";
import { SettingsSessiondPanel } from "./SettingsSessiondPanel";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

describe("SettingsSessiondPanel Ask Questions setting", () => {
  it("lets the user disable ask_user with a daemon config patch", async () => {
    const panel = new SettingsSessiondPanel();
    const onSave = vi.fn();
    panel.configResponse = configResponse(true);
    panel.onSave = onSave;
    document.body.append(panel);
    await panel.updateComplete;

    const toggle = askUserToggle(panel);
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(false);

    toggle.click();
    await panel.updateComplete;

    expect(onSave).toHaveBeenCalledWith({ askUser: false });
  });

  it("keeps an environment-overridden setting read-only", async () => {
    const panel = new SettingsSessiondPanel();
    panel.configResponse = configResponse(true, true);
    document.body.append(panel);
    await panel.updateComplete;

    const toggle = askUserToggle(panel);
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(true);
    const help = panel.shadowRoot?.getElementById(toggle.getAttribute("aria-describedby") ?? "");
    expect(help?.textContent).toContain("Read-only because PI_WEB_ASK_USER overrides this setting.");
    expect(toggle.closest("label")?.textContent).toContain("Allow agents to ask you questions");
  });
});

function askUserToggle(panel: SettingsSessiondPanel): HTMLInputElement {
  const toggle = panel.shadowRoot?.querySelector<HTMLInputElement>('input#ask-user');
  if (toggle === undefined || toggle === null) throw new Error("Ask Questions toggle was not rendered");
  return toggle;
}

function configResponse(askUser: boolean, askUserOverride = false): PiWebConfigResponse {
  return {
    path: "/tmp/pi-web/config.json",
    exists: true,
    config: { askUser },
    effectiveConfig: { askUser },
    envOverrides: {
      host: false,
      port: false,
      allowedHosts: false,
      spawnSessions: false,
      subsessions: false,
      askUser: askUserOverride,
    },
  };
}
