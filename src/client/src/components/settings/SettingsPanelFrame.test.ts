// @vitest-environment happy-dom
import { html } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPanelFrame, settingsNoticeTone, type SettingsNotice } from "./SettingsPanelFrame";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

function shadowRoot(frame: SettingsPanelFrame): ShadowRoot {
  if (frame.shadowRoot === null) throw new Error("Frame has not rendered");
  return frame.shadowRoot;
}

describe("settings-panel-frame", () => {
  it("renders the heading, ordered notices, and slotted settings content", async () => {
    const frame = new SettingsPanelFrame();
    frame.heading = "Pi packages";
    frame.description = "Manage packages on Lab Mac.";
    frame.actionLabel = "Reload";
    frame.notices = [
      { type: "availability", title: "Unavailable", content: "Package management is unavailable." },
      { type: "success", content: "Saved package settings." },
      { type: "security", content: html`<strong>Trusted code warning:</strong> Install packages only from sources you trust.` },
    ];
    const content = document.createElement("form");
    frame.append(content);
    document.body.append(frame);
    await frame.updateComplete;
    const root = shadowRoot(frame);

    expect(root.querySelector("h2")?.textContent).toBe("Pi packages");
    expect(root.querySelector(".description")?.textContent).toContain("Manage packages on Lab Mac.");
    expect([...root.querySelectorAll("article")].map((notice) => notice.textContent.trim())).toEqual([
      expect.stringContaining("Package management is unavailable."),
      "Saved package settings.",
      "Trusted code warning: Install packages only from sources you trust.",
    ]);
    expect(root.querySelector<HTMLSlotElement>(".content slot")?.assignedElements()).toEqual([content]);
  });

  it("maps notice types to default tones and accessible roles, with explicit overrides", async () => {
    const notices: readonly SettingsNotice[] = [
      { type: "availability", content: "Configuration unavailable." },
      { type: "success", content: "Saved." },
      { type: "security", content: "Trusted code warning." },
      { type: "info", content: "Loading…" },
      { type: "info", tone: "warning", role: "status", content: "Restart required." },
    ];
    const frame = new SettingsPanelFrame();
    frame.notices = notices;
    document.body.append(frame);
    await frame.updateComplete;

    expect(notices.map(settingsNoticeTone)).toEqual(["error", "success", "warning", "info", "warning"]);
    expect([...shadowRoot(frame).querySelectorAll("article")].map((notice) => notice.getAttribute("role"))).toEqual([
      "alert", "status", "note", "note", "status",
    ]);
  });

  it("honors the disabled state and invokes the default header action", async () => {
    const frame = new SettingsPanelFrame();
    frame.actionLabel = "Reload";
    frame.actionTitle = "Reload settings";
    frame.actionDisabled = true;
    const reload = vi.fn();
    frame.onAction = reload;
    document.body.append(frame);
    await frame.updateComplete;
    const button = shadowRoot(frame).querySelector("button");
    if (button === null) throw new Error("Missing default action");

    expect(button.title).toBe("Reload settings");
    button.click();
    expect(reload).not.toHaveBeenCalled();
    frame.actionDisabled = false;
    await frame.updateComplete;
    button.click();
    expect(reload).toHaveBeenCalledOnce();
  });
});
