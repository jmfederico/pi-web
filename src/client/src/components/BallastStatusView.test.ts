// @vitest-environment happy-dom
import { afterEach, expect, it } from "vitest";
import { BallastStatusView } from "./BallastStatusView";
import type { ChatLine } from "./shared";

afterEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
});

async function mountView(options: {
  statusText?: string;
  messages?: readonly ChatLine[];
  machineLabel?: string;
} = {}): Promise<BallastStatusView> {
  const view = new BallastStatusView();
  view.statusText = options.statusText;
  view.messages = options.messages ?? [];
  view.machineLabel = options.machineLabel ?? "machine-a";
  document.body.append(view);
  await view.updateComplete;
  return view;
}

it("shows a current warning separately from machine identity and historical tool evidence", async () => {
  const view = await mountView({ statusText: "ballast: WARN 2 GB free · worker 1 GB", machineLabel: "workstation" });

  expect(view.renderRoot.querySelector(".current-status.warning")?.getAttribute("role")).toBe("alert");
  expect(view.renderRoot.querySelector(".status-text")?.textContent).toContain("ballast: WARN 2 GB free · worker 1 GB");
  expect(view.renderRoot.querySelector(".machine")?.textContent).toBe("workstation");
  expect(view.renderRoot.querySelector(".evidence")).toBeNull();
});

it("uses critical alert styling for a recognized current critical status", async () => {
  const view = await mountView({ statusText: "ballast: CRITICAL 1 GB free" });

  expect(view.renderRoot.querySelector(".current-status.critical")?.getAttribute("role")).toBe("alert");
  expect(view.renderRoot.querySelector(".level")?.textContent).toBe("CRITICAL");
});

it("reports absent status as unavailable, not healthy, and labels an unknown machine", async () => {
  const view = await mountView({ machineLabel: "   " });

  expect(view.renderRoot.textContent).toContain("Unknown machine");
  expect(view.renderRoot.textContent).toContain("No current Ballast pressure alert is available.");
  expect(view.renderRoot.textContent).toContain("This does not confirm that memory is healthy.");
  expect(view.renderRoot.querySelector(".current-status")).toBeNull();
});

it("does not promote arbitrary status text to an alert", async () => {
  const view = await mountView({ statusText: "Memory seems fine" });

  expect(view.renderRoot.querySelector(".current-status.unclassified")?.getAttribute("role")).toBe("status");
  expect(view.renderRoot.querySelector('[role="alert"]')).toBeNull();
  expect(view.renderRoot.textContent).toContain("Memory seems fine");
});

it("labels prior critical tool output as historical rather than current status", async () => {
  const messages: ChatLine[] = [{ role: "tool", parts: [{
    type: "toolResult",
    toolName: "ballast_status",
    text: "Memory pressure critical (low headroom).",
    details: { level: "critical", reason: "low headroom", headroomBytes: 0 },
    isError: false,
  }] }];
  const view = await mountView({ messages });

  expect(view.renderRoot.querySelector(".current-status")).toBeNull();
  expect(view.renderRoot.querySelector('[role="alert"]')).toBeNull();
  expect(view.renderRoot.querySelector(".evidence")?.textContent).toContain("Last-reported evidence · ballast_status");
  expect(view.renderRoot.querySelector(".historical")?.textContent).toContain("not a current memory reading");
  expect(view.renderRoot.textContent).toContain("Reported pressure level");
  expect(view.renderRoot.textContent).not.toContain("headroomBytes");
});

it("selects latest tool evidence and clears it when the supplied session history changes", async () => {
  const messages: ChatLine[] = [
    { role: "tool", parts: [{ type: "toolResult", toolName: "ballast_status", text: "older result", isError: false }] },
    { role: "tool", parts: [{ type: "toolResult", toolName: "ballast_consumers", text: "latest result", isError: false }] },
  ];
  const view = await mountView({ messages });

  expect(view.renderRoot.querySelector(".evidence")?.textContent).toContain("ballast_consumers");
  expect(view.renderRoot.querySelector(".evidence")?.textContent).toContain("latest result");
  expect(view.renderRoot.querySelector(".evidence")?.textContent).not.toContain("older result");

  view.messages = [];
  await view.updateComplete;
  expect(view.renderRoot.querySelector(".evidence")).toBeNull();
  expect(view.renderRoot.textContent).toContain("No Ballast tool evidence is available in the loaded history.");
});

it("limits the empty state claim when older evidence is outside the loaded history page", async () => {
  const earlierEvidence: ChatLine = {
    role: "tool",
    parts: [{ type: "toolResult", toolName: "ballast_status", text: "older critical result", details: { level: "critical" }, isError: false }],
  };
  const laterMessages = Array.from({ length: 100 }, (_, index): ChatLine => ({
    role: "user",
    parts: [{ type: "text", text: `Loaded message ${String(index)}` }],
  }));
  const fullHistory = [earlierEvidence, ...laterMessages];
  const loadedHistoryPage = fullHistory.slice(-100);
  expect(loadedHistoryPage).not.toContain(earlierEvidence);

  const view = await mountView({ messages: loadedHistoryPage });

  expect(view.renderRoot.textContent).toContain("No Ballast tool evidence is available in the loaded history.");
  expect(view.renderRoot.textContent).not.toContain("No Ballast tool result has been reported in this session.");
  expect(view.renderRoot.textContent).not.toContain("older critical result");
});

it("renders tool output as escaped plain text", async () => {
  const maliciousText = '<img src="x" onerror="alert(1)">';
  const messages: ChatLine[] = [{ role: "tool", parts: [{
    type: "toolResult", toolName: "ballast_consumers", text: maliciousText, isError: false,
  }] }];
  const view = await mountView({ messages });

  expect(view.renderRoot.querySelector("pre")?.textContent).toBe(maliciousText);
  expect(view.renderRoot.querySelector("img")).toBeNull();
});
