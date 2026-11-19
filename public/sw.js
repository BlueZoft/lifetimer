self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', event => {
  if (!event.data) return;

  const { title, body, tag } = event.data.json();
  event.waitUntil(self.registration.showNotification(title, { body, tag, icon: '/icon-192.png' }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const home = new URL('./', self.registration.scope);
    const app = windows.find(client => {
      const url = new URL(client.url);
      return url.origin === home.origin && url.pathname === home.pathname;
    });
    if (app) await app.focus();
    else await self.clients.openWindow(home.href);
  })());
});
