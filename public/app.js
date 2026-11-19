import { buildPlan, DEFAULT_SETTINGS } from './planner.js';
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
let editingId;
let subscription;
let pushBusy = false;
let pushQueue = Promise.resolve();
let testReminder;
let noticeTimeout;
let previousTick = Date.now();
let previousDay = dayKey(previousTick);
const shownReminders = new Set();

function loadState() {
  const defaults = {
    settings: { ...DEFAULT_SETTINGS },
    tasks: [],
    session: null,
    water: {},
    anchor: Date.now(),
    background: false,
  };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(STORAGE_KEY)) };
  } catch {
    return defaults;
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function dayKey(timestamp) {
  const date = new Date(timestamp);
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].join('-');
}

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

function nextFocusNow(now) {
  return buildPlan(state.tasks, state.settings, new Date(now)).blocks.find(block => block.kind === 'focus');
}

function calculatePlan(now) {
  const session = state.session;
  if (!session) return buildPlan(state.tasks, state.settings, new Date(state.anchor));

  const finish = activePhases().at(-1).end;
  const projectedEnd = session.runningSince === null
    ? Math.max(state.anchor, now) + finish - session.elapsed
    : session.runningSince + finish - session.elapsed;
  const projectedTasks = state.tasks.map(task => task.id === session.taskId
    ? { ...task, completedMinutes: task.completedMinutes + session.minutes }
    : task);
  return buildPlan(projectedTasks, state.settings, new Date(projectedEnd));
}

function renderBudget() {
  const { sleepHours } = state.settings;
  const workable = duration(plan.workMinutes);
  $('budget-work').textContent = workable;
  $('budget-work-row').textContent = workable;
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
    : plan.unscheduled.length ? 'Your workable window has ended. Unfinished tasks carry forward.' : 'All tasks are complete.';
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
  const hasWork = state.tasks.some(task => task.completedMinutes < task.minutes);
  let taskTitle = next?.title ?? (hasWork ? 'Work window closed' : 'Plan your first block');
  let copy = next
    ? (next.start > now + MINUTE
      ? `Your work window opens at ${timeFormat.format(next.start)}.`
      : `${duration(next.minutes)} of focus, with breaks as needed.`)
    : hasWork
      ? 'Unfinished tasks stay on your list for the next workable window.'
      : 'Add a task to build your plan.';
  let action = next ? 'Start focus' : hasWork ? 'Check window' : 'Add task';
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
  $('task-count').textContent = state.tasks.filter(task => task.completedMinutes < task.minutes).length;
  $('task-count').hidden = state.tasks.length === 0;
  const rows = state.tasks.map((task, index) => {
    const row = element('li', 'task-item');
    const details = element('div', 'task-item-info');
    const done = task.completedMinutes >= task.minutes;
    const locked = task.id === state.session?.taskId;
    details.append(element('strong', '', task.title), element('span', 'timeline-meta',
      done ? 'Complete' : `${duration(task.minutes - task.completedMinutes)} remaining · ${duration(task.minutes)} estimated`));
    const actions = element('div', 'task-row-actions');
    actions.append(
      control('up', 'Move up', 'up', task, index === 0),
      control('down', 'Move down', 'down', task, index === state.tasks.length - 1),
      control('edit', 'Edit', 'settings', task, locked),
      control('done', done ? 'Reopen' : 'Mark complete', done ? 'refresh' : 'check', task, locked),
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
  taskForm.elements.minutes.value = task?.minutes ?? state.settings.focusMinutes;
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
  const reminders = [];
  const { windowEnd, workMinutes } = plan;
  const wake = windowEnd - workMinutes * MINUTE;
  const bedtime = wake + (24 - state.settings.sleepHours) * 60 * MINUTE;
  const target = Math.ceil(state.settings.waterLitres * 4);
  const logged = state.water[dayKey(Date.now())] || 0;
  const hydrationCadence = (bedtime - wake) / (target + 1);
  if (logged < state.settings.waterLitres * 1000) {
    for (let glass = 1; glass <= target; glass++) {
      const at = Math.round(wake + glass * hydrationCadence);
      reminders.push(makeReminder('water-' + at, at, 'Pause for water', 'Take a sip and log a glass if you drink one.', 'water'));
    }
  }

  if (session && session.runningSince !== null) {
    const start = session.runningSince - session.elapsed;
    const phases = activePhases();
    for (const phase of phases.slice(1)) {
      const [title, body] = breakPrompts[phase.kind] ?? ['Back to focus', session.title];
      reminders.push(makeReminder(session.id + '-' + phase.start, start + phase.start, title, body, 'session'));
    }
    const finish = phases.at(-1).end;
    if (chosenBlock()?.start !== start + finish) {
      reminders.push(makeReminder(session.id + '-finish', start + finish, 'Session finished',
        'Open LifeTimer when you’re ready to plan your next block.', 'session'));
    }
  }

  if (!session || session.runningSince !== null) {
    for (const block of plan.blocks.filter(block => block.kind === 'focus').slice(0, 200)) {
      reminders.push(makeReminder('plan-' + block.id, block.start, 'Time to lock in', block.title, 'plan'));
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
  syncPush();
}

function endSession(now, completed) {
  const task = state.tasks.find(task => task.id === state.session.taskId);
  const earned = Math.floor(focusElapsed(activePhases(), sessionElapsed(state.session, now)) / MINUTE);
  if (task) task.completedMinutes = Math.min(task.minutes, task.completedMinutes + earned);
  state.session = null;
  refresh({ replan: true });
  notify(completed ? 'Session complete' : 'Session ended', earned
    ? `${duration(earned)} of focus logged.`
    : 'No full focus minutes logged.');
}

function tick() {
  const now = Date.now();
  if (dayKey(now) !== previousDay || buildPlan([], state.settings, new Date(now)).windowEnd !== plan.windowEnd) {
    const day = dayKey(now);
    if (day !== previousDay) shownReminders.clear();
    previousDay = day;
    // Re-anchor when a different wake window begins.
    if (!state.session) refresh({ replan: true });
    else renderWater();
  }

  const due = reminders().filter(reminder => reminder.id !== testReminder?.id && reminder.at > previousTick
    && reminder.at <= now && now - reminder.at < 90_000 && !shownReminders.has(reminder.id));
  if (plan.blocks.some(block => block.end > previousTick && block.end <= now)) renderPlan();
  due.forEach(reminder => shownReminders.add(reminder.id));
  const latest = due.at(-1);
  if (latest) notify(latest.title, latest.body);

  if (state.session && sessionElapsed(state.session, now) >= activePhases().at(-1).end) {
    endSession(now, true);
  }
  if (testReminder && testReminder.at < now - 60_000) testReminder = undefined;

  previousTick = now;
  renderTimer(now);
}

function startOrPause() {
  const now = Date.now();
  if (state.session) {
    const { session } = state;
    session.elapsed = sessionElapsed(session, now);
    session.runningSince = session.runningSince === null ? now : null;
    refresh({ replan: true });
    return;
  }
  const fresh = buildPlan(state.tasks, state.settings, new Date(now));
  const block = fresh.blocks.find(block => block.kind === 'focus');
  if (!block) {
    if (state.anchor !== now) refresh({ replan: true });
    if (!state.tasks.some(task => task.completedMinutes < task.minutes)) showDialog('tasks-dialog', true);
    else notify('No focus time left today', 'Your tasks will stay on the list for the next workable window.');
    return;
  }
  if (block.start > now + 60_000) {
    notify('Your focus window starts at ' + timeFormat.format(block.start), 'Adjust your wake time in Settings if you want to start earlier.');
    return;
  }
  const next = fresh.blocks[fresh.blocks.indexOf(block) + 1];
  state.session = {
    id: 'session-' + now,
    taskId: block.taskId,
    title: block.title,
    minutes: block.minutes,
    recovery: next?.kind === 'break' ? next.minutes : 0,
    startedAt: now,
    elapsed: 0,
    runningSince: now,
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
  state.water = { [key]: Math.max(0, (state.water[key] || 0) + amount) };
  saveState();
  renderWater();
  syncPush();
}

function addTask(title, minutes) {
  state.tasks.push({ id: crypto.randomUUID(), title, minutes, completedMinutes: 0 });
}

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
    Object.assign(task, { title, minutes, completedMinutes: Math.min(task.completedMinutes, minutes) });
  } else if (!editingId) {
    addTask(title, minutes);
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
    case 'done': task.completedMinutes = task.completedMinutes >= task.minutes ? 0 : task.minutes; break;
    case 'remove':
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
