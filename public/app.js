import { buildPlan, taskMinutesRemaining } from './planner.js';
import { buildCampaign, dateKey, focusMinutesInWindow } from './campaign.js';
import { migrateState, createTask, reviseTask, finishSession } from './model.js';
import { initHealth } from './health.js';
import { futureDayReminders } from './reminder-schedule.js';
import { focusElapsed, MINUTE, sessionElapsed, sessionPhases } from './session.js';
import { existingSubscription, saveReminders, subscribe } from './push.js';

const STORAGE_KEY = 'lifetimer.v1';
const $ = id => document.getElementById(id);
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dateFormat = new Intl.DateTimeFormat(undefined, {
  weekday: 'long', month: 'short', day: 'numeric',
});
const taskForm = $('task-form');
const settingsForm = $('settings-form');
const breakPrompts = {
  eyes: ['Time to look away', 'Look at something 20 feet away for 20 seconds.'],
  movement: ['Time to move', 'Stand up and take a 5-minute walk.'],
  combined: ['Time to move and look away', 'Take a 5-minute walk and look 20 feet away for at least 20 seconds.'],
  recovery: ['Focus complete', 'Take a short walk or step away before your next block.'],
};
let state = loadState();
let plan;
let campaignPlan;
let plannedReminders = [];
let reviewingTaskId;
let reviewingEntryId;
let historyLimit = 10;
let editingId;
let subscription;
let pushBusy = false;
let pushQueue = Promise.resolve();
let testReminder;
let noticeTimeout;
let previousTick = Date.now();
let previousDay = dateKey(previousTick);
const shownReminders = new Set();
const health = initHealth({
  getState: () => state,
  onChange: () => refresh({ replan: true }),
  notify,
  dayKey: dateKey,
});

function loadState() {
  try {
    return migrateState(JSON.parse(localStorage.getItem(STORAGE_KEY)));
  } catch {
    return migrateState(null);
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    notify('Storage is full or unavailable', 'Keep this window open and free browser storage before reloading.');
  }
}

const dayKey = dateKey;
function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('icon');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(svg.namespaceURI, 'use');
  use.setAttribute('href', '#i-' + name);
  svg.append(use);
  return svg;
}

function element(tag, className, label) {
  const node = document.createElement(tag);
  node.className = className;
  if (label !== undefined) node.textContent = label;
  return node;
}

function notify(title, body) {
  $('notice-title').textContent = title;
  $('notice-body').textContent = body;
  $('notice').hidden = false;
  clearTimeout(noticeTimeout);
  noticeTimeout = setTimeout(() => { $('notice').hidden = true; }, 15_000);
}

function duration(minutes) {
  minutes = Math.round(minutes);
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return [hours ? hours + 'h' : '', remainder || !hours ? remainder + 'm' : ''].filter(Boolean).join(' ');
}

function secondsLabel(ms) {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0');
}

function activePhases() {
  return sessionPhases(state.session.minutes, state.session.recovery);
}

function chosenBlock() {
  return plan.blocks.find(block => block.kind === 'focus');
}

function usedFocus(history, now) {
  const window = buildPlan([], state.settings, new Date(now));
  const wake = window.windowEnd - window.workMinutes * MINUTE;
  const nextWake = new Date(wake);
  nextWake.setDate(nextWake.getDate() + 1);
  return focusMinutesInWindow(history, wake, nextWake.getTime());
}

function planAt(tasks, now, history = state.history) {
  const settings = { ...state.settings, usedFocusMinutes: usedFocus(history, now) };
  if (!state.campaign) return buildPlan(tasks, settings, new Date(now));
  const campaign = buildCampaign(tasks, state.settings, state.campaign, new Date(now), history);
  const window = buildPlan([], settings, new Date(now));
  const date = dateKey(window.windowEnd - window.workMinutes * MINUTE);
  const today = campaign.days.find(day => day.date === date);
  return today ?? {
    ...window, blocks: [],
    unscheduled: tasks.filter(task => taskMinutesRemaining(task) > 0)
      .map(task => ({ taskId: task.id, title: task.title, minutes: taskMinutesRemaining(task) })),
  };
}

function nextFocusNow(now) {
  return planAt(state.tasks, now).blocks.find(block => block.kind === 'focus');
}

function calculatePlan(now) {
  let tasks = state.tasks;
  let at = state.anchor;
  let history = state.history;
  if (state.session) {
    const session = state.session;
    const finish = activePhases().at(-1).end;
    at = session.runningSince === null
      ? Math.max(state.anchor, now) + finish - session.elapsed
      : session.runningSince + finish - session.elapsed;
    tasks = state.tasks.map(task => task.id === session.taskId
      ? { ...task, remainingMinutes: Math.max(0, task.remainingMinutes - session.minutes) }
      : task);
    history = [...history, { startedAt: session.startedAt, focusMinutes: session.minutes }];
  }
  const currentWindow = buildPlan([], state.settings, new Date(now));
  const wake = currentWindow.windowEnd - currentWindow.workMinutes * MINUTE;
  const rolling = state.campaign ?? {
    startDate: dateKey(wake), days: 14, restWeekdays: [],
  };
  campaignPlan = buildCampaign(tasks, state.settings, rolling, new Date(at), history);
  plannedReminders = futureDayReminders(campaignPlan.days, state.settings, now, state.water).filter(reminder => {
    const date = dateKey(reminder.at);
    if (reminder.tag === 'morning-checkin') return !state.health[date]?.morning;
    if (reminder.tag === 'evening-checkin') return !state.health[date]?.evening;
    return true;
  });
  return planAt(tasks, at, history);
}

function renderBudget() {
  const { sleepHours } = state.settings;
  const workable = duration(plan.workMinutes);
  $('budget-work').textContent = workable;
  $('budget-work-row').textContent = workable;
  $('focus-budget').textContent = duration(state.settings.dailyFocusHours * 60) + ' daily focus allowance · ' + duration(usedFocus(state.history, Date.now())) + ' logged';
  $('budget-sleep').textContent = duration(Math.round(sleepHours * 60));
  const bar = $('budget-bar');
  bar.style.setProperty('grid-template-columns', `${plan.workMinutes}fr 240fr ${sleepHours * 60}fr`);
  bar.setAttribute('aria-label', `24 hours: ${workable} workable, 4h daily essentials, ${sleepHours}h sleep`);
}

function renderWater() {
  const logged = state.water[dayKey(Date.now())] || 0;
  const target = state.settings.waterLitres;
  $('water-label').textContent = `${logged / 1000} / ${target} L today`;
  $('water-progress').max = target * 1000;
  $('water-progress').value = logged;
  $('water-undo').hidden = logged === 0;
}

function renderPlan() {
  const next = chosenBlock();
  const now = Date.now();
  const rows = [];
  if (state.session) {
    rows.push(timelineRow({
      kind: 'focus',
      start: state.session.startedAt,
      title: state.session.title,
      minutes: state.session.minutes,
    }, 'is-next', 'Current session'));
  }
  for (const block of plan.blocks) {
    const classes = [];
    if (block.kind === 'break') classes.push('is-break');
    if (block.end <= now) classes.push('is-past');
    if (block === next && !state.session && block.end > now) classes.push('is-next');
    rows.push(timelineRow(block, classes.join(' ')));
  }
  $('timeline').replaceChildren(...rows);
  $('empty-plan').hidden = rows.length > 0;
  $('demo-tasks').hidden = state.tasks.length > 0;
  $('empty-plan-message').textContent = !state.tasks.length
    ? 'Add your first task to build a plan.'
    : state.tasks.some(task => !task.done && task.remainingMinutes <= 0)
      ? 'Check in on your tasks to confirm completion or estimate the remaining work.'
      : state.tasks.some(task => !task.done)
        ? plan.isRest ? 'Rest day. Your work is planned for the available days.' : 'No focus block fits this window. Unfinished tasks carry forward.'
        : 'All tasks are complete.';
  $('plan-subtitle').textContent = rows.length ? `${duration(plan.remainingMinutes)} unallocated in this window` : 'Your tasks and recovery breaks';
  const overflow = plan.unscheduled.reduce((total, task) => total + task.minutes, 0);
  $('plan-overflow').hidden = !overflow;
  $('plan-overflow').textContent = `${duration(overflow)} of estimated work exceeds this window and stays on your task list.`;
}

function timelineRow(block, type, description) {
  const row = element('li', ('timeline-item ' + type).trim());
  const stamp = element('time', 'timeline-time', timeFormat.format(block.start));
  stamp.dateTime = new Date(block.start).toISOString();
  const marker = element('span', 'timeline-marker');
  marker.append(icon(block.kind === 'break' ? 'walk' : 'clock'));
  const info = element('div', 'timeline-info');
  info.append(element('span', 'timeline-title', block.title), element('span', 'timeline-meta',
    description || (block.kind === 'break' ? 'Step away from your desk' : 'Focus block')));
  row.append(stamp, marker, info, element('span', 'timeline-duration', duration(block.minutes)));
  return row;
}

function renderTimer(now) {
  const { session, settings } = state;
  const next = session ? null : nextFocusNow(now);
  const dial = $('timer-dial');
  const start = $('focus-start');
  let remaining = (next?.minutes ?? settings.focusMinutes) * MINUTE;
  let progress = 0;
  let kind = 'focus';
  let status = 'Ready to focus';
  let timerLabel = 'Focus timer';
  let caption = next ? 'Up next' : '';
  const hasWork = state.tasks.some(task => !task.done);
  const needsReview = state.tasks.some(task => !task.done && task.remainingMinutes <= 0);
  let taskTitle = next?.title ?? (needsReview ? 'Review your progress' : hasWork
    ? 'No focus block available' : state.tasks.length ? 'All tasks complete' : 'Plan your first block');
  let copy = next
    ? (next.start > now + MINUTE
      ? `Your work window opens at ${timeFormat.format(next.start)}.`
      : `${duration(next.minutes)} of focus, with breaks as needed.`)
    : needsReview
      ? 'Confirm what was achieved and update the remaining estimate.'
      : hasWork
      ? 'Unfinished tasks stay on your list for the next workable window.'
      : 'Add a task to build your plan.';
  let action = next ? 'Start focus' : needsReview ? 'Review task' : hasWork ? 'Check window' : 'Add task';
  let actionIcon = next ? 'play' : hasWork ? 'refresh' : 'plus';

  if (session) {
    const phases = activePhases();
    const elapsed = sessionElapsed(session, now);
    const phase = phases.find(item => elapsed < item.end) ?? phases.at(-1);
    kind = phase.kind;
    const isFocus = kind === 'focus';
    const paused = session.runningSince === null;
    const full = isFocus ? session.minutes * MINUTE : phase.end - phase.start;
    remaining = isFocus ? full - focusElapsed(phases, elapsed) : phase.end - elapsed;
    progress = Math.min(360, 360 * (1 - remaining / full));
    const prompt = breakPrompts[kind];
    timerLabel = isFocus ? 'Focus remaining' : 'Break remaining';
    status = paused ? 'Paused' : isFocus ? 'Focusing' : 'On a break';
    caption = isFocus ? 'Current task' : 'Take a break';
    taskTitle = prompt?.[0] ?? session.title;
    copy = prompt?.[1] ?? 'LifeTimer will prompt you when it’s time to take a break.';
    action = paused ? 'Resume' : 'Pause';
    actionIcon = paused ? 'play' : 'pause';
  }

  $('timer-time').textContent = secondsLabel(remaining);
  $('timer-label').textContent = timerLabel;
  $('focus-status').textContent = status;
  $('focus-status').classList.toggle('is-active', !!session);
  $('focus-caption').textContent = caption;
  $('focus-caption').hidden = !caption;
  $('focus-task').textContent = taskTitle;
  $('focus-copy').textContent = copy;
  dial.style.setProperty('--progress', progress + 'deg');
  dial.dataset.kind = kind === 'focus' ? 'focus' : 'break';
  if (start.dataset.action !== action) {
    start.dataset.action = action;
    start.replaceChildren(icon(actionIcon), document.createTextNode(action));
  }
  $('focus-end').hidden = !session;
  $('focus-end').textContent = kind === 'recovery' ? 'Skip break' : 'End session';
}

function control(action, text, symbol, task, disabled = false) {
  const button = element('button', 'button button-secondary button-icon');
  button.type = 'button';
  button.dataset.taskAction = action;
  button.dataset.taskId = task.id;
  button.title = text;
  button.setAttribute('aria-label', text + ' ' + task.title);
  button.disabled = disabled;
  button.append(icon(symbol));
  return button;
}

function renderTasks() {
  $('task-count').textContent = state.tasks.filter(task => !task.done).length;
  $('task-count').hidden = state.tasks.length === 0;
  const rows = state.tasks.map((task, index) => {
    const row = element('li', 'task-item');
    const details = element('div', 'task-item-info');
    const done = task.done;
    const locked = task.id === state.session?.taskId;
    details.append(element('strong', '', task.title), element('span', 'timeline-meta',
      done ? 'Confirmed complete' : `${duration(task.remainingMinutes)} remaining · ${duration(task.completedMinutes)} logged`));
    const actions = element('div', 'task-row-actions');
    actions.append(
      control('up', 'Move up', 'up', task, index === 0),
      control('down', 'Move down', 'down', task, index === state.tasks.length - 1),
      control('edit', 'Edit', 'settings', task, locked),
      control('done', done ? 'Reopen' : 'Check in', done ? 'refresh' : 'check', task, locked),
      control('remove', 'Remove', 'close', task, locked),
    );
    row.append(details, actions);
    return row;
  });
  $('task-list').replaceChildren(...rows);
}

function setTaskEditor(task, focusInput = true) {
  editingId = task?.id;
  taskForm.elements.title.setCustomValidity('');
  taskForm.elements.title.value = task?.title ?? '';
  taskForm.elements.minutes.value = task ? Math.max(1, Math.ceil(task.remainingMinutes)) : state.settings.focusMinutes;
  taskForm.elements.minutes.max = task ? 10080 : 1440;
  $('task-minutes-label').textContent = task ? 'Remaining minutes' : 'Estimated minutes';
  taskForm.elements.goal.value = task?.goal ?? '';
  taskForm.elements.goal.readOnly = !!task;
  taskForm.elements.criteria.value = task?.criteria ?? '';
  taskForm.elements.checkpoints.value = task?.checkpoints.map(item => item.title).join('\n') ?? '';
  taskForm.elements.checkpoints.readOnly = !!task;
  $('criteria-revisions').hidden = !task || task.criteriaHistory.length < 2;
  $('criteria-history').replaceChildren(...(task?.criteriaHistory ?? []).map(revision => {
    const li = element('li');
    li.append(element('span', 'timeline-meta', new Date(revision.at).toLocaleString()),
      element('p', '', revision.text || 'No criteria entered'));
    return li;
  }));
  $('task-submit-label').textContent = task ? 'Save task' : 'Add task';
  $('cancel-edit').hidden = !task;
  if (focusInput) taskForm.elements.title.focus();
}

function showDialog(id, add = false) {
  const dialog = $(id);
  if (id === 'settings-dialog') {
    for (const [name, value] of Object.entries(state.settings)) {
      settingsForm.elements[name].value = value;
    }
  }
  if (!dialog.open) dialog.showModal();
  if (add) setTaskEditor();
}

function makeReminder(id, at, title, body, tag = id) {
  return { id, at, title, body, tag };
}

function reminders() {
  const session = state.session;
  const window = buildPlan([], state.settings, new Date());
  const nextWake = new Date(window.windowEnd - window.workMinutes * MINUTE);
  nextWake.setDate(nextWake.getDate() + 1);
  const reminders = plannedReminders.filter(reminder => !(session?.runningSince === null
    && reminder.tag === 'plan' && reminder.at < nextWake.getTime()));
  if (session && session.runningSince !== null) {
    const start = session.runningSince - session.elapsed;
    const phases = activePhases();
    for (const phase of phases.slice(1)) {
      const [title, body] = breakPrompts[phase.kind] ?? ['Back to focus', session.title];
      if (start + phase.start < sessionStopAt()) {
        reminders.push(makeReminder(session.id + '-' + phase.start, start + phase.start, title, body, 'session'));
      }
    }
    const finish = Math.min(start + phases.at(-1).end, sessionStopAt());
    if (chosenBlock()?.start !== finish) {
      reminders.push(makeReminder(session.id + '-finish', finish, 'Session finished',
        'Open LifeTimer when you’re ready to plan your next block.', 'session'));
    }
  }

  if (testReminder) reminders.push(testReminder);
  return reminders;
}

function pushStatus(message) {
  $('notification-status').textContent = message ?? (subscription ? 'Background reminders enabled.' : 'In-app reminders are on.');
  $('enable-push').hidden = !!subscription;
  $('enable-push').disabled = pushBusy;
  $('disable-push').hidden = !subscription;
  $('test-push').hidden = !subscription;
  $('disable-push').disabled = pushBusy;
  $('test-push').disabled = pushBusy;
}

function syncPush() {
  if (!subscription || pushBusy) return Promise.resolve(false);
  const currentSubscription = subscription;
  const now = Date.now();
  const upcoming = reminders().filter(reminder => reminder.at > now);
  pushQueue = pushQueue.then(async () => {
    if (subscription !== currentSubscription) return false;
    try {
      await saveReminders(currentSubscription, upcoming);
      pushStatus();
      return true;
    } catch (error) {
      pushStatus(error.message);
      return false;
    }
  });
  return pushQueue;
}

function refresh({ replan = false, store = true } = {}) {
  const now = Date.now();
  if (replan) state.anchor = now;
  if (store) saveState();
  plan = calculatePlan(now);
  const date = $('today-date').querySelector('time');
  date.textContent = dateFormat.format(now);
  date.dateTime = new Date(now).toISOString();
  renderBudget();
  renderWater();
  renderPlan();
  renderTasks();
  renderTimer(now);
  renderCampaign();
  renderHistory();
  health.render();
  syncPush();
}

function endSession(now, completed) {
  const entry = finishSession(state, now);
  refresh({ replan: true });
  if (!entry) return;
  notify(completed ? 'Session complete' : 'Session ended', duration(entry.focusMinutes) + ' of focus logged. Check in to record the outcome.');
  openReview(entry.taskId, entry.id);
}

function tick() {
  const now = Date.now();
  if (dayKey(now) !== previousDay || buildPlan([], state.settings, new Date(now)).windowEnd !== plan.windowEnd) {
    const day = dayKey(now);
    if (day !== previousDay) shownReminders.clear();
    previousDay = day;
    // Re-anchor when a different wake window begins.
    if (!state.session) refresh({ replan: true });
    else { renderWater(); health.render(); }
  }

  const due = reminders().filter(reminder => reminder.id !== testReminder?.id && reminder.at > previousTick
    && reminder.at <= now && now - reminder.at < 90_000 && !shownReminders.has(reminder.id));
  if (plan.blocks.some(block => block.end > previousTick && block.end <= now)) renderPlan();
  due.forEach(reminder => shownReminders.add(reminder.id));
  const latest = due.at(-1);
  if (latest) notify(latest.title, latest.body);

  if (state.session && state.session.runningSince !== null) {
    const naturalEnd = state.session.runningSince + activePhases().at(-1).end - state.session.elapsed;
    const finish = Math.min(naturalEnd, sessionStopAt());
    if (now >= finish) endSession(finish, naturalEnd <= sessionStopAt());
  }
  if (testReminder && testReminder.at < now - 60_000) testReminder = undefined;

  previousTick = now;
  renderTimer(now);
}

function sessionStopAt() {
  return state.session.stopAt ??
    buildPlan([], state.settings, new Date(state.session.startedAt)).windowEnd;
}

function startOrPause() {
  const now = Date.now();
  if (state.session) {
    const { session } = state;
    if (session.runningSince === null) {
      const current = planAt(state.tasks, now);
      const currentWindow = buildPlan([], state.settings, new Date(now));
      const currentWake = currentWindow.windowEnd - currentWindow.workMinutes * MINUTE;
      const remainingWall = activePhases().at(-1).end - session.elapsed;
      const remainingFocus = session.minutes - focusElapsed(activePhases(), session.elapsed) / MINUTE;
      const availableFocus = state.settings.dailyFocusHours * 60 - usedFocus(state.history, now)
        - focusElapsed(activePhases(), session.elapsed) / MINUTE;
      if (session.startedAt < currentWake || now + remainingWall > sessionStopAt()
        || remainingFocus > availableFocus || (state.campaign && (current.isRest || !current.blocks.length))) {
        endSession(now, false);
        return;
      }
    }
    session.elapsed = sessionElapsed(session, now);
    if (session.runningSince !== null) session.interruptions = (session.interruptions || 0) + 1;
    session.runningSince = session.runningSince === null ? now : null;
    refresh({ replan: true });
    return;
  }
  const fresh = planAt(state.tasks, now);
  const block = fresh.blocks.find(block => block.kind === 'focus');
  if (!block) {
    if (state.anchor !== now) refresh({ replan: true });
    if (!state.tasks.some(task => !task.done)) showDialog('tasks-dialog', true);
    else {
      const pending = state.tasks.find(task => !task.done && task.remainingMinutes <= 0);
      if (pending) openReview(pending.id);
      else notify('No focus block available', 'Your daily allowance, rest days, and plan dates determine the next available block.');
    }
    return;
  }
  if (block.start > now + 60_000) {
    notify('Your focus window starts at ' + timeFormat.format(block.start), 'Adjust your wake time in Settings if you want to start earlier.');
    return;
  }
  const unreviewed = state.history.find(entry => entry.taskId === block.taskId && !entry.reviewedAt);
  if (unreviewed) { openReview(block.taskId, unreviewed.id); return; }
  const task = state.tasks.find(task => task.id === block.taskId);
  const next = fresh.blocks[fresh.blocks.indexOf(block) + 1];
  state.session = {
    id: 'session-' + now,
    taskId: block.taskId,
    title: block.title,
    minutes: block.minutes,
    recovery: next?.kind === 'break' ? next.minutes : 0,
    startedAt: now,
    stopAt: fresh.windowEnd,
    elapsed: 0,
    runningSince: now,
    interruptions: 0,
    goal: task.goal,
    criteria: task.criteria,
    checkpoints: task.checkpoints.map(item => ({ ...item })),
  };
  refresh({ replan: true });
  notify('Focus started', block.title);
}

function moveTask(index, newIndex) {
  const [task] = state.tasks.splice(index, 1);
  state.tasks.splice(newIndex, 0, task);
}

function adjustWater(amount) {
  const key = dayKey(Date.now());
  state.water[key] = Math.max(0, (state.water[key] || 0) + amount);
  saveState();
  renderWater();
  refresh({ store: false });
}

function addTask(title, minutes) {
  state.tasks.push(createTask({ title, minutes }));
}

function openReview(taskId, entryId) {
  const task = state.tasks.find(task => task.id === taskId);
  if (!task || task.id === state.session?.taskId) return;
  const pending = state.history.find(entry => entry.taskId === taskId && !entry.reviewedAt);
  const entry = state.history.find(item => item.id === (entryId ?? pending?.id));
  reviewingTaskId = taskId;
  reviewingEntryId = entry?.id;
  const form = $('review-form');
  form.reset();
  $('review-task-title').textContent = task.title;
  $('review-session-summary').textContent = entry
    ? duration(entry.focusMinutes) + ' focus logged · ' + new Date(entry.endedAt).toLocaleString()
    : 'Record progress and choose the next step.';
  $('review-goal').textContent = task.goal;
  $('review-criteria').textContent = task.criteria || 'No success criteria entered yet.';
  $('review-checkpoints').hidden = !task.checkpoints.length;
  $('review-checkpoint-list').replaceChildren(...task.checkpoints.map(checkpoint => {
    const label = element('label', 'checkpoint-label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.name = 'checkpoint';
    checkbox.value = checkpoint.id;
    checkbox.checked = checkpoint.done;
    label.append(checkbox, document.createTextNode(checkpoint.title));
    return label;
  }));
  form.elements.remainingMinutes.value = Math.max(1, Math.ceil(task.remainingMinutes || state.settings.focusMinutes));
  form.elements.remainingMinutes.disabled = false;
  form.elements.interruptions.value = entry?.interruptions ?? 0;
  $('review-error').hidden = true;
  if (!$('review-dialog').open) $('review-dialog').showModal();
}

function renderHistory() {
  const panel = $('history-panel');
  const heading = element('div', 'card-header');
  const title = element('div');
  title.append(element('h2', 'card-title', 'Work review'));
  title.firstChild.id = 'history-heading';
  const pending = state.history.filter(entry => !entry.reviewedAt);
  const today = state.history.filter(entry => dateKey(entry.startedAt) === dateKey(Date.now()));
  title.append(element('p', 'card-subtitle',
    duration(today.reduce((sum, entry) => sum + entry.focusMinutes, 0)) + ' logged today · ' + pending.length + ' awaiting review'));
  heading.append(title);
  const rows = element('ol', 'review-list');
  const reviewed = state.history.filter(entry => entry.reviewedAt).slice().reverse();
  const entries = [...pending.slice().reverse(), ...reviewed.slice(0, historyLimit)];
  for (const entry of entries) {
    const row = element('li');
    const top = element('div', 'history-title');
    top.append(element('strong', '', entry.title), element('span', 'timeline-meta',
      entry.kind === 'task' ? 'Task check-in' : duration(entry.focusMinutes) + ' focus'));
    row.append(top, element('span', 'timeline-meta', new Date(entry.endedAt).toLocaleString()));
    row.append(element('p', '', entry.reviewedAt
      ? (entry.outcome === 'done' ? 'Confirmed complete' : 'Continuing') +
        (entry.quality ? ' · Focus ' + entry.quality + '/5' : '') + ' · ' + entry.interruptions + ' interruptions'
      : 'Task check-in needed'));
    if (entry.notes) row.append(element('p', '', entry.notes));
    if (!entry.reviewedAt && state.tasks.some(task => task.id === entry.taskId)) {
      const button = element('button', 'button button-secondary', 'Review session');
      button.type = 'button';
      button.addEventListener('click', () => openReview(entry.taskId, entry.id));
      row.append(button);
    }
    const snapshot = element('details');
    snapshot.append(element('summary', '', entry.kind === 'task' ? 'Goal at check-in' : 'Goal at session start'), element('p', '', entry.goal),
      element('p', '', entry.criteria || 'No success criteria entered'));
    if (entry.checkpoints?.length) {
      snapshot.append(element('p', 'timeline-meta', 'Original checkpoints'));
      for (const checkpoint of entry.checkpoints) {
        snapshot.append(element('p', '', checkpoint.title));
      }
    }
    row.append(snapshot);
    rows.append(row);
  }
  panel.replaceChildren(heading, rows);
  if (reviewed.length > historyLimit) {
    const more = element('button', 'button button-secondary', 'Show earlier records');
    more.type = 'button';
    more.addEventListener('click', () => { historyLimit += 10; renderHistory(); });
    panel.append(more);
  }
  if (!entries.length) panel.append(element('p', 'history-summary', 'Completed sessions and task check-ins will appear here.'));
}

function renderCampaign() {
  const panel = $('campaign-panel');
  const header = element('div', 'card-header');
  const title = element('div');
  const h = element('h2', 'card-title', 'Goal plan');
  h.id = 'campaign-heading';
  title.append(h, element('p', 'card-subtitle', 'A clear outcome over 3 days, a week, or a fortnight'));
  const button = element('button', 'button button-secondary', state.campaign ? 'End plan' : 'Start a plan');
  button.type = 'button';
  button.addEventListener('click', () => {
    if (state.campaign) {
      if (!confirm('End this goal plan? Its original goal and checkpoints will be kept in plan history.')) return;
      state.campaignHistory.push({ ...state.campaign, endedAt: Date.now() });
      state.campaign = null;
      refresh({ replan: true });
    } else {
      const form = $('campaign-form');
      form.reset();
      form.elements.startDate.value = dateKey(Date.now());
      const latest = new Date();
      latest.setDate(latest.getDate() + 1);
      form.elements.startDate.min = dateKey(Date.now());
      form.elements.startDate.max = dateKey(latest);
      $('campaign-dialog').showModal();
    }
  });
  header.append(title, button);
  panel.replaceChildren(header);
  const campaign = state.campaign;
  if (campaign) {
    panel.append(element('p', 'campaign-goal', campaign.goal));
    panel.append(element('p', 'history-summary', campaign.startDate + ' – ' + campaignPlan.endDate +
      ' · ' + duration(state.settings.dailyFocusHours * 60) + ' daily focus allowance'));
    const checkpoints = element('div');
    for (const checkpoint of campaign.checkpoints ?? []) {
      const label = element('label', 'checkpoint-label');
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = checkpoint.done;
      check.addEventListener('change', () => {
        checkpoint.done = check.checked;
        checkpoint.completedAt = check.checked ? Date.now() : null;
        refresh();
      });
      label.append(check, document.createTextNode(checkpoint.title));
      checkpoints.append(label);
    }
    panel.append(checkpoints);
    const days = element('div', 'campaign-days');
    for (const day of campaignPlan.days) {
      const node = element('div', 'campaign-day' + (day.date === dateKey(Date.now()) ? ' is-today' : ''));
      node.append(element('span', '', new Date(day.date + 'T12:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })),
        element('strong', '', day.isRest ? 'Rest day' : duration(day.focusMinutes + day.usedFocusMinutes)),
        element('span', '', day.isPast ? 'Logged focus' : 'Planned + logged'));
      days.append(node);
    }
    panel.append(days);
    const overflow = campaignPlan.unscheduled.reduce((sum, task) => sum + task.minutes, 0);
    if (overflow) panel.append(element('p', 'plan-overflow', duration(overflow) + ' exceeds the remaining plan capacity. Adjust the scope or estimates.'));
  } else {
    panel.append(element('p', 'history-summary', 'Spread your task list across days with a daily focus allowance and your chosen rest days.'));
  }
  if (state.campaignHistory.length) {
    const details = element('details', 'view-guidance');
    details.append(element('summary', '', 'Previous goal plans'));
    for (const previous of state.campaignHistory.slice().reverse()) {
      details.append(element('p', '', previous.goal));
      details.append(element('span', 'timeline-meta', previous.startDate + ' · ' + previous.days + ' days'));
      for (const checkpoint of previous.checkpoints ?? []) {
        details.append(element('p', '', (checkpoint.done ? '✓ ' : '○ ') + checkpoint.title));
      }
    }
    panel.append(details);
  }
}

$('review-form').elements.outcome.addEventListener('change', event => {
  $('review-form').elements.remainingMinutes.disabled = event.target.value === 'done';
});
$('review-form').addEventListener('submit', event => {
  event.preventDefault();
  const task = state.tasks.find(task => task.id === reviewingTaskId);
  if (!task || task.id === state.session?.taskId) return;
  const data = new FormData(event.target);
  const done = data.get('outcome') === 'done';
  const completed = new Set(data.getAll('checkpoint'));
  if (done && task.checkpoints.some(checkpoint => !completed.has(checkpoint.id))) {
    $('review-error').textContent = 'Confirm each original checkpoint before marking this task done.';
    $('review-error').hidden = false;
    return;
  }
  const now = Date.now();
  const entry = state.history.find(item => item.id === reviewingEntryId) ?? {
    id: crypto.randomUUID(), kind: 'task', taskId: task.id, title: task.title,
    startedAt: now, endedAt: now, focusMinutes: 0, plannedMinutes: 0,
    goal: task.goal, criteria: task.criteria, checkpoints: task.checkpoints.map(item => ({ ...item })),
  };
  const remainingMinutes = done ? 0 : Number(data.get('remainingMinutes'));
  Object.assign(entry, {
    outcome: done ? 'done' : 'continue', remainingMinutes, notes: data.get('notes').trim(),
    quality: data.get('quality') ? Number(data.get('quality')) : null,
    interruptions: Number(data.get('interruptions') || 0), reviewedAt: now,
  });
  if (!state.history.includes(entry)) state.history.push(entry);
  task.done = done;
  task.remainingMinutes = remainingMinutes;
  for (const checkpoint of task.checkpoints) {
    const checked = completed.has(checkpoint.id);
    if (checked !== checkpoint.done) checkpoint.completedAt = checked ? now : null;
    checkpoint.done = checked;
  }
  entry.checkedCheckpointIds = [...completed];
  $('review-dialog').close();
  refresh({ replan: true });
  notify('Check-in saved', done ? 'Task confirmed complete.' : 'Your remaining work has been replanned.');
});

const weekdays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
$('rest-weekdays').replaceChildren(...weekdays.map((day, index) => {
  const label = element('label', 'checkpoint-label');
  const check = document.createElement('input');
  check.type = 'checkbox';
  check.name = 'restWeekdays';
  check.value = index;
  label.append(check, document.createTextNode(day));
  return label;
}));
$('campaign-form').addEventListener('submit', event => {
  event.preventDefault();
  const data = new FormData(event.target);
  const goal = data.get('goal').trim();
  if (!goal) {
    event.target.elements.goal.setCustomValidity('Enter the outcome for this plan.');
    event.target.elements.goal.reportValidity();
    return;
  }
  state.campaign = {
    id: crypto.randomUUID(), goal, startDate: data.get('startDate'), days: Number(data.get('days')),
    restWeekdays: data.getAll('restWeekdays').map(Number), createdAt: Date.now(),
    checkpoints: data.get('checkpoints').split('\n').map(line => line.trim()).filter(Boolean)
      .map(title => ({ id: crypto.randomUUID(), title, done: false, completedAt: null })),
  };
  $('campaign-dialog').close();
  refresh({ replan: true });
  notify('Goal plan started', 'Your task estimates have been spread across the available days.');
});
$('campaign-form').elements.goal.addEventListener('input', event => event.target.setCustomValidity(''));

document.querySelectorAll('[data-dialog]').forEach(button => {
  button.addEventListener('click', () => showDialog(button.dataset.dialog, button.hasAttribute('data-add-task')));
});
document.querySelectorAll('[data-close]').forEach(button => {
  button.addEventListener('click', () => button.closest('dialog').close());
});
$('tasks-dialog').addEventListener('close', () => setTaskEditor(undefined, false));
$('cancel-edit').addEventListener('click', () => setTaskEditor());
taskForm.elements.title.addEventListener('input', () => taskForm.elements.title.setCustomValidity(''));
taskForm.addEventListener('submit', event => {
  event.preventDefault();
  const data = new FormData(taskForm);
  const title = data.get('title').trim();
  const minutes = Number(data.get('minutes'));
  if (!title) {
    taskForm.elements.title.setCustomValidity('Enter a task name.');
    taskForm.elements.title.reportValidity();
    return;
  }
  const task = state.tasks.find(item => item.id === editingId);
  if (task && task.id !== state.session?.taskId) {
    Object.assign(task, reviseTask(task, { title, remainingMinutes: minutes, criteria: data.get('criteria') }));
  } else if (!editingId) {
    state.tasks.push(createTask({
      title, minutes, goal: data.get('goal'), criteria: data.get('criteria'),
      checkpoints: data.get('checkpoints').split('\n').map(line => line.trim()).filter(Boolean),
    }));
  }
  setTaskEditor();
  refresh({ replan: true });
});
$('task-list').addEventListener('click', event => {
  const button = event.target.closest('[data-task-action]');
  if (!button) return;
  const index = state.tasks.findIndex(item => item.id === button.dataset.taskId);
  const task = state.tasks[index];
  if (!task) return;
  switch (button.dataset.taskAction) {
    case 'up': moveTask(index, index - 1); break;
    case 'down': moveTask(index, index + 1); break;
    case 'edit': setTaskEditor(task); return;
    case 'done':
      if (!task.done) {
        const pending = state.history.find(entry => entry.taskId === task.id && !entry.reviewedAt);
        openReview(task.id, pending?.id);
        return;
      }
      task.done = false;
      task.remainingMinutes = state.settings.focusMinutes;
      break;
    case 'remove':
      if (state.history.some(entry => entry.taskId === task.id && !entry.reviewedAt)) {
        notify('Review this task first', 'Save its pending session check-in before removing it.');
        return;
      }
      if (!confirm('Remove this task? Its recorded session history will be kept.')) return;
      state.tasks.splice(index, 1);
      if (task.id === editingId) setTaskEditor();
      break;
  }
  refresh({ replan: true });
  if (button.dataset.taskAction === 'up' || button.dataset.taskAction === 'down') {
    const controls = $('task-list').querySelectorAll('[data-task-id]');
    const sameAction = [...controls].find(item =>
      item.dataset.taskId === task.id && item.dataset.taskAction === button.dataset.taskAction);
    if (!sameAction?.disabled) sameAction?.focus();
    else [...controls].find(item => item.dataset.taskId === task.id && !item.disabled)?.focus();
  }
});
settingsForm.addEventListener('submit', event => {
  event.preventDefault();
  const data = new FormData(settingsForm);
  state.settings = {
    wakeTime: data.get('wakeTime'),
    sleepHours: Number(data.get('sleepHours')),
    focusMinutes: Number(data.get('focusMinutes')),
    waterLitres: Number(data.get('waterLitres')),
    dailyFocusHours: Number(data.get('dailyFocusHours')),
  };
  refresh({ replan: true });
  $('settings-dialog').close();
  notify('Settings saved', 'Your plan was updated.');
});
$('replan').addEventListener('click', () => {
  refresh({ replan: true });
  notify('Plan updated', 'Remaining work was fitted to your current time window.');
});
$('demo-tasks').addEventListener('click', () => {
  addTask('Work on a priority project', 40);
  addTask('Review notes and next steps', 25);
  refresh({ replan: true });
  notify('Example tasks added', 'You can edit or remove them under Tasks.');
});
$('focus-start').addEventListener('click', startOrPause);
$('focus-end').addEventListener('click', () => {
  if (!state.session) return;
  const now = Date.now();
  const earned = focusElapsed(activePhases(), sessionElapsed(state.session, now));
  endSession(now, earned === state.session.minutes * MINUTE);
});
$('water-add').addEventListener('click', () => adjustWater(250));
$('water-undo').addEventListener('click', () => adjustWater(-250));
$('notice-close').addEventListener('click', () => { $('notice').hidden = true; });

$('enable-push').addEventListener('click', async () => {
  pushBusy = true;
  pushStatus('Connecting to your browser’s push service…');
  try {
    subscription = await subscribe();
    state.background = true;
    saveState();
    pushBusy = false;
    await syncPush();
  } catch (error) {
    pushBusy = false;
    pushStatus(error.message);
  }
});
$('test-push').addEventListener('click', async () => {
  const at = Date.now() + 5000;
  testReminder = makeReminder('test-' + at, at, 'LifeTimer test', 'Background reminders are reaching this device.', 'test');
  if (await syncPush()) {
    pushStatus('Test queued. Close this tab and look for a system notification in about 5 seconds.');
  } else {
    testReminder = undefined;
  }
});
$('disable-push').addEventListener('click', async () => {
  pushBusy = true;
  pushStatus('Clearing scheduled reminders…');
  try {
    await pushQueue;
    await saveReminders(subscription, []);
    await subscription.unsubscribe();
    subscription = undefined;
    state.background = false;
    testReminder = undefined;
    saveState();
    pushBusy = false;
    pushStatus();
  } catch (error) {
    pushBusy = false;
    pushStatus(error.message);
  }
});

window.addEventListener('storage', event => {
  if (event.key !== STORAGE_KEY) return;
  state = loadState();
  if (!state.background) subscription = undefined;
  else if (!subscription) restorePush();
  refresh({ store: false });
});

async function restorePush() {
  if (!state.background) return;
  try {
    subscription = await existingSubscription();
    if (subscription) await syncPush();
    else pushStatus('Enable background reminders again to renew this browser’s subscription.');
  } catch (error) {
    pushStatus(error.message);
  }
}

const currentWindow = buildPlan([], state.settings).windowEnd;
const savedWindow = buildPlan([], state.settings, new Date(state.anchor)).windowEnd;
refresh({ replan: currentWindow !== savedWindow });
restorePush();
tick();
setInterval(tick, 1000);
