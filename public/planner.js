import { MINUTE, MOVEMENT_BREAK_MINUTES, sessionPhases } from './session.js';

export const DEFAULT_SETTINGS = Object.freeze({
  wakeTime: '08:00',
  sleepHours: 8,
  focusMinutes: 40,
  waterLitres: 2.5,
  dailyFocusHours: 4,
});

const DAY_MINUTES = 24 * 60;
const DAILY_RESERVE_MINUTES = 4 * 60;

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

export function taskMinutesRemaining(task) {
  if (task.done === true) return 0;
  if (Number.isFinite(task.remainingMinutes)) return Math.max(0, Math.ceil(task.remainingMinutes));
  return Math.max(0, wholeMinutes(task.minutes) - wholeMinutes(task.completedMinutes));
}

export function buildPlan(tasks, settings = DEFAULT_SETTINGS, now = new Date()) {
  const sleepHours = Number.isFinite(settings.sleepHours)
    ? Math.min(9, Math.max(7, settings.sleepHours))
    : DEFAULT_SETTINGS.sleepHours;
  const requestedFocus = wholeMinutes(settings.focusMinutes) || DEFAULT_SETTINGS.focusMinutes;
  const focusMinutes = Math.min(90, Math.max(15, requestedFocus));
  const awakeMinutes = DAY_MINUTES - Math.round(sleepHours * 60);
  const workMinutes = awakeMinutes - DAILY_RESERVE_MINUTES;
  const dailyFocusHours = Number.isFinite(settings.dailyFocusHours)
    ? Math.min(13, Math.max(0, settings.dailyFocusHours))
    : DEFAULT_SETTINGS.dailyFocusHours;
  const usedFocusMinutes = Number.isFinite(settings.usedFocusMinutes)
    ? Math.max(0, settings.usedFocusMinutes)
    : 0;
  const focusBudgetMinutes = Math.floor(dailyFocusHours * 60);
  let remainingFocusMinutes = Math.max(0, Math.floor(focusBudgetMinutes - usedFocusMinutes));
  const wake = currentWake(now, settings.wakeTime, awakeMinutes);
  const windowEnd = wake + workMinutes * MINUTE;
  const windowStart = Math.min(windowEnd, Math.max(now.getTime(), wake));
  const blocks = [];
  const unscheduled = [];
  let cursor = windowStart;

  const capacity = () => windowEnd - cursor;
  function addBlock(task, kind, minutes, duration = minutes * MINUTE) {
    const end = cursor + duration;
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
    let outstanding = taskMinutesRemaining(task);
    while (outstanding > 0 && remainingFocusMinutes > 0 && capacity() >= MINUTE) {
      let minutes = Math.min(outstanding, focusMinutes, remainingFocusMinutes, Math.floor(capacity() / MINUTE));
      let duration = sessionPhases(minutes).at(-1).end;
      while (duration > capacity()) {
        minutes--;
        duration = sessionPhases(minutes).at(-1).end;
      }
      addBlock(task, 'focus', minutes, duration);
      outstanding -= minutes;
      remainingFocusMinutes -= minutes;

      const breakMinutes = Math.min(MOVEMENT_BREAK_MINUTES, Math.floor(capacity() / MINUTE));
      if (breakMinutes > 0) addBlock(task, 'break', breakMinutes);
    }
    if (outstanding > 0) {
      unscheduled.push({ taskId: task.id, title: task.title, minutes: outstanding });
    }
  }

  return {
    blocks, unscheduled, workMinutes,
    remainingMinutes: Math.floor(capacity() / MINUTE),
    focusBudgetMinutes, remainingFocusMinutes, windowStart, windowEnd,
  };
}
