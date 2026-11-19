import test from 'node:test';
import assert from 'node:assert/strict';
import { createTask, finishSession, migrateState, reviseTask } from '../public/model.js';
import { MINUTE } from '../public/session.js';

const now = new Date(2026, 10, 19, 9).getTime();

test('upgrades legacy tasks without losing their progress or completion status', () => {
  const state = migrateState({
    tasks: [
      { id: 'open', title: 'Draft', minutes: 60, completedMinutes: 15 },
      { id: 'done', title: 'Review', minutes: 20, completedMinutes: 20 },
    ],
    water: { '2026-11-19': 750 },
  }, now);
  assert.equal(state.version, 2);
  assert.equal(state.tasks[0].remainingMinutes, 45);
  assert.equal(state.tasks[0].done, false);
  assert.equal(state.tasks[0].goal, 'Draft');
  assert.equal(state.tasks[1].remainingMinutes, 0);
  assert.equal(state.tasks[1].done, true);
  assert.deepEqual(state.water, { '2026-11-19': 750 });
  assert.deepEqual(state.history, []);
  assert.equal(state.session, null);
  assert.deepEqual(migrateState({ water: { '2026-11-9': 250 } }, now).water, { '2026-11-09': 250 });
  assert.deepEqual(migrateState({ water: { '2026-11-09': 0, '2026-11-9': 250 } }, now).water, { '2026-11-09': 0 });
});

test('revisions preserve the original goal and checkpoint wording while retaining criteria history', () => {
  const task = createTask({
    title: 'Write draft', minutes: 60, goal: 'Publish a usable draft',
    criteria: 'Include introduction', checkpoints: ['Outline approved', 'Draft reviewed'],
  }, now);
  const next = reviseTask(task, {
    title: 'Write final draft', remainingMinutes: 90,
    goal: 'Changed goal', checkpoints: ['Changed checkpoint'], criteria: 'Include introduction and examples',
  }, now + MINUTE);
  assert.equal(next.goal, 'Publish a usable draft');
  assert.deepEqual(next.checkpoints.map(item => item.title), ['Outline approved', 'Draft reviewed']);
  assert.equal(next.minutes, 60);
  assert.equal(next.remainingMinutes, 90);
  assert.deepEqual(next.criteriaHistory, [
    { at: now, text: 'Include introduction' },
    { at: now + MINUTE, text: 'Include introduction and examples' },
  ]);
  assert.equal(reviseTask(next, { criteria: next.criteria }, now + 2 * MINUTE).criteriaHistory.length, 2);
});

test('session history credits actual focus once and requires explicit task completion', () => {
  const task = createTask({ title: 'Draft', minutes: 40, checkpoints: [] }, now);
  const state = migrateState({ tasks: [task], session: {
    id: 's1', taskId: task.id, title: task.title, minutes: 40, recovery: 5,
    startedAt: now, elapsed: 0, runningSince: now, interruptions: 2,
  } }, now);
  const record = finishSession(state, now + 55 * MINUTE);
  assert.equal(record.focusMinutes, 40);
  assert.equal(record.interruptions, 2);
  assert.equal(record.reviewedAt, null);
  assert.equal(record.goal, 'Draft');
  assert.equal(state.tasks[0].completedMinutes, 40);
  assert.equal(state.tasks[0].remainingMinutes, 0);
  assert.equal(state.tasks[0].done, false);
  assert.equal(state.history.length, 1);
  assert.equal(finishSession(state, now + 60 * MINUTE), null);
  state.session = {
    id: 's1', taskId: task.id, minutes: 40, recovery: 5,
    startedAt: now, elapsed: 0, runningSince: now,
  };
  assert.equal(finishSession(state, now + 60 * MINUTE), record);
  assert.equal(state.tasks[0].completedMinutes, 40);
  assert.equal(state.history.length, 1);
});

test('early sessions preserve partial minutes and corrupt persisted fields recover', () => {
  const state = migrateState({
    settings: { sleepHours: 'bad', focusMinutes: -5, wakeTime: '99:99' },
    tasks: [null, { id: 'a', title: 'Work', minutes: 40, completedMinutes: 0 }],
    history: 'bad', health: null, water: { yesterday: 'bad' },
    session: { id: 's', taskId: 'a', minutes: 40, startedAt: now, runningSince: now, elapsed: 0 },
  }, now);
  assert.equal(state.settings.sleepHours, 8);
  assert.equal(state.settings.focusMinutes, 15);
  assert.equal(state.settings.wakeTime, '08:00');
  assert.deepEqual(state.health, {});
  const record = finishSession(state, now + 90_000);
  assert.equal(record.focusMinutes, 1.5);
  assert.equal(state.tasks[1].remainingMinutes, 38.5);
});
