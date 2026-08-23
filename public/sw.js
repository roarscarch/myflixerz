// Service worker: installable app + instant shell.
//
// Strategy:
//  - precache the app shell (index.html + css/js) at install
//  - navigations: network-first, fall back to the cached shell (offline)
//  - static assets: cache-first
//  - API + /play: NEVER cached (auth'd tokens, range requests, live data)
const CACHE = 'myflixerz-v1';
const SHELL = ['/', '/css/style.css', '/js/api.js', '/js/player.js', '/js/app.js', '/manifest.webmanifest', '/icons/icon.svg'];

// everything the app fetches from our own API — network only
const NETWORK_ONLY = /^\/(?:play|download|sources|servers|dubs|search|info|recent|trending|movies|tv|genre|top-imdb|health|movie\/embed|tv\/embed)(?:\/|\?|$)/;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // pass external/CDN through
  if (NETWORK_ONLY.test(url.pathname)) return;

  if (e.request.mode === 'navigate') {
    // offline-capable shell: try network, fall back to cached page
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // static assets: cache-first, then network + store
  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy));
          }
          return res;
        })
    )
  );
});
