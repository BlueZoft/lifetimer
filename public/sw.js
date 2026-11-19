self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', event => {
  if (!event.data) return;

  const { title, body, tag } = event.data.json();
  event.waitUntil(self.registration.showNotification(title, { body, tag }));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const home = new URL('./', self.registration.scope).href;
    const app = windows.find(client => client.url === home);
    if (app) await app.focus();
    else await self.clients.openWindow(home);
  })());
});
