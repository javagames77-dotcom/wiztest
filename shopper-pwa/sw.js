// ═══════════════════════════════════════════════════════════
// GhostAudit / Wizoria — Shopper PWA Service Worker
// ═══════════════════════════════════════════════════════════

const CACHE_NAME = 'ga-shopper-v15';
const APP_SHELL = [
  './index.html',
  './app.js?v=15',
  './manifest.json'
];

// ─── INSTALL: pre-cache app shell ─────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

// ─── ACTIVATE: clean up old caches ─────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(names => Promise.all(
      names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))
    )).then(() => self.clients.claim())
  );
});

// ─── FETCH ──────────────────────────────────────────────────
// App shell (index.html/app.js/manifest.json) → NETWORK-FIRST.
// This project is under active development: cache-first would silently keep
// serving an old, already-cached version of the app forever, even after the
// files are updated on the server — exactly the bug that cost real time to
// track down. Network-first always tries to fetch the latest file first, and
// only falls back to the cached copy if there's no connection at all, which
// still satisfies the offline requirement without freezing updates.
// API calls (n8n webhook) → always network, same as before.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  const isApiCall = url.hostname !== self.location.hostname;

  if (isApiCall) {
    event.respondWith(
      fetch(event.request).catch(() => new Response(
        JSON.stringify({ success: false, error: "Немає з'єднання з сервером" }),
        // X-GA-Offline: 1 — маркер саме для app.js: дає змогу відрізнити "сервер сам
        // відповів 503" від "мережі реально нема", не покладаючись на текст помилки
        { status: 503, headers: { 'Content-Type': 'application/json', 'X-GA-Offline': '1' } }
      ))
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(res => {
        // keep the cache fresh with whatever we just fetched, for offline fallback
        const resClone = res.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(event.request, resClone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});

// ─── PUSH ───────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  let payload = { title: 'Wizoria', body: 'Нове сповіщення' };
  try { payload = event.data ? event.data.json() : payload; } catch (_) {}

  event.waitUntil(
    self.registration.showNotification(payload.title || 'Wizoria', {
      body: payload.body || '',
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      vibrate: [100, 50, 100],
      data: payload.data || {}
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clientsArr => {
      const existing = clientsArr.find(c => c.url.includes(self.location.origin));
      if (existing) return existing.focus();
      return self.clients.openWindow('./index.html');
    })
  );
});
