// Magdeburg Mobil — Service Worker v8
// - network-first for the app shell (updates arrive immediately)
// - cache-first for images/fonts, never caches live API data
// - Web Push: shows notifications from the server, opens the right tab on tap
const CACHE_NAME = 'mvb-magdeburg-cache-v9-16';
const CORE_URLS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/push.js',
  '/pwa.js',
  '/jinx-fx.js',
  '/live-map.js',
  '/season.js',
  '/settings.js',
  '/routes.js',
  '/maintenance.js',
  '/secret.js',
  '/formation.js',
  '/manifest.json',
  '/assets/icon.svg',
  '/assets/icon-192.png',
  '/assets/badge-72.png',
  '/assets/tram_mvb.png',
  '/assets/background_magdeburg.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      // Cache each file individually so one missing file doesn't break the install
      Promise.all(CORE_URLS.map(url => cache.add(url).catch(() => null)))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Live data and the admin area: always network, never cached
  if (url.pathname.includes('/api/') || url.pathname.startsWith('/admin')) return;

  const isStatic = /\.(png|jpe?g|svg|webp|gif|woff2?)$/i.test(url.pathname) || url.hostname.includes('fonts.g');

  if (isStatic) {
    event.respondWith(
      caches.match(req).then(cached => cached || fetch(req).then(res => {
        if (res && (res.ok || res.type === 'opaque')) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, copy));
        }
        return res;
      }))
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // App shell: network first, fall back to cache when offline
  event.respondWith(
    fetch(req).then(res => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE_NAME).then(c => c.put(req, copy));
      }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then(cached => cached || caches.match('/index.html')))
  );
});

// ---------------------------------------------------------------
// Push notifications
// ---------------------------------------------------------------
function apiBase() {
  // the static frontend on magdeburg-mobil.onrender.com talks to the Python backend
  return self.location.hostname.includes('magdeburg-mobil.onrender.com') ? 'https://mvb-app.onrender.com/api' : '/api';
}

self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = { title: 'Magdeburg Mobil', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Magdeburg Mobil';
  const options = {
    body: data.body || '',
    icon: '/assets/icon-192.png',
    badge: '/assets/badge-72.png',
    tag: data.tag || undefined,
    renotify: !!data.tag,
    requireInteraction: !!data.requireInteraction,
    vibrate: data.kind === 'reminder' ? [120, 60, 120, 60, 240] : [180, 80, 180],
    timestamp: Date.now(),
    data: { url: data.url || '/?tab=alerts' },
    actions: data.kind === 'disruption'
      ? [{ action: 'open', title: 'Details ansehen' }]
      : data.kind === 'reminder' ? [{ action: 'open', title: 'Abfahrten öffnen' }] : [],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  const tab = new URL(target, self.location.origin).searchParams.get('tab');
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = all.find(c => new URL(c.url).origin === self.location.origin);
    if (client) {
      await client.focus();
      if (tab) client.postMessage({ type: 'open-tab', tab });
      return;
    }
    await self.clients.openWindow(target);
  })());
});

// The browser rotated the subscription: register the new one with the server
self.addEventListener('pushsubscriptionchange', event => {
  event.waitUntil((async () => {
    try {
      const keyRes = await fetch(`${apiBase()}/push/key`);
      const { publicKey } = await keyRes.json();
      const pad = '='.repeat((4 - (publicKey.length % 4)) % 4);
      const raw = atob((publicKey + pad).replace(/-/g, '+').replace(/_/g, '/'));
      const sub = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: Uint8Array.from([...raw].map(c => c.charCodeAt(0))),
      });
      await fetch(`${apiBase()}/push/subscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subscription: sub.toJSON(), prefs: {} }),
      });
    } catch (e) {
      // the app re-syncs on next start anyway
    }
  })());
});
