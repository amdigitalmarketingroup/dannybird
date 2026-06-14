/* Service worker de Danny Bird — cache-first para que el juego sea instalable y
 * jugable offline. Bump CACHE al cambiar assets para invalidar la versión vieja. */
const CACHE = 'dannybird-v20';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './game.js',
  './manifest.webmanifest',
  './assets/player_bombita.png',
  './assets/fart_puff.png',
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
      .catch(() => {}) // si iOS rechaza un delete, no abortar la activación
      .then(() => self.clients.claim())
  );
});

// guarda en cache una copia OK same-origin (best-effort, no bloquea la respuesta)
function putCache(req, res, sameOrigin) {
  if (res && res.ok && sameOrigin) {
    const copy = res.clone();
    caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
  }
  return res;
}

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const sameOrigin = url.origin === self.location.origin;

  // 1) Ranking (/api): SIEMPRE va a la red, NUNCA al cache (datos en vivo).
  //    (Bug previo: cache-first cacheaba GET /api/scores y "envenenaba" el ranking
  //     con una respuesta vieja vacía, aunque el POST guardara bien.)
  if (sameOrigin && url.pathname.startsWith('/api')) {
    e.respondWith(fetch(e.request)); // sin red → falla → el juego muestra "no se pudo cargar"
    return;
  }

  // 2) Código propio (navegación + .html/.js/.css): NETWORK-FIRST con fallback a cache.
  //    Así un deploy nuevo se ve al instante sin depender de bumpear CACHE, pero sigue
  //    jugable offline con la última copia guardada.
  const isCode =
    e.request.mode === 'navigate' ||
    (sameOrigin && (url.pathname === '/' || /\.(html|js|css)$/.test(url.pathname)));
  if (isCode) {
    e.respondWith(
      fetch(e.request)
        .then((res) => putCache(e.request, res, sameOrigin))
        .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
    );
    return;
  }

  // 3) Resto (imágenes, iconos, manifest, fuentes): CACHE-FIRST (rara vez cambian).
  e.respondWith(
    caches.match(e.request).then((hit) =>
      hit ||
      fetch(e.request)
        .then((res) => putCache(e.request, res, sameOrigin))
        .catch(() => undefined)
    )
  );
});
