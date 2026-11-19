import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, DEFAULT_SETTINGS } from '../public/planner.js';
import { buildCampaign, dateKey } from '../public/campaign.js';

const local = (day, hour = 8) => new Date(2026, 10, day, hour);
const focusMinutes = plan => plan.blocks.filter(block => block.kind === 'focus')
  .reduce((total, block) => total + block.minutes, 0);
const campaign = { id: 'plan', goal: 'Finish the draft', startDate: '2026-11-19', days: 3, dailyFocusHours: 1, restWeekdays: [] };

test('daily focus cap accounts for logged focus and explicit task completion', () => {
  const tasks = [
    { id: 'done', title: 'Complete', minutes: 100, remainingMinutes: 100, done: true },
    { id: 'current', title: 'Draft', minutes: 30, completedMinutes: 30, remainingMinutes: 90, done: false },
    { id: 'review', title: 'Review progress', minutes: 30, remainingMinutes: 0, done: false },
  ];
  const plan = buildPlan(tasks, { ...DEFAULT_SETTINGS, dailyFocusHours: 1, usedFocusMinutes: 20 }, local(19));
  assert.equal(focusMinutes(plan), 40);
  assert.equal(plan.remainingFocusMinutes, 0);
  assert.equal(plan.focusBudgetMinutes, 60);
  assert.deepEqual(plan.unscheduled, [{ taskId: 'current', title: 'Draft', minutes: 50 }]);
  assert.equal(tasks[1].done, false);
  assert.equal(tasks[1].remainingMinutes, 90);
});

test('three-day plan allocates remaining work in priority order without mutating estimates', () => {
  const tasks = [
    { id: 'a', title: 'First', minutes: 120, remainingMinutes: 80, done: false },
    { id: 'b', title: 'Second', minutes: 150, remainingMinutes: 150, done: false },
  ];
  const result = buildCampaign(tasks, DEFAULT_SETTINGS, campaign, local(19));
  assert.deepEqual(result.days.map(day => day.focusMinutes), [60, 60, 60]);
  assert.deepEqual(result.days.map(day => [...new Set(day.blocks.filter(block => block.kind === 'focus').map(block => block.taskId))]), [['a'], ['a', 'b'], ['b']]);
  assert.deepEqual(result.unscheduled, [{ taskId: 'b', title: 'Second', minutes: 50 }]);
  assert.equal(result.endDate, '2026-11-21');
  assert.equal(tasks[0].remainingMinutes, 80);
});

test('rest days and past days receive no new focus, with logged focus reducing today capacity', () => {
  const history = [{ startedAt: local(20, 8).getTime(), focusMinutes: 25 }];
  const tasks = [{ id: 'a', title: 'Draft', minutes: 200 }];
  const result = buildCampaign(tasks, DEFAULT_SETTINGS, { ...campaign, restWeekdays: [6] }, local(20, 10), history);
  assert.deepEqual(result.days.map(day => day.focusMinutes), [0, 35, 0]);
  assert.equal(result.days[0].isPast, true);
  assert.equal(result.days[2].isRest, true);
  assert.equal(result.days[1].usedFocusMinutes, 25);
  assert.equal(result.unscheduled[0].minutes, 165);
});

test('fortnight horizon ends after fourteen local calendar dates and rejects longer plans', () => {
  const tasks = [{ id: 'a', title: 'Long task', minutes: 2000 }];
  const result = buildCampaign(tasks, DEFAULT_SETTINGS, { ...campaign, days: 14 }, local(19));
  assert.equal(result.days.length, 14);
  assert.equal(result.endDate, '2026-12-02');
  assert.equal(result.days.at(-1).date, dateKey(local(32)));
  assert.equal(result.unscheduled[0].minutes, 1160);
  assert.deepEqual(buildCampaign(tasks, DEFAULT_SETTINGS, { ...campaign, days: 15 }, local(19)).days, []);
});

test('an overnight campaign retains the active wake date after midnight', () => {
  const settings = { ...DEFAULT_SETTINGS, wakeTime: '20:00' };
  const history = [{ startedAt: local(19, 23).getTime(), focusMinutes: 25 }];
  const tasks = [{ id: 'night', title: 'Night work', minutes: 200 }];
  const result = buildCampaign(tasks, settings, campaign, local(20, 1), history);
  assert.equal(result.days[0].date, '2026-11-19');
  assert.equal(result.days[0].isPast, false);
  assert.equal(result.days[0].focusMinutes, 35);
  assert.equal(result.days[0].blocks[0].start, local(20, 1).getTime());
  assert.equal(result.days[0].usedFocusMinutes, 25);
  assert.equal(result.days[1].usedFocusMinutes, 0);
});
