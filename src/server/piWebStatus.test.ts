import { afterEach, describe, expect, it, vi } from "vitest";
import { comparePackageVersions, getPiWebStatus } from "./piWebStatus.js";
import { SessionDaemonClient } from "./sessiond/sessionDaemonClient.js";

const originalSkipVersionCheck = process.env["PI_WEB_SKIP_VERSION_CHECK"];

afterEach(() => {
  if (originalSkipVersionCheck === undefined) delete process.env["PI_WEB_SKIP_VERSION_CHECK"];
  else process.env["PI_WEB_SKIP_VERSION_CHECK"] = originalSkipVersionCheck;
  vi.restoreAllMocks();
});

describe("Pi Web status", () => {
  it("compares semver-shaped CalVer versions", () => {
    expect(comparePackageVersions("1.202605.9", "1.202605.8")).toBeGreaterThan(0);
    expect(comparePackageVersions("1.202605.8", "1.202605.8")).toBe(0);
    expect(comparePackageVersions("1.202605.7", "1.202605.8")).toBeLessThan(0);
  });

  it("reports stale session daemon versions as messages", async () => {
    process.env["PI_WEB_SKIP_VERSION_CHECK"] = "1";
    const daemon = new SessionDaemonClient();
    vi.spyOn(daemon, "request").mockResolvedValue({
      statusCode: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: {
          component: "sessiond",
          label: "Session daemon",
          runtimeVersion: "1.202605.7",
          installedVersion: "1.202605.8",
          stale: true,
          available: true,
          installation: { kind: "pi-package", source: "npm:@jmfederico/pi-web", scope: "user", path: "/tmp/pi-web" },
        },
      }),
    });

    const status = await getPiWebStatus(daemon);

    expect(status.release.skipped).toBe(true);
    expect(status.components.sessiond.stale).toBe(true);
    expect(status.components.sessiond.installation).toMatchObject({ kind: "pi-package", source: "npm:@jmfederico/pi-web", scope: "user" });
    expect(status.commands.update).not.toBe("");
    expect(status.messages.map((message) => message.id)).toContain("sessiond-stale");
  });
});
