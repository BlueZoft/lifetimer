import test from 'node:test';
import assert from 'node:assert/strict';
import { futureDayReminders } from '../public/reminder-schedule.js';
import { DEFAULT_SETTINGS } from '../public/planner.js';

const local = (day, hour = 0, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const day = (date, isRest = false) => ({
  date: `2026-11-${date}`,
  windowStart: local(date, 8),
  windowEnd: local(date, 20),
  isRest,
  blocks: [{ id: `focus-task-${local(date, 8)}`, title: 'Write draft', kind: 'focus', start: local(date, 8) }],
});

test('queues stable future check-ins and water within waking hours across a fortnight', () => {
  const days = Array.from({ length: 14 }, (_, index) => day(index + 10));
  const reminders = futureDayReminders(days, DEFAULT_SETTINGS, local(10, 7));
  assert.equal(reminders.filter(item => item.id.startsWith('morning-')).length, 14);
  assert.equal(reminders.filter(item => item.id.startsWith('evening-')).length, 14);
  assert.equal(reminders.filter(item => item.id.startsWith('water-')).length, 140);
  assert.ok(reminders.some(item => item.at > local(12, 7)));
  assert.deepEqual(futureDayReminders(days, DEFAULT_SETTINGS, local(10, 7)), reminders);
  for (const item of reminders.filter(item => item.tag === 'water')) {
    assert.ok(item.at > new Date(item.at).setHours(8, 0, 0, 0));
    assert.ok(item.at < new Date(item.at).setHours(24, 0, 0, 0));
  }
});

test('rest days retain wellness prompts and completed hydration suppresses only its calendar day', () => {
  const reminders = futureDayReminders([day(10, true), day(11)], DEFAULT_SETTINGS,
    local(10, 12), { '2026-11-10': 2500 });
  assert.ok(reminders.every(item => item.at > local(10, 12)));
  assert.equal(reminders.filter(item => item.tag === 'water').length, 10);
  assert.equal(reminders.filter(item => item.tag === 'plan').length, 1);
  assert.equal(reminders.filter(item => item.tag === 'evening-checkin').length, 2);
});

test('an overnight waking window queues hydration between wake and the next local bedtime', () => {
  const reminders = futureDayReminders([{ ...day(10), windowEnd: local(11, 8) }],
    { ...DEFAULT_SETTINGS, wakeTime: '20:00' }, local(10, 19));
  const water = reminders.filter(item => item.tag === 'water');
  assert.equal(water.length, 10);
  assert.ok(water.every(item => item.at > local(10, 20) && item.at < local(11, 12)));
});
