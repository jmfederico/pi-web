import { describe, expect, it } from "vitest";
import {
  createDevelopmentNativeServicePlan,
  resolveProductionNativeServicePlan,
  type NativeServiceAuthoritativeProbe,
  type NativeServicePlan,
  type NativeServicePlanService,
  type ProductionNativeServicePlanInput,
} from "./servicePlan.js";
import { renderLaunchdPlist, renderSystemdUnit } from "./serviceRendering.js";

const zsh = {
  name: "zsh",
  executable: "/bin/zsh",
  source: "detected",
  detectedExecutable: "/bin/zsh",
} as const;

function developmentPlan(kind: "systemd" | "launchd"): NativeServicePlan {
  return createDevelopmentNativeServicePlan({
    backend: { kind, label: kind },
    shell: zsh,
    environment: { PI_WEB_CONFIG: "/home/user/config with \"quote\".json" },
    workingDirectory: "/checkout with space",
    packageJsonPath: "/checkout with space/package.json",
  });
}

function planService(plan: NativeServicePlan, index: number): NativeServicePlanService {
  const service = plan.services[index];
  if (service === undefined) throw new Error(`Missing service at index ${String(index)}`);
  return service;
}

/**
 * ACCEPTANCE A5: the rendered unit execs the launcher by absolute path — never an interpreter
 * chosen at install time — so the runtime stays decidable at start, including through the unit's
 * own Environment= (PI_WEB_RUNTIME) without reinstalling.
 */
function launcherInput(kind: "systemd" | "launchd"): ProductionNativeServicePlanInput {
  return {
    backend: { kind, label: kind },
    shell: zsh,
    environment: { PI_WEB_CONFIG: "/home/user/config.json" },
    executables: {
      sessiond: {
        configuredCommand: undefined,
        namedCommand: "pi-web-sessiond",
        bundledLauncherPath: "/package with space/pi-web-sessiond's.sh",
      },
      web: {
        configuredCommand: undefined,
        namedCommand: "pi-web-server",
        bundledLauncherPath: "/package/dist/bin/pi-web-server.sh",
      },
    },
  };
}

async function bundledLauncherPlan(kind: "systemd" | "launchd"): Promise<NativeServicePlan> {
  const probe: NativeServiceAuthoritativeProbe = {
    run: (request) => Promise.resolve({
      kind: "completed",
      outcomes: request.prerequisites.map((prerequisite) => ({
        prerequisiteId: prerequisite.id,
        status: "unsatisfied",
        detail: null,
      })),
    }),
  };
  const resolution = await resolveProductionNativeServicePlan(launcherInput(kind), {
    probe,
    fileExists: () => true,
  });
  if (!resolution.ok) throw new Error(`Expected the bundled launcher plan to resolve: ${JSON.stringify(resolution.failures)}`);
  return resolution.plan;
}

describe("native service rendering", () => {
  it("renders a production plan whose unit execs the bundled launcher", async () => {
    const systemdPlan = await bundledLauncherPlan("systemd");
    const unit = renderSystemdUnit(systemdPlan, planService(systemdPlan, 0));
    // The launcher path goes through shell single-quoting and then systemd's own escaping, so a
    // path with a space and a quote must survive both layers verbatim.
    expect(unit).toContain(String.raw`-lc "exec '/package with space/pi-web-sessiond'\\''s.sh'"`);
    expect(unit).not.toContain("node ");

    const launchdPlan = await bundledLauncherPlan("launchd");
    const plist = renderLaunchdPlist(launchdPlan, planService(launchdPlan, 1), "/logs");
    expect(plist).toContain("<string>exec &apos;/package/dist/bin/pi-web-server.sh&apos;</string>");
    expect(plist).not.toContain("<string>node");
  });

  it("renders systemd entirely from the canonical plan", () => {
    const plan = developmentPlan("systemd");
    const unit = renderSystemdUnit(plan, planService(plan, 1));

    expect(unit).toContain("Description=PI WEB UI dev server");
    expect(unit).toContain("After=pi-web-sessiond.service\nWants=pi-web-sessiond.service");
    expect(unit).toContain("WorkingDirectory=/checkout\\x20with\\x20space");
    expect(unit).toContain('Environment="PI_WEB_CONFIG=/home/user/config with \\"quote\\".json"');
    expect(unit).toContain('ExecStart=/usr/bin/env "/bin/zsh" -lc "exec /usr/bin/env bash -c \'trap \\"kill 0\\" EXIT;');
    expect(unit).toContain("Restart=no");
  });

  it("escapes systemd specifiers and line controls without changing directives", () => {
    const plan = createDevelopmentNativeServicePlan({
      backend: { kind: "systemd", label: "systemd" },
      shell: {
        name: "bash",
        executable: "/shell $HOME/%h/bash",
        source: "detected",
        detectedExecutable: "/shell $HOME/%h/bash",
      },
      environment: { PI_WEB_CONFIG: "/config/%h\nEnvironment=INJECTED=yes" },
      workingDirectory: "/checkout %h\nwith newline",
      packageJsonPath: "/checkout/package.json",
    });
    const unit = renderSystemdUnit(plan, planService(plan, 0));

    expect(unit).toContain("WorkingDirectory=/checkout\\x20%%h\\nwith\\x20newline");
    expect(unit).toContain('Environment="PI_WEB_CONFIG=/config/%%h\\nEnvironment=INJECTED=yes"');
    expect(unit).toContain('ExecStart=/usr/bin/env "/shell $$HOME/%%h/bash"');
    expect(unit.match(/^Environment=/gmu)).toHaveLength(1);
  });

  it("renders launchd entirely from the canonical plan", () => {
    const plan = developmentPlan("launchd");
    const plist = renderLaunchdPlist(plan, planService(plan, 0), "/logs");

    expect(plist).toContain("<string>com.pi-web.sessiond</string>");
    expect(plist).toContain("<string>/bin/zsh</string>");
    expect(plist).toContain("<string>exec npm run start:sessiond</string>");
    expect(plist).toContain("<key>WorkingDirectory</key>\n  <string>/checkout with space</string>");
    expect(plist).toContain("<key>PI_WEB_CONFIG</key>\n    <string>/home/user/config with &quot;quote&quot;.json</string>");
    expect(plist.match(/<string>\/logs\/sessiond\.log<\/string>/gu)).toHaveLength(2);
    expect(plist).not.toContain("<string>\\logs\\sessiond.log</string>");
    expect(plist).not.toContain("<key>KeepAlive</key>");
  });

  it("rejects a service from a different plan", () => {
    const first = developmentPlan("systemd");
    const second = developmentPlan("systemd");
    expect(() => renderSystemdUnit(first, planService(second, 0))).toThrow("not a member");
  });
});
