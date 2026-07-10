// PI WEB Service Worker — handles Web Push notifications

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

async function handlePush(event) {
  let payload;
  try {
    payload = event.data?.json();
  } catch {
    payload = { title: "PI WEB", body: "Agent finished" };
  }

  const { title, body, tag, url, sessionId, machineId, cwd, ...data } = payload ?? {};

  // Skip the OS notification if a visible, focused client already has this
  // session open — they'll see completion in-app, and an extra OS popup on
  // top of an actively-watched tab is just noise (desktop background tabs
  // remain "visible: false" so they still get notified).
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const alreadyVisible = clients.some(
    (client) =>
      client.visibilityState === "visible" &&
      (sessionId !== undefined
        ? client.url.includes(`session=${encodeURIComponent(sessionId)}`)
        : url === undefined || client.url.includes(url)),
  );
  if (alreadyVisible) return;

  await self.registration.showNotification(title ?? "PI WEB", {
    body: body ?? "",
    icon: "/pwa-icon-192.png",
    badge: "/pwa-icon-192.png",
    tag: tag ?? "agent-end",
    data: { url: url ?? "/", sessionId, machineId, cwd, ...data },
    requireInteraction: false,
    vibrate: [200, 100, 200],
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data ?? {};
  const { sessionId, machineId, cwd } = data;

  // Build a session-aware URL from the notification data
  const params = new URLSearchParams();
  if (machineId && machineId !== "local") params.set("machine", machineId);
  if (cwd) params.set("workspace", cwd);
  if (sessionId) params.set("session", sessionId);
  const targetUrl = params.size > 0 ? `/?${params.toString()}` : (data.url ?? "/");

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then(async (clients) => {
        // Send a navigate message to existing PI WEB windows
        for (const client of clients) {
          try {
            client.postMessage({ type: "pi-web:navigate-session", sessionId, machineId, cwd });
          } catch {
            // ignore postMessage failures (e.g. client not ready)
          }
        }

        // Focus an existing window if available
        for (const client of clients) {
          if ((sessionId && client.url.includes(`session=${encodeURIComponent(sessionId)}`)) || client.url.includes(targetUrl)) {
            if ("focus" in client) {
              return client.focus();
            }
          }
        }
        // Fallback: focus any PI WEB window
        for (const client of clients) {
          if ("focus" in client) {
            return client.focus();
          }
        }

        // Otherwise open a new window with session context
        if (self.clients.openWindow) {
          return self.clients.openWindow(targetUrl);
        }
      }),
  );
});
