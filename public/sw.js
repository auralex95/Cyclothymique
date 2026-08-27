/**
 * Service worker minimal : il met en cache la coquille de l'application pour que
 * l'icône PWA s'ouvre même si le serveur est momentanément absent (on affiche
 * alors le voile "serveur injoignable" plutôt qu'une erreur Safari).
 *
 * Attention : on ne met JAMAIS en cache les échanges temps réel (WebSocket, /api).
 */
const CACHE = 'artnet-shell-v1';
const SHELL = [
  '.', 'index.html', 'style.css',
  'js/main.js', 'js/net.js', 'js/state.js', 'js/util.js',
  'js/components/fader.js', 'js/components/xypad.js', 'js/components/colorpicker.js',
  'js/views/control.js', 'js/views/patch.js', 'js/views/presets.js', 'js/views/fixtures.js',
  'js/views/network.js', 'js/views/monitor.js',
  '/shared/attributes.js',
  'manifest.webmanifest', 'icons/icon.svg'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Temps réel et API : toujours le réseau, jamais le cache.
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/socket.io')) return;
  // Le reste : réseau d'abord (on veut la dernière version), cache en secours.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
  );
});
