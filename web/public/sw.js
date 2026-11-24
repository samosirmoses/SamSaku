const CACHE = "samsaku-public-v1";
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(["/", "/icon.svg", "/manifest.webmanifest"])));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("samsaku-public-") && key !== CACHE).map(key => caches.delete(key)))));
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin || url.search || event.request.headers.has("authorization") || event.request.headers.has("X-Dev-Token")) return;
  if (event.request.mode === "navigate" && url.pathname === "/") {
    event.respondWith(fetch(event.request).catch(() => caches.match("/")));
  } else if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(caches.open(CACHE).then(async cache => {
      const hit = await cache.match(event.request);
      if (hit) return hit;
      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    }));
  }
});
