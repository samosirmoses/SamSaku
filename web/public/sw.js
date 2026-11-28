const CACHE = "samsaku-public-v2";
const CACHE_PREFIX = "samsaku-public-";
const PRECACHE_URLS = ["/icon.svg", "/manifest.webmanifest"];

self.addEventListener("install", event => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(PRECACHE_URLS)));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(key => key.startsWith(CACHE_PREFIX) && key !== CACHE)
            .map(key => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const req = event.request;
  const url = new URL(req.url);
  if (
    req.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/v1/") ||
    url.pathname === "/health" ||
    url.search ||
    req.headers.has("authorization") ||
    req.headers.has("X-Dev-Token")
  ) {
    return;
  }

  const isHtmlNav =
    req.mode === "navigate" ||
    url.pathname === "/" ||
    (req.headers.get("accept") || "").includes("text/html");

  if (isHtmlNav) {
    event.respondWith(
      fetch(req)
        .then(res => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(cache => cache.put(req, copy));
          }
          return res;
        })
        .catch(async () => (await caches.match(req)) || (await caches.match("/")))
    );
    return;
  }

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.open(CACHE).then(async cache => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const response = await fetch(req);
        if (response.ok) await cache.put(req, response.clone());
        return response;
      })
    );
    return;
  }

  if (PRECACHE_URLS.includes(url.pathname)) {
    event.respondWith(
      caches.open(CACHE).then(async cache => {
        const cached = await cache.match(req);
        const networkPromise = fetch(req)
          .then(res => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || networkPromise;
      })
    );
  }
});
