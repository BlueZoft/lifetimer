export const DEFAULT_SETTINGS = Object.freeze({
  wakeTime: '08:00',
  sleepHours: 8,
  focusMinutes: 40,
  waterLitres: 2.5,
});

const MINUTE = 60_000;
const DAY_MINUTES = 24 * 60;
const DAILY_RESERVE_MINUTES = 4 * 60;
export const MOVEMENT_INTERVAL_MINUTES = 30;
export const MOVEMENT_BREAK_MINUTES = 5;

function wakeOn(date, wakeTime) {
  const time = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(wakeTime)
    ? wakeTime
    : DEFAULT_SETTINGS.wakeTime;
  const [hour, minute] = time.split(':').map(Number);
  const wake = new Date(date);
  wake.setHours(hour, minute, 0, 0);
  return wake;
}

function currentWake(now, wakeTime, awakeMinutes) {
  const today = wakeOn(now, wakeTime);
  if (now >= today) return today.getTime();

  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  const previousWake = wakeOn(yesterday, wakeTime).getTime();
  return now.getTime() < previousWake + awakeMinutes * MINUTE
    ? previousWake
    : today.getTime();
}

function wholeMinutes(value) {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function focusCapacity(available) {
  const cycle = MOVEMENT_INTERVAL_MINUTES + MOVEMENT_BREAK_MINUTES;
  const fullCycles = Math.floor(available / cycle);
  const tail = Math.min(available % cycle, MOVEMENT_INTERVAL_MINUTES);
  return fullCycles * MOVEMENT_INTERVAL_MINUTES + tail;
}

export function buildPlan(tasks, settings = DEFAULT_SETTINGS, now = new Date()) {
  const sleepHours = Number.isFinite(settings.sleepHours)
    ? Math.min(9, Math.max(7, settings.sleepHours))
    : DEFAULT_SETTINGS.sleepHours;
  const requestedFocus = wholeMinutes(settings.focusMinutes) || DEFAULT_SETTINGS.focusMinutes;
  const focusMinutes = Math.min(90, Math.max(15, requestedFocus));
  const awakeMinutes = DAY_MINUTES - Math.round(sleepHours * 60);
  const workMinutes = awakeMinutes - DAILY_RESERVE_MINUTES;
  const wake = currentWake(now, settings.wakeTime, awakeMinutes);
  const windowEnd = wake + workMinutes * MINUTE;
  const windowStart = Math.min(windowEnd, Math.max(now.getTime(), wake));
  const blocks = [];
  const unscheduled = [];
  let cursor = windowStart;

  const capacity = () => Math.floor((windowEnd - cursor) / MINUTE);
  function addBlock(task, kind, minutes, elapsedMinutes = minutes) {
    const end = cursor + elapsedMinutes * MINUTE;
    blocks.push({
      id: `${kind}-${task.id}-${cursor}`,
      taskId: task.id,
      title: kind === 'focus' ? task.title : 'Movement break',
      kind,
      start: cursor,
      end,
      minutes,
    });
    cursor = end;
  }

  for (const task of tasks) {
    let outstanding = wholeMinutes(task.minutes) - wholeMinutes(task.completedMinutes);
    while (outstanding > 0 && capacity() > 0) {
      const minutes = Math.min(outstanding, focusMinutes, focusCapacity(capacity()));
      const movementBreaks = Math.floor((minutes - 1) / MOVEMENT_INTERVAL_MINUTES);
      addBlock(task, 'focus', minutes, minutes + movementBreaks * MOVEMENT_BREAK_MINUTES);
      outstanding -= minutes;

      const breakMinutes = Math.min(MOVEMENT_BREAK_MINUTES, capacity());
      if (breakMinutes > 0) addBlock(task, 'break', breakMinutes);
    }
    if (outstanding > 0) {
      unscheduled.push({ taskId: task.id, title: task.title, minutes: outstanding });
    }
  }

  return { blocks, unscheduled, workMinutes, remainingMinutes: capacity(), windowStart, windowEnd };
}
