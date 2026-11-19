import { DEFAULT_SETTINGS } from './planner.js';
import { MINUTE } from './session.js';

function dayWake(date, wakeTime) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = wakeTime.split(':').map(Number);
  const wake = new Date(year, month - 1, day, hour, minute);
  if (wake.getFullYear() !== year || wake.getMonth() !== month - 1 || wake.getDate() !== day) {
    return null;
  }
  return wake;
}

function loggedWater(water, timestamp) {
  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const padded = [year, String(month).padStart(2, '0'), String(day).padStart(2, '0')].join('-');
  return water[padded] ?? water[[year, month, day].join('-')] ?? 0;
}

export function futureDayReminders(days, settings, now = Date.now(), water = {}) {
  const wakeTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(settings.wakeTime)
    ? settings.wakeTime : DEFAULT_SETTINGS.wakeTime;
  const sleepHours = Number.isFinite(settings.sleepHours)
    ? Math.min(9, Math.max(7, settings.sleepHours)) : DEFAULT_SETTINGS.sleepHours;
  const waterLitres = Number.isFinite(settings.waterLitres)
    ? Math.min(3, Math.max(2, settings.waterLitres)) : DEFAULT_SETTINGS.waterLitres;
  const reminders = new Map();

  function add(id, at, title, body, tag) {
    if (!Number.isFinite(at) || at <= now) return;
    reminders.set(id, { id, at: Math.round(at), title, body, tag });
  }

  for (const day of days.slice(0, 14)) {
    const wake = dayWake(day.date, wakeTime);
    if (!wake) continue;
    const bedtime = new Date(wake);
    bedtime.setDate(bedtime.getDate() + 1);
    bedtime.setMinutes(bedtime.getMinutes() - sleepHours * 60);
    const review = day.windowEnd ?? wake.getTime() + (20 - sleepHours) * 60 * MINUTE;

    add('morning-' + day.date, wake.getTime(), 'Morning check-in',
      'Check your sleep and energy, then choose today’s pace.', 'morning-checkin');
    add('evening-' + day.date, review, 'Time to review your day',
      'Record how you feel and check what you finished.', 'evening-checkin');

    const glasses = Math.ceil(waterLitres * 4);
    const cadence = (bedtime.getTime() - wake.getTime()) / (glasses + 1);
    for (let glass = 1; glass <= glasses; glass++) {
      const at = Math.round(wake.getTime() + glass * cadence);
      if (loggedWater(water, at) >= waterLitres * 1000) continue;
      add('water-' + at, at, 'Pause for water',
        'Take a sip and log a glass if you drink one.', 'water');
    }

    if (day.isRest) continue;
    for (const block of day.blocks) {
      if (block.kind !== 'focus') continue;
      add('plan-' + block.id, block.start, 'Time to lock in',
        String(block.title).slice(0, 240), 'plan');
    }
  }

  return [...reminders.values()].sort((first, second) => first.at - second.at);
}
