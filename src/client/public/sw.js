// PI WEB service worker — intentionally minimal on fetches, full-featured for push.
//
// No fetch handling on purpose: the app streams live session data (HTTP and WebSocket) and relies
// on the network, so intercepting requests here could only add stale or broken traffic.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

/** A visible PI WEB window already reports what happened; pushes must not compete with it. */
async function hasVisibleWindowClient() {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  return clients.some((client) => client.visibilityState === "visible");
}

/** Render server-pushed notifications (assistant message completions and session errors). */
self.addEventListener("push", (event) => {
  let data;
  try {
    data = event.data ? event.data.json() : undefined;
  } catch {
    data = undefined; // Malformed payloads must never break the worker.
  }
  const title = typeof data?.title === "string" && data.title !== "" ? data.title : "PI WEB";
  const body = typeof data?.body === "string" ? data.body : "";
  const notificationData = data?.data && typeof data.data === "object" ? data.data : {};
  const sessionId = typeof notificationData.sessionId === "string" ? notificationData.sessionId : "";
  // Per-session tag: a newer notification replaces the previous one from the same session
  // instead of stacking, so a talkative agent leaves exactly one notification per chat.
  // Icon paths stay relative to the worker scope so nested deployments resolve inside their prefix.
  event.waitUntil((async () => {
    if (await hasVisibleWindowClient()) return; // The app is on screen; the in-app UI covers this.
    await self.registration.showNotification(title, {
      body,
      tag: sessionId !== "" ? `pi-web-${sessionId}` : "pi-web",
      icon: `${self.registration.scope}pwa-icon-192.png`,
      data: notificationData,
    });
  })());
});

/** The app came back to the foreground: close shown notifications (their moment has passed). */
self.addEventListener("message", (event) => {
  const type = event.data?.type;
  if (type === "pi-web:clear-push-notifications") {
    event.waitUntil((async () => {
      for (const notification of await self.registration.getNotifications()) notification.close();
    })());
    return;
  }
  // Ack of an in-app session open from a page that has the handler (see notificationclick).
  if (type === "pi-web:open-session-ack") {
    const requestId = typeof event.data?.requestId === "string" ? event.data.requestId : "";
    const pending = openSessionAcks.get(requestId);
    // WindowClient instances are per-message wrappers: identity comparison must go through the stable client id.
    if (pending !== undefined && pending.client.id === event.source?.id) {
      openSessionAcks.delete(requestId);
      pending.resolve(true);
    }
  }
});

/** Focus (or open) the app and route into the session that produced the notification. */
const openSessionAcks = new Map();
const OPEN_SESSION_ACK_TIMEOUT_MS = 800;

/** Ask one client to route in-app; resolve true on ack, false if the page predates the handler. */
function openSessionInClient(client, target) {
  const requestId = self.crypto.randomUUID();
  const acked = new Promise((resolve) => {
    const timer = setTimeout(() => {
      openSessionAcks.delete(requestId);
      resolve(false);
    }, OPEN_SESSION_ACK_TIMEOUT_MS);
    openSessionAcks.set(requestId, { client, resolve: (value) => {
      clearTimeout(timer);
      resolve(value);
    } });
  });
  client.postMessage({ type: "pi-web:open-session", sessionId: target.sessionId, cwd: target.cwd === "" ? undefined : target.cwd, projectId: target.projectId === "" ? undefined : target.projectId, workspaceId: target.workspaceId === "" ? undefined : target.workspaceId, requestId });
  return acked;
}

function notificationTarget(notification) {
  const data = notification.data && typeof notification.data === "object" ? notification.data : {};
  const readString = (key) => (typeof data[key] === "string" && data[key] !== "" ? data[key] : "");
  return { sessionId: readString("sessionId"), cwd: readString("cwd"), projectId: readString("projectId"), workspaceId: readString("workspaceId") };
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = notificationTarget(event.notification);
  const targetUrl = new URL(self.registration.scope);
  if (target.sessionId !== "") {
    targetUrl.searchParams.set("session", target.sessionId);
    if (target.projectId !== "") {
      // Canonical app route (?project=&workspace=&session=&view=chat): ids resolve everywhere,
      // no cwd join needed, and view=chat opens the conversation instead of a workspace panel.
      targetUrl.searchParams.set("project", target.projectId);
      if (target.workspaceId !== "") targetUrl.searchParams.set("workspace", target.workspaceId);
      targetUrl.searchParams.set("view", "chat");
    }
    // The cwd stays as fallback for pages that only understand the pre-ids join.
    if (target.cwd !== "") targetUrl.searchParams.set("cwd", target.cwd);
  }
  event.waitUntil((async () => {
    for (const client of await self.clients.matchAll({ type: "window", includeUncontrolled: true })) {
      try {
        await client.focus();
      } catch {
        continue; // Unreachable clients are skipped; the next one wins.
      }
      if (target.sessionId === "") return;
      // Prefer in-app routing (no reload, keeps unsent composer state); older pages never ack.
      if (await openSessionInClient(client, target)) return;
      try {
        await client.navigate(targetUrl.toString());
      } catch {
        // Same-URL or unsupported: the page is already where the notification pointed.
      }
      return;
    }
    if (target.sessionId !== "") return self.clients.openWindow(targetUrl.toString());
  })());
});
