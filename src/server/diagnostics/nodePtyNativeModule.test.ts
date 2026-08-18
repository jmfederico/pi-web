import { describe, expect, it } from "vitest";
import {
  checkNodePtyNativeModule,
  formatNodePtyNativeModuleCheck,
  NODE_PTY_GLOBAL_REINSTALL_COMMAND,
} from "./nodePtyNativeModule.js";

describe("node-pty native module diagnostics", () => {
  it("passes when node-pty loads", () => {
    const check = checkNodePtyNativeModule({ load: () => ({ spawn: () => undefined }) });

    expect(check).toEqual({ status: "ok" });
    expect(formatNodePtyNativeModuleCheck(check)).toEqual({
      ok: true,
      lines: ["✓ node-pty native module loadable"],
    });
  });

  it("reports the scoped global reinstall command when node-pty cannot load", () => {
    const check = checkNodePtyNativeModule({
      load: () => { throw new Error("Failed to load native module: pty.node\nchecked build/Release"); },
    });

    expect(check).toEqual({
      status: "load-failed",
      message: "Failed to load native module: pty.node checked build/Release",
    });
    const formatted = formatNodePtyNativeModuleCheck(check);
    expect(formatted.ok).toBe(false);
    expect(formatted.lines).toContain(`    ${NODE_PTY_GLOBAL_REINSTALL_COMMAND}`);
    expect(formatted.lines).toContain("  Then run `pi-web doctor` again.");
    expect(formatted.lines.join("\n")).not.toContain("dangerously-allow-all-scripts");
  });
});
