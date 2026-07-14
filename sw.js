/* PWA: network-first для HTML/JS/CSS — иначе после деплоя чёрный экран из старого кэша. */
const CACHE = "mc-v21";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./assets/background.webp",
  "./assets/background-mob.webp",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;

  const isShell = /\.(js|css|html|webmanifest)$/i.test(url.pathname) || url.pathname.endsWith("/") || url.pathname.endsWith("/kira_for_managers");

  if (isShell) {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then((cached) => cached || fetch(e.request).then((res) => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => cached))
  );
});

self.addEventListener("push", (e) => {
  let data = { title: "Кира Ai", body: "Новое сообщение", url: "./" };
  try {
    if (e.data) data = Object.assign(data, e.data.json());
  } catch (_) {
    try {
      data.body = e.data ? e.data.text() : data.body;
    } catch (__) {}
  }
  const title = data.title || "Кира Ai";
  const opts = {
    body: data.body || "",
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    tag: data.tag || "kira-push",
    data: { url: data.url || "./" },
    renotify: true,
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ("focus" in client) {
          client.focus();
          if ("navigate" in client) {
            try { client.navigate(target); } catch (_) {}
          }
          return;
        }
      }
      if (clients.openWindow) return clients.openWindow(target);
    })
  );
});
