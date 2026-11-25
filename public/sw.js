/* Service worker de OLI GROUP: solo notificaciones push (sin caché offline). */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: "OLI GROUP", body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "OLI GROUP";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || "",
      icon: "/pwa-icon/192",
      badge: "/pwa-icon/192",
      tag: data.tag || undefined,
      renotify: !!data.tag,
      requireInteraction: true,
      data: { url: data.url || "/dashboard/conversaciones" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/dashboard/conversaciones", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url.startsWith(self.location.origin) && "navigate" in c) {
          return c.navigate(target).then((w) => (w || c).focus());
        }
      }
      return self.clients.openWindow(target);
    })
  );
});
