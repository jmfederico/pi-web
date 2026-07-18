import { describe, expect, it, vi } from "vitest";
import {
  createDevelopmentNativeServicePlan,
  planValidationProbeRequests,
  resolveProductionNativeServicePlan,
  type NativeServiceAuthoritativeProbe,
  type NativeServiceProbeRequest,
  type NativeServiceProbeResult,
  type ProductionNativeServicePlanInput,
} from "./servicePlan.js";

const backend = { kind: "systemd", label: "systemd user services" } as const;
const shell = {
  name: "zsh",
  executable: "/bin/zsh",
  source: "detected",
  detectedExecutable: "/bin/zsh",
} as const;

function productionInput(): ProductionNativeServicePlanInput {
  return {
    backend,
    shell,
    environment: { PI_WEB_CONFIG: "/home/user/.config/pi-web/config.json" },
    executables: {
      sessiond: {
        configuredCommand: undefined,
        namedCommand: "pi-web-sessiond",
        bundledEntrypointPath: "/package/dist/server/sessiond.js",
      },
      web: {
        configuredCommand: undefined,
        namedCommand: "pi-web-server",
        bundledEntrypointPath: "/package/dist/server/index.js",
      },
    },
  };
}

function completedProbe(status: "satisfied" | "unsatisfied", detail: string | null = null): NativeServiceAuthoritativeProbe {
  return {
    run: (request) => Promise.resolve({
      kind: "completed",
      outcomes: request.prerequisites.map((prerequisite) => ({ prerequisiteId: prerequisite.id, status, detail })),
    }),
  };
}

describe("production native service planning", () => {
  it("selects named commands from one authoritative backend probe and carries their exact requirements", async () => {
    const requests: NativeServiceProbeRequest[] = [];
    const probe: NativeServiceAuthoritativeProbe = {
      run: (request) => {
        requests.push(request);
        return Promise.resolve({
          kind: "completed",
          outcomes: request.prerequisites.map((prerequisite) => ({
            prerequisiteId: prerequisite.id,
            status: "satisfied",
            detail: "/usr/local/bin/example",
          })),
        });
      },
    };

    const resolution = await resolveProductionNativeServicePlan(productionInput(), {
      probe,
      fileExists: () => false,
    });

    expect(requests).toEqual([
      {
        purpose: "executable-selection",
        backend,
        shell,
        environment: { PI_WEB_CONFIG: "/home/user/.config/pi-web/config.json" },
        workingDirectory: null,
        prerequisites: [
          expect.objectContaining({ id: "sessiond.command.pi-web-sessiond", kind: "command-available", command: "pi-web-sessiond" }),
          expect.objectContaining({ id: "web.command.pi-web-server", kind: "command-available", command: "pi-web-server" }),
        ],
      },
    ]);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error(JSON.stringify(resolution.failures));

    expect(resolution.plan).toMatchObject({
      mode: "production",
      backend,
      shell,
      services: [
        {
          id: "sessiond",
          manager: { systemdName: "pi-web-sessiond.service", launchdLabel: "com.pi-web.sessiond" },
          shellCommand: "exec pi-web-sessiond",
          strategy: { kind: "named-command", command: "pi-web-sessiond", selectedBy: "authoritative-backend-probe" },
          environment: { PI_WEB_CONFIG: "/home/user/.config/pi-web/config.json" },
          workingDirectory: null,
          after: [],
          wants: [],
          prerequisites: [
            { id: "sessiond.command.pi-web-sessiond", kind: "command-available", command: "pi-web-sessiond" },
            { id: "sessiond.node", kind: "node-version", command: "node", minimumVersion: "22.19.0" },
          ],
        },
        {
          id: "web",
          shellCommand: "exec pi-web-server",
          strategy: { kind: "named-command", command: "pi-web-server" },
          after: ["sessiond"],
          wants: ["sessiond"],
          prerequisites: [
            { id: "web.command.pi-web-server", kind: "command-available", command: "pi-web-server" },
            { id: "web.node", kind: "node-version", command: "node", minimumVersion: "22.19.0" },
          ],
        },
      ],
    });

    expect(planValidationProbeRequests(resolution.plan)).toMatchObject([
      {
        purpose: "plan-validation",
        backend,
        shell,
        workingDirectory: null,
        prerequisites: [
          { id: "sessiond.command.pi-web-sessiond" },
          { id: "sessiond.node" },
          { id: "web.command.pi-web-server" },
          { id: "web.node" },
        ],
      },
    ]);
  });

  it("preserves configured overrides verbatim and never probes or executes them", async () => {
    const input = productionInput();
    input.executables.sessiond.configuredCommand = "  /opt/pi web/run-sessiond --flag  ";
    input.executables.web.configuredCommand = "custom-web --serve";
    const run = vi.fn<(request: NativeServiceProbeRequest) => Promise<NativeServiceProbeResult>>();
    const fileExists = vi.fn<(path: string) => boolean>();

    const resolution = await resolveProductionNativeServicePlan(input, { probe: { run }, fileExists });

    expect(run).not.toHaveBeenCalled();
    expect(fileExists).not.toHaveBeenCalled();
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error(JSON.stringify(resolution.failures));
    expect(resolution.plan.services).toMatchObject([
      {
        id: "sessiond",
        shellCommand: "exec   /opt/pi web/run-sessiond --flag  ",
        strategy: {
          kind: "configured-override",
          command: "  /opt/pi web/run-sessiond --flag  ",
          verification: "unverified",
        },
        prerequisites: [],
      },
      {
        id: "web",
        shellCommand: "exec custom-web --serve",
        strategy: { kind: "configured-override", command: "custom-web --serve", verification: "unverified" },
        prerequisites: [],
      },
    ]);
    expect(planValidationProbeRequests(resolution.plan)).toEqual([{
      purpose: "plan-validation",
      backend,
      shell,
      environment: { PI_WEB_CONFIG: "/home/user/.config/pi-web/config.json" },
      workingDirectory: null,
      prerequisites: [],
    }]);
  });

  it("falls back per service to bundled entrypoints when named commands are unavailable", async () => {
    const input = productionInput();
    input.executables.sessiond.bundledEntrypointPath = "/package with space/sessiond's entry.js";
    const fileExists = vi.fn<(path: string) => boolean>(() => true);

    const resolution = await resolveProductionNativeServicePlan(input, {
      probe: completedProbe("unsatisfied", "command not found"),
      fileExists,
    });

    expect(fileExists).toHaveBeenCalledTimes(2);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error(JSON.stringify(resolution.failures));
    expect(resolution.plan.services[0]).toMatchObject({
      shellCommand: "exec node '/package with space/sessiond'\\''s entry.js'",
      strategy: {
        kind: "bundled-entrypoint",
        command: "node",
        namedCommand: "pi-web-sessiond",
        namedCommandFailure: "command not found",
      },
      prerequisites: [
        { id: "sessiond.node", kind: "node-version", command: "node", minimumVersion: "22.19.0" },
        { id: "sessiond.entrypoint", kind: "readable-file", path: "/package with space/sessiond's entry.js" },
      ],
    });
  });

  it("mixes configured, named, and bundled decisions without unrelated checks", async () => {
    const input = productionInput();
    input.executables.sessiond.configuredCommand = "custom-sessiond";
    const requests: NativeServiceProbeRequest[] = [];

    const resolution = await resolveProductionNativeServicePlan(input, {
      probe: {
        run: (request) => {
          requests.push(request);
          return Promise.resolve({
            kind: "completed",
            outcomes: [{ prerequisiteId: "web.command.pi-web-server", status: "unsatisfied", detail: null }],
          });
        },
      },
      fileExists: () => true,
    });

    expect(requests[0]?.prerequisites).toMatchObject([{ id: "web.command.pi-web-server", command: "pi-web-server" }]);
    expect(resolution.ok).toBe(true);
    if (resolution.ok) {
      expect(resolution.plan.services.map((service) => service.strategy.kind)).toEqual(["configured-override", "bundled-entrypoint"]);
    }
  });

  it("returns structured failures when neither production executable strategy is viable", async () => {
    const resolution = await resolveProductionNativeServicePlan(productionInput(), {
      probe: completedProbe("unsatisfied", "not found in service PATH"),
      fileExists: () => false,
    });

    expect(resolution).toEqual({
      ok: false,
      failures: [
        {
          kind: "executable-unavailable",
          serviceId: "sessiond",
          namedCommand: "pi-web-sessiond",
          namedCommandFailure: "not found in service PATH",
          bundledEntrypointPath: "/package/dist/server/sessiond.js",
        },
        {
          kind: "executable-unavailable",
          serviceId: "web",
          namedCommand: "pi-web-server",
          namedCommandFailure: "not found in service PATH",
          bundledEntrypointPath: "/package/dist/server/index.js",
        },
      ],
    });
  });

  it("does not reinterpret probe infrastructure failures as missing commands", async () => {
    const fileExists = vi.fn<(path: string) => boolean>(() => true);
    const resolution = await resolveProductionNativeServicePlan(productionInput(), {
      probe: {
        run: () => Promise.resolve({ kind: "infrastructure-failure", reason: "cleanup", message: "launchd probe cleanup failed" }),
      },
      fileExists,
    });

    expect(fileExists).not.toHaveBeenCalled();
    expect(resolution).toEqual({
      ok: false,
      failures: [{
        kind: "probe-infrastructure",
        serviceIds: ["sessiond", "web"],
        reason: "cleanup",
        message: "launchd probe cleanup failed",
      }],
    });
  });

  it("treats thrown and malformed probe results as infrastructure failures", async () => {
    const thrown = await resolveProductionNativeServicePlan(productionInput(), {
      probe: { run: () => Promise.reject(new Error("systemd-run failed")) },
      fileExists: () => true,
    });
    expect(thrown).toMatchObject({
      ok: false,
      failures: [{ kind: "probe-infrastructure", reason: "manager", message: "systemd-run failed" }],
    });

    const malformed = await resolveProductionNativeServicePlan(productionInput(), {
      probe: {
        run: () => Promise.resolve({
          kind: "completed",
          outcomes: [{ prerequisiteId: "sessiond.command.pi-web-sessiond", status: "satisfied", detail: null }],
        }),
      },
      fileExists: () => true,
    });
    expect(malformed).toMatchObject({
      ok: false,
      failures: [{ kind: "probe-infrastructure", reason: "malformed-output", message: "Authoritative probe returned no outcome for web.command.pi-web-server." }],
    });
  });
});

describe("development native service planning", () => {
  it("plans only the exact checkout commands and prerequisites", () => {
    const plan = createDevelopmentNativeServicePlan({
      backend: { kind: "launchd", label: "LaunchAgents" },
      shell: { name: "fish", executable: "/opt/homebrew/bin/fish", source: "detected", detectedExecutable: "/opt/homebrew/bin/fish" },
      environment: { PI_WEB_CONFIG: "/tmp/config.json" },
      workingDirectory: "/checkout with space",
      packageJsonPath: "/checkout with space/package.json",
    });

    expect(plan).toMatchObject({
      mode: "development",
      backend: { kind: "launchd" },
      shell: { name: "fish", executable: "/opt/homebrew/bin/fish" },
      services: [
        {
          id: "sessiond",
          shellCommand: "exec npm run start:sessiond",
          strategy: { kind: "development-npm-script", script: "start:sessiond" },
          restart: "never",
          environment: { PI_WEB_CONFIG: "/tmp/config.json" },
          workingDirectory: "/checkout with space",
          prerequisites: [
            { id: "sessiond.node", kind: "node-version", minimumVersion: "22.19.0" },
            { id: "sessiond.command.npm", kind: "command-available", command: "npm" },
            { id: "sessiond.package-scripts", kind: "package-scripts", scripts: ["start:sessiond"] },
          ],
        },
        {
          id: "uiDev",
          shellCommand: "exec /usr/bin/env bash -c 'trap \"kill 0\" EXIT; npm run dev:web & npm run dev:client & wait'",
          strategy: { kind: "development-npm-script-group", scripts: ["dev:web", "dev:client"], interpreter: "bash" },
          restart: "never",
          workingDirectory: "/checkout with space",
          after: ["sessiond"],
          wants: ["sessiond"],
          prerequisites: [
            { id: "uiDev.node", kind: "node-version", minimumVersion: "22.19.0" },
            { id: "uiDev.command.npm", kind: "command-available", command: "npm" },
            { id: "uiDev.command.bash", kind: "command-available", command: "bash" },
            { id: "uiDev.package-scripts", kind: "package-scripts", scripts: ["dev:web", "dev:client"] },
          ],
        },
      ],
    });

    const serviceCommandRequirements = plan.services.flatMap((service) => service.prerequisites)
      .filter((prerequisite) => prerequisite.kind === "command-available")
      .map((prerequisite) => prerequisite.command);
    expect(serviceCommandRequirements).toEqual(["npm", "npm", "bash"]);
    expect(serviceCommandRequirements).not.toContain("pi-web-server");
    expect(serviceCommandRequirements).not.toContain("pi-web-sessiond");

    expect(planValidationProbeRequests(plan)).toMatchObject([
      {
        backend: { kind: "launchd" },
        workingDirectory: "/checkout with space",
        prerequisites: [
          { id: "sessiond.node" },
          { id: "sessiond.command.npm" },
          { id: "sessiond.package-scripts" },
          { id: "uiDev.node" },
          { id: "uiDev.command.npm" },
          { id: "uiDev.command.bash" },
          { id: "uiDev.package-scripts" },
        ],
      },
    ]);
  });
});
