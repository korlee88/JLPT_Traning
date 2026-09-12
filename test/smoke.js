// Headless-browser smoke test for the static site. Run with `npm test`.
// Starts a local static server, drives the app with Playwright, and asserts
// the core flows work: today/checklist/streak, the plan table, both quizzes,
// and week/D-day logic across date boundaries (before start / mid-plan /
// last day / exam day / after exam).
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const PORT = 8123;
const URL = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, "..");
const CLOUD_CHROMIUM = "/opt/pw-browsers/chromium"; // stable path in Claude Code cloud sessions

function launchOpts() {
  const opts = { args: ["--no-sandbox"] };
  if (fs.existsSync(CLOUD_CHROMIUM)) opts.executablePath = CLOUD_CHROMIUM;
  return opts;
}

function assert(cond, message) {
  if (!cond) throw new Error("FAIL: " + message);
  console.log("  ok - " + message);
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = spawn("python3", ["-m", "http.server", String(PORT)], { cwd: ROOT });
    server.on("error", reject);
    const check = setInterval(() => {
      fetch(URL)
        .then(() => {
          clearInterval(check);
          resolve(server);
        })
        .catch(() => {});
    }, 300);
    setTimeout(() => {
      clearInterval(check);
      reject(new Error("server did not come up in time"));
    }, 15000);
  });
}

async function withFixedDate(page, isoDate) {
  await page.addInitScript((iso) => {
    const fixed = new Date(iso + "T12:00:00");
    const RealDate = Date;
    class FakeDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) return new RealDate(fixed);
        return new RealDate(...args);
      }
      static now() {
        return fixed.getTime();
      }
    }
    // eslint-disable-next-line no-global-assign
    Date = FakeDate;
  }, isoDate);
}

async function main() {
  console.log("Starting local server on " + URL + " ...");
  const server = await startServer();
  const browser = await chromium.launch(launchOpts());

  try {
    const plan = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "n4", "plan.json"), "utf8"));

    // --- Core flow: today / checklist / streak / plan / quizzes ---
    {
      const page = await browser.newPage();
      const consoleErrors = [];
      page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
      page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));

      await withFixedDate(page, plan.weeks[2].start); // safely mid-plan, avoids boundary flakiness
      await page.goto(URL, { waitUntil: "networkidle" });
      await page.waitForSelector("#week-title");

      const weekTitle = await page.textContent("#week-title");
      assert(weekTitle.startsWith("Week 3"), `week-title reflects the mocked date (got "${weekTitle}")`);

      const streakDays = await page.$$eval("#streak .day", (els) => els.length);
      assert(streakDays === 14, `streak grid renders 14 days (got ${streakDays})`);

      await page.locator('#checklist input[type="checkbox"]').first().check();
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector("#checklist input");
      const persisted = await page.locator('#checklist input[type="checkbox"]').first().isChecked();
      assert(persisted, "checklist state persists across reload (localStorage)");

      await page.click('.tab-btn[data-tab="plan"]');
      await page.waitForSelector("#plan-table tbody tr");
      const rowCount = await page.$$eval("#plan-table tbody tr", (rows) => rows.length);
      assert(rowCount === plan.weeks.length, `plan table shows all ${plan.weeks.length} weeks (got ${rowCount})`);

      await page.click('.tab-btn[data-tab="quiz"]');
      await page.click("#start-vocab");
      await page.waitForSelector("#quiz-choices .choice-btn");
      for (let i = 0; i < 10; i++) {
        await page.waitForSelector("#quiz-choices .choice-btn");
        await page.locator("#quiz-choices .choice-btn").first().click();
        await page.click("#quiz-next");
      }
      await page.waitForSelector("#quiz-result:not([hidden])");
      const scoreText = await page.textContent("#quiz-score");
      assert(/\d+ \/ 10/.test(scoreText), `vocab quiz reaches a score screen (got "${scoreText}")`);
      await page.click("#quiz-retry");
      assert(await page.isVisible("#quiz-start"), "retry returns to quiz start screen");

      await page.click("#start-grammar");
      await page.waitForSelector("#quiz-choices .choice-btn");
      await page.locator("#quiz-choices .choice-btn").first().click();
      const noteVisible = await page.isVisible("#quiz-note");
      assert(noteVisible, "grammar quiz shows an explanation note after answering");

      assert(consoleErrors.length === 0, `no console errors (got ${JSON.stringify(consoleErrors)})`);
      await page.close();
    }

    // --- Date-boundary logic ---
    const cases = [
      { date: "2000-01-01", expect: (t, d) => t.includes("시작 전") },
      { date: plan.weeks[0].start, expect: (t) => t.startsWith("Week 1") },
      { date: plan.examDate, expect: (t, d) => d.includes("시험일") },
      { date: "2099-01-01", expect: (t, d) => d.includes("종료") },
    ];
    for (const c of cases) {
      const page = await browser.newPage();
      await withFixedDate(page, c.date);
      await page.goto(URL, { waitUntil: "networkidle" });
      await page.waitForSelector("#week-title");
      const title = await page.textContent("#week-title");
      const dday = await page.textContent("#dday");
      assert(c.expect(title, dday), `date ${c.date} -> week-title="${title}" dday="${dday}"`);
      await page.close();
    }

    console.log("\nAll smoke checks passed.");
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
