const assert = require("node:assert/strict");
const { once } = require("node:events");
const { mkdtemp, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { before, after, beforeEach, afterEach, test } = require("node:test");
const { chromium } = require("playwright-core");

let browser;
let server;
let dataDir;
let base;

before(async () => {
  const { createLifeTimerServer } = await import("../server.js");
  dataDir = await mkdtemp(join(tmpdir(), "lifetimer-browser-"));
  server = createLifeTimerServer({ dataDir });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = "http://127.0.0.1:" + server.address().port;
});

beforeEach(async () => {
  browser = await chromium.launch({
    executablePath: process.env.LIFETIMER_BROWSER || undefined,
    headless: true,
    args: [
      "--no-sandbox",
      "--no-zygote",
      "--single-process",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });
});

afterEach(async () => {
  if (browser) await browser.close();
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test("task outcomes, health check-ins, and fortnight plans survive normal use", async (t) => {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    timezoneId: "Asia/Colombo",
  });
  t.after(() => page.close());
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.clock.install({ time: new Date("2026-11-19T09:00:00+05:30") });
  await page.goto(base, { waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: "Add task", exact: true })
    .first()
    .click();
  const taskForm = page.locator("#task-form");
  await taskForm.getByLabel("Task name").fill("Write release notes");
  await taskForm.getByLabel("Estimated minutes").fill("20");
  await taskForm.getByLabel("Original goal").fill("Ship a useful release");
  await taskForm
    .getByLabel("Success criteria")
    .fill("Release notes describe all changes.");
  await taskForm
    .getByLabel("Original checkpoints, one per line")
    .fill("Draft complete\nReview complete");
  await taskForm.getByRole("button", { name: "Add task", exact: true }).click();
  await page
    .getByRole("button", { name: "Edit Write release notes", exact: true })
    .click();
  assert.equal(
    await taskForm.getByLabel("Original goal").getAttribute("readonly"),
    "",
  );
  await taskForm
    .getByLabel("Success criteria")
    .fill("Release notes describe changes and installation.");
  await taskForm
    .getByRole("button", { name: "Save task", exact: true })
    .click();
  await page.getByRole("button", { name: "Close tasks" }).click();
  await page.getByRole("button", { name: "Start focus", exact: true }).click();
  await page.clock.fastForward(60_000);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.clock.fastForward(60_000);
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.clock.fastForward(19 * 60_000);
  await page.getByRole("button", { name: "Skip break", exact: true }).click();
  await page.locator("#review-dialog").waitFor({ state: "visible" });
  assert.equal(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("lifetimer.v1")).tasks[0].done,
    ),
    false,
  );
  await page.getByRole("button", { name: "Review later", exact: true }).click();
  await page.reload({ waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: "Review session", exact: true })
    .click();
  const review = page.locator("#review-form");
  await review.getByLabel("Task outcome").selectOption("continue");
  await review.getByLabel("Remaining minutes").fill("15");
  await review
    .getByLabel("What was accomplished?")
    .fill("Draft is complete, review still pending.");
  await review.getByLabel("Draft complete", { exact: true }).check();
  await review.getByLabel("Focus quality").selectOption("4");
  await review
    .getByRole("button", { name: "Save check-in", exact: true })
    .click();
  let state = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("lifetimer.v1")),
  );
  assert.equal(state.tasks[0].done, false);
  assert.equal(state.tasks[0].remainingMinutes, 15);
  assert.equal(state.tasks[0].goal, "Ship a useful release");
  assert.equal(state.tasks[0].criteriaHistory.length, 2);
  assert.equal(state.history[0].focusMinutes, 20);
  assert.equal(state.history[0].interruptions, 1);
  await page
    .getByRole("button", { name: "Tasks", exact: false })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Check in Write release notes", exact: true })
    .click();
  await review.getByLabel("Task outcome").selectOption("done");
  await review
    .getByRole("button", { name: "Save check-in", exact: true })
    .click();
  assert.match(
    await page.locator("#review-error").textContent(),
    /each original checkpoint/,
  );
  await review.getByLabel("Review complete", { exact: true }).check();
  await review
    .getByRole("button", { name: "Save check-in", exact: true })
    .click();
  await page.getByRole("button", { name: "Close tasks" }).click();
  await page
    .getByRole("button", { name: "Morning check-in", exact: true })
    .click();
  await page.getByLabel("Check-in date").fill("");
  await page
    .locator("#health-dialog")
    .getByRole("button", { name: "Save check-in", exact: true })
    .click();
  assert.deepEqual(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("lifetimer.v1")).health,
    ),
    {},
  );
  await page.getByLabel("Check-in date").fill("2026-11-20");
  await page
    .locator("#health-dialog")
    .getByRole("button", { name: "Save check-in", exact: true })
    .click();
  assert.deepEqual(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("lifetimer.v1")).health,
    ),
    {},
  );
  await page.getByLabel("Check-in date").fill("2026-11-19");
  await page.getByLabel("Sleep duration (hours)").fill("6");
  await page.getByLabel("Morning energy").selectOption("2");
  await page
    .locator("#health-dialog")
    .getByRole("button", { name: "Save check-in", exact: true })
    .click();
  assert.match(
    await page.locator("#health-panel").textContent(),
    /lighter day/,
  );
  await page.getByRole("button", { name: "+ Walk", exact: true }).click();
  await page
    .getByRole("button", { name: "Undo last walk log", exact: true })
    .click();
  await page.getByRole("button", { name: "+ Walk", exact: true }).click();
  await page.getByRole("button", { name: "+ Meal", exact: true }).click();
  await page
    .getByRole("button", { name: "+ Screen break", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Evening check-in", exact: true })
    .click();
  await page.getByLabel("Evening energy").selectOption("3");
  await page.getByLabel("Eyes", { exact: true }).selectOption("1");
  await page.getByLabel("Exercise completed (minutes)").fill("30");
  await page.getByLabel("Interruptions noticed today").fill("0");
  await page
    .locator("#health-dialog")
    .getByRole("button", { name: "Save check-in", exact: true })
    .click();
  await page.getByRole("button", { name: "Start a plan", exact: true }).click();
  await page.getByLabel("Plan goal", { exact: true }).fill("Prepare a release");
  await page
    .getByLabel("Plan checkpoints, one per line")
    .fill("Release notes checked\nPublish ready");
  await page.getByLabel("Duration").selectOption("14");
  await page.getByLabel("Sun", { exact: true }).check();
  await page
    .getByRole("button", { name: "Start goal plan", exact: true })
    .click();
  assert.equal(await page.locator(".campaign-day").count(), 14);
  await page.reload({ waitUntil: "networkidle" });
  state = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("lifetimer.v1")),
  );
  assert.equal(state.health["2026-11-19"].morning.sleepHours, 6);
  assert.equal("sleepQuality" in state.health["2026-11-19"].morning, false);
  assert.equal(state.health["2026-11-19"].evening.interruptions, 0);
  assert.equal(state.health["2026-11-19"].activity.walks, 1);
  assert.equal(state.tasks[0].done, true);
  await page.getByRole("button", { name: "Log 250 mL of water" }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth),
    390,
  );
  await page
    .getByRole("button", { name: "Add task", exact: true })
    .first()
    .click();
  assert.equal(
    await page.evaluate(
      () =>
        document.querySelector("#tasks-dialog").scrollWidth <=
        document.querySelector("#tasks-dialog").clientWidth,
    ),
    true,
  );
  await page.getByRole("button", { name: "Close tasks" }).click();
  assert.deepEqual(errors, []);
});

test("daily limits, migration, and future reminders handle paused and overnight sessions", async (t) => {
  const context = await browser.newContext({ timezoneId: "Asia/Colombo" });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.clock.install({ time: new Date("2026-11-19T10:00:00+05:30") });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    localStorage.setItem(
      "lifetimer.v1",
      JSON.stringify({
        settings: {
          wakeTime: "08:00",
          sleepHours: 8,
          focusMinutes: 40,
          waterLitres: 2.5,
          dailyFocusHours: 0.5,
        },
        tasks: [
          { id: "old", title: "Old task", minutes: 60, completedMinutes: 0 },
        ],
        water: { "2026-11-9": 250 },
        history: [
          {
            id: "used",
            taskId: "old",
            title: "Old task",
            startedAt: Date.now() - 60 * 60_000,
            endedAt: Date.now() - 30 * 60_000,
            focusMinutes: 30,
            reviewedAt: Date.now(),
          },
        ],
      }),
    );
  });
  await page.reload({ waitUntil: "networkidle" });
  assert.match(
    await page.locator("#focus-task").textContent(),
    /No focus block/,
  );
  await page.getByRole("button", { name: "Check window", exact: true }).click();
  assert.equal(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("lifetimer.v1")).session,
    ),
    null,
  );
  assert.equal(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("lifetimer.v1")).water["2026-11-09"],
    ),
    250,
  );
  // A paused session from yesterday is recorded, and cannot consume today's allowance.
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("lifetimer.v1"));
    state.settings.dailyFocusHours = 4;
    state.history = [];
    state.session = {
      id: "paused",
      taskId: "old",
      title: "Old task",
      minutes: 40,
      recovery: 5,
      startedAt: Date.now() - 86400_000,
      elapsed: 10 * 60_000,
      runningSince: null,
    };
    localStorage.setItem("lifetimer.v1", JSON.stringify(state));
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.locator("#review-dialog").waitFor({ state: "visible" });
  assert.equal(
    await page.evaluate(
      () => JSON.parse(localStorage.getItem("lifetimer.v1")).session,
    ),
    null,
  );
  assert.equal(
    await page.evaluate(
      () =>
        JSON.parse(localStorage.getItem("lifetimer.v1")).history[0]
          .focusMinutes,
    ),
    10,
  );
  // Check real frontend queue output through a mocked browser subscription, no vendor delivery claim.
  await page.getByRole("button", { name: "Review later", exact: true }).click();
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("lifetimer.v1"));
    state.background = true;
    state.tasks[0].remainingMinutes = 600;
    state.session = {
      id: "today",
      taskId: "old",
      title: "Old task",
      minutes: 40,
      recovery: 5,
      startedAt: Date.now(),
      elapsed: 0,
      runningSince: null,
    };
    localStorage.setItem("lifetimer.v1", JSON.stringify(state));
  });
  const key = await (await page.request.get(base + "/api/push/key")).json();
  await page.addInitScript(({ publicKey }) => {
    const bytes = Uint8Array.from(
      atob(publicKey.replaceAll("-", "+").replaceAll("_", "/")),
      (x) => x.charCodeAt(0),
    );
    const subscription = {
      endpoint: "https://fcm.googleapis.com/fcm/send/local-test",
      keys: { p256dh: "BA".repeat(43) + "A", auth: "AQ".repeat(11) },
      options: { applicationServerKey: bytes.buffer },
      toJSON() {
        return { endpoint: this.endpoint, keys: this.keys };
      },
    };
    Object.defineProperty(Notification, "permission", { get: () => "granted" });
    Object.defineProperty(navigator, "serviceWorker", {
      value: {
        register: async () => ({}),
        ready: Promise.resolve({
          pushManager: { getSubscription: async () => subscription },
        }),
      },
    });
  }, key);
  const queues = [];
  await page.route("**/api/push/schedule", async (route) => {
    queues.push(route.request().postDataJSON().reminders);
    await route.fulfill({ status: 204 });
  });
  await page.reload({ waitUntil: "networkidle" });
  const tomorrow = new Date("2026-11-20T08:00:00+05:30").getTime();
  assert.ok(
    queues.at(-1).some((entry) => entry.tag === "plan" && entry.at >= tomorrow),
    "paused session preserves future focus invitations",
  );
  assert.ok(
    !queues.at(-1).some((entry) => entry.tag === "plan" && entry.at < tomorrow),
    "paused session suppresses current-day invitations",
  );
  // Overnight ordinary mode preserves the previous date's active waking window.
  await page.clock.setSystemTime(new Date("2026-11-20T01:00:00+05:30"));
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("lifetimer.v1"));
    state.session = null;
    state.settings.wakeTime = "20:00";
    state.history = [];
    state.anchor = Date.now();
    localStorage.setItem("lifetimer.v1", JSON.stringify(state));
  });
  await page.reload({ waitUntil: "networkidle" });
  const nextWake = new Date("2026-11-20T20:00:00+05:30").getTime();
  assert.ok(
    queues.at(-1).some((entry) => entry.tag === "plan" && entry.at < nextWake),
    "active overnight focus invitation remains queued",
  );
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("lifetimer.v1"));
    state.campaign = {
      goal: "Finish the draft",
      startDate: "2026-11-19",
      days: 3,
      restWeekdays: [4],
      checkpoints: [],
    };
    state.health["2026-11-20"] = { evening: { energy: 3, at: Date.now() } };
    localStorage.setItem("lifetimer.v1", JSON.stringify(state));
  });
  await page.reload({ waitUntil: "networkidle" });
  assert.match(await page.locator("#empty-plan-message").textContent(), /Rest day/);
  assert.ok(
    !queues.at(-1).some((entry) => entry.id === "evening-2026-11-19"),
    "overnight check-in suppression follows the delivery calendar date",
  );
  assert.deepEqual(errors, []);
});
