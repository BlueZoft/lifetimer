function supportsPush() {
  if (!('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window)) {
    throw new Error('Background push needs a supported browser on HTTPS or localhost.');
  }
}

function serviceWorker() {
  supportsPush();
  return navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready);
}

async function serverKey() {
  try {
    const response = await fetch('/api/push/key', { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error();
    const { publicKey } = await response.json();
    return Uint8Array.from(atob(publicKey.replaceAll('-', '+').replaceAll('_', '/')),
      character => character.charCodeAt(0));
  } catch {
    throw new Error('LifeTimer’s reminder server is unavailable.');
  }
}

function sameKey(subscription, key) {
  const subscribedKey = new Uint8Array(subscription.options.applicationServerKey);
  return key.length === subscribedKey.length && key.every((byte, index) => byte === subscribedKey[index]);
}

export async function existingSubscription() {
  const registration = await serviceWorker();
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription || Notification.permission !== 'granted') return null;
  return sameKey(subscription, await serverKey()) ? subscription : null;
}

export async function subscribe() {
  // Request permission directly from the button gesture, including on iOS.
  supportsPush();
  if (await Notification.requestPermission() !== 'granted') {
    throw new Error('Allow notifications for LifeTimer in your browser to enable this.');
  }
  const registration = await serviceWorker();
  const key = await serverKey();
  const existing = await registration.pushManager.getSubscription();
  if (existing && sameKey(existing, key)) return existing;
  try {
    if (existing) await existing.unsubscribe();
    return await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: key,
    });
  } catch {
    throw new Error('The browser could not connect to its push service.');
  }
}

export async function saveReminders(subscription, reminders) {
  try {
    const response = await fetch('/api/push/schedule', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription, reminders }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error();
  } catch {
    throw new Error('The reminder schedule could not be saved. Check that the server is running.');
  }
}
