import { describe, expect, it } from "vitest";
import {
  gatewayServerConfigFromDraft,
  gatewayServerDraftFromConfig,
  machineAccessConfigPatchFromDraft,
  machineAccessDraftFromConfig,
} from "./settingsConfigDraft";

describe("settings config drafts", () => {
  it("splits gateway server and selected-machine access drafts", () => {
    const config = {
      host: "0.0.0.0",
      port: 8504,
      allowedHosts: ["example.local", "192.168.1.20"],
      pathAccess: { allowedPaths: ["/tmp", "~/SDKs"] },
      uploads: { defaultFolder: "manual/uploads" },
    };

    expect(gatewayServerDraftFromConfig(config)).toEqual({
      host: "0.0.0.0",
      port: "8504",
      allowedHostsMode: "list",
      allowedHostsText: "example.local\n192.168.1.20",
    });
    expect(machineAccessDraftFromConfig(config)).toEqual({
      allowedPathsText: "/tmp\n~/SDKs",
      uploadDefaultFolder: "manual/uploads",
    });
    expect(gatewayServerDraftFromConfig({ allowedHosts: true }).allowedHostsMode).toBe("all");
  });

  it("builds gateway server saves without dropping preserved config values", () => {
    expect(gatewayServerConfigFromDraft({
      host: " gateway.local ",
      port: "9000",
      allowedHostsMode: "all",
      allowedHostsText: "ignored.local",
    }, {
      shortcuts: { "core:view.chat": "mod+1" },
      plugins: { info: { enabled: false } },
      pathAccess: { allowedPaths: ["/old"] },
      uploads: { defaultFolder: "old/uploads" },
      maxUploadBytes: 1234,
      spawnSessions: true,
      subsessions: false,
      agent: { command: "agent-lab", dir: "~/agent-profiles/lab" },
    })).toEqual({
      host: "gateway.local",
      port: 9000,
      allowedHosts: true,
      shortcuts: { "core:view.chat": "mod+1" },
      plugins: { info: { enabled: false } },
      pathAccess: { allowedPaths: ["/old"] },
      uploads: { defaultFolder: "old/uploads" },
      maxUploadBytes: 1234,
      spawnSessions: true,
      subsessions: false,
      agent: { command: "agent-lab", dir: "~/agent-profiles/lab" },
    });

    expect(gatewayServerConfigFromDraft({
      host: "",
      port: "",
      allowedHostsMode: "list",
      allowedHostsText: "example.local, 192.168.1.20\n",
    })).toEqual({ allowedHosts: ["example.local", "192.168.1.20"] });
  });

  it("builds selected-machine access/upload patches only from selected-machine-safe fields", () => {
    const patch = machineAccessConfigPatchFromDraft({
      allowedPathsText: "/tmp\n~/SDKs\n",
      uploadDefaultFolder: " manual\\uploads/. ",
    });

    expect(Object.keys(patch)).toEqual(["pathAccess", "uploads"]);
    expect(patch).toEqual({
      pathAccess: { allowedPaths: ["/tmp", "~/SDKs"] },
      uploads: { defaultFolder: "manual/uploads" },
    });
  });

  it("clears selected-machine access/upload settings with safe default patches", () => {
    expect(machineAccessConfigPatchFromDraft({ allowedPathsText: "", uploadDefaultFolder: "" })).toEqual({
      pathAccess: { allowedPaths: [] },
      uploads: {},
    });
  });

  it("rejects invalid selected-machine upload default folders before saving", () => {
    expect(() => machineAccessConfigPatchFromDraft({ allowedPathsText: "", uploadDefaultFolder: "/tmp/uploads" })).toThrow("Upload default folder must be workspace-relative.");
    expect(() => machineAccessConfigPatchFromDraft({ allowedPathsText: "", uploadDefaultFolder: "../secret" })).toThrow("Upload default folder must not contain path traversal.");
  });

  it("rejects relative external paths before saving selected-machine access", () => {
    expect(() => machineAccessConfigPatchFromDraft({
      allowedPathsText: "relative/path",
      uploadDefaultFolder: "",
    })).toThrow("Allowed external paths must be absolute paths or start with ~");
  });
});
