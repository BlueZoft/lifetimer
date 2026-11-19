# Development handoff

## Working on the app

Run `npm ci`, then `npm start` from the repository root. The app is served at localhost port 3000. It uses native browser modules and static files, so frontend changes need a browser refresh. Restart the Node process after server changes. Run `npm test` for the automated suite.

Use the existing checkout for development. Keep `.lifetimer/` private and outside commits. For isolated validation, set `PORT` and `LIFETIMER_DATA_DIR` to a spare port and temporary directory.

## Behavior and data

Browser state remains under `lifetimer.v1` in localStorage with a versioned payload. `migrateState` upgrades existing tasks, settings, water dates, and session state. Legacy completed tasks retain their completed state. New tasks have explicit completion and remaining estimates, alongside accumulated elapsed focus.

A task's original goal and checkpoint wording are preserved. Current success criteria can change, and each change is retained with its time. A session snapshots the original goal, current criteria, and checkpoints at start. Finishing a session credits elapsed focus once and creates a pending review. The user confirms the outcome and remaining estimate. Pending reviews survive reloads and appear before reviewed records in Work review.

Health records are keyed by local calendar date. Morning and evening forms have optional signals. Missing values stay absent, while an explicit zero is a recorded value. Walks, meals, and screen breaks are user confirmations. Trends report sample counts and use recorded values for averages. Health signals can suggest a lighter plan, and the user changes the allowance in Settings.

Goal plans span three, seven, or fourteen local calendar dates. All unfinished tasks participate in priority order. The planner accounts for logged focus, daily focus allowance, breaks, rest weekdays, and the protected end of the workable window. A four-hour daily focus allowance is the initial product default. Plan goal and checkpoint wording are fixed at creation, while checkpoint status can change. Ending a plan archives it.

## Module boundaries

- `public/app.js` connects dashboard controls, task editing, outcome reviews, goal plans, timer events, and reminder updates.
- `public/model.js` migrates browser data, creates and revises tasks, and records completed sessions idempotently.
- `public/planner.js` allocates daily focus and recovery in priority order. `public/session.js` defines shared focus, eye, movement, and recovery phases.
- `public/campaign.js` distributes work over a goal plan's local dates and accounts for logged focus by waking window.
- `public/health.js` owns optional check-in forms, confirmed activity logs, and recent trends. `public/health.css` styles those controls.
- `public/reminder-schedule.js` creates future check-in, water, and planned focus invitations. `public/push.js` manages the subscription and sends replacement schedules. `public/sw.js` displays notifications.
- `server.js` serves files and persists the subscription, queue, VAPID keys, and delivery receipts. The supplied test transport lets tests exercise delivery without contacting a push provider.

## Reminder lifecycle

The browser builds a complete finite queue. An active goal plan uses its original dates. Ordinary mode prepares fourteen wake dates beginning with the active waking window, including an overnight window that began the previous calendar day. Updates replace the previous server queue. Running sessions add their actual timed break prompts. Planned blocks only invite the user to start.

The server accepts at most 1,800 reminders within sixteen days and a 512 KiB request body. The extra horizon accommodates a plan starting tomorrow and an overnight waking period. Queues and delivery receipts persist across restarts. Stale reminders expire after their short delivery grace period. Provider retries stay inside that original grace period, and an empty schedule cancels pending reminders.

Health fields and task check-in notes remain in browser storage. The reminder server receives the text and timing needed for notifications. A deployment uses one private server and one active subscription. The Node process must keep running for queued dispatch.

## Validation and current limits

The automated suite covers legacy migration, immutable task commitments, criteria revisions, idempotent session recording, daily and multi-day allocation, overnight planning, hydration cadence, queue validation, persistence, cancellation, and stale delivery. Chromium verification passed task creation and editing, preserved original goals and checkpoints, revised criteria history, pause/resume focus accounting, pending reviews across reloads, explicit completion, health entries and confirmed activities, fortnight plan creation, persisted records, and mobile dialog sizing. Isolated health checks also verified optional and zero values, invalid dates, clearing entries, and 14-day trends. Earlier work records are available through Show earlier records.

Run `npm test` for the 21 engine and server checks. Run `npm run test:browser` for the two browser scenarios in `scripts/browser-smoke.cjs`. Install Chromium with `npx playwright-core install chromium` or provide an existing executable through `LIFETIMER_BROWSER`. Each browser scenario gets its own browser process and uses a temporary local server and isolated storage. The queue assertions mock the browser subscription and inspect outgoing schedules. Live provider delivery is a separate capability.

Boundary checks verify that logged focus exhausts the daily allowance, a session paused past its original working window ends for review, pausing retains later days' invitations, and overnight scheduling includes the active wake date. A session that finishes while the tab is closed is recorded at its scheduled end when the app next runs. Check-in suppression uses the notification's local calendar date.

Native notification display has been verified in Chromium using a simulated push event. Actual provider delivery still requires a compatible browser, notification permission, and reachable vendor endpoints. The cloud browser could not establish a live subscription.

Records belong to the current browser profile and address. Calendar integration, task deadlines, and cross-device data synchronization are future work. The reminder horizon is finite and refreshes when LifeTimer is opened or updated. Health records are self-reported, and elapsed timer history can continue while the tab is closed. Use check-ins to record what was accomplished and activities completed.
