import { resolveAppUrl, type AppUrlContext } from "./appUrl";

/** Structural view of the service-worker registration API this module drives. */
export interface ServiceWorkerContainerLike {
  register(url: string): Promise<ServiceWorkerRegistrationLike | null | undefined>;
}

/** Structural view of the settled registration: only the active worker's `postMessage` is used. */
export interface ServiceWorkerRegistrationLike {
  readonly active?: { postMessage(message: unknown): void } | null | undefined;
}

/** Minimal structural view of the document surface used to observe foreground transitions. */
export interface VisibilityDocumentLike {
  readonly visibilityState: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
}

/** Minimal structural view of the navigator surface this module uses. */
export interface PwaNavigatorLike {
  readonly serviceWorker?: ServiceWorkerContainerLike | undefined;
}

/** Minimal structural view of the window APIs registration scheduling touches. */
export interface PwaWindowLike {
  addEventListener(type: "load", listener: () => void): void;
  readonly document?: { readonly readyState: string } | undefined;
}

export interface RegisterPwaServiceWorkerOptions {
  /** Browser `navigator`, injected for testing. Defaults to the global when present. */
  readonly navigatorObject?: PwaNavigatorLike | undefined;
  /** Browser `window`, injected for testing. Registration runs immediately when absent or already loaded. */
  readonly windowObject?: PwaWindowLike | undefined;
  /** Absolute URL of the worker script. Defaults to resolving `sw.js` against the application base (requires a browser document). */
  readonly url?: string | undefined;
}

/**
 * Resolve the browser-ready absolute URL of the PI WEB service worker. The path stays
 * application-relative so nested reverse-proxy deployments keep their scope within the prefix.
 * Like {@link resolveAppUrl}, omitting the context reads browser globals, so tests should inject one.
 */
export function resolveServiceWorkerUrl(context?: AppUrlContext): string {
  return context === undefined ? resolveAppUrl("sw.js") : resolveAppUrl("sw.js", context);
}

/**
 * Register the PI WEB service worker once the page has finished loading.
 *
 * Best-effort by contract: an unavailable ServiceWorkerContainer (insecure contexts, unsupported
 * browsers) is skipped silently, and a failed registration is logged without ever breaking the app —
 * PI WEB must keep working with no service worker at all. A successful registration additionally
 * arms foreground clearing of shown push notifications via {@link armForegroundNotificationClearing}.
 */
export function registerPwaServiceWorker(options: RegisterPwaServiceWorkerOptions = {}): void {
  const navigatorObject = options.navigatorObject ?? (typeof navigator !== "undefined" ? navigator : undefined);
  if (navigatorObject?.serviceWorker === undefined) return;
  const container = navigatorObject.serviceWorker;
  const windowObject = options.windowObject;
  const url = options.url ?? resolveServiceWorkerUrl();

  const register = () => {
    void container
      .register(url)
      .then((registration) => {
        armForegroundNotificationClearing(registration);
      })
      .catch((error: unknown) => {
        console.debug("PI WEB service worker registration failed", error);
      });
  };

  if (windowObject === undefined || windowObject.document?.readyState === "complete") {
    register();
    return;
  }
  windowObject.addEventListener("load", register);
}

/**
 * Tell the active service worker to close shown push notifications whenever the page enters the
 * foreground: a push notification is only meaningful while the app is not visible, and stale rows
 * must not outlive the user's attention (the worker's push handler additionally skips new pushes
 * while a window is visible; this half covers notifications shown while the app was away).
 */
export function armForegroundNotificationClearing(
  registration: ServiceWorkerRegistrationLike | null | undefined,
  doc: VisibilityDocumentLike | undefined = typeof document !== "undefined" ? document : undefined,
): void {
  if (doc === undefined) return;
  doc.addEventListener("visibilitychange", () => {
    if (doc.visibilityState !== "visible") return;
    registration?.active?.postMessage({ type: "pi-web:clear-push-notifications" });
  });
}
