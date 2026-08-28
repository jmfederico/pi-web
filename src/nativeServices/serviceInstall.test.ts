import { describe, expect, it, vi } from "vitest";
import {
  installNativeServiceCandidate,
  nativeServiceInstallFailureNeedsPathAdvice,
} from "./serviceInstall.js";
import type {
  NativeServiceAuthoritativeProbe,
  NativeServicePlan,
  NativeServiceProbeRequest,
  ProductionNativeServicePlanInput,
} from "./servicePlan.js";

const productionInput: ProductionNativeServicePlanInput = {
  backend: { kind: "systemd", label: "systemd user services" },
  shell: {
    name: "bash",
    executable: "/bin/bash",
    source: "detected",
    detectedExecutable: "/bin/bash",
  },
  environment: { PI_WEB_CONFIG: "/home/user/config.json" },
  executables: {
    sessiond: {
      configuredCommand: undefined,
      namedCommand: "pi-web-sessiond",
      bundledLauncherPath: "/package/dist/bin/pi-web-sessiond.sh",
    },
    web: {
      configuredCommand: undefined,
      namedCommand: "pi-web-server",
      bundledLauncherPath: "/package/dist/bin/pi-web-server.sh",
    },
  },
};

function successfulProbe(events: string[]): NativeServiceAuthoritativeProbe {
  return {
    run: (request) => {
      events.push(`probe:${request.purpose}`);
      return Promise.resolve({
        kind: "completed",
        outcomes: request.prerequisites.map((prerequisite) => ({
          prerequisiteId: prerequisite.id,
          status: "satisfied" as const,
          detail: null,
        })),
      });
    },
  };
}

describe("native service install orchestration", () => {
  it("resolves and validates the complete plan before writing config or replacing services", async () => {
    const events: string[] = [];
    const writeInitialConfig = vi.fn(() => { events.push("write-config"); return Promise.resolve(); });
    const replaceServices = vi.fn((plan: NativeServicePlan) => {
      events.push(`replace:${plan.mode}`);
      return Promise.resolve();
    });

    const result = await installNativeServiceCandidate(
      { mode: "production", input: productionInput },
      {
        probe: successfulProbe(events),
        fileExists: () => false,
        writeInitialConfig,
        replaceServices,
      },
    );

    expect(result.ok).toBe(true);
    expect(events).toEqual([
      "probe:executable-selection",
      "probe:plan-validation",
      "write-config",
      "replace:production",
    ]);
    expect(writeInitialConfig).toHaveBeenCalledOnce();
    expect(replaceServices).toHaveBeenCalledWith(expect.objectContaining({ mode: "production" }));
  });

  it("validates manager and shell readiness without executing configured overrides", async () => {
    const writeInitialConfig = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const replaceServices = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const requests: NativeServiceProbeRequest[] = [];
    const configuredInput: ProductionNativeServicePlanInput = {
      ...productionInput,
      executables: {
        sessiond: { ...productionInput.executables.sessiond, configuredCommand: "custom-sessiond --flag" },
        web: { ...productionInput.executables.web, configuredCommand: "custom-web --flag" },
      },
    };

    const result = await installNativeServiceCandidate(
      { mode: "production", input: configuredInput },
      {
        probe: {
          run: (request) => {
            requests.push(request);
            return Promise.resolve({ kind: "infrastructure-failure", reason: "manager", message: "manager unavailable" });
          },
        },
        fileExists: () => false,
        writeInitialConfig,
        replaceServices,
      },
    );

    expect(result).toMatchObject({ ok: false, failure: { kind: "plan-validation" } });
    if (result.ok) throw new Error("Expected manager validation failure");
    expect(nativeServiceInstallFailureNeedsPathAdvice(result.failure)).toBe(false);
    expect(requests).toEqual([expect.objectContaining({ purpose: "plan-validation", prerequisites: [] })]);
    expect(writeInitialConfig).not.toHaveBeenCalled();
    expect(replaceServices).not.toHaveBeenCalled();
  });

  it("does not make durable changes when exact plan requirements are unsatisfied", async () => {
    const writeInitialConfig = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const replaceServices = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const probe: NativeServiceAuthoritativeProbe = {
      run: (request: NativeServiceProbeRequest) => Promise.resolve({
        kind: "completed",
        outcomes: request.prerequisites.map((prerequisite) => ({
          prerequisiteId: prerequisite.id,
          status: request.purpose === "plan-validation" ? "unsatisfied" : "satisfied",
          detail: "not visible in the service manager environment",
        })),
      }),
    };

    const result = await installNativeServiceCandidate(
      { mode: "production", input: productionInput },
      { probe, fileExists: () => false, writeInitialConfig, replaceServices },
    );

    expect(result).toMatchObject({ ok: false, failure: { kind: "plan-validation" } });
    if (result.ok || result.failure.kind !== "plan-validation") throw new Error("Expected validation failure");
    expect(result.failure.failures).not.toHaveLength(0);
    expect(result.failure.failures.every((failure) => failure.kind === "prerequisite-unsatisfied")).toBe(true);
    expect(nativeServiceInstallFailureNeedsPathAdvice(result.failure)).toBe(true);
    expect(writeInitialConfig).not.toHaveBeenCalled();
    expect(replaceServices).not.toHaveBeenCalled();
  });

  it("does not mislabel probe infrastructure failures or write anything", async () => {
    const writeInitialConfig = vi.fn<() => Promise<void>>(() => Promise.resolve());
    const replaceServices = vi.fn<() => Promise<void>>(() => Promise.resolve());

    const result = await installNativeServiceCandidate(
      { mode: "production", input: productionInput },
      {
        probe: {
          run: () => Promise.resolve({
            kind: "infrastructure-failure",
            reason: "timeout",
            message: "service manager probe timed out",
          }),
        },
        fileExists: () => true,
        writeInitialConfig,
        replaceServices,
      },
    );

    expect(result).toEqual({
      ok: false,
      failure: {
        kind: "plan-resolution",
        failures: [{
          kind: "probe-infrastructure",
          serviceIds: ["sessiond", "web"],
          reason: "timeout",
          message: "service manager probe timed out",
        }],
      },
    });
    if (result.ok) throw new Error("Expected infrastructure failure");
    expect(nativeServiceInstallFailureNeedsPathAdvice(result.failure)).toBe(false);
    expect(writeInitialConfig).not.toHaveBeenCalled();
    expect(replaceServices).not.toHaveBeenCalled();
  });
});
