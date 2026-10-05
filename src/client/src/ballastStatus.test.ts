import { describe, expect, it } from "vitest";
import { ballastCurrentStatus, latestBallastToolEvidence } from "./ballastStatus";
import type { ChatLine } from "./components/shared";

describe("ballastCurrentStatus", () => {
  it.each([
    ["ballast: WATCH 4 GB free", "watch"],
    ["ballast: WARN 2 GB free", "warn"],
    ["ballast: CRITICAL 1 GB free", "critical"],
  ] as const)("recognizes the producer's %s pressure hint", (text, level) => {
    expect(ballastCurrentStatus(text)).toEqual({ text, level });
  });

  it.each([undefined, "", "   ", "ballast: OK", "Memory looks fine", "warn: arbitrary text"])(
    "does not infer a pressure level from %s",
    (text) => {
      const status = ballastCurrentStatus(text);
      if (text === undefined || text.trim() === "") expect(status).toBeUndefined();
      else expect(status).toEqual({ text });
    },
  );

  it("bounds current extension status text without parsing its figures", () => {
    const text = `ballast: WARN ${"x".repeat(1_000)}`;
    expect(ballastCurrentStatus(text)).toEqual({ text: `${text.slice(0, 500)}… [truncated]`, level: "warn" });
  });
});

describe("latestBallastToolEvidence", () => {
  it("selects the latest completed Ballast result and ignores unrelated or in-flight tools", () => {
    const messages: ChatLine[] = [
      { role: "tool", parts: [{ type: "toolResult", toolName: "ballast_status", text: "older status", details: { level: "warn" }, isError: false }] },
      { role: "tool", parts: [{ type: "toolExecution", toolName: "ballast_plan", summary: "plan", status: "running", resultText: "in progress" }] },
      { role: "tool", parts: [{ type: "toolResult", toolName: "read", text: "not Ballast", isError: false }] },
      { role: "tool", parts: [{ type: "toolExecution", toolName: "ballast_relieve", summary: "relief", status: "success", resultText: "Relieved 42 bytes.", details: { bytesFreed: 42 } }] },
    ];

    expect(latestBallastToolEvidence(messages)).toEqual({
      toolName: "ballast_relieve",
      text: "Relieved 42 bytes.",
      isError: false,
      fields: [{ label: "Reported bytes freed", value: "42 bytes" }],
    });
  });

  it("keeps only documented structured fields for each Ballast tool", () => {
    const messages: ChatLine[] = [
      { role: "tool", parts: [{
        type: "toolResult",
        toolName: "ballast_status",
        text: "Pressure status text remains plain text.",
        details: { level: "critical", reason: "low headroom", headroomBytes: 0, private: "ignore" },
        isError: false,
      }] },
    ];

    expect(latestBallastToolEvidence(messages)).toEqual({
      toolName: "ballast_status",
      text: "Pressure status text remains plain text.",
      isError: false,
      fields: [
        { label: "Reported pressure level", value: "critical" },
        { label: "Reported reason", value: "low headroom" },
      ],
    });
  });

  it("ignores undocumented plan fields and rejects invalid numeric evidence", () => {
    const messages: ChatLine[] = [{ role: "tool", parts: [{
      type: "toolResult",
      toolName: "ballast_plan",
      text: "Plan output",
      details: { safeBytes: 512, disruptiveBytes: -1, headroomBytes: 2_048, counts: 3 },
      isError: false,
    }] }];

    expect(latestBallastToolEvidence(messages)?.fields).toEqual([
      { label: "Reported safe plan bytes", value: "512 bytes" },
    ]);
  });

  it("bounds tool output and does not retain the prior session's messages", () => {
    const messages: ChatLine[] = [{ role: "tool", parts: [{
      type: "toolResult", toolName: "ballast_consumers", text: "x".repeat(5_000), isError: false,
    }] }];

    expect(latestBallastToolEvidence(messages)?.text).toBe(`${"x".repeat(4_000)}… [truncated]`);
    expect(latestBallastToolEvidence([])).toBeUndefined();
  });
});
