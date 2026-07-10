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
  const target = { sessionId, url };

  // Skip the OS notification if a visible, focused client already has this
  // session open — they'll see completion in-app, and an extra OS popup on
  // top of an actively-watched tab is just noise (desktop background tabs
  // remain "visible: false" so they still get notified).
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const alreadyVisible = clients.some((client) => client.visibilityState === "visible" && clientMatchesTarget(client, target));
  if (alreadyVisible) return;

  // Tag per-session (not a single shared tag) so multiple sessions finishing
  // while the app is closed stack as separate notifications instead of each
  // clobbering the last — the badge count below depends on that.
  await self.registration.showNotification(title ?? "PI WEB", {
    body: body ?? "",
    icon: "/pwa-icon-192.png",
    badge: "/pwa-icon-192.png",
    tag: tag ?? (sessionId !== undefined ? `agent-end:${sessionId}` : "agent-end"),
    data: { url: url ?? "/", sessionId, machineId, cwd, ...data },
    requireInteraction: false,
    vibrate: [200, 100, 200],
  });
  await updateBadge();
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data ?? {};
  const { sessionId, machineId, cwd } = data;
  const targetUrl = sessionRouteUrl({ machineId, cwd, sessionId, fallbackUrl: data.url });

  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });

      // Send a navigate message to existing PI WEB windows
      for (const client of clients) {
        try {
          client.postMessage({ type: "pi-web:navigate-session", sessionId, machineId, cwd });
        } catch {
          // ignore postMessage failures (e.g. client not ready)
        }
      }

      await updateBadge();

      // Focus an existing window if available
      const target = { sessionId, url: targetUrl };
      for (const client of clients) {
        if (clientMatchesTarget(client, target) && "focus" in client) return client.focus();
      }
      // Fallback: focus any PI WEB window
      for (const client of clients) {
        if ("focus" in client) return client.focus();
      }

      // Otherwise open a new window with session context
      if (self.clients.openWindow) return self.clients.openWindow(targetUrl);
      return undefined;
    })(),
  );
});

/** Builds the `/?machine=&workspace=&session=` route URL a notification or launch should land on. */
function sessionRouteUrl({ machineId, cwd, sessionId, fallbackUrl }) {
  const params = new URLSearchParams();
  if (machineId && machineId !== "local") params.set("machine", machineId);
  if (cwd) params.set("workspace", cwd);
  if (sessionId) params.set("session", sessionId);
  return params.size > 0 ? `/?${params.toString()}` : (fallbackUrl ?? "/");
}

/** Whether an open client window is already showing the given session/url. */
function clientMatchesTarget(client, { sessionId, url }) {
  if (sessionId !== undefined) return client.url.includes(`session=${encodeURIComponent(sessionId)}`);
  return url === undefined || client.url.includes(url);
}

/** Reflects the count of pending (unclicked) agent-finished notifications on the home-screen icon. */
async function updateBadge() {
  if (!("setAppBadge" in self.navigator)) return;
  try {
    const notifications = await self.registration.getNotifications();
    if (notifications.length > 0) await self.navigator.setAppBadge(notifications.length);
    else await self.navigator.clearAppBadge();
  } catch {
    // Badging API is best-effort — never let it fail the push/click handler.
  }
}
