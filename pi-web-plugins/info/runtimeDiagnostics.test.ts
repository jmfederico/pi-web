import { describe, expect, it } from "vitest";
import type { PiWebComponentStatus, PiWebStatusResponse } from "@jmfederico/pi-web/plugin-api";
import { browserRuntimeLabel, componentDetails, diagnosticsSummary, redactUserPaths, runtimeLabel } from "./infoInternals.js";

describe("runtimeLabel", () => {
  it("names the runtime and its engine version", () => {
    expect(runtimeLabel(componentStatus({ runtime: "bun", runtimeEngine: "1.4.2" }))).toBe("Bun 1.4.2");
    expect(runtimeLabel(componentStatus({ runtime: "node", runtimeEngine: "v24.19.0" }))).toBe("Node.js v24.19.0");
  });

  it("still names the runtime when the engine version is missing", () => {
    expect(runtimeLabel(componentStatusWithoutEngine({ runtime: "bun" }))).toBe("Bun");
    expect(runtimeLabel(componentStatusWithoutEngine({ runtime: "node" }))).toBe("Node.js");
    expect(runtimeLabel(componentStatus({ runtime: "bun", runtimeEngine: "" }))).toBe("Bun");
  });

  it("reports an unreported runtime instead of inferring another component's runtime", () => {
    expect(runtimeLabel(componentStatusWithoutRuntime())).toBe("runtime unknown");
  });
});

describe("browserRuntimeLabel", () => {
  it("names Chromium browsers by their build (Edge reports itself as Chrome-compatible)", () => {
    expect(browserRuntimeLabel("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.60 Safari/537.36")).toBe("Chrome 142.0.7444");
    expect(browserRuntimeLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.60 Safari/537.36 Edg/142.0.3595.65")).toBe("Edge 142.0.3595");
  });

  it("detects Opera, which also advertises Chrome", () => {
    expect(browserRuntimeLabel("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/126.0.0.0")).toBe("Opera 126.0.0");
  });

  it("names Gecko and WebKit browsers", () => {
    expect(browserRuntimeLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0")).toBe("Firefox 133.0");
    expect(browserRuntimeLabel("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15")).toBe("Safari 18.1");
  });

  it("stays unknown when the browser is unrecognized or unreported", () => {
    expect(browserRuntimeLabel("")).toBe("unknown browser");
    expect(browserRuntimeLabel(undefined)).toBe("unknown browser");
    expect(browserRuntimeLabel("SomeCrawler/1.0")).toBe("unknown browser");
  });
});

describe("redactUserPaths", () => {
  it("shortens Linux, macOS, and root home directories to a tilde", () => {
    expect(redactUserPaths("/home/alice/dev/pi-web", "/home/alice")).toBe("~/dev/pi-web");
    expect(redactUserPaths("/Users/alice/dev/pi-web", "/Users/alice")).toBe("~/dev/pi-web");
    expect(redactUserPaths("/root/.pi-web/plugins", "/root")).toBe("~/.pi-web/plugins");
  });

  it("anonymizes the username outside the home directory", () => {
    expect(redactUserPaths("/srv/alice/checkout", "/home/alice")).toBe("/srv/<user>/checkout");
    expect(redactUserPaths("/opt/backups/alice/pi-web", "/home/alice")).toBe("/opt/backups/<user>/pi-web");
  });

  it("leaves paths that never mention the user untouched", () => {
    expect(redactUserPaths("/srv/dev/pi-web", "/home/alice")).toBe("/srv/dev/pi-web");
    expect(redactUserPaths("/usr/lib/node_modules", "/home/alice")).toBe("/usr/lib/node_modules");
  });

  it("does not rewrite a longer name that merely starts with the username", () => {
    expect(redactUserPaths("/home/alicia/dev", "/home/alice")).toBe("/home/alicia/dev");
    expect(redactUserPaths("/srv/alicia/checkout", "/home/alice")).toBe("/srv/alicia/checkout");
    expect(redactUserPaths("/home/alicealice/x", "/home/alice")).toBe("/home/alicealice/x");
    expect(redactUserPaths("/srv/alicealice/x", "/home/alice")).toBe("/srv/alicealice/x");
  });

  it("masks the username even when it repeats inside the home directory", () => {
    expect(redactUserPaths("/home/alice/alice/notes", "/home/alice")).toBe("~/<user>/notes");
  });

  it("redacts both the home and a username elsewhere in the same line", () => {
    expect(redactUserPaths("/home/alice/x and /srv/alice/y", "/home/alice")).toBe("~/x and /srv/<user>/y");
  });

  it("replaces every occurrence of the home prefix in a multi-line block", () => {
    const block = ["Path: /home/alice/dev/pi-web", "Other: /home/alice/.pi-web"].join("\n");
    expect(redactUserPaths(block, "/home/alice")).toBe(["Path: ~/dev/pi-web", "Other: ~/.pi-web"].join("\n"));
  });

  it("returns the text unchanged when no home directory is known", () => {
    expect(redactUserPaths("/home/alice/dev", undefined)).toBe("/home/alice/dev");
  });
});

describe("runtime in the panel component details", () => {
  it("includes the runtime even when the component does not report one", () => {
    expect(componentDetails(componentStatus())).toContain("Bun 1.4.2");
    expect(componentDetails(componentStatusWithoutRuntime())).toContain("runtime unknown");
  });
});

describe("diagnosticsSummary runtime reporting", () => {
  it("reports the runtime of both services and the browser", () => {
    const summary = diagnosticsSummary({ status: statusResponse(), userAgent: CHROME_UA });

    expect(summary).toContain("Web/UI: running 1.0.0 · installed 1.0.0 · pi 0.84.1 · Bun 1.4.2 · current");
    expect(summary).toContain("Session daemon: running 1.0.0 · installed 1.0.0 · pi 0.84.1 · Node.js v24.19.0 · current");
    expect(summary).toContain("Browser: Chrome 142.0.7444");
  });

  it("omits the browser line when the browser is unknown", () => {
    expect(diagnosticsSummary({ status: statusResponse(), userAgent: "" })).not.toContain("Browser:");
  });

  it("redacts both the home directory and the username when a home directory is supplied", () => {
    const summary = diagnosticsSummary({
      status: statusResponse(),
      workspace: workspace(),
      home: "/home/alice",
    });

    expect(summary).toContain("Workspace: pi-web — ~/dev/pi-web");
    expect(summary).not.toContain("alice");
  });
});

const CHROME_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.7444.60 Safari/537.36";

function componentStatus(patch: Partial<PiWebComponentStatus> = {}): PiWebComponentStatus {
  return {
    component: "web",
    label: "Web/UI",
    runtimeVersion: "1.0.0",
    installedVersion: "1.0.0",
    piVersion: "0.84.1",
    runtime: "bun",
    runtimeEngine: "1.4.2",
    stale: false,
    available: true,
    installation: { kind: "npm-global", path: "/usr/lib/node_modules" },
    ...patch,
  };
}

function statusResponse(): PiWebStatusResponse {
  return {
    packageName: "@jmfederico/pi-web",
    generatedAt: "2025-01-02T03:04:06Z",
    components: {
      web: componentStatus(),
      sessiond: componentStatus({ component: "sessiond", label: "Session daemon", runtime: "node", runtimeEngine: "v24.19.0" }),
    },
    release: { packageName: "@jmfederico/pi-web", updateAvailable: false },
    commands: {},
    messages: [],
  };
}

/** Component status whose runtime reporting is absent, as an older host reports. */
function componentStatusWithoutRuntime(): PiWebComponentStatus {
  const component = componentStatus();
  delete component.runtime;
  delete component.runtimeEngine;
  return component;
}

/** Component status on a runtime whose engine version is not reported. */
function componentStatusWithoutEngine(patch: Partial<PiWebComponentStatus>): PiWebComponentStatus {
  const component = componentStatus(patch);
  delete component.runtimeEngine;
  return component;
}

function workspace() {
  return {
    id: "ws-1",
    projectId: "proj-1",
    path: "/home/alice/dev/pi-web",
    label: "pi-web",
    isMain: true,
  };
}
