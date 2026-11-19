function serviceWorker() {
  if (!('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window)) {
    throw new Error('Background push needs a supported browser on HTTPS or localhost.');
  }
  return navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready);
}

export async function existingSubscription() {
  const registration = await serviceWorker();
  return registration.pushManager.getSubscription();
}

export async function subscribe() {
  // Request permission directly from the button gesture, including on iOS.
  if (!('Notification' in window)) {
    throw new Error('Background notifications are unavailable in this browser.');
  }
  if (await Notification.requestPermission() !== 'granted') {
    throw new Error('Allow notifications for LifeTimer in your browser to enable this.');
  }
  const registration = await serviceWorker();
  const existing = await registration.pushManager.getSubscription();
  if (existing) return existing;

  const response = await fetch('/api/push/key');
  if (!response.ok) throw new Error('LifeTimer’s reminder server is unavailable.');
  const { publicKey } = await response.json();
  try {
    return await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: publicKey,
    });
  } catch {
    throw new Error('The browser could not connect to its push service.');
  }
}

export async function saveReminders(subscription, reminders) {
  const response = await fetch('/api/push/schedule', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription, reminders }),
  });
  if (!response.ok) throw new Error('The reminder schedule could not be saved. Check that the server is running.');
}
