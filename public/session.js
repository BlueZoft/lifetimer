export const MINUTE = 60_000;
export const MOVEMENT_INTERVAL_MINUTES = 30;
export const MOVEMENT_BREAK_MINUTES = 5;
const EYE_INTERVAL_MINUTES = 20;
const EYE_BREAK = 20_000;

export function sessionPhases(minutes, recoveryMinutes = 0) {
  let elapsed = 0;
  let previous = 0;
  const phases = [];

  function add(kind, duration) {
    phases.push({ kind, start: elapsed, end: elapsed + duration });
    elapsed += duration;
  }

  for (let minute = 1; minute < minutes; minute++) {
    const movement = minute % MOVEMENT_INTERVAL_MINUTES === 0;
    const eye = minute % EYE_INTERVAL_MINUTES === 0;
    if (!movement && !eye) continue;

    add('focus', (minute - previous) * MINUTE);
    add(movement ? (eye ? 'combined' : 'movement') : 'eyes',
      movement ? MOVEMENT_BREAK_MINUTES * MINUTE : EYE_BREAK);
    previous = minute;
  }

  add('focus', (minutes - previous) * MINUTE);
  if (recoveryMinutes > 0) add('recovery', recoveryMinutes * MINUTE);
  return phases;
}

export function sessionElapsed(session, now) {
  const running = session.runningSince === null ? 0 : Math.max(0, now - session.runningSince);
  return session.elapsed + running;
}

export function focusElapsed(phases, elapsed) {
  return phases.filter(phase => phase.kind === 'focus').reduce((total, phase) => {
    return total + Math.max(0, Math.min(phase.end, elapsed) - phase.start);
  }, 0);
}
