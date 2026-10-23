import { describe, expect, it } from "vitest";
import {
  formatNodePtyNativeModuleCheck,
  NODE_PTY_GLOBAL_REINSTALL_COMMAND,
} from "./nodePtyNativeModule.js";

describe("node-pty native module diagnostics", () => {
  it("passes when node-pty loads", () => {
    expect(formatNodePtyNativeModuleCheck({ status: "ok" })).toEqual({
      ok: true,
      lines: ["✓ node-pty native module loadable"],
    });
  });

  it("reports the scoped global reinstall command when node-pty cannot load", () => {
    const formatted = formatNodePtyNativeModuleCheck({ status: "load-failed", message: "Failed to load native module: pty.node" });
    expect(formatted.ok).toBe(false);
    expect(formatted.lines).toContain(`    ${NODE_PTY_GLOBAL_REINSTALL_COMMAND}`);
    expect(formatted.lines).toContain("  Then run `pi-web doctor` again.");
    expect(formatted.lines.join("\n")).not.toContain("dangerously-allow-all-scripts");
  });
});
