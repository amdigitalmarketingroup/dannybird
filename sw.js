/* Service worker de Danny Bird — cache-first para que el juego sea instalable y
 * jugable offline. Bump CACHE al cambiar assets para invalidar la versión vieja. */
const CACHE = 'dannybird-v7';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './game.js',
  './manifest.webmanifest',
  './assets/player.png',
  './assets/player2.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // El ranking (/api/...) SIEMPRE va a la red, NUNCA al cache: son datos en vivo.
  // (Bug previo: cache-first cacheaba el GET /api/scores y "envenenaba" el ranking
  //  con una respuesta vieja vacía, aunque el POST guardara bien. Por eso no salía.)
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request)); // si no hay red, falla → el juego muestra "no se pudo cargar"
    return;
  }

  // Estáticos del juego: cache-first (instalable + jugable offline).
  e.respondWith(
    caches.match(e.request).then((hit) =>
      hit ||
      fetch(e.request)
        .then((res) => {
          // cachear assets propios nuevos (same-origin), best-effort
          if (res.ok && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match('./index.html')) // fallback offline
    )
  );
});
