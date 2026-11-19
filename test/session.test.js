import test from 'node:test';
import assert from 'node:assert/strict';
import { focusElapsed, MINUTE, sessionElapsed, sessionPhases } from '../public/session.js';

test('a 40-minute block includes an eye reset, movement, and recovery without crediting break time', () => {
  const phases = sessionPhases(40, 5);
  assert.deepEqual(phases.map(({ kind }) => kind), ['focus', 'eyes', 'focus', 'movement', 'focus', 'recovery']);
  assert.equal(phases[1].end - phases[1].start, 20_000);
  assert.equal(phases[3].end - phases[3].start, 5 * MINUTE);
  assert.equal(phases.at(-1).end, 50 * MINUTE + 20_000);
  assert.equal(focusElapsed(phases, phases[3].start + MINUTE), 30 * MINUTE);
  assert.equal(focusElapsed(phases, phases.at(-1).end), 40 * MINUTE);
});

test('paused time is excluded and coinciding breaks share one phase', () => {
  assert.equal(sessionElapsed({ elapsed: MINUTE, runningSince: null }, 180_000), MINUTE);
  assert.equal(sessionElapsed({ elapsed: MINUTE, runningSince: 120_000 }, 180_000), 2 * MINUTE);
  assert.equal(sessionPhases(65).filter(phase => phase.kind === 'combined').length, 1);
});
