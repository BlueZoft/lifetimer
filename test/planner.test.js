import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, DEFAULT_SETTINGS } from '../public/planner.js';

const minute = 60_000;
const local = (day, hour, minutes = 0) => new Date(2026, 10, day, hour, minutes);

test('sets aside sleep plus four reserve hours and starts at the configured wake time', () => {
  for (const sleepHours of [7, 8, 9]) {
    const plan = buildPlan([], { ...DEFAULT_SETTINGS, sleepHours }, local(19, 6));
    const workable = (20 - sleepHours) * 60;
    assert.equal(plan.workMinutes, workable);
    assert.equal(plan.remainingMinutes, workable);
    assert.equal(plan.windowStart, local(19, 8).getTime());
    assert.equal(plan.windowEnd - plan.windowStart, workable * minute);
  }
});

test('schedules remaining task time in order and accounts for movement within and between sessions', () => {
  const tasks = [
    { id: 'a', title: 'Draft', minutes: 60, completedMinutes: 15 },
    { id: 'b', title: 'Review', minutes: 20 },
    { id: 'c', title: 'Filed', minutes: 10, completedMinutes: 10 },
  ];
  const plan = buildPlan(tasks, DEFAULT_SETTINGS, local(19, 8));
  assert.deepEqual(plan.blocks.map(block => [block.taskId, block.kind, block.minutes]), [
    ['a', 'focus', 40], ['a', 'break', 5],
    ['a', 'focus', 5], ['a', 'break', 5],
    ['b', 'focus', 20], ['b', 'break', 5],
  ]);
  assert.equal(plan.blocks[0].end, local(19, 8, 45).getTime());
  assert.deepEqual(plan.blocks.slice(1).map(block => block.start),
    plan.blocks.slice(0, -1).map(block => block.end));
  assert.equal(plan.remainingMinutes, 720 - 85);
  assert.deepEqual(plan.unscheduled, []);
});

test('reports work that overflows the daily window and avoids starting a pause it cannot finish', () => {
  const tasks = [
    { id: 'a', title: 'Draft', minutes: 50 },
    { id: 'b', title: 'Review', minutes: 20 },
  ];
  const plan = buildPlan(tasks, DEFAULT_SETTINGS, local(19, 19, 25));
  assert.deepEqual(plan.blocks.map(block => [block.kind, block.minutes]), [
    ['focus', 30], ['break', 5],
  ]);
  assert.equal(plan.remainingMinutes, 0);
  assert.equal(plan.blocks.at(-1).end, plan.windowEnd);
  assert.deepEqual(plan.unscheduled, [
    { taskId: 'a', title: 'Draft', minutes: 20 },
    { taskId: 'b', title: 'Review', minutes: 20 },
  ]);
});

test('retains a night-shift work window across midnight', () => {
  const plan = buildPlan([], { ...DEFAULT_SETTINGS, wakeTime: '20:00' }, local(20, 1));
  assert.equal(plan.windowStart, local(20, 1).getTime());
  assert.equal(plan.windowEnd, local(20, 8).getTime());
  assert.equal(plan.remainingMinutes, 420);
});
