# LifeTimer

LifeTimer fits tasks into a daily focus allowance, prompts you to take breaks, and records how the work and the day went. It runs in your browser from a small local Node.js server.

## Install and run

With Node.js 22 or newer and npm installed, run these commands from the repository root.

```sh
npm ci
npm start
```

Open [LifeTimer](http://localhost:3000) and keep the terminal running. To give LifeTimer its own app window, look for **Install LifeTimer** or **Add to Home Screen** in a supported browser. Run `npm start` again after restarting the computer. Use the same browser profile and address each time, since browser data is scoped to both.

## Plan the work

1. Set wake time, sleep, focus block length, daily focus allowance, and water goal in **Settings**. Defaults are eight hours of sleep, 40-minute blocks, four hours of focus per day, and 2.5 L of water. The four-hour allowance is an adjustable planning default. Sleep is adjustable from seven to nine hours. One hour each is reserved for personal care, exercise, meals, and buffer, leaving an 11–13-hour window in which to place focus and recovery blocks.
2. Add a task with estimated minutes, an original goal, success criteria, and optional checkpoints. A blank goal uses the task name. Use the arrows in **Tasks** to set priority. **Replan** fits remaining estimates into the time and focus allowance still available.
3. Edit a task to revise its current success criteria or remaining minutes. The original goal and checkpoint wording stay recorded. Success criteria changes have a dated history. Checkpoints can be confirmed during a task check-in.
4. For a longer effort, select **Start a plan** under **Goal plan**. Choose a goal, optional checkpoints, three days, one week, or one fortnight, and any rest weekdays. Plans can start today or tomorrow. The daily preview shows planned and logged focus, and reports work that exceeds the remaining capacity. **End plan** keeps its original commitment and checkpoint statuses in previous plan history.

The workable window begins at wake time and ends four hours before the end of the waking period. You choose when to handle the reserved activities. The daily focus allowance applies within that window, and rest weekdays receive wellness prompts. All unfinished tasks participate in the active goal plan in priority order.

## Focus and review outcomes

Select **Start focus** to begin the next block. Pause and resume or end early as needed. Closing the tab during a running session lets its timer continue. A paused session that no longer fits its original working window is ended for review when you try to resume it.

Ending a session records elapsed focus and opens a **Task check-in**. Choose **Needs more time** and enter the remaining estimate, or choose **Done** and confirm every original checkpoint. You can record what was accomplished, focus quality, and interruptions. Pauses provide an initial interruption count that you can correct.

**Review later** leaves the session in **Work review** after closing the dialog or reloading. Review the pending session before starting another block on the same task. You can also open a task check-in directly from **Tasks**. Session history keeps the goal and success criteria that were recorded at session start.

Existing browser data is upgraded in place. Older tasks already marked complete retain that state. New session time reduces the remaining estimate while task completion is confirmed through a check-in.

## Check in on wellbeing

**Daily check-ins** provides optional morning and evening entries. You can edit an earlier date, clear one entry, or leave any field blank.

- Morning entries record sleep duration, sleep quality, and energy.
- Evening entries record energy, focus quality, interruptions, exercise minutes, notes, and eye, neck, back, or wrist discomfort.
- **Walk**, **Meal**, and **Screen break** log activities you confirm, with undo controls.
- **Recent check-ins** shows seven or fourteen days of records, including sample counts for sleep and energy averages. Missing values remain blank in the record and appear as dashes in the table.
- Lower energy or shorter sleep produces a suggestion to consider a lighter workload. You control changes to the focus allowance in **Settings**.

Use **250 mL** under **Hydration** to log water and the minus icon to undo. The displayed total follows the local calendar day, and previous daily totals remain stored.

## Background reminders

Open **Settings → Enable background reminders**, allow notifications, then select **Send test** and close the tab or app window. Keep the Node server running on a computer that stays awake and can reach the browser’s push provider. Browser background behavior, operating system notification settings, and force-quitting the browser affect delivery. [Web Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)

An active goal plan queues morning and evening check-ins, hydration, and focus invitations across its dates. Ordinary daily mode prepares the next fourteen wake dates. Opening or updating LifeTimer refreshes the queue. The saved queue survives a server restart and continues through its finite horizon while the app tab is closed. Actual session break prompts are added when you start a session. Completed health check-ins and a reached water goal suppress their remaining prompts when the app updates the queue.

- Use localhost on your own computer or HTTPS for remote access. On iOS and iPadOS, install LifeTimer to the Home Screen from its HTTPS address, then enable notifications from the installed app. [WebKit guidance](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- The server listens on `127.0.0.1:3000` by default. Use `PORT` to change the port. For remote use, use a private, authenticated HTTPS reverse proxy that preserves the external `Host` header, and set `LIFETIMER_ORIGIN` to the exact HTTPS origin without a trailing slash. Use one server instance and one active push subscription per user.
- Tasks, goals, timer state, session history, health entries, and water logs stay in the browser profile on this device. Push sends reminder text and times to the server. The server persists keys, the subscription, and pending reminders in `.lifetimer/` or the directory set by `LIFETIMER_DATA_DIR`. Keep that directory private and persistent.

## Wellness defaults

- **Focus** starts at 40 minutes as an adjustable preference. Brief breaks can help sustain attention. [Ariga and Lleras, 2011](https://doi.org/10.1016/j.cognition.2010.12.007)
- **Eyes** get a 20-second reset after 20 minutes of focus. Look at something 20 feet (about 6 metres) away. [American Optometric Association](https://www.aoa.org/healthy-eyes/eye-and-vision-conditions/computer-vision-syndrome)
- **Movement** gets a five-minute walking break after 30 minutes of focus and a recovery break after a completed block, as the window permits. A small study measured blood sugar and blood pressure benefits from brief walks during prolonged sitting. [Columbia University Irving Medical Center](https://www.cuimc.columbia.edu/news/short-bursts-activity-can-offset-harmful-effects-sitting)
- **Hydration** is a personal tracking goal between 2 and 3 L. Individual water needs vary, and food and other drinks contribute. [CDC](https://www.cdc.gov/healthy-weight-growth/water-healthy-drinks/index.html)

## Development

Run `npm test` for the planner, timer, migration, campaign allocation, and reminder server. Frontend changes appear after refreshing the browser. Restart `npm start` after server changes. The continuation guide describes the modules, stored data, validation, and current limits. [Development handoff](docs/DEVELOPMENT.md)

The cloud environment verified timed delivery with a test transport and notification display in Chromium with a simulated push event. Verify the actual provider path on your machine with **Send test** and the app closed. The cloud could not establish a live browser subscription and its network policy blocked push providers.
