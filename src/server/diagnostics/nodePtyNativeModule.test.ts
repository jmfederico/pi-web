import { afterEach, describe, expect, it, vi } from "vitest";
import { loadNodePtyModule } from "../terminals/nodePtyModule.js";
import {
  checkNodePtyNativeModule,
  formatNodePtyNativeModuleCheck,
  NODE_PTY_GLOBAL_REINSTALL_COMMAND,
} from "./nodePtyNativeModule.js";

// SPEC D4: doctor and NodePTYBackend must resolve node-pty through one loader, so the r1
// contradiction ("doctor ✓ while terminals ✗") cannot come back. Runtime proof that the default
// path really is the shared loader — a regex over the source would pass with a second copy.
vi.mock("../terminals/nodePtyModule.js", () => ({
  loadNodePtyModule: vi.fn(() => {
    throw new Error("shared-loader-was-used");
  }),
}));

describe("node-pty native module diagnostics", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("uses the shared terminal loader when no loader is injected", () => {
    expect(checkNodePtyNativeModule()).toEqual({
      status: "load-failed",
      message: "shared-loader-was-used",
    });
    expect(vi.mocked(loadNodePtyModule)).toHaveBeenCalledTimes(1);
  });

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
