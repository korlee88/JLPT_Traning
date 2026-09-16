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

function addDaysToDateStr(dateStr, days) {
  const d = new Date(dateStr + "T12:00:00Z"); // noon UTC anchor avoids DST/timezone edge issues
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
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

      // Uses item 3 (no quiz auto-check maps to it) so it doesn't interfere with
      // the quiz-driven checklist assertions later in this test.
      await page.locator('#checklist input[type="checkbox"]').nth(3).check();
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForSelector("#checklist input");
      const persisted = await page.locator('#checklist input[type="checkbox"]').nth(3).isChecked();
      assert(persisted, "checklist state persists across reload (localStorage)");
      await page.locator('#checklist input[type="checkbox"]').nth(3).uncheck(); // reset for the quiz auto-check assertions below

      await page.click('.tab-btn[data-tab="plan"]');
      await page.waitForSelector("#plan-table tbody tr");
      const rowCount = await page.$$eval("#plan-table tbody tr", (rows) => rows.length);
      assert(rowCount === plan.weeks.length, `plan table shows all ${plan.weeks.length} weeks (got ${rowCount})`);

      // Runs one full 10-question round for `startButtonId`, calling `onFirstQuestion`
      // (if given) after the first question renders but before answering it, and
      // `onFirstAnswer` right after that first answer is submitted. Ends back at the
      // quiz list screen via "쪽지시험 목록으로", and checks that button now shows
      // today's completion badge.
      // Questions expected per round, mirroring QUIZ_ROUND_SIZE/DEFAULT_ROUND_SIZE
      // in app.js. 독해 is 8 rather than 10 because reading.json only has 8
      // entries and a round is capped at the data file's size — if that file
      // grows past 10, this expectation moves to 10.
      const EXPECTED_ROUND_SIZE = {
        "#start-hiragana": 20,
        "#start-katakana": 20,
        "#start-kanji": 20,
        "#start-vocab": 10,
        "#start-grammar": 10,
        "#start-reading": 8,
        "#start-listening": 10,
      };

      async function runQuizRound(startButtonId, onFirstQuestion, onFirstAnswer) {
        await page.click(startButtonId);
        await page.waitForSelector("#quiz-choices .choice-btn");
        const progress = await page.textContent("#quiz-progress");
        const total = Number(progress.split("/")[1].trim());
        assert(
          total === EXPECTED_ROUND_SIZE[startButtonId],
          `${startButtonId}: round asks ${EXPECTED_ROUND_SIZE[startButtonId]} questions (got ${total})`
        );
        for (let i = 0; i < total; i++) {
          await page.waitForSelector("#quiz-choices .choice-btn");
          if (i === 0 && onFirstQuestion) await onFirstQuestion();
          await page.locator("#quiz-choices .choice-btn").first().click();
          if (i === 0 && onFirstAnswer) await onFirstAnswer();
          await page.click("#quiz-next");
        }
        await page.waitForSelector("#quiz-result:not([hidden])");
        const scoreText = await page.textContent("#quiz-score");
        assert(new RegExp(`\\d+ / ${total}`).test(scoreText), `${startButtonId} quiz reaches a score screen (got "${scoreText}")`);
        await page.click("#quiz-retry");
        assert(await page.isVisible("#quiz-start"), `${startButtonId}: retry returns to quiz list screen`);

        const btnText = await page.textContent(startButtonId);
        const btnClass = await page.getAttribute(startButtonId, "class");
        assert(btnText.startsWith("✓") && new RegExp(`\\(\\d+/${total}\\)`).test(btnText), `${startButtonId}: shows today's completion badge (got "${btnText}")`);
        assert(btnClass.includes("done-today"), `${startButtonId}: marked done-today`);
      }

      async function checklistChecked(i) {
        return page.locator('#checklist input[type="checkbox"]').nth(i).isChecked();
      }

      await page.click('.tab-btn[data-tab="quiz"]');

      assert(!(await checklistChecked(0)), "checklist item 0 starts unchecked before any word/kana/kanji quiz today");
      await runQuizRound(
        "#start-hiragana",
        async () => {
          const hint = await page.textContent("#quiz-hint");
          assert(hint.includes("한글"), `hiragana quiz asks for hangul reading (got "${hint}")`);
        },
        async () => {
          const note = await page.textContent("#quiz-note");
          assert(/^.+ = .+$/.test(note.trim()), `hiragana quiz explains the char=hangul pairing after answering (got "${note}")`);
        }
      );
      assert(await checklistChecked(0), "completing the hiragana quiz auto-checks checklist item 0 (단어·한자 학습/복습)");

      await runQuizRound("#start-katakana");

      await runQuizRound("#start-vocab", null, async () => {
        assert(!(await page.isVisible("#quiz-replay")), "replay button stays hidden outside listening mode (vocab)");
        const note = await page.textContent("#quiz-note");
        assert(note.includes("=") && note.includes("("), `vocab quiz explains word/reading/meaning after answering (got "${note}")`);
      });

      assert(!(await checklistChecked(1)), "checklist item 1 starts unchecked before any grammar/reading quiz today");
      await runQuizRound("#start-grammar", null, async () => {
        assert(await page.isVisible("#quiz-note"), "grammar quiz shows an explanation note after answering");
      });
      assert(await checklistChecked(1), "completing the grammar quiz auto-checks checklist item 1 (문법·진도 학습)");

      await runQuizRound(
        "#start-kanji",
        async () => {
          const kanjiHint = await page.textContent("#quiz-hint");
          assert(kanjiHint.includes("읽는 법"), `kanji quiz asks for reading (got "${kanjiHint}")`);
        },
        async () => {
          const note = await page.textContent("#quiz-note");
          assert(note.includes("→") && note.includes("("), `kanji quiz explains word/reading/meaning after answering (got "${note}")`);
        }
      );

      await runQuizRound(
        "#start-reading",
        async () => {
          const promptClass = await page.getAttribute("#quiz-prompt", "class");
          assert(promptClass.includes("passage"), "reading quiz renders the passage in passage style");
          assert(!(await page.isVisible("#quiz-replay")), "replay button stays hidden outside listening mode (reading)");
        },
        async () => {
          assert(await page.isVisible("#quiz-note"), "reading quiz shows an explanation note after answering");
        }
      );

      assert(!(await checklistChecked(2)), "checklist item 2 starts unchecked before any listening quiz today");
      await runQuizRound(
        "#start-listening",
        async () => {
          assert(await page.isVisible("#quiz-replay"), "listening quiz shows a replay button");
        },
        async () => {
          const listeningNote = await page.textContent("#quiz-note");
          assert(
            listeningNote.includes("스크립트:") && listeningNote.includes("뜻:"),
            `listening quiz reveals both script and meaning after answering (got "${listeningNote}")`
          );
        }
      );
      assert(await checklistChecked(2), "completing the listening quiz auto-checks checklist item 2 (청해 연습)");
      assert(!(await checklistChecked(3)), "checklist item 3 (전날 내용 복습) has no quiz proxy and stays unchecked");

      const nextDay = addDaysToDateStr(plan.weeks[2].start, 1);
      await withFixedDate(page, nextDay);
      await page.reload({ waitUntil: "networkidle" });
      await page.click('.tab-btn[data-tab="quiz"]');
      const vocabBtnTextNextDay = await page.textContent("#start-vocab");
      assert(!vocabBtnTextNextDay.startsWith("✓"), `completion badge resets on a new day (got "${vocabBtnTextNextDay}")`);
      assert(!(await checklistChecked(0)), "auto-checked checklist items also reset on a new day");

      assert(consoleErrors.length === 0, `no console errors (got ${JSON.stringify(consoleErrors)})`);
      await page.close();
    }

    // --- Wrong-answer review queue: a missed item should resurface next round ---
    {
      const page = await browser.newPage();
      await withFixedDate(page, plan.weeks[2].start);
      await page.goto(URL, { waitUntil: "networkidle" });
      await page.click('.tab-btn[data-tab="quiz"]');
      await page.click("#start-vocab");
      await page.waitForSelector("#quiz-choices .choice-btn");

      let missedPrompt = null;
      for (let i = 0; i < 10; i++) {
        await page.waitForSelector("#quiz-choices .choice-btn");
        const prompt = await page.textContent("#quiz-prompt");
        await page.locator("#quiz-choices .choice-btn").first().click();
        if (!missedPrompt && (await page.locator(".choice-btn.wrong").count()) > 0) missedPrompt = prompt;
        await page.click("#quiz-next");
      }
      assert(missedPrompt, "at least one vocab question was answered wrong in this round (expected virtually always with random clicks)");

      await page.click("#quiz-retry");
      await page.click("#start-vocab");
      let reappeared = false;
      for (let i = 0; i < 10; i++) {
        await page.waitForSelector("#quiz-choices .choice-btn");
        if ((await page.textContent("#quiz-prompt")) === missedPrompt) reappeared = true;
        await page.locator("#quiz-choices .choice-btn").first().click();
        await page.click("#quiz-next");
      }
      assert(reappeared, `missed item "${missedPrompt}" was prioritized back into the next vocab round`);
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
