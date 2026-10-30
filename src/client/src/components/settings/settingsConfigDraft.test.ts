import { describe, expect, it } from "vitest";
import {
  gatewayServerConfigFromDraft,
  gatewayServerDraftFromConfig,
  machineAccessConfigPatchFromDraft,
  machineAccessDraftFromConfig,
  reconcileConfigDraft,
} from "./settingsConfigDraft";

describe("settings config drafts", () => {
  it("rebases untouched fields and leaves dirty fields intact without mutating snapshots", () => {
    const previous = { host: "old.local", port: "8504" };
    const draft = { host: "draft.local", port: "8504" };
    const incoming = { host: "new.local", port: "9000" };
    expect(reconcileConfigDraft(draft, previous, incoming)).toEqual({ host: "draft.local", port: "9000" });
    expect(incoming).toEqual({ host: "new.local", port: "9000" });
    expect(draft).toEqual({ host: "draft.local", port: "8504" });
  });

  it("splits gateway server and selected-machine access drafts", () => {
    const config = {
      host: "0.0.0.0",
      port: 8504,
      allowedHosts: ["example.local", "192.168.1.20"],
      pathAccess: { allowedPaths: ["/tmp", "~/SDKs"] },
      uploads: { defaultFolder: "manual/uploads" },
      attachments: { defaultFolder: "saved/attachments" },
    };

    expect(gatewayServerDraftFromConfig(config)).toEqual({
      host: "0.0.0.0",
      port: "8504",
      allowedHostsMode: "list",
      allowedHostsText: "example.local\n192.168.1.20",
    });
    expect(machineAccessDraftFromConfig(config)).toEqual({
      installationName: "",
      allowedPathsText: "/tmp\n~/SDKs",
      uploadDefaultFolder: "manual/uploads",
      attachmentDefaultFolder: "saved/attachments",
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
      attachments: { defaultFolder: "old/attachments" },
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
      attachments: { defaultFolder: "old/attachments" },
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

  it("preserves installation identity when saving gateway fields", () => {
    expect(gatewayServerConfigFromDraft(gatewayServerDraftFromConfig({}), { installationName: "Studio" }).installationName).toBe("Studio");
    expect(machineAccessDraftFromConfig({ installationName: "Studio" }).installationName).toBe("Studio");
  });

  it("preserves localization defaults when saving gateway fields", () => {
    const defaultLocalization = { language: "fr", formatLocale: "de-DE", timeZone: "UTC", hourCycle: "h23" as const };
    expect(gatewayServerConfigFromDraft(gatewayServerDraftFromConfig({}), { defaultLocalization }).defaultLocalization).toEqual(defaultLocalization);
  });

  it("preserves the default theme when saving gateway fields", () => {
    const defaultTheme = { themeId: "themes:pi-web-light", auto: false };
    expect(gatewayServerConfigFromDraft(gatewayServerDraftFromConfig({}), { defaultTheme }).defaultTheme).toEqual(defaultTheme);
  });

  it.each(["steer", "followUp"] as const)("preserves defaultStreamingBehavior %s during gateway edits", (defaultStreamingBehavior) => {
    const draft = gatewayServerDraftFromConfig({ host: "gateway.local" });
    expect(gatewayServerConfigFromDraft(draft, { defaultStreamingBehavior }).defaultStreamingBehavior).toBe(defaultStreamingBehavior);
    expect(gatewayServerConfigFromDraft(draft)).not.toHaveProperty("defaultStreamingBehavior");
  });

  it.each([true, false])("preserves sessionMessages %s during gateway edits", (sessionMessages) => {
    const draft = gatewayServerDraftFromConfig({ host: "gateway.local" });
    expect(gatewayServerConfigFromDraft(draft, { sessionMessages }).sessionMessages).toBe(sessionMessages);
    expect(gatewayServerConfigFromDraft(draft)).not.toHaveProperty("sessionMessages");
  });

  it.each([true, false])("preserves quietMode %s during gateway edits", (quietMode) => {
    const draft = gatewayServerDraftFromConfig({ host: "gateway.local" });
    expect(gatewayServerConfigFromDraft(draft, { quietMode }).quietMode).toBe(quietMode);
    expect(gatewayServerConfigFromDraft(draft)).not.toHaveProperty("quietMode");
  });

  it("builds selected-machine access/upload patches only from selected-machine-safe fields", () => {
    const patch = machineAccessConfigPatchFromDraft({
      installationName: " Studio ",
      allowedPathsText: "/tmp\n~/SDKs\n",
      uploadDefaultFolder: " manual\\uploads/. ",
      attachmentDefaultFolder: " saved\\attachments/. ",
    });

    expect(Object.keys(patch)).toEqual(["installationName", "pathAccess", "uploads", "attachments"]);
    expect(patch).toEqual({
      installationName: "Studio",
      pathAccess: { allowedPaths: ["/tmp", "~/SDKs"] },
      uploads: { defaultFolder: "manual/uploads" },
      attachments: { defaultFolder: "saved/attachments" },
    });
  });

  it("clears selected-machine access/upload settings with safe default patches", () => {
    expect(machineAccessConfigPatchFromDraft({ installationName: "", allowedPathsText: "", uploadDefaultFolder: "", attachmentDefaultFolder: "" })).toEqual({
      installationName: "",
      pathAccess: { allowedPaths: [] },
      uploads: {},
      attachments: {},
    });
  });

  it("rejects invalid selected-machine upload default folders before saving", () => {
    expect(() => machineAccessConfigPatchFromDraft({ installationName: "", allowedPathsText: "", uploadDefaultFolder: "/tmp/uploads", attachmentDefaultFolder: "" })).toThrow("Upload default folder must be workspace-relative.");
    expect(() => machineAccessConfigPatchFromDraft({ installationName: "", allowedPathsText: "", uploadDefaultFolder: "../secret", attachmentDefaultFolder: "" })).toThrow("Upload default folder must not contain path traversal.");
  });

  it("rejects invalid selected-machine attachment default folders before saving", () => {
    expect(() => machineAccessConfigPatchFromDraft({ installationName: "", allowedPathsText: "", uploadDefaultFolder: "", attachmentDefaultFolder: "/tmp/attachments" })).toThrow("Attachment default folder must be workspace-relative.");
    expect(() => machineAccessConfigPatchFromDraft({ installationName: "", allowedPathsText: "", uploadDefaultFolder: "", attachmentDefaultFolder: "../secret" })).toThrow("Attachment default folder must not contain path traversal.");
  });

  it("rejects relative external paths before saving selected-machine access", () => {
    expect(() => machineAccessConfigPatchFromDraft({
      installationName: "",
      allowedPathsText: "relative/path",
      uploadDefaultFolder: "",
      attachmentDefaultFolder: "",
    })).toThrow("Allowed external paths must be absolute paths or start with ~");
  });
});
