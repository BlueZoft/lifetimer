import { DEFAULT_SETTINGS } from './planner.js';
import { focusElapsed, MINUTE, sessionElapsed, sessionPhases } from './session.js';

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function number(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function timestamp(value, fallback = null) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function checkpoints(values) {
  if (!Array.isArray(values)) return [];
  return values.map(value => {
    const item = typeof value === 'string' ? { title: value } : object(value);
    return {
      id: text(item.id) || crypto.randomUUID(),
      title: text(item.title).trim(),
      done: item.done === true,
      completedAt: timestamp(item.completedAt),
    };
  }).filter(item => item.title);
}

function taskFrom(value, now) {
  const task = object(value);
  const minutes = number(task.minutes, DEFAULT_SETTINGS.focusMinutes, 1);
  const completedMinutes = number(task.completedMinutes, 0);
  const criteria = text(task.criteria);
  const createdAt = timestamp(task.createdAt, now);
  const revisions = Array.isArray(task.criteriaHistory) ? task.criteriaHistory : [];
  const criteriaHistory = revisions.filter(item => typeof item?.text === 'string')
    .map(item => ({ at: timestamp(item.at, createdAt), text: item.text }));
  if (!criteriaHistory.length) criteriaHistory.push({ at: createdAt, text: criteria });
  const done = typeof task.done === 'boolean' ? task.done : completedMinutes >= minutes;
  return {
    ...task,
    id: text(task.id) || crypto.randomUUID(),
    title: text(task.title, 'Untitled task'),
    minutes,
    completedMinutes,
    remainingMinutes: done ? 0 : number(task.remainingMinutes, Math.max(0, minutes - completedMinutes)),
    done,
    goal: text(task.goal, text(task.title, 'Untitled task')),
    criteria,
    criteriaHistory,
    checkpoints: checkpoints(task.checkpoints),
    createdAt,
  };
}

function historyEntry(value, now) {
  const item = object(value);
  return {
    ...item,
    id: text(item.id) || crypto.randomUUID(),
    taskId: text(item.taskId),
    title: text(item.title, 'Untitled task'),
    startedAt: timestamp(item.startedAt, now),
    endedAt: timestamp(item.endedAt, now),
    focusMinutes: number(item.focusMinutes, 0),
    plannedMinutes: number(item.plannedMinutes, 0),
    interruptions: Math.floor(number(item.interruptions, 0)),
    reviewedAt: timestamp(item.reviewedAt),
    notes: text(item.notes),
    quality: Number.isInteger(item.quality) && item.quality >= 1 && item.quality <= 5 ? item.quality : null,
    outcome: typeof item.outcome === 'string' ? item.outcome : null,
    goal: text(item.goal),
    criteria: text(item.criteria),
    checkpoints: checkpoints(item.checkpoints),
  };
}

function validSession(value, tasks, now) {
  if (!value || typeof value !== 'object') return null;
  const session = object(value);
  const task = tasks.find(item => item.id === session.taskId);
  if (!task || !Number.isFinite(session.minutes) || session.minutes <= 0) return null;
  const startedAt = timestamp(session.startedAt, now);
  return {
    ...session,
    id: text(session.id) || 'session-' + startedAt,
    taskId: task.id,
    title: text(session.title, task.title),
    minutes: number(session.minutes, 40, 1, 90),
    recovery: number(session.recovery, 0, 0, 5),
    startedAt,
    elapsed: number(session.elapsed, 0),
    runningSince: session.runningSince === null ? null : timestamp(session.runningSince, now),
    interruptions: Math.floor(number(session.interruptions, 0)),
  };
}

export function migrateState(raw, now = Date.now()) {
  const state = object(raw);
  const settings = { ...DEFAULT_SETTINGS, ...object(state.settings) };
  settings.wakeTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(settings.wakeTime)
    ? settings.wakeTime : DEFAULT_SETTINGS.wakeTime;
  settings.sleepHours = number(settings.sleepHours, DEFAULT_SETTINGS.sleepHours, 7, 9);
  settings.focusMinutes = Math.round(number(settings.focusMinutes, DEFAULT_SETTINGS.focusMinutes, 15, 90));
  settings.waterLitres = number(settings.waterLitres, DEFAULT_SETTINGS.waterLitres, 2, 3);
  settings.dailyFocusHours = number(settings.dailyFocusHours, DEFAULT_SETTINGS.dailyFocusHours, 0.5, 12);
  const tasks = Array.isArray(state.tasks) ? state.tasks.map(item => taskFrom(item, now)) : [];
  const water = {};
  for (const [date, amount] of Object.entries(object(state.water))) {
    if (!/^\d{4}-\d{1,2}-\d{1,2}$/.test(date) || !Number.isFinite(amount) || amount < 0) continue;
    const [year, month, day] = date.split('-');
    const key = [year, month.padStart(2, '0'), day.padStart(2, '0')].join('-');
    if (date === key || water[key] === undefined) water[key] = amount;
  }
  return {
    ...state,
    version: 2,
    settings,
    tasks,
    session: validSession(state.session, tasks, now),
    water,
    anchor: timestamp(state.anchor, now),
    background: state.background === true,
    history: Array.isArray(state.history) ? state.history.map(item => historyEntry(item, now)) : [],
    health: object(state.health),
    campaignHistory: Array.isArray(state.campaignHistory) ? state.campaignHistory : [],
    campaign: state.campaign && typeof state.campaign === 'object' && !Array.isArray(state.campaign)
      ? state.campaign : null,
  };
}

export function createTask({ title, minutes, goal, criteria = '', checkpoints: titles = [] }, now = Date.now()) {
  return taskFrom({
    id: crypto.randomUUID(),
    title: title.trim(),
    minutes,
    completedMinutes: 0,
    remainingMinutes: minutes,
    done: false,
    goal: typeof goal === 'string' && goal.trim() ? goal.trim() : title.trim(),
    criteria: criteria.trim(),
    checkpoints: titles,
    createdAt: now,
  }, now);
}

export function reviseTask(task, edits, now = Date.now()) {
  const next = { ...task };
  if (typeof edits.title === 'string' && edits.title.trim()) next.title = edits.title.trim();
  if (Number.isFinite(edits.remainingMinutes)) {
    next.remainingMinutes = Math.max(0, edits.remainingMinutes);
  }
  if (typeof edits.criteria === 'string' && edits.criteria.trim() !== task.criteria) {
    next.criteria = edits.criteria.trim();
    next.criteriaHistory = [...task.criteriaHistory, { at: now, text: next.criteria }];
  }
  return next;
}

export function finishSession(state, now = Date.now()) {
  const session = state.session;
  if (!session) return null;
  const existing = state.history.find(entry => entry.id === session.id);
  state.session = null;
  if (existing) return existing;

  const phases = sessionPhases(session.minutes, session.recovery);
  const elapsed = sessionElapsed(session, now);
  const focusMinutes = focusElapsed(phases, elapsed) / MINUTE;
  const task = state.tasks.find(item => item.id === session.taskId);
  const entry = historyEntry({
    id: session.id,
    taskId: session.taskId,
    title: session.title,
    startedAt: session.startedAt,
    endedAt: now,
    focusMinutes,
    plannedMinutes: session.minutes,
    interruptions: session.interruptions,
    goal: session.goal ?? task?.goal,
    criteria: session.criteria ?? task?.criteria,
    checkpoints: session.checkpoints ?? task?.checkpoints,
  }, now);
  if (task) {
    task.completedMinutes += focusMinutes;
    task.remainingMinutes = Math.max(0, task.remainingMinutes - focusMinutes);
  }
  state.history.push(entry);
  return entry;
}
