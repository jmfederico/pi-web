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

  const { title, body, tag, url, ...data } = payload ?? {};

  // Skip the OS notification if a visible, focused client already has this
  // session open — they'll see completion in-app, and an extra OS popup on
  // top of an actively-watched tab is just noise (desktop background tabs
  // remain "visible: false" so they still get notified).
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const alreadyVisible = clients.some((client) => client.visibilityState === "visible" && (url === undefined || client.url.includes(url)));
  if (alreadyVisible) return;

  await self.registration.showNotification(title ?? "PI WEB", {
    body: body ?? "",
    icon: "/pwa-icon-192.png",
    badge: "/pwa-icon-192.png",
    tag: tag ?? "agent-end",
    data: { url: url ?? "/", ...data },
    requireInteraction: false,
    vibrate: [200, 100, 200],
  });
}

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url ?? "/";

  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) => {
        // Focus an existing window if available
        for (const client of clients) {
          if (client.url.includes(url) && "focus" in client) {
            return client.focus();
          }
        }
        // Otherwise open a new one
        if (self.clients.openWindow) {
          return self.clients.openWindow(url);
        }
      }),
  );
});
