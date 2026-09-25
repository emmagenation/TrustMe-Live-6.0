/* Trust Me alerts worker. It only handles alerts: no caching, so it can never serve a stale copy of the app. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

const APPLE = /iPhone|iPad|iPod|Macintosh/.test(self.navigator.userAgent);   // Safari revokes alerts if a push arrives and nothing is shown

self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (_) {}
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (!APPLE && wins.some(w => w.visibilityState === 'visible')) {       // the app is open in front of them: it already updates itself
      wins.forEach(w => w.postMessage({ type: 'push' })); return;
    }
    await self.registration.showNotification(d.title || 'Trust Me', {
      body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag,       // same booking or chat: replace, do not stack
      icon: '/icon-192.png', data: d.data || {}
    });
  })());
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const open = (e.notification.data || {}).open || '';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {                                                // app already open somewhere: bring it forward and tell it where to go
      try { await w.focus(); w.postMessage({ type: 'open', open }); return; } catch (_) {}
    }
    await self.clients.openWindow('/?open=' + encodeURIComponent(open));
  })());
});
