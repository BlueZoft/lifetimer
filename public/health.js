function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function dateInputValue(date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')].join('-');
}

function optionalNumber(value) {
  return value === '' ? undefined : Number(value);
}

export function summarizeHealth(entries) {
  function average(values) {
    return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 10) / 10 : null;
  }
  const sleep = entries.map(entry => entry?.morning?.sleepHours).filter(Number.isFinite);
  const energy = entries.flatMap(entry => [entry?.morning?.energy, entry?.evening?.energy]).filter(Number.isFinite);
  return {
    daysLogged: entries.filter(entry => entry?.morning || entry?.evening).length,
    sleepHours: average(sleep),
    sleepSamples: sleep.length,
    energy: average(energy),
    energySamples: energy.length,
    walks: entries.reduce((sum, entry) => sum + (entry?.activity?.walks || 0), 0),
    exerciseMinutes: entries.reduce((sum, entry) => sum + (entry?.activity?.exerciseMinutes || 0), 0),
  };
}

export function initHealth({ getState, onChange, notify, dayKey }) {
  const panel = document.getElementById('health-panel');
  const dialog = document.getElementById('health-dialog');
  const fullDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  let mode = 'morning';
  let selectedDate = dateInputValue(new Date());
  let trendDays = 7;

  function selectedKey() {
    return dayKey(new Date(selectedDate + 'T12:00:00').getTime());
  }

  function selectedEntry() {
    return getState().health?.[selectedKey()] || {};
  }

  function changeEntry(change) {
    const state = getState();
    state.health ??= {};
    const key = selectedKey();
    state.health[key] = change(state.health[key] || {});
    onChange();
    render();
  }

  function button(label, action, className = 'button button-secondary') {
    const control = node('button', className, label);
    control.type = 'button';
    control.addEventListener('click', action);
    return control;
  }

  function logActivity(name, amount) {
    const state = getState();
    const key = dayKey(Date.now());
    state.health ??= {};
    const entry = state.health[key] || {};
    state.health[key] = { ...entry, activity: {
      ...entry.activity,
      [name]: Math.max(0, (entry.activity?.[name] || 0) + amount),
    } };
    onChange();
    render();
  }

  function render() {
    const entry = getState().health?.[dayKey(Date.now())] || {};
    const heading = node('div', 'card-header');
    const title = node('div');
    title.append(node('h2', 'card-title', 'Daily check-ins'), node('p', 'card-subtitle', 'Notice how your day is feeling'));
    heading.append(title);

    const content = node('div', 'health-content');
    const actions = node('div', 'health-actions');
    actions.append(
      button(entry.morning ? 'Edit morning' : 'Morning check-in', () => openCheckin('morning')),
      button(entry.evening ? 'Edit evening' : 'Evening check-in', () => openCheckin('evening')),
    );
    const summary = [];
    if (entry.morning?.sleepHours !== undefined) summary.push(entry.morning.sleepHours + 'h sleep logged');
    if (entry.morning?.energy !== undefined) summary.push('Morning energy ' + entry.morning.energy + '/5');
    if (entry.evening?.energy !== undefined) summary.push('Evening energy ' + entry.evening.energy + '/5');
    content.append(actions, node('p', 'health-caption', summary.join(' · ') || 'Check in when you have a moment. Every field is optional.'));

    const lowEnergy = [entry.morning?.energy, entry.evening?.energy].some(value => value !== undefined && value <= 2);
    const shortSleep = entry.morning?.sleepHours !== undefined && entry.morning.sleepHours < getState().settings.sleepHours;
    if (lowEnergy || shortSleep) {
      content.append(node('p', 'health-suggestion', 'A lighter day may help. Consider reducing today’s focus cap or taking a longer break. You can adjust your plan in Settings.'));
    }

    const activities = node('div', 'health-activities');
    activities.append(node('h3', '', 'Log a completed break'));
    const controls = node('div', 'health-actions');
    for (const [name, label] of [['walks', 'Walk'], ['meals', 'Meal'], ['screenBreaks', 'Screen break']]) {
      const count = entry.activity?.[name] || 0;
      const group = node('div', 'health-activity-control');
      group.append(button('+ ' + label, () => logActivity(name, 1)), node('span', 'health-count', count + ' logged'));
      if (count) {
        const undo = button('Undo', () => logActivity(name, -1), 'health-text-button');
        undo.setAttribute('aria-label', 'Undo last ' + label.toLowerCase() + ' log');
        group.append(undo);
      }
      controls.append(group);
    }
    activities.append(controls, node('p', 'health-caption', 'Log activities after you complete them.'));
    content.append(activities);
    content.append(trends());
    panel.replaceChildren(heading, content);
  }

  function trends() {
    const details = node('details', 'health-trends');
    details.append(node('summary', '', 'Recent check-ins'));
    const selector = node('div', 'health-actions');
    for (const days of [7, 14]) {
      const control = button(days + ' days', () => {
        trendDays = days;
        details.replaceWith(trends());
        panel.querySelector('.health-trends').open = true;
      });
      control.setAttribute('aria-pressed', String(days === trendDays));
      selector.append(control);
    }
    const days = [];
    for (let offset = trendDays - 1; offset >= 0; offset--) {
      const date = new Date();
      date.setDate(date.getDate() - offset);
      days.push({ date, entry: getState().health?.[dayKey(date.getTime())] });
    }
    const totals = summarizeHealth(days.map(day => day.entry));
    const summary = node('p', 'health-caption', totals.daysLogged + ' of ' + trendDays + ' days with check-ins');
    const metrics = node('ul', 'health-trend-summary');
    if (totals.sleepHours !== null) metrics.append(node('li', '', totals.sleepHours + 'h average sleep · ' + totals.sleepSamples + ' logs'));
    if (totals.energy !== null) metrics.append(node('li', '', totals.energy + '/5 average energy · ' + totals.energySamples + ' logs'));
    metrics.append(node('li', '', totals.walks + ' walks logged · ' + totals.exerciseMinutes + ' exercise minutes logged'));
    const table = node('table', 'health-table');
    const header = node('tr');
    for (const label of ['Date', 'Sleep', 'Energy AM / PM']) header.append(node('th', '', label));
    const head = node('thead');
    head.append(header);
    const body = node('tbody');
    for (const { date, entry } of days) {
      const row = node('tr');
      const dateCell = node('td');
      const edit = button(fullDate.format(date), () => {
        selectedDate = dateInputValue(date);
        openCheckin(entry?.morning ? 'evening' : 'morning', selectedDate);
      }, 'health-text-button');
      edit.setAttribute('aria-label', 'Edit health check-in for ' + fullDate.format(date));
      dateCell.append(edit);
      row.append(dateCell, node('td', '', entry?.morning?.sleepHours === undefined ? '—' : entry.morning.sleepHours + 'h'),
        node('td', '', (entry?.morning?.energy ?? '—') + ' / ' + (entry?.evening?.energy ?? '—')));
      body.append(row);
    }
    table.append(head, body);
    details.append(selector, summary, metrics, table, node('p', 'health-caption', 'A dash means no entry. Averages include only recorded values.'));
    return details;
  }

  function numberField(label, name, value, { min = 0, max = 1440, step = 1 } = {}) {
    const field = node('label', 'field', label);
    const input = node('input');
    input.type = 'number';
    input.name = name;
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = value ?? '';
    input.placeholder = 'Optional';
    field.append(input);
    return field;
  }

  function ratingField(label, name, value, labels = ['Very low', 'Low', 'Okay', 'Good', 'Very good'], first = 1) {
    const field = node('div', 'field');
    const caption = node('label', '', label);
    const select = node('select');
    select.id = 'health-' + mode + '-' + name;
    caption.htmlFor = select.id;
    select.name = name;
    const blank = node('option', '', 'Skip this signal');
    blank.value = '';
    select.append(blank);
    labels.forEach((label, index) => {
      const option = node('option', '', (index + first) + ' · ' + label);
      option.value = String(index + first);
      select.append(option);
    });
    select.value = value ?? '';
    field.append(caption, select);
    return field;
  }

  function renderDialog() {
    const entry = selectedEntry();
    const saved = entry[mode] || {};
    const header = node('div', 'dialog-header');
    const title = node('div');
    const heading = node('h2', '', 'Health check-in');
    heading.id = 'health-dialog-heading';
    title.append(heading, node('p', '', 'Your entries stay in this browser.'));
    const close = button('Close', () => dialog.close());
    close.setAttribute('aria-label', 'Close health check-in');
    header.append(title, close);

    const body = node('div', 'dialog-body');
    const dateField = node('label', 'field', 'Check-in date');
    const date = node('input');
    date.type = 'date';
    date.value = selectedDate;
    date.max = dateInputValue(new Date());
    date.required = true;
    date.addEventListener('change', () => {
      if (!date.value || !date.validity.valid) return;
      selectedDate = date.value;
      renderDialog();
    });
    dateField.append(date);
    const modes = node('div', 'health-actions');
    for (const value of ['morning', 'evening']) {
      const control = button(value === 'morning' ? 'Morning' : 'Evening', () => {
        mode = value;
        renderDialog();
      });
      control.setAttribute('aria-pressed', String(value === mode));
      modes.append(control);
    }
    const form = node('form', 'health-form');
    const fields = node('div', 'health-fields');
    if (mode === 'morning') {
      fields.append(numberField('Sleep duration (hours)', 'sleepHours', saved.sleepHours, { max: 24, step: 0.25 }),
        ratingField('Sleep quality', 'sleepQuality', saved.sleepQuality),
        ratingField('Morning energy', 'energy', saved.energy));
    } else {
      fields.append(ratingField('Evening energy', 'energy', saved.energy),
        ratingField('How well could you focus?', 'focusQuality', saved.focusQuality),
        numberField('Interruptions noticed today', 'interruptions', saved.interruptions, { max: 999 }),
        numberField('Exercise completed (minutes)', 'exerciseMinutes', entry.activity?.exerciseMinutes));
      const discomfort = node('fieldset', 'health-discomfort');
      discomfort.append(node('legend', '', 'Discomfort today'));
      const levels = ['None', 'Mild', 'Moderate', 'Strong'];
      for (const [name, label] of [['eyes', 'Eyes'], ['neck', 'Neck'], ['back', 'Back'], ['wrists', 'Wrists']]) {
        discomfort.append(ratingField(label, name, saved.discomfort?.[name], levels, 0));
      }
      fields.append(discomfort);
      const notes = node('label', 'field', 'Anything to remember?');
      const input = node('textarea');
      input.name = 'notes';
      input.maxLength = 1000;
      input.rows = 3;
      input.value = saved.notes || '';
      input.placeholder = 'Optional';
      notes.append(input);
      fields.append(notes);
    }
    const actions = node('div', 'dialog-actions');
    if (entry[mode]) {
      actions.append(button('Clear ' + mode + ' entry', () => {
        changeEntry(current => {
          const next = { ...current };
          delete next[mode];
          return next;
        });
        renderDialog();
        notify('Check-in cleared', 'The selected entry was removed.');
      }));
    }
    const submit = node('button', 'button button-primary', 'Save check-in');
    submit.type = 'submit';
    actions.append(submit);
    form.append(dateField, modes, fields,
      node('p', 'health-caption', 'Skip any signal you prefer. Zero is a recorded value.'), actions);
    form.addEventListener('submit', event => {
      event.preventDefault();
      const values = new FormData(form);
      const result = { at: Date.now() };
      const numericNames = mode === 'morning' ? ['sleepHours', 'sleepQuality', 'energy'] : ['energy', 'focusQuality', 'interruptions'];
      for (const name of numericNames) {
        const value = optionalNumber(values.get(name));
        if (value !== undefined) result[name] = value;
      }
      if (mode === 'evening') {
        const discomfort = {};
        for (const name of ['eyes', 'neck', 'back', 'wrists']) {
          const value = optionalNumber(values.get(name));
          if (value !== undefined) discomfort[name] = value;
        }
        if (Object.keys(discomfort).length) result.discomfort = discomfort;
        if (values.get('notes').trim()) result.notes = values.get('notes').trim();
      }
      changeEntry(current => {
        const next = { ...current, [mode]: result };
        if (mode === 'evening') {
          next.activity = { ...current.activity };
          const minutes = optionalNumber(values.get('exerciseMinutes'));
          if (minutes === undefined) delete next.activity.exerciseMinutes;
          else next.activity.exerciseMinutes = minutes;
        }
        return next;
      });
      dialog.close();
      notify('Check-in saved', 'Your observations are recorded for ' + fullDate.format(new Date(selectedDate + 'T12:00:00')) + '.');
    });
    body.append(form);
    dialog.setAttribute('aria-labelledby', heading.id);
    dialog.replaceChildren(header, body);
  }

  function openCheckin(nextMode, date = dateInputValue(new Date())) {
    selectedDate = date;
    mode = nextMode === 'evening' || nextMode === 'morning' ? nextMode : new Date().getHours() < 15 ? 'morning' : 'evening';
    renderDialog();
    if (!dialog.open) dialog.showModal();
  }

  render();
  return { render, openCheckin };
}
