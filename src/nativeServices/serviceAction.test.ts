import { describe, expect, it } from "vitest";
import type { RunningComponentId } from "../piWebVersionReport.js";
import {
  awaitServicesReady,
  launchdBootoutArgs,
  launchdBootstrapArgs,
  launchdEnableArgs,
  launchdKickstartArgs,
  launchdPrintArgs,
  launchdServiceTarget,
  orderServices,
  performServiceAction,
  readinessComponentForService,
  restartLaunchdService,
  ServiceCommandError,
  serviceRestartOrder,
  serviceStartOrder,
  serviceStopOrder,
  settleLaunchdServiceUnload,
  startLaunchdService,
  systemctlUserActionArgs,
  type LaunchdServiceContext,
  type LifecycleServiceRef,
  type ServiceActionDeps,
  type ServiceActionTiming,
} from "./serviceAction.js";
import { nativeServiceManagerRefs, type NativeServiceBackend, type NativeServiceId } from "./servicePlan.js";

const systemdBackend: NativeServiceBackend = { kind: "systemd", label: "systemd user services" };
const launchdBackend: NativeServiceBackend = { kind: "launchd", label: "LaunchAgents" };

function ref(id: NativeServiceId): LifecycleServiceRef {
  return { id, ...nativeServiceManagerRefs[id] };
}

function allRefs(): LifecycleServiceRef[] {
  return [ref("sessiond"), ref("web"), ref("uiDev")];
}

const launchdContext: LaunchdServiceContext = {
  domain: "gui/501",
  plistPath: (service) => `/LaunchAgents/${service.launchdPlistName}`,
};

interface RecordedCall {
  command: string;
  args: string[];
}

interface FakeEnvironmentOptions {
  runStatus?: (command: string, args: string[]) => number;
  quietStatus?: (command: string, args: string[]) => number;
  running?: (service: LifecycleServiceRef) => boolean;
  ready?: (component: RunningComponentId) => boolean;
}

interface FakeEnvironment {
  calls: RecordedCall[];
  sleeps: number[];
  probedComponents: RunningComponentId[];
  deps: ServiceActionDeps;
}

/** Injected boundary fakes: recorded commands, instant sleeps, scripted probes. */
function fakeEnvironment(options: FakeEnvironmentOptions = {}): FakeEnvironment {
  const calls: RecordedCall[] = [];
  const sleeps: number[] = [];
  const probedComponents: RunningComponentId[] = [];
  const deps: ServiceActionDeps = {
    run: (command, args) => {
      calls.push({ command, args });
      return options.runStatus?.(command, args) ?? 0;
    },
    runQuiet: (command, args) => {
      calls.push({ command, args });
      return options.quietStatus?.(command, args) ?? 0;
    },
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
    isServiceRunning: (service) => options.running?.(service) ?? true,
    isComponentReady: (component) => {
      probedComponents.push(component);
      return Promise.resolve(options.ready?.(component) ?? true);
    },
  };
  return { calls, sleeps, probedComponents, deps };
}

/** Script `launchctl print` statuses in call order (the last one repeats); every other verb succeeds. */
function launchdPrintSequence(statuses: readonly number[]): (command: string, args: string[]) => number {
  let printIndex = 0;
  return (_command, args) => {
    if (args[0] !== "print") return 0;
    const status = statuses[Math.min(printIndex, statuses.length - 1)] ?? 1;
    printIndex += 1;
    return status;
  };
}

const settleTiming: ServiceActionTiming = { launchdUnloadSettleTimeoutMs: 4, launchdUnloadSettleIntervalMs: 1 };
const readinessTiming: ServiceActionTiming = { readinessTimeoutMs: 3, readinessIntervalMs: 1 };

describe("service manager argument construction", () => {
  it("builds the systemctl user action vector", () => {
    expect(systemctlUserActionArgs("restart", ["pi-web.service", "pi-web-sessiond.service"])).toEqual([
      "--user",
      "restart",
      "pi-web.service",
      "pi-web-sessiond.service",
    ]);
  });

  it("builds exact launchctl vectors", () => {
    expect(launchdBootoutArgs("gui/501/com.pi-web.web")).toEqual(["bootout", "gui/501/com.pi-web.web"]);
    expect(launchdPrintArgs("gui/501/com.pi-web.web")).toEqual(["print", "gui/501/com.pi-web.web"]);
    expect(launchdBootstrapArgs("gui/501", "/LaunchAgents/com.pi-web.web.plist")).toEqual([
      "bootstrap",
      "gui/501",
      "/LaunchAgents/com.pi-web.web.plist",
    ]);
    expect(launchdEnableArgs("gui/501/com.pi-web.web")).toEqual(["enable", "gui/501/com.pi-web.web"]);
    expect(launchdKickstartArgs("gui/501/com.pi-web.web")).toEqual(["kickstart", "gui/501/com.pi-web.web"]);
  });

  it("targets a service inside the user gui domain", () => {
    expect(launchdServiceTarget("gui/501", ref("web"))).toBe("gui/501/com.pi-web.web");
  });
});

describe("orderServices", () => {
  it("keeps the deliberate lifecycle orders", () => {
    expect(serviceStartOrder).toEqual(["sessiond", "web", "uiDev"]);
    expect(serviceStopOrder).toEqual(["web", "uiDev", "sessiond"]);
    // Restart handles web/UI before sessiond so a restart issued from a pi-web
    // terminal (killed by the sessiond restart) has already restarted the rest.
    expect(serviceRestartOrder).toEqual(["web", "uiDev", "sessiond"]);
  });

  it("orders present services and drops missing ones", () => {
    expect(orderServices(allRefs(), serviceRestartOrder).map((service) => service.id)).toEqual(["web", "uiDev", "sessiond"]);
    expect(orderServices([ref("sessiond"), ref("uiDev")], serviceRestartOrder).map((service) => service.id)).toEqual([
      "uiDev",
      "sessiond",
    ]);
  });
});

describe("readinessComponentForService", () => {
  it("maps API-serving services to the web component and sessiond to itself", () => {
    expect(readinessComponentForService("web")).toBe("web");
    expect(readinessComponentForService("uiDev")).toBe("web");
    expect(readinessComponentForService("sessiond")).toBe("sessiond");
  });
});

describe("settleLaunchdServiceUnload", () => {
  it("settles immediately when the label was never loaded", async () => {
    const env = fakeEnvironment({ quietStatus: launchdPrintSequence([1]) });
    const settled = await settleLaunchdServiceUnload("gui/501/com.pi-web.web", env.deps, settleTiming);
    expect(settled).toBe(true);
    expect(env.calls.filter((call) => call.args[0] === "print")).toHaveLength(1);
    expect(env.sleeps).toEqual([]);
  });

  it("waits until the asynchronous unload completes", async () => {
    const env = fakeEnvironment({ quietStatus: launchdPrintSequence([0, 0, 1]) });
    const settled = await settleLaunchdServiceUnload("gui/501/com.pi-web.web", env.deps, settleTiming);
    expect(settled).toBe(true);
    expect(env.calls.filter((call) => call.args[0] === "print")).toHaveLength(3);
    expect(env.sleeps).toEqual([1, 1]);
  });

  it("times out truthfully when the label never disappears", async () => {
    const env = fakeEnvironment({ quietStatus: launchdPrintSequence([0]) });
    const settled = await settleLaunchdServiceUnload("gui/501/com.pi-web.web", env.deps, settleTiming);
    expect(settled).toBe(false);
    // Four budgeted polls plus the final check, with a sleep between polls.
    expect(env.calls.filter((call) => call.args[0] === "print")).toHaveLength(5);
    expect(env.sleeps).toEqual([1, 1, 1, 1]);
  });
});

describe("startLaunchdService", () => {
  it("bootstraps and enables an unloaded label, then kickstarts", () => {
    const env = fakeEnvironment({ quietStatus: launchdPrintSequence([1]) });
    startLaunchdService(ref("web"), launchdContext, env.deps);
    expect(env.calls).toEqual([
      { command: "launchctl", args: ["print", "gui/501/com.pi-web.web"] },
      { command: "launchctl", args: ["bootstrap", "gui/501", "/LaunchAgents/com.pi-web.web.plist"] },
      { command: "launchctl", args: ["enable", "gui/501/com.pi-web.web"] },
      { command: "launchctl", args: ["kickstart", "gui/501/com.pi-web.web"] },
    ]);
  });

  it("only kickstarts an already-loaded label", () => {
    const env = fakeEnvironment({ quietStatus: launchdPrintSequence([0]) });
    startLaunchdService(ref("web"), launchdContext, env.deps);
    expect(env.calls).toEqual([
      { command: "launchctl", args: ["print", "gui/501/com.pi-web.web"] },
      { command: "launchctl", args: ["kickstart", "gui/501/com.pi-web.web"] },
    ]);
  });

  it("throws ServiceCommandError and skips kickstart when bootstrap fails", () => {
    const env = fakeEnvironment({
      quietStatus: launchdPrintSequence([1]),
      runStatus: (_command, args) => (args[0] === "bootstrap" ? 36 : 0),
    });
    expect(() => {
      startLaunchdService(ref("web"), launchdContext, env.deps);
    }).toThrow(ServiceCommandError);
    expect(env.calls.map((call) => call.args[0])).toEqual(["print", "bootstrap"]);
  });
});

describe("restartLaunchdService", () => {
  it("bootouts, settles, then bootstraps and kickstarts once unloaded", async () => {
    // Print answers: still loaded right after bootout, unloaded on the second
    // poll, still unloaded at the post-settle start check.
    const env = fakeEnvironment({ quietStatus: launchdPrintSequence([0, 1, 1]) });
    await restartLaunchdService(ref("web"), launchdContext, env.deps, settleTiming);
    expect(env.calls).toEqual([
      { command: "launchctl", args: ["bootout", "gui/501/com.pi-web.web"] },
      { command: "launchctl", args: ["print", "gui/501/com.pi-web.web"] },
      { command: "launchctl", args: ["print", "gui/501/com.pi-web.web"] },
      { command: "launchctl", args: ["print", "gui/501/com.pi-web.web"] },
      { command: "launchctl", args: ["bootstrap", "gui/501", "/LaunchAgents/com.pi-web.web.plist"] },
      { command: "launchctl", args: ["enable", "gui/501/com.pi-web.web"] },
      { command: "launchctl", args: ["kickstart", "gui/501/com.pi-web.web"] },
    ]);
  });

  it("surfaces kickstart failure when the label never settles", async () => {
    const env = fakeEnvironment({
      quietStatus: launchdPrintSequence([0]),
      runStatus: (_command, args) => (args[0] === "kickstart" ? 1 : 0),
    });
    await expect(restartLaunchdService(ref("web"), launchdContext, env.deps, settleTiming)).rejects.toThrow(
      ServiceCommandError,
    );
  });
});

describe("awaitServicesReady", () => {
  it("returns immediately without sleeping when everything is already ready", async () => {
    const env = fakeEnvironment();
    const unready = await awaitServicesReady(allRefs(), env.deps, readinessTiming);
    expect(unready).toEqual([]);
    expect(env.sleeps).toEqual([]);
    // Probed in the order the refs were passed in.
    expect(env.probedComponents).toEqual(["sessiond", "web", "web"]);
  });
});

describe("performServiceAction", () => {
  it("restarts systemd units in one manager job ordered web, uiDev, sessiond, with no launchd steps", async () => {
    const env = fakeEnvironment();
    const result = await performServiceAction(
      { backend: systemdBackend, action: "restart", refs: allRefs(), launchdContext },
      env.deps,
      readinessTiming,
    );
    expect(result.unreadyServices).toEqual([]);
    expect(env.calls).toEqual([
      { command: "systemctl", args: ["--user", "restart", "pi-web.service", "pi-web-ui-dev.service", "pi-web-sessiond.service"] },
    ]);
    expect(env.probedComponents).toEqual(["web", "web", "sessiond"]);
  });

  it("starts systemd units in start order", async () => {
    const env = fakeEnvironment();
    const result = await performServiceAction(
      { backend: systemdBackend, action: "start", refs: allRefs(), launchdContext },
      env.deps,
      readinessTiming,
    );
    expect(result.unreadyServices).toEqual([]);
    expect(env.calls).toEqual([
      { command: "systemctl", args: ["--user", "start", "pi-web-sessiond.service", "pi-web.service", "pi-web-ui-dev.service"] },
    ]);
  });

  it("stops systemd units in stop order and skips the readiness gate", async () => {
    const env = fakeEnvironment();
    const result = await performServiceAction(
      { backend: systemdBackend, action: "stop", refs: allRefs(), launchdContext },
      env.deps,
      readinessTiming,
    );
    expect(result.unreadyServices).toEqual([]);
    expect(env.calls).toEqual([
      { command: "systemctl", args: ["--user", "stop", "pi-web.service", "pi-web-ui-dev.service", "pi-web-sessiond.service"] },
    ]);
    expect(env.probedComponents).toEqual([]);
  });

  it("throws when the systemctl job fails", async () => {
    const env = fakeEnvironment({ runStatus: () => 4 });
    await expect(
      performServiceAction({ backend: systemdBackend, action: "restart", refs: allRefs(), launchdContext }, env.deps, readinessTiming),
    ).rejects.toThrow(ServiceCommandError);
  });

  it("restarts each LaunchAgent fully before the next, in web, uiDev, sessiond order", async () => {
    // Every label is already unloaded when polled, so each service bootstraps fresh.
    const env = fakeEnvironment({ quietStatus: launchdPrintSequence([1]) });
    const result = await performServiceAction(
      { backend: launchdBackend, action: "restart", refs: allRefs(), launchdContext },
      env.deps,
      readinessTiming,
    );
    expect(result.unreadyServices).toEqual([]);
    // Per service: bootout, settle poll, post-settle start check, bootstrap,
    // enable, kickstart — each service fully restarted before the next.
    expect(env.calls).toEqual([
      { command: "launchctl", args: ["bootout", "gui/501/com.pi-web.web"] },
      { command: "launchctl", args: ["print", "gui/501/com.pi-web.web"] },
      { command: "launchctl", args: ["print", "gui/501/com.pi-web.web"] },
      { command: "launchctl", args: ["bootstrap", "gui/501", "/LaunchAgents/com.pi-web.web.plist"] },
      { command: "launchctl", args: ["enable", "gui/501/com.pi-web.web"] },
      { command: "launchctl", args: ["kickstart", "gui/501/com.pi-web.web"] },
      { command: "launchctl", args: ["bootout", "gui/501/com.pi-web.ui-dev"] },
      { command: "launchctl", args: ["print", "gui/501/com.pi-web.ui-dev"] },
      { command: "launchctl", args: ["print", "gui/501/com.pi-web.ui-dev"] },
      { command: "launchctl", args: ["bootstrap", "gui/501", "/LaunchAgents/com.pi-web.ui-dev.plist"] },
      { command: "launchctl", args: ["enable", "gui/501/com.pi-web.ui-dev"] },
      { command: "launchctl", args: ["kickstart", "gui/501/com.pi-web.ui-dev"] },
      { command: "launchctl", args: ["bootout", "gui/501/com.pi-web.sessiond"] },
      { command: "launchctl", args: ["print", "gui/501/com.pi-web.sessiond"] },
      { command: "launchctl", args: ["print", "gui/501/com.pi-web.sessiond"] },
      { command: "launchctl", args: ["bootstrap", "gui/501", "/LaunchAgents/com.pi-web.sessiond.plist"] },
      { command: "launchctl", args: ["enable", "gui/501/com.pi-web.sessiond"] },
      { command: "launchctl", args: ["kickstart", "gui/501/com.pi-web.sessiond"] },
    ]);
  });

  it("starts LaunchAgents in start order without bootout", async () => {
    const env = fakeEnvironment({ quietStatus: launchdPrintSequence([0]) });
    const result = await performServiceAction(
      { backend: launchdBackend, action: "start", refs: [ref("sessiond"), ref("web")], launchdContext },
      env.deps,
      readinessTiming,
    );
    expect(result.unreadyServices).toEqual([]);
    expect(env.calls).toEqual([
      { command: "launchctl", args: ["print", "gui/501/com.pi-web.sessiond"] },
      { command: "launchctl", args: ["kickstart", "gui/501/com.pi-web.sessiond"] },
      { command: "launchctl", args: ["print", "gui/501/com.pi-web.web"] },
      { command: "launchctl", args: ["kickstart", "gui/501/com.pi-web.web"] },
    ]);
  });

  it("stops LaunchAgents in stop order without settle or readiness checks", async () => {
    const env = fakeEnvironment();
    const result = await performServiceAction(
      { backend: launchdBackend, action: "stop", refs: allRefs(), launchdContext },
      env.deps,
      readinessTiming,
    );
    expect(result.unreadyServices).toEqual([]);
    expect(env.calls).toEqual([
      { command: "launchctl", args: ["bootout", "gui/501/com.pi-web.web"] },
      { command: "launchctl", args: ["bootout", "gui/501/com.pi-web.ui-dev"] },
      { command: "launchctl", args: ["bootout", "gui/501/com.pi-web.sessiond"] },
    ]);
    expect(env.probedComponents).toEqual([]);
  });

  it("reports a manager-running service whose user-facing endpoint never becomes ready", async () => {
    const env = fakeEnvironment({ ready: (component) => component !== "web" });
    const result = await performServiceAction(
      { backend: systemdBackend, action: "restart", refs: [ref("web"), ref("sessiond")], launchdContext },
      env.deps,
      readinessTiming,
    );
    expect(result.unreadyServices.map((service) => service.id)).toEqual(["web"]);
    expect(env.sleeps).toEqual([1, 1, 1]);
  });

  it("reports a service that never reaches manager-reported running without probing its component", async () => {
    const env = fakeEnvironment({ running: (service) => service.id !== "sessiond" });
    const result = await performServiceAction(
      { backend: systemdBackend, action: "restart", refs: [ref("web"), ref("sessiond")], launchdContext },
      env.deps,
      readinessTiming,
    );
    expect(result.unreadyServices.map((service) => service.id)).toEqual(["sessiond"]);
    expect(env.probedComponents).toEqual(["web"]);
  });

  it("flags a launchd restart whose kickstart succeeded against a label that vanished anyway", async () => {
    // The issue #151 race: bootout's unload never settles during the wait, the
    // kickstart against the still-resolving record exits 0, and the label is
    // gone afterwards. The readiness gate must catch what the old
    // fire-and-forget path reported as success.
    const env = fakeEnvironment({
      quietStatus: launchdPrintSequence([0]),
      running: () => false,
    });
    const result = await performServiceAction(
      { backend: launchdBackend, action: "restart", refs: [ref("web")], launchdContext },
      env.deps,
      { launchdUnloadSettleTimeoutMs: 2, launchdUnloadSettleIntervalMs: 1, readinessTimeoutMs: 3, readinessIntervalMs: 1 },
    );
    expect(result.unreadyServices.map((service) => service.id)).toEqual(["web"]);
    expect(env.calls).toContainEqual({ command: "launchctl", args: ["kickstart", "gui/501/com.pi-web.web"] });
  });

  it("does nothing when no services are selected", async () => {
    const env = fakeEnvironment();
    const result = await performServiceAction(
      { backend: systemdBackend, action: "restart", refs: [], launchdContext },
      env.deps,
      readinessTiming,
    );
    expect(result.unreadyServices).toEqual([]);
    expect(env.calls).toEqual([]);
  });
});
