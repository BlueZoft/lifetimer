import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import webPush from 'web-push';

const PUBLIC_DIR = fileURLToPath(new URL('./public', import.meta.url));
const DEFAULT_DATA_DIR = fileURLToPath(new URL('./.lifetimer', import.meta.url));
// A fortnight plan can include a start date tomorrow and an overnight waking window.
const MAX_SCHEDULE_AHEAD = 16 * 24 * 60 * 60 * 1000;
const DELIVERY_GRACE = 2 * 60 * 1000;
const MAX_REMINDERS = 1800;
const MAX_BODY_BYTES = 512 * 1024;
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i;
const PUSH_HOSTS = new Set([
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
]);
const CONTENT_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return fallback();
  }
}

function writeJson(path, value) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporaryPath, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
    renameSync(temporaryPath, path);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

function parseUrl(value, base) {
  try {
    return new URL(value, base);
  } catch {
    return null;
  }
}

function parsePushEndpoint(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  const endpoint = parseUrl(value);
  const valid = endpoint?.protocol === 'https:'
    && !endpoint.port && !endpoint.username && !endpoint.password && !endpoint.hash
    && (PUSH_HOSTS.has(endpoint.hostname)
      || /^[a-z0-9-]+\.notify\.windows\.com$/.test(endpoint.hostname));
  return valid ? endpoint.href : null;
}

function isPushKey(value, bytes) {
  return typeof value === 'string' && value.length <= 88 && /^[a-zA-Z0-9_-]+={0,2}$/.test(value)
    && Buffer.from(value, 'base64url').length === bytes;
}

function shortString(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength;
}

function validateSchedule(input, now) {
  const { subscription, reminders } = input ?? {};
  const endpoint = parsePushEndpoint(subscription?.endpoint);
  if (!endpoint
    || !isPushKey(subscription?.keys?.p256dh, 65)
    || !isPushKey(subscription?.keys?.auth, 16)
    || !Array.isArray(reminders) || reminders.length > MAX_REMINDERS) return null;

  const cleanReminders = new Map();
  for (const reminder of reminders) {
    if (!shortString(reminder?.id, 120) || cleanReminders.has(reminder.id)
      || !Number.isSafeInteger(reminder.at) || reminder.at < 0 || reminder.at > now + MAX_SCHEDULE_AHEAD
      || !shortString(reminder.title, 100) || !shortString(reminder.body, 240)
      || !shortString(reminder.tag, 120)) return null;
    const { id, at, title, body, tag } = reminder;
    cleanReminders.set(id, { id, at, title, body, tag });
  }

  const { keys: { p256dh, auth } } = subscription;
  return {
    subscription: { endpoint, keys: { p256dh, auth } },
    reminders: [...cleanReminders.values()].filter(reminder => reminder.at + DELIVERY_GRACE > now),
  };
}

async function readRequestJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      request.resume();
      throw new RequestError(413, 'Schedule is too large.');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError(400, 'Invalid JSON.');
  }
}

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function respondJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': CONTENT_TYPES['.json'] });
  response.end(JSON.stringify(value));
}

function getAllowedOrigin(value) {
  if (!value) return null;
  const url = parseUrl(value);
  if (!url || url.protocol !== 'https:' || url.origin !== value) {
    throw new Error('LIFETIMER_ORIGIN must be an HTTPS origin with no trailing slash.');
  }
  return url;
}

function sameSubscription(first, second) {
  return first?.endpoint === second.endpoint
    && first?.keys.p256dh === second.keys.p256dh
    && first?.keys.auth === second.keys.auth;
}

export function createLifeTimerServer({
  dataDir = process.env.LIFETIMER_DATA_DIR || DEFAULT_DATA_DIR,
  origin = process.env.LIFETIMER_ORIGIN,
  subject = process.env.LIFETIMER_VAPID_SUBJECT || 'mailto:lifetimer@localhost',
  sendPush = webPush.sendNotification.bind(webPush),
} = {}) {
  const allowedOrigin = getAllowedOrigin(origin);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const keysPath = resolve(dataDir, 'vapid.json');
  const keys = readJson(keysPath, () => {
    const newKeys = webPush.generateVAPIDKeys();
    writeJson(keysPath, newKeys);
    return newKeys;
  });
  // Validate the contact and keys at startup without logging their values.
  webPush.setVapidDetails(subject, keys.publicKey, keys.privateKey);

  const schedulePath = resolve(dataDir, 'schedule.json');
  const emptySchedule = { subscription: null, reminders: [], sent: [] };
  let schedule = readJson(schedulePath, () => emptySchedule);
  let dispatching = false;

  function saveSchedule(nextSchedule) {
    writeJson(schedulePath, nextSchedule);
    schedule = nextSchedule;
  }

  function replaceSchedule(nextSchedule, now) {
    const existingSubscription = sameSubscription(schedule.subscription, nextSchedule.subscription);
    const sent = existingSubscription ? schedule.sent.filter(entry => entry.until > now) : [];
    const sentIds = new Set(sent.map(entry => entry.id));
    const pending = new Map(existingSubscription ? schedule.reminders.map(entry => [entry.id, entry]) : []);
    const reminders = nextSchedule.reminders
      .filter(entry => !sentIds.has(entry.id))
      .map(entry => {
        const existing = pending.get(entry.id);
        return existing?.at === entry.at ? { ...existing, ...entry } : entry;
      });
    saveSchedule({ ...nextSchedule, reminders, sent });
  }

  async function dispatchReminders() {
    if (dispatching || !schedule.subscription) return;
    dispatching = true;
    try {
      const now = Date.now();
      const { subscription, reminders, sent } = schedule;
      const active = reminders.filter(entry => entry.at + DELIVERY_GRACE > now);
      if (active.length !== reminders.length) saveSchedule({ subscription, reminders: active, sent });
      const due = active.filter(entry => (entry.retryAt ?? entry.at) <= now).slice(0, 8);
      await Promise.all(due.map(entry => deliverReminder(subscription, entry)));
    } catch {
      console.error('Could not process the LifeTimer push schedule.');
    } finally {
      dispatching = false;
    }
  }

  async function deliverReminder(subscription, entry) {
    const { id, title, body, tag } = entry;
    let status;
    try {
      const { statusCode } = await sendPush(subscription, JSON.stringify({ title, body, tag }), {
        TTL: Math.max(1, Math.ceil((entry.at + DELIVERY_GRACE - Date.now()) / 1000)),
        urgency: 'high',
        timeout: 10_000,
        vapidDetails: { subject, ...keys },
      });
      status = statusCode;
    } catch (error) {
      status = error.statusCode ?? 503;
    }

    if (!sameSubscription(schedule.subscription, subscription)) return;
    if (status === 404 || status === 410) {
      saveSchedule(emptySchedule);
      return;
    }
    const current = schedule.reminders.find(reminder => reminder.id === id);
    if (current?.at !== entry.at) return;

    let reminders = schedule.reminders.filter(reminder => reminder.id !== id);
    let sent = schedule.sent;
    if (status >= 200 && status < 300) {
      sent = [...sent.filter(receipt => receipt.until > Date.now()).slice(-3599),
        { id, until: Date.now() + MAX_SCHEDULE_AHEAD }];
    } else {
      const retryAt = Date.now() + 15_000;
      if ((status >= 500 || status === 429) && retryAt < entry.at + DELIVERY_GRACE) {
        reminders = [...reminders, { ...current, retryAt }];
      } else {
        console.error(`LifeTimer push could not be delivered (HTTP ${status}).`);
      }
    }
    saveSchedule({ subscription: schedule.subscription, reminders, sent });
  }

  async function respond(request, response) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');

    const host = request.headers.host ?? '';
    if (host !== allowedOrigin?.host && !LOOPBACK_HOST.test(host)) {
      throw new RequestError(403, 'Host is not configured for LifeTimer.');
    }
    const expectedOrigin = host === allowedOrigin?.host ? allowedOrigin.origin : `http://${host}`;
    const url = parseUrl(request.url, expectedOrigin);
    if (!url || url.origin !== expectedOrigin) throw new RequestError(400, 'Invalid request URL.');

    if (request.method === 'GET' && url.pathname === '/api/push/key') {
      return respondJson(response, 200, { publicKey: keys.publicKey });
    }
    if (request.method === 'PUT' && url.pathname === '/api/push/schedule') {
      if (request.headers.origin !== expectedOrigin) throw new RequestError(403, 'Origin is not allowed.');
      if (request.headers['content-type']?.split(';', 1)[0] !== 'application/json') {
        throw new RequestError(415, 'Send the schedule as JSON.');
      }
      const input = await readRequestJson(request);
      const now = Date.now();
      const validSchedule = validateSchedule(input, now);
      if (!validSchedule) throw new RequestError(400, 'Invalid push subscription or reminder schedule.');
      replaceSchedule(validSchedule, now);
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      throw new RequestError(405, 'Method not allowed.');
    }

    const pathname = decodeURIComponent(url.pathname);
    const path = resolve(PUBLIC_DIR, pathname === '/' ? 'index.html' : `.${pathname}`);
    if (!path.startsWith(`${PUBLIC_DIR}${sep}`)) throw new RequestError(404, 'File not found.');

    let contents;
    try {
      contents = await readFile(path);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) throw new RequestError(404, 'File not found.');
      throw error;
    }
    response.writeHead(200, {
      'Content-Type': CONTENT_TYPES[extname(path)] ?? 'application/octet-stream',
      'Content-Length': contents.length,
    });
    response.end(request.method === 'GET' ? contents : undefined);
  }

  const server = createServer((request, response) => {
    respond(request, response).catch(error => {
      if (error instanceof RequestError) return respondJson(response, error.status, { error: error.message });
      if (error instanceof URIError) return respondJson(response, 400, { error: 'Invalid request URL.' });
      console.error('LifeTimer request failed.');
      respondJson(response, 500, { error: 'LifeTimer could not complete the request.' });
    });
  });
  const timer = setInterval(dispatchReminders, 1000);
  timer.unref();
  server.on('close', () => clearInterval(timer));
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3000);
  const server = createLifeTimerServer();
  server.listen(port, host, () => {
    const address = host.includes(':') ? `[${host}]` : host;
    console.log(`LifeTimer is listening at http://${address}:${server.address().port}`);
  });
}
