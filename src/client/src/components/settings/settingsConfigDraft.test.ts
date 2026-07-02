import { describe, expect, it } from "vitest";
import {
  configFromDraft,
  draftFromConfig,
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
  });

  it("builds gateway server saves without changing selected-machine-safe config values", () => {
    expect(gatewayServerConfigFromDraft({
      host: " gateway.local ",
      port: "9000",
      allowedHostsMode: "all",
      allowedHostsText: "ignored.local",
    }, {
      pathAccess: { allowedPaths: ["/old"] },
      uploads: { defaultFolder: "old/uploads" },
      maxUploadBytes: 1234,
      spawnSessions: true,
    })).toEqual({
      host: "gateway.local",
      port: 9000,
      allowedHosts: true,
      pathAccess: { allowedPaths: ["/old"] },
      uploads: { defaultFolder: "old/uploads" },
      maxUploadBytes: 1234,
      spawnSessions: true,
    });
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

  it("converts PI WEB config values to editable general settings drafts", () => {
    expect(draftFromConfig({ host: "0.0.0.0", port: 8504, allowedHosts: ["example.local", "192.168.1.20"], pathAccess: { allowedPaths: ["/tmp", "~/SDKs"] } })).toEqual({
      host: "0.0.0.0",
      port: "8504",
      allowedHostsMode: "list",
      allowedHostsText: "example.local\n192.168.1.20",
      allowedPathsText: "/tmp\n~/SDKs",
    });
    expect(draftFromConfig({ allowedHosts: true }).allowedHostsMode).toBe("all");
  });

  it("converts drafts back to config while preserving non-general preferences", () => {
    expect(configFromDraft({
      host: " 127.0.0.1 ",
      port: "9000",
      allowedHostsMode: "list",
      allowedHostsText: "example.local, 192.168.1.20\n",
      allowedPathsText: "/tmp\n~/SDKs\n",
    }, { shortcuts: { "core:view.chat": "mod+1", "core:session.stop": null }, plugins: { info: { enabled: false } }, pathAccess: { allowedPaths: ["/old"] }, uploads: { defaultFolder: "manual/uploads" }, maxUploadBytes: 1234 })).toEqual({
      host: "127.0.0.1",
      port: 9000,
      allowedHosts: ["example.local", "192.168.1.20"],
      shortcuts: { "core:view.chat": "mod+1", "core:session.stop": null },
      plugins: { info: { enabled: false } },
      pathAccess: { allowedPaths: ["/tmp", "~/SDKs"] },
      uploads: { defaultFolder: "manual/uploads" },
      maxUploadBytes: 1234,
    });
  });

  it("removes global path access when the allowed paths field is cleared", () => {
    expect(configFromDraft({
      host: "",
      port: "",
      allowedHostsMode: "list",
      allowedHostsText: "",
      allowedPathsText: "",
    }, { pathAccess: { allowedPaths: ["/old"] } })).not.toHaveProperty("pathAccess");
  });

  it("rejects relative external paths before saving", () => {
    expect(() => configFromDraft({
      host: "",
      port: "",
      allowedHostsMode: "list",
      allowedHostsText: "",
      allowedPathsText: "relative/path",
    })).toThrow("Allowed external paths must be absolute paths or start with ~");
  });

  it("preserves the spawnSessions flag when saving general settings", () => {
    const result = configFromDraft({
      host: "",
      port: "",
      allowedHostsMode: "list",
      allowedHostsText: "",
      allowedPathsText: "",
    }, { spawnSessions: true });
    expect(result.spawnSessions).toBe(true);
  });
});
