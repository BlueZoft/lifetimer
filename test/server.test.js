import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createLifeTimerServer } from '../server.js';

const subscription = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/test-subscription',
  keys: {
    p256dh: Buffer.alloc(65, 4).toString('base64url'),
    auth: Buffer.alloc(16, 1).toString('base64url'),
  },
};

async function runningServer(dataDir, sendPush) {
  const server = createLifeTimerServer({ dataDir, origin: '', sendPush });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    stop: () => new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    }),
  };
}

function putSchedule(url, data, origin = url) {
  return fetch(`${url}/api/push/schedule`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify(data),
  });
}

function reminder(id, at = Date.now() + 5000) {
  return { id, at, title: 'Time to focus', body: 'Write the introduction', tag: id };
}

test('push schedule validates the provider and request origin, and an empty schedule clears it', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'lifetimer-push-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const { url, stop } = await runningServer(dataDir);
  t.after(stop);

  const response = await fetch(`${url}/api/push/key`);
  assert.equal(response.status, 200);
  const { publicKey } = await response.json();
  assert.equal(Buffer.from(publicKey, 'base64url').length, 65);

  const data = { subscription, reminders: [reminder('focus')] };
  assert.equal((await putSchedule(url, data, 'https://unrelated.example')).status, 403);
  assert.equal((await putSchedule(url, {
    ...data,
    subscription: { ...subscription, endpoint: 'https://unrelated.example/push' },
  })).status, 400);

  assert.equal((await putSchedule(url, data)).status, 204);
  assert.equal((await putSchedule(url, { ...data, reminders: [] })).status, 204);
  const saved = JSON.parse(await readFile(join(dataDir, 'schedule.json'), 'utf8'));
  assert.deepEqual(saved.reminders, []);
});

test('scheduled reminders deliver after restart and resyncing an unchanged plan does not resend', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'lifetimer-push-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));

  let firstDelivery;
  const delivered = new Promise(resolve => { firstDelivery = resolve; });
  const calls = [];
  async function sendPush(target, payload, options) {
    calls.push({ target, payload: JSON.parse(payload), options });
    firstDelivery();
    return { statusCode: 201 };
  }

  const initial = await runningServer(dataDir, sendPush);
  const originalKey = await (await fetch(`${initial.url}/api/push/key`)).json();
  const entry = reminder('focus-at-start', Date.now() + 1250);
  try {
    assert.equal((await putSchedule(initial.url, { subscription, reminders: [entry] })).status, 204);
  } finally {
    await initial.stop();
  }

  const restarted = await runningServer(dataDir, sendPush);
  t.after(restarted.stop);
  assert.deepEqual(await (await fetch(`${restarted.url}/api/push/key`)).json(), originalKey);
  const expired = AbortSignal.timeout(5000);
  await Promise.race([
    delivered,
    new Promise((_, reject) => expired.addEventListener('abort', () => reject(expired.reason), { once: true })),
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].target, subscription);
  assert.deepEqual(calls[0].payload, { title: entry.title, body: entry.body, tag: entry.tag });
  assert.equal(calls[0].options.vapidDetails.publicKey, originalKey.publicKey);

  assert.equal((await putSchedule(restarted.url, { subscription, reminders: [entry] })).status, 204);
  await delay(1200);
  assert.equal(calls.length, 1);
});

test('a fortnight queue survives restart, drops expired reminders, and can be cancelled', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'lifetimer-fortnight-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const calls = [];
  const sendPush = async (...args) => { calls.push(args); return { statusCode: 201 }; };
  const initial = await runningServer(dataDir, sendPush);
  const now = Date.now();
  const entries = [
    reminder('expired', now - 3 * 60_000),
    reminder('day-three', now + 3 * 24 * 60 * 60_000),
    reminder('day-fourteen', now + 14 * 24 * 60 * 60_000),
  ];
  try {
    assert.equal((await putSchedule(initial.url, { subscription, reminders: entries })).status, 204);
    assert.equal((await putSchedule(initial.url, {
      subscription,
      reminders: [reminder('outside-horizon', now + 17 * 24 * 60 * 60_000)],
    })).status, 400);
  } finally {
    await initial.stop();
  }

  const restarted = await runningServer(dataDir, sendPush);
  t.after(restarted.stop);
  const saved = JSON.parse(await readFile(join(dataDir, 'schedule.json'), 'utf8'));
  assert.deepEqual(saved.reminders, entries.slice(1));
  await delay(1100);
  assert.equal(calls.length, 0);
  assert.equal((await putSchedule(restarted.url, { subscription, reminders: [] })).status, 204);
  assert.deepEqual(JSON.parse(await readFile(join(dataDir, 'schedule.json'), 'utf8')).reminders, []);
});
