import { buildPlan, DEFAULT_SETTINGS, taskMinutesRemaining } from './planner.js';

export function dateKey(value) {
  const date = new Date(value);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')].join('-');
}

function parseDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day, 12);
  return dateKey(date) === value ? date : null;
}

function wakeOn(date, settings) {
  const wake = new Date(date);
  const wakeTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(settings.wakeTime)
    ? settings.wakeTime : DEFAULT_SETTINGS.wakeTime;
  const [hour, minute] = wakeTime.split(':').map(Number);
  wake.setHours(hour, minute, 0, 0);
  return wake;
}

export function focusMinutesInWindow(history, start, end) {
  return history.reduce((total, session) => {
    const inWindow = session.startedAt >= start && session.startedAt < end;
    return total + (inWindow && Number.isFinite(session.focusMinutes)
      ? Math.max(0, session.focusMinutes) : 0);
  }, 0);
}

export function buildCampaign(tasks, settings, campaign, now = new Date(), history = []) {
  const start = parseDate(campaign?.startDate);
  const duration = campaign?.days;
  const outstanding = tasks.map(task => ({ ...task, remainingMinutes: taskMinutesRemaining(task) }));
  const unscheduled = () => outstanding.filter(task => task.remainingMinutes > 0)
    .map(task => ({ taskId: task.id, title: task.title, minutes: task.remainingMinutes }));
  if (!start || ![3, 7, 14].includes(duration)) {
    return { days: [], unscheduled: unscheduled(), endDate: null };
  }

  const restWeekdays = Array.isArray(campaign.restWeekdays) ? campaign.restWeekdays : [];
  const days = [];
  for (let offset = 0; offset < duration; offset++) {
    const date = new Date(start);
    date.setDate(start.getDate() + offset);
    const wake = wakeOn(date, settings);
    const nextDate = new Date(date);
    nextDate.setDate(date.getDate() + 1);
    const nextWake = wakeOn(nextDate, settings);
    const usedFocusMinutes = focusMinutesInWindow(history, wake.getTime(), nextWake.getTime());
    const daySettings = {
      ...settings,
      dailyFocusHours: campaign.dailyFocusHours ?? settings.dailyFocusHours,
      usedFocusMinutes,
    };
    const empty = buildPlan([], daySettings, wake);
    const isRest = restWeekdays.includes(date.getDay());
    const isPast = empty.windowEnd <= now.getTime();
    const dayPlan = isRest || isPast ? empty
      : buildPlan(outstanding, daySettings, new Date(Math.max(wake.getTime(), now.getTime())));
    let focusMinutes = 0;
    for (const block of dayPlan.blocks) {
      if (block.kind !== 'focus') continue;
      const task = outstanding.find(task => task.id === block.taskId);
      task.remainingMinutes -= block.minutes;
      focusMinutes += block.minutes;
    }
    days.push({
      ...dayPlan,
      date: dateKey(date),
      focusMinutes,
      usedFocusMinutes,
      isRest,
      isPast,
    });
  }
  return { days, unscheduled: unscheduled(), endDate: days.at(-1).date };
}
