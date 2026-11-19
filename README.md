# LifeTimer

LifeTimer fits your tasks into a realistic daily budget and prompts you to focus, look away, move, and drink water. It runs in the browser from a small local Node.js server.

## Install and run

With Node.js 22 or newer and npm installed, run these commands from the repository root.

```sh
npm ci
npm start
```

Open [LifeTimer](http://localhost:3000) and keep the terminal running. To give LifeTimer its own app window, look for **Install LifeTimer** or **Add to Home Screen** in a supported browser. Run `npm start` again after restarting the computer. Use the same browser profile and address each time, since browser data is scoped to both.

## Plan and focus

1. Set your wake time, sleep, focus length, and water goal in **Settings**. LifeTimer starts with eight hours of sleep, a 40-minute focus block, and a 2.5 L water goal. Sleep is adjustable from seven to nine hours. The planner reserves one hour each for personal care, exercise, meals, and buffer, leaving 11–13 workable hours that include focus breaks.
2. Add tasks with estimated minutes. Use the arrows in **Tasks** to set their priority. **Today’s plan** splits unfinished work in that order and shows how much won’t fit in the current window. **Replan** rebuilds the schedule from the current time. The four reserved hours are a budget allowance. LifeTimer schedules focus and recovery, while you choose when to handle the other activities.
3. Select **Start focus** to begin the next task. You can pause and resume or end early. Focus time credits the task estimate, and unfinished tasks carry forward. Scheduled prompts invite you to start a block. You control when the timer starts.
4. Use **250 mL** under **Hydration** to log water. The total resets for each local calendar day. Use the minus icon to undo an entry.

## Background reminders

Open **Settings → Enable background reminders**, allow notifications, then select **Send test** and close the tab or app window. In-app prompts work while LifeTimer is open. Once background reminders are enabled, the server queues future prompts so a supported browser can deliver them after the tab closes.

- Leave the Node server running on a computer that stays awake and can reach your browser’s push provider. Browser background behavior, operating system notification settings, and force-quitting the browser affect delivery. [Web Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API)
- Use localhost on your own computer or HTTPS for remote access. On iOS and iPadOS, install LifeTimer to the Home Screen from its HTTPS address, then enable notifications from the installed app. [WebKit guidance](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/)
- The server listens on `127.0.0.1:3000` by default. Use `PORT` to change the port. For remote use, put it behind a private, authenticated HTTPS reverse proxy that preserves the external `Host` header, and set `LIFETIMER_ORIGIN` to the exact HTTPS origin without a trailing slash. Use one server instance and one active push subscription per user. The app has no built-in accounts.
- Tasks, settings, water logs, and timer state stay in your browser profile on this device. When push is enabled, the server stores keys, your subscription, and pending reminder text and times in `.lifetimer/` or the directory set by `LIFETIMER_DATA_DIR`. Keep that directory private and persistent across server restarts.

## Wellness defaults

- **Focus** starts at 40 minutes as an adjustable preference. Brief breaks can help sustain attention. [Ariga and Lleras, 2011](https://doi.org/10.1016/j.cognition.2010.12.007)
- **Eyes** get a 20-second reset after 20 minutes of focus. Look at something 20 feet (about 6 metres) away. [American Optometric Association](https://www.aoa.org/healthy-eyes/eye-and-vision-conditions/computer-vision-syndrome)
- **Movement** gets a five-minute walking break after 30 minutes of focus and a recovery break after a completed block, as the window permits. A small study measured blood sugar and blood pressure benefits from brief walks during prolonged sitting. [Columbia University Irving Medical Center](https://www.cuimc.columbia.edu/news/short-bursts-activity-can-offset-harmful-effects-sitting)
- **Hydration** is a personal tracking goal between 2 and 3 L. Individual water needs vary, and food and other drinks contribute. [CDC](https://www.cdc.gov/healthy-weight-growth/water-healthy-drinks/index.html)

## Developer handoff

Run `npm test` to check the planner, timer phases, schedule validation, and persisted reminder delivery with a test transport. The app serves static files directly. Saving a frontend change and refreshing the browser is enough to see it. Restart `npm start` after server changes.

- `public/planner.js` allocates focus and recovery in priority order and reports overflow. `public/session.js` defines timed focus, eye, movement, and recovery phases that the plan and live timer share.
- `public/app.js` manages the dashboard and browser state. `public/push.js` manages subscriptions and schedule updates. `public/sw.js` turns push messages into native notifications and opens the app when a notification is selected.
- `server.js` serves the app and persists and dispatches reminders. A schedule replaces the previous submission for that server. The server uses a provider allowlist, accepts schedules only for its configured origin, and stores delivery receipts to avoid resending an unchanged reminder.

The planner uses durations and task priority. Calendar events, task deadlines, and synced task data are outside the current workflow. The cloud environment verified timed delivery with a test transport and notification display in Chromium with a simulated push event. Verify the actual provider path on your machine with **Send test** and the app closed. The cloud could not establish a live browser subscription and its network policy blocked push providers.
