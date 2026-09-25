import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppUrlContext } from "./appUrl";
import {
  armForegroundNotificationClearing,
  registerPwaServiceWorker,
  resolveServiceWorkerUrl,
  type PwaWindowLike,
  type ServiceWorkerContainerLike,
  type ServiceWorkerRegistrationLike,
  type VisibilityDocumentLike,
} from "./pwaServiceWorker";

const rootHttpContext: AppUrlContext = {
  viteBaseUrl: "/",
  documentBaseUrl: "http://pi.example.test/",
};

const nestedHttpsContext: AppUrlContext = {
  viteBaseUrl: "./",
  documentBaseUrl: "https://pi.example.test/test/ai/",
};

function createLoadWindow(readyState: "loading" | "complete" = "loading"): { window: PwaWindowLike; fire: () => void } {
  let loadListener: (() => void) | undefined;
  const window: PwaWindowLike = {
    addEventListener(_type, listener): void {
      loadListener = listener;
    },
    document: { readyState },
  };
  return {
    window,
    fire: () => {
      loadListener?.();
    },
  };
}

function createContainer(register: ServiceWorkerContainerLike["register"]): ServiceWorkerContainerLike {
  return { register };
}

describe("resolveServiceWorkerUrl", () => {
  it("resolves at an HTTP root deployment", () => {
    expect(resolveServiceWorkerUrl(rootHttpContext)).toBe("http://pi.example.test/sw.js");
  });

  it("stays within a canonical nested HTTPS deployment prefix", () => {
    expect(resolveServiceWorkerUrl(nestedHttpsContext)).toBe("https://pi.example.test/test/ai/sw.js");
  });
});

describe("registerPwaServiceWorker", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips silently when no ServiceWorkerContainer is available", () => {
    const register = vi.fn();
    const loadWindow = createLoadWindow();
    expect(() =>
      { registerPwaServiceWorker({ navigatorObject: {}, windowObject: loadWindow.window, url: "http://pi.example.test/sw.js" }); },
    ).not.toThrow();
    loadWindow.fire();
    expect(register).not.toHaveBeenCalled();
  });

  it("registers only after the window load event", () => {
    const register = vi.fn().mockResolvedValue(undefined);
    const loadWindow = createLoadWindow();
    registerPwaServiceWorker({
      navigatorObject: { serviceWorker: createContainer(register) },
      windowObject: loadWindow.window,
      url: "http://pi.example.test/sw.js",
    });
    expect(register).not.toHaveBeenCalled();
    loadWindow.fire();
    expect(register).toHaveBeenCalledWith("http://pi.example.test/sw.js");
  });

  it("registers immediately when the document is already complete", () => {
    const register = vi.fn().mockResolvedValue(undefined);
    const doneWindow = createLoadWindow("complete");
    registerPwaServiceWorker({
      navigatorObject: { serviceWorker: createContainer(register) },
      windowObject: doneWindow.window,
      url: "http://pi.example.test/sw.js",
    });
    expect(register).toHaveBeenCalledOnce();
  });

  it("logs registration failures without throwing", async () => {
    const error = new Error("sw.js unavailable");
    const register = vi.fn().mockRejectedValue(error);
    const consoleDebug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const loadWindow = createLoadWindow();
    expect(() => {
      registerPwaServiceWorker({
        navigatorObject: { serviceWorker: createContainer(register) },
        windowObject: loadWindow.window,
        url: "http://pi.example.test/sw.js",
      });
      loadWindow.fire();
    }).not.toThrow();
    await vi.waitFor(() => { expect(consoleDebug).toHaveBeenCalledTimes(1); });
    expect(consoleDebug).toHaveBeenCalledWith(expect.stringContaining("service worker registration failed"), error);
  });

  it("arms foreground notification clearing on the settled registration", async () => {
    const postMessage = vi.fn();
    const register = vi.fn().mockResolvedValue({ active: { postMessage } } satisfies ServiceWorkerRegistrationLike);
    let visibilityListener: (() => void) | undefined;
    let visibilityState = "hidden";
    const doc: VisibilityDocumentLike = {
      get visibilityState() {
        return visibilityState;
      },
      addEventListener(_type, listener): void {
        visibilityListener = listener;
      },
    };
    vi.stubGlobal("document", doc);
    const doneWindow = createLoadWindow("complete");
    registerPwaServiceWorker({
      navigatorObject: { serviceWorker: createContainer(register) },
      windowObject: doneWindow.window,
      url: "http://pi.example.test/sw.js",
    });
    await vi.waitFor(() => { expect(visibilityListener).toBeDefined(); });

    visibilityListener?.();
    expect(postMessage).not.toHaveBeenCalled(); // still hidden: nothing to clear
    visibilityState = "visible";
    visibilityListener?.();
    expect(postMessage).toHaveBeenCalledWith({ type: "pi-web:clear-push-notifications" });
    vi.unstubAllGlobals();
  });
});

describe("armForegroundNotificationClearing", () => {
  it("is a silent no-op without a document", () => {
    expect(() => { armForegroundNotificationClearing({ active: { postMessage: () => undefined } }, undefined); }).not.toThrow();
  });

  it("tolerates a registration without an active worker", () => {
    let visibilityListener: (() => void) | undefined;
    const doc: VisibilityDocumentLike = {
      visibilityState: "visible",
      addEventListener(_type, listener): void {
        visibilityListener = listener;
      },
    };
    armForegroundNotificationClearing(undefined, doc);
    expect(() => {
      visibilityListener?.();
    }).not.toThrow();
  });
});
