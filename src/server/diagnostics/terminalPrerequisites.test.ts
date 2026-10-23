import { describe, expect, it, vi } from "vitest";
import { checkTerminalPrerequisites } from "./terminalPrerequisites.js";

describe("terminal startup prerequisites", () => {
  it("uses the selected Bun provider without checking Node helpers", async () => {
    const helper = vi.fn(() => { throw new Error("node-pty helper must not run"); });
    expect((await checkTerminalPrerequisites({
      inspectProvider: () => ({ kind: "bun", supported: true }), checkNodeHelper: helper,
    })).ok).toBe(true);
    expect(helper).not.toHaveBeenCalled();
  });

  it("reports unsupported Bun APIs without suggesting a Node addon fallback", async () => {
    const result = await checkTerminalPrerequisites({
      inspectProvider: () => ({ kind: "bun", supported: false, reason: "upgrade Bun" }),
    });
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("upgrade Bun");
    expect(result.lines.join("\n")).toContain("fallback is not supported");
  });

  it("checks the Node helper only after successful native binding inspection", async () => {
    const helper = vi.fn(() => ({ ok: false, lines: ["helper failed"] }));
    const result = await checkTerminalPrerequisites({
      inspectProvider: () => ({ kind: "node", supported: true }), checkNodeHelper: helper,
    });
    expect(result).toEqual({ ok: false, lines: ["✓ node-pty native module loadable", "helper failed"] });
    expect(helper).toHaveBeenCalledOnce();
  });

  it("preserves native load failure and skips helper inspection", async () => {
    const helper = vi.fn(() => ({ ok: true, lines: [] }));
    const result = await checkTerminalPrerequisites({
      inspectProvider: () => ({ kind: "node", supported: false, reason: "load failed" }), checkNodeHelper: helper,
    });
    expect(result.ok).toBe(false);
    expect(result.lines.join("\n")).toContain("load failed");
    expect(helper).not.toHaveBeenCalled();
  });

  it("reports a missing prerequisite inspector rather than guessing", async () => {
    const result = await checkTerminalPrerequisites({ inspectProvider: () => { throw new Error("provider missing"); } });
    expect(result).toEqual({ ok: false, lines: ["✗ Terminal provider inspection failed", "  provider missing"] });
  });
});
