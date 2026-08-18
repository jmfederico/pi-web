import { describe, expect, it } from "vitest";
import { sessiondDescription, sessiondPanelNotices } from "./SettingsSessiondPanel";

// This suite asserts the session-daemon panel's dynamic behavior through public
// seams rather than by inspecting rendered Lit `TemplateResult` internals:
// notice composition/ordering and the description string come from the exported
// `sessiondPanelNotices`/`sessiondDescription` helpers. Static labels and layout
// are intentionally not asserted here (no DOM harness); per the testing-guide
// skill those are not verified by scraping template internals.

describe("session daemon panel notices", () => {
  it("names the selected machine in the scope description", () => {
    expect(sessiondDescription("Lab Mac (remote machine)")).toContain("Lab Mac (remote machine)");
  });

  it("orders save/load error notices before the saved confirmation", () => {
    const notices = sessiondPanelNotices({
      error: "Failed to save session-daemon config.",
      savedMessage: "Session daemon settings saved.",
    });

    expect(notices).toEqual([
      { type: "error", content: "Failed to save session-daemon config." },
      { type: "success", content: "Session daemon settings saved." },
    ]);
  });

  it("reports only the blocking error when config is unavailable", () => {
    const notices = sessiondPanelNotices({
      error: "Could not reach Lab Mac for selected-machine settings. Check the machine connection and try again.",
      savedMessage: "",
    });

    expect(notices).toEqual([
      { type: "error", content: "Could not reach Lab Mac for selected-machine settings. Check the machine connection and try again." },
    ]);
  });

  it("reports nothing when there is no error or saved confirmation", () => {
    expect(sessiondPanelNotices({ error: "", savedMessage: "" })).toEqual([]);
  });
});
