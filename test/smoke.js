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
// The owner studies off a phone; every layout budget in CLAUDE.md is measured here.
const PHONE = { width: 390, height: 844 };
const URL = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, "..");
const CLOUD_CHROMIUM = "/opt/pw-browsers/chromium"; // stable path in Claude Code cloud sessions

function launchOpts() {
  const opts = { args: ["--no-sandbox"] };
  if (fs.existsSync(CLOUD_CHROMIUM)) opts.executablePath = CLOUD_CHROMIUM;
  return opts;
}

// Whether the 다음 button is actually within the viewport, not merely rendered.
// page.isVisible() only means "not display:none", so it says nothing about the
// fold — and on a phone a button below the fold after every question is exactly
// what the note-length budget exists to prevent. selectAnswer scrolls it into
// view, so this is what proves that works.
async function nextButtonOnScreen(page) {
  const box = await page.locator("#quiz-next").boundingBox();
  if (!box) return false;
  const h = page.viewportSize().height;
  return box.y >= 0 && box.y + box.height <= h;
}

// Headless Chromium has the Web Speech API but no voice, so what the app says can
// only be checked by intercepting it. Records every utterance instead of speaking
// it; must run before page.goto.
async function spyOnSpeech(page) {
  await page.addInitScript(() => {
    window.__spoken = [];
    window.SpeechSynthesisUtterance = function (text) { this.text = text; };
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        speak: (u) => window.__spoken.push({ text: u.text, rate: u.rate, lang: u.lang }),
        cancel: () => {},
      },
    });
  });
}

// The 같은 글자를 쓰는 다른 단어 lines are derived, not authored, so the test asks the
// page what it should have produced and checks the note carries exactly that —
// including the case where the word shares no character and nothing is appended.
async function assertRelatedLines(page, note, label) {
  const { word, lines, radLines } = await page.evaluate(() => {
    const w = quiz.pool[quiz.index].word;
    return { word: w, lines: relatedWordLines(w), radLines: radicalLines(w) };
  });
  // The radical table is hand-verified data, so the test also pins its shape:
  // every line names a group that exists and lists only that group's members.
  for (const line of radLines) {
    assert(note.includes(line), `${label}: note carries the radical line for ${word} (expected "${line}" in "${note}")`);
  }
  assert(radLines.length <= 2, `${label}: radical lines are capped at 2 (got ${radLines.length} for ${word})`);
  const radsSeen = radLines.map((l) => l.split("(")[0]);
  assert(new Set(radsSeen).size === radsSeen.length, `${label}: radical lines are deduped (got "${radsSeen.join(" ")}" for ${word})`);
  if (!lines.length) {
    assert(!/\n[\u4E00-\u9FFF]: /.test(note), `${label}: no related line for ${word}, which shares no character (got "${note}")`);
    return;
  }
  for (const line of lines) {
    assert(note.includes(line), `${label}: note carries the related-word line for ${word} (expected "${line}" in "${note}")`);
  }
  assert(lines.length <= 3, `${label}: related lines are capped at 3 (got ${lines.length} for ${word})`);
  // Count the word(reading, meaning) units, not comma-separated fields: both the
  // reading and the meaning can contain a comma, so a split-based count read
  // 会: 会社(かいしゃ, 회사) as several words.
  assert(
    lines.every((l) => (l.match(/\)(?=,|$)/g) || []).length <= 1),
    `${label}: at most 1 word per character now that readings are shown (got "${lines.join(" | ")}")`
  );
  // The owner can't read all these kanji yet, so a bare 会社(회사) is no help.
  // A kana-only entry legitimately shows no reading — it would repeat the word.
  for (const line of lines) {
    const shownWord = line.slice(line.indexOf(": ") + 2, line.indexOf("("));
    if (!/[\u4E00-\u9FFF]/.test(shownWord)) continue;
    const inner = line.slice(line.indexOf("(") + 1, line.lastIndexOf(")"));
    assert(
      /[\u3040-\u309F]/.test(inner.split(",")[0]),
      `${label}: a kanji-written related word carries its reading (got "${line}")`
    );
  }
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

      // Cache-busting: the deploy workflow rewrites these markers to the commit
      // SHA. Assert the hooks it edits are present and shaped as it expects, so a
      // rename here can't silently leave phones pinned to a stale app.js.
      const assetUrls = await page.$$eval(
        'script[src], link[rel="stylesheet"]',
        (els) => els.map((e) => e.getAttribute("src") || e.getAttribute("href"))
      );
      for (const u of assetUrls.filter((u) => /^(app\.js|style\.css)/.test(u))) {
        assert(/\?v=.+$/.test(u), `local asset is version-queried for cache-busting (got "${u}")`);
      }
      const stamp = (await page.textContent(".buildstamp")).trim();
      assert(/^build \S+$/.test(stamp), `build marker is visible and stamped (got "${stamp}")`);

      for (const sel of ["#quiz-prompt", "#quiz-reveal", "#quiz-meaning", "#quiz-choices", "#quiz-note"]) {
        const lang = await page.getAttribute(sel, "lang");
        assert(lang === "ja", `${sel} is marked lang="ja" so kanji use Japanese glyph shapes (got "${lang}")`);
      }

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
      // in app.js. A round is also capped at the data file's size, which is what
      // used to hold 독해 to 8; reading.json passed 10 entries on 2026-10-05, so
      // every type now runs its full configured length.
      const EXPECTED_ROUND_SIZE = {
        "#start-hiragana": 20,
        "#start-katakana": 20,
        "#start-loanword": 10,
        "#start-kanji": 20,
        "#start-vocab": 10,
        "#start-grammar": 10,
        "#start-reading": 10,
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

      // --- 탁음/반탁음 are in both kana tables, and no 한글 value collides with
      // its own 청음. The aspirated reading (か=카, not 가) exists precisely so
      // が=가 stays answerable; a regression there makes the quiz unwinnable.
      for (const kind of ["hiragana", "katakana"]) {
        const rows = await page.evaluate(
          (k) => fetch(`data/n4/${k}.json`).then((r) => r.json()),
          kind
        );
        const map = new Map(rows.map((e) => [e.char, e.hangul]));
        // 46 base + 20 탁음 + 5 반탁음 + 33 요음 (ぢゃ행 제외). The kana table is a
        // closed set, so this is the whole inventory — unlike every other quiz
        // type, "more entries" here means completing the chart, not inventing.
        assert(rows.length === 104, `${kind}.json carries the full kana chart (got ${rows.length})`);
        // Maps every character, not just the first: 요음 are two characters, and
        // converting only [0] turned きゃ into キ and faked a clash with き.
        const kana =
          kind === "hiragana"
            ? (c) => c
            : (c) => [...c].map((ch) => String.fromCodePoint(ch.codePointAt(0) + 0x60)).join("");
        for (const [plain, voiced] of [
          ["か", "が"], ["さ", "ざ"], ["た", "だ"], ["は", "ば"], ["は", "ぱ"], ["ば", "ぱ"],
          ["ち", "ぢ"], ["つ", "づ"], ["て", "で"], ["と", "ど"], ["き", "ぎ"], ["し", "じ"],
          // 요음 against its own 탁음, and against the plain kana it is built from
          ["きゃ", "ぎゃ"], ["きゅ", "ぎゅ"], ["きょ", "ぎょ"], ["しゃ", "じゃ"], ["しゅ", "じゅ"],
          ["しょ", "じょ"], ["ひゃ", "びゃ"], ["ひょ", "びょ"], ["びゃ", "ぴゃ"], ["びょ", "ぴょ"],
          ["き", "きゃ"], ["し", "しゃ"], ["ち", "ちゃ"], ["こ", "きょ"], ["そ", "しょ"], ["と", "ちょ"],
        ]) {
          const [a, b] = [kana(plain), kana(voiced)];
          assert(map.has(a) && map.has(b), `${kind}: both ${a} and ${b} are in the table`);
          assert(
            map.get(a) !== map.get(b),
            `${kind}: ${a} and ${b} must not share a 한글 reading (both ${map.get(a)})`
          );
        }
        // Five pairs legitimately share a reading — お/を, じ/ぢ, ず/づ, and the two
        // 요음 brought in: ざ/じゃ (자) and ぞ/じょ (조). All are real facts of the
        // 표기법, not data bugs, but pickDistractors must dedupe or a round can show
        // the same choice twice. Pinned exactly, so a sixth can't appear unnoticed.
        const shared = [...new Set(rows.map((e) => e.hangul))].length;
        assert(
          rows.length - shared === 5,
          `${kind}: exactly 5 readings are shared by two kana (got ${rows.length - shared})`
        );
      }

      {
        // Drive a full kana round and check every question's four choices are
        // distinct — the cases that break are じ/ぢ both rendering as 지, or
        // ざ/じゃ both as 자 now that 요음 are in.
        await page.click("#start-hiragana");
        for (let i = 0; i < 20; i++) {
          await page.waitForSelector("#quiz-choices .choice-btn");
          const shown = await page.evaluate(() =>
            [...document.querySelectorAll("#quiz-choices .choice-btn")].map((b) => b.textContent)
          );
          const prompt = await page.textContent("#quiz-prompt");
          assert(
            shown.length === 4 && new Set(shown).size === 4,
            `kana round never repeats a choice (${prompt} showed [${shown.join(", ")}])`
          );
          await page.locator("#quiz-choices .choice-btn").first().click();
          await page.click("#quiz-next");
        }
        await page.click("#quiz-retry");
      }

      await runQuizRound(
        "#start-loanword",
        async () => {
          const hint = await page.textContent("#quiz-hint");
          assert(hint.includes("가타카나 표기"), `외래어 quiz asks for the katakana spelling (got "${hint}")`);

          // The distractors are generated near-misses, so what matters is that
          // they're distinct, all katakana, and none of them is the answer twice.
          const choices = await page.$$eval("#quiz-choices .choice-btn", (els) => els.map((e) => e.textContent.trim()));
          const answer = await page.evaluate(() => quiz.pool[quiz.index].word);
          assert(new Set(choices).size === 4, `외래어 choices are all distinct (got ${choices.join(" / ")})`);
          assert(choices.includes(answer), `the correct spelling is among the choices (${answer} in ${choices.join(" / ")})`);
          assert(
            choices.every((c) => /^[ァ-ヶー]+$/.test(c)),
            `every 외래어 choice is katakana (got ${choices.join(" / ")})`
          );
          assert(
            choices.filter((c) => c !== answer).every((c) => c.length > 0),
            "no empty distractor spellings"
          );
        },
        async () => {
          const note = await page.textContent("#quiz-note");
          assert(note.includes("="), `외래어 quiz explains word = meaning after answering (got "${note}")`);
        }
      );

      await runQuizRound(
        "#start-vocab",
        async () => {
          // The reading is behind a tap now, so the prompt must be the word alone.
          const item = await page.evaluate(() => quiz.pool[quiz.index]);
          const vocabPrompt = (await page.textContent("#quiz-prompt")).trim();
          assert(vocabPrompt === item.word, `vocab prompt shows the word alone (got "${vocabPrompt}", expected "${item.word}")`);
          if (item.reading === item.word) {
            // Kana-only entry: revealing it would just repeat the prompt.
            assert(!(await page.isVisible("#quiz-reveal")), `no reading cue for the kana-only entry ${item.word}`);
          } else {
            const cue = (await page.textContent("#quiz-reveal")).trim();
            assert(cue === "글자를 누르면 읽는 법", `vocab quiz shows the reading cue before tapping (got "${cue}")`);
            await page.click("#quiz-prompt");
            const shown = (await page.textContent("#quiz-reveal")).trim();
            assert(shown === item.reading, `tapping the vocab word reveals its reading (got "${shown}", expected "${item.reading}")`);
          }
        },
        async () => {
        assert(!(await page.isVisible("#quiz-replay")), "replay button stays hidden outside listening mode (vocab)");
        assert(!(await page.isVisible("#quiz-meaning")), "meaning hint stays hidden outside the kanji quiz (vocab)");
        const note = await page.textContent("#quiz-note");
        assert(note.includes("=") && note.includes("("), `vocab quiz explains word/reading/meaning after answering (got "${note}")`);
        await assertRelatedLines(page, note, "vocab");
        }
      );

      assert(!(await checklistChecked(1)), "checklist item 1 starts unchecked before any grammar/reading quiz today");
      await runQuizRound("#start-grammar", null, async () => {
        assert(!(await page.isVisible("#quiz-reveal")), "reading cue stays hidden in quiz types that don't wire it (grammar)");
        assert(await page.isVisible("#quiz-note"), "grammar quiz shows an explanation note after answering");
      });
      assert(await checklistChecked(1), "completing the grammar quiz auto-checks checklist item 1 (문법·진도 학습)");

      await runQuizRound(
        "#start-kanji",
        async () => {
          const kanjiHint = await page.textContent("#quiz-hint");
          assert(kanjiHint.includes("읽는 법"), `kanji quiz asks for reading (got "${kanjiHint}")`);

          // The meaning is a hint now, not part of the prompt — it must not be
          // readable anywhere on screen until the hint line is tapped.
          const kanjiMeaning = await page.evaluate(() => quiz.pool[quiz.index].meaning);
          assert(
            !kanjiHint.includes(kanjiMeaning),
            `kanji hint line no longer gives the meaning away (got "${kanjiHint}")`
          );
          const meaningCue = (await page.textContent("#quiz-meaning")).trim();
          assert(meaningCue === "💡 뜻 힌트", `kanji quiz shows the meaning cue before tapping (got "${meaningCue}")`);
          await page.click("#quiz-meaning");
          const meaningShown = (await page.textContent("#quiz-meaning")).trim();
          assert(
            meaningShown === `뜻: ${kanjiMeaning}`,
            `tapping the hint reveals the meaning (got "${meaningShown}", expected "뜻: ${kanjiMeaning}")`
          );

          // Distractors are picked for shape similarity (pickReadingDistractors),
          // so guard the two ways that can go wrong: a repeated choice when two
          // entries are homophones, and a choice that isn't a real reading.
          const choices = await page.$$eval("#quiz-choices .choice-btn", (els) => els.map((e) => e.textContent.trim()));
          const readings = await page.evaluate(() => quiz.allItems.map((i) => i.reading));
          assert(choices.length === 4, `kanji quiz offers 4 choices (got ${choices.length})`);
          assert(new Set(choices).size === 4, `kanji quiz choices are all distinct (got ${choices.join(" / ")})`);
          assert(choices.every((c) => readings.includes(c)), `every kanji choice is a real reading from the data (got ${choices.join(" / ")})`);

          // Tapping the word reveals its reading; the cue sits there until then.
          const cue = (await page.textContent("#quiz-reveal")).trim();
          assert(cue === "글자를 누르면 읽는 법", `kanji quiz shows the tap cue before peeking (got "${cue}")`);
          const expected = await page.evaluate(() => quiz.pool[quiz.index].reading);
          await page.click("#quiz-prompt");
          const revealed = (await page.textContent("#quiz-reveal")).trim();
          assert(revealed === expected, `tapping the word reveals its reading (got "${revealed}", expected "${expected}")`);
        },
        async () => {
          const note = await page.textContent("#quiz-note");
          assert(note.includes("→") && note.includes("("), `kanji quiz explains word/reading/meaning after answering (got "${note}")`);
          await assertRelatedLines(page, note, "kanji");
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
          // The three distractors are authored per entry (a changed time, day,
          // direction or actor), not drawn from other entries at random, so the
          // rendered set must be exactly that entry's own meaning + choices.
          const { expected, shown } = await page.evaluate(() => ({
            expected: [quiz.pool[quiz.index].meaning, ...quiz.pool[quiz.index].choices],
            shown: [...document.querySelectorAll("#quiz-choices .choice-btn")].map((b) => b.textContent),
          }));
          assert(
            expected.length === 4 && shown.length === 4 &&
              [...expected].sort().join("|") === [...shown].sort().join("|"),
            `listening choices are the entry's own near-misses (shown [${shown.join(", ")}])`
          );
          assert(
            await page.isVisible("#quiz-replay-slow"),
            "listening quiz offers a 천천히 듣기 button beside the normal one"
          );
          // One replay each, like the exam. Each button stays in place and says so.
          for (const id of ["#quiz-replay", "#quiz-replay-slow"]) {
            assert(!(await page.locator(id).isDisabled()), `${id} starts available`);
            await page.click(id);
            assert(await page.locator(id).isDisabled(), `${id} is spent after one replay`);
            assert(
              (await page.textContent(id)).includes("0회"),
              `${id} says how many replays are left (got "${await page.textContent(id)}")`
            );
          }
          // Separate budgets: spending the normal replay can't have spent the slow
          // one, which the loop above already proved by clicking it afterwards.
          const slowRate = await page.evaluate(() => [SLOW_SPEECH_RATE, SPEECH_RATE]);
          assert(
            slowRate[0] < slowRate[1],
            `the 천천히 pass is slower than the normal one (got ${slowRate[0]} vs ${slowRate[1]})`
          );
        },
        async () => {
          const listeningNote = await page.textContent("#quiz-note");
          assert(
            listeningNote.includes("스크립트:") && listeningNote.includes("뜻:"),
            `listening quiz reveals both script and meaning after answering (got "${listeningNote}")`
          );
          // Both buttons come back once the answer is in: the transcript is on
          // screen, so there's nothing left to grind and replaying is pure study.
          for (const id of ["#quiz-replay", "#quiz-replay-slow"]) {
            assert(
              !(await page.locator(id).isDisabled()),
              `${id} is usable again after answering, even though it was spent`
            );
            assert(
              !(await page.textContent(id)).includes("회)"),
              `${id} drops the remaining-count label after answering (got "${await page.textContent(id)}")`
            );
          }
          await page.click("#quiz-replay-slow");
          assert(
            !(await page.locator("#quiz-replay-slow").isDisabled()),
            "post-answer replays are unlimited, so the button stays usable"
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

      const missed = [];
      for (let i = 0; i < 10; i++) {
        await page.waitForSelector("#quiz-choices .choice-btn");
        const prompt = await page.textContent("#quiz-prompt");
        await page.locator("#quiz-choices .choice-btn").first().click();
        if ((await page.locator(".choice-btn.wrong").count()) > 0) missed.push(prompt);
        await page.click("#quiz-next");
      }
      assert(missed.length, "at least one vocab question was answered wrong in this round (expected virtually always with random clicks)");

      await page.click("#quiz-retry");
      await page.click("#start-vocab");
      const seen = [];
      for (let i = 0; i < 10; i++) {
        await page.waitForSelector("#quiz-choices .choice-btn");
        seen.push(await page.textContent("#quiz-prompt"));
        await page.locator("#quiz-choices .choice-btn").first().click();
        await page.click("#quiz-next");
      }
      // Review items are prioritized, but only up to REVIEW_SHARE of the round —
      // asserting one *specific* missed word comes back would be flaky now that
      // random clicking misses more than the cap. The count is exact: fresh items
      // are by definition not in the wrong set, so nothing else can inflate it.
      const cap = await page.evaluate(() => Math.max(1, Math.round(10 * REVIEW_SHARE)));
      const reappeared = seen.filter((w) => missed.includes(w)).length;
      assert(
        reappeared === Math.min(missed.length, cap),
        `missed items are prioritized back into the next vocab round, up to the ${cap}-item review cap ` +
          `(missed ${missed.length}, ${reappeared} came back)`
      );
      await page.close();
    }

    // --- 한자 기초 tab ---
    // It renders from the same radical.json the note uses, so the test checks
    // the page against the file rather than against hardcoded counts.
    {
      const page = await browser.newPage();
      const errs = [];
      page.on("pageerror", (e) => errs.push(e.message));
      page.on("console", (m) => m.type() === "error" && errs.push(m.text()));
      await page.goto(URL, { waitUntil: "networkidle" });
      await page.click('.tab-btn[data-tab="radical"]');
      await page.waitForSelector("#radical-groups .card");

      const groups = JSON.parse(fs.readFileSync(path.join(ROOT, "data/n4/radical.json"), "utf8"));

      // A variant radical shows its standalone parent — 礻 (示) — because the bare
      // codepoint renders from a fallback font on some phones and comes out
      // looking unlike the same part inside 社. The parent is a common character.
      const heads = await page.$$eval(".radical-glyph", (els) => els.map((e) => e.textContent.trim()));
      for (const [rad, g] of Object.entries(groups)) {
        const want = g.base ? `${rad} (${g.base})` : rad;
        assert(heads.includes(want), `radical head shows ${g.base ? "the variant with its parent" : "the glyph"} (expected "${want}")`);
      }
      // Japanese text is marked lang="ja" so the browser picks Japanese glyph
      // shapes rather than the page's lang="ko" Korean ones.
      for (const sel of [".radical-glyph", ".radical-chars", ".radical-words"]) {
        const tagged = await page.$$eval(sel, (els) => els.every((e) => e.lang === "ja"));
        assert(tagged, `${sel} is marked lang="ja"`);
      }
      const expectedGroups = Object.keys(groups).length;
      const expectedChars = Object.values(groups).reduce((n, g) => n + g.chars.length, 0);
      const cards = await page.$$eval("#radical-groups .card", (e) => e.length);
      const chips = await page.$$eval(".radical-char", (e) => e.map((b) => b.textContent));
      assert(cards === expectedGroups, `한자 기초 renders one card per radical group (got ${cards}, expected ${expectedGroups})`);
      assert(chips.length === expectedChars, `한자 기초 renders every group member (got ${chips.length}, expected ${expectedChars})`);
      assert(
        chips.every((c) => Object.values(groups).some((g) => g.chars.includes(c))),
        "every chip is a character radical.json actually lists"
      );

      // Tapping a character shows the words it appears in, from the xref index.
      const probe = chips.find((c) => c === "港") || chips[0];
      await page.locator(".radical-char", { hasText: probe }).first().click();
      const shown = (await page.locator(".radical-words:visible").first().textContent()).trim();
      assert(shown.startsWith(`${probe} —`), `tapping ${probe} shows the words it appears in (got "${shown}")`);
      assert(
        /\([\u3040-\u309F]/.test(shown),
        `한자 기초 word list carries readings, not just meanings (got "${shown}")`
      );
      // Tapping the same chip again closes it.
      await page.locator(".radical-char", { hasText: probe }).first().click();
      assert(
        (await page.locator(".radical-words:visible").count()) === 0,
        "tapping the same character again closes the word list"
      );
      assert(errs.length === 0, `한자 기초 tab renders with no console errors (got ${JSON.stringify(errs)})`);
      await page.close();
    }

    // --- The radical line, on a word chosen to have one ---
    // The round above only sees whatever it draws, and 53% of kanji words have no
    // radical group, so this pins the positive case against the shipped table.
    {
      // 390x844 on purpose: every note-length budget in CLAUDE.md was measured at
      // phone size, and the default 1280x720 wraps so little that the height
      // assertion below would pass whatever the note said.
      const page = await browser.newPage({ viewport: PHONE });
      await page.goto(URL, { waitUntil: "networkidle" });
      await page.click('.tab-btn[data-tab="quiz"]');
      await page.click("#start-kanji");
      await page.waitForSelector("#quiz-choices .choice-btn");

      const probe = await page.evaluate(async () => {
        const groups = await fetch("data/n4/radical.json").then((r) => r.json());
        const target = quiz.allItems.find((i) => radicalLines(i.word).length > 0);
        quiz.pool[quiz.index] = target;
        renderQuestion();
        return { groups, word: target.word, reading: target.reading, lines: radicalLines(target.word) };
      });
      await page.locator("#quiz-choices .choice-btn", { hasText: probe.reading }).first().click();
      const radNote = await page.textContent("#quiz-note");
      for (const line of probe.lines) {
        assert(radNote.includes(line), `radical line shows for ${probe.word} (expected "${line}" in "${radNote}")`);
        const rad = line.split("(")[0];
        const g = probe.groups[rad];
        assert(g, `radical line names a group that exists in radical.json (got "${rad}")`);
        const shown = line.split(": ")[1].split(" ");
        assert(
          shown.every((c) => g.chars.includes(c) && c !== probe.word),
          `radical line lists only that group's members (got "${line}")`
        );
      }
      assert(await nextButtonOnScreen(page), "the 다음 button stays reachable under the longest note");
      await page.close();
    }

    // --- Peeking at a vocab reading does NOT keep it in the review queue ---
    // The 단어 quiz asks for the meaning, so the reading is a hint rather than the
    // answer; only the 한자 quiz's peek is penalized.
    {
      const page = await browser.newPage();
      await page.goto(URL, { waitUntil: "networkidle" });
      await page.evaluate(() => localStorage.clear());
      await page.reload({ waitUntil: "networkidle" });
      await page.click('.tab-btn[data-tab="quiz"]');
      await page.click("#start-vocab");
      await page.waitForSelector("#quiz-choices .choice-btn");

      // Skip to a question that actually has a reading to reveal.
      let item = await page.evaluate(() => quiz.pool[quiz.index]);
      while (item.reading === item.word) {
        await page.locator("#quiz-choices .choice-btn").first().click();
        await page.click("#quiz-next");
        await page.waitForSelector("#quiz-choices .choice-btn");
        item = await page.evaluate(() => quiz.pool[quiz.index]);
      }
      await page.click("#quiz-prompt");
      // Asserted here as well as in the round above, because which entry the round
      // draws first is random and may be a kana-only one with no reading to show.
      const vocabShown = (await page.textContent("#quiz-reveal")).trim();
      assert(vocabShown === item.reading, `vocab reading reveals on tap (got "${vocabShown}", expected "${item.reading}")`);
      await page.locator("#quiz-choices .choice-btn", { hasText: item.meaning }).first().click();
      const vocabQueued = await page.evaluate(() => JSON.parse(localStorage.getItem("jlpt_wrong_items_n4") || "{}").vocab || []);
      assert(
        !vocabQueued.includes(item.word),
        `a peeked vocab reading still counts as recall when answered right (${item.word} not in [${vocabQueued.join(", ")}])`
      );
      await page.close();
    }

    // --- Peeking at a kanji reading keeps it in the review queue ---
    {
      const page = await browser.newPage();
      await page.goto(URL, { waitUntil: "networkidle" });
      await page.evaluate(() => localStorage.clear());
      await page.reload({ waitUntil: "networkidle" });
      await page.click('.tab-btn[data-tab="quiz"]');
      await page.click("#start-kanji");
      await page.waitForSelector("#quiz-choices .choice-btn");

      const peeked = await page.evaluate(() => quiz.pool[quiz.index]);
      await page.click("#quiz-prompt");
      // Answer it correctly — without the peek this would clear it from review.
      await page.locator("#quiz-choices .choice-btn", { hasText: peeked.reading }).first().click();

      const queued = await page.evaluate(() => JSON.parse(localStorage.getItem("jlpt_wrong_items_n4") || "{}").kanji || []);
      assert(
        queued.includes(peeked.word),
        `a peeked kanji stays in the review queue even when answered right (${peeked.word} in [${queued.join(", ")}])`
      );
      await page.close();
    }

    // --- 독해: the Korean translation shows after answering ---
    {
      const page = await browser.newPage({ viewport: PHONE });
      await page.goto(URL, { waitUntil: "networkidle" });
      const missing = await page.evaluate(async () => {
        const all = await fetch("data/n4/reading.json").then((x) => x.json());
        return all
          .filter((e) => !e.translation || /[\u3040-\u30FF\u4E00-\u9FFF]/.test(e.translation))
          .map((e) => e.passage.slice(0, 16));
      });
      assert(
        missing.length === 0,
        `every 독해 entry has a Korean translation with no Japanese left in it (${missing.length} bad: ${missing.slice(0, 3).join(" | ")})`
      );

      await page.click('.tab-btn[data-tab="quiz"]');
      await page.click("#start-reading");
      await page.waitForSelector("#quiz-choices .choice-btn");
      const item = await page.evaluate(() => quiz.pool[quiz.index]);
      assert(!(await page.isVisible("#quiz-note")), "the translation stays hidden until the question is answered");
      await page.locator("#quiz-choices .choice-btn").first().click();
      const note = await page.textContent("#quiz-note");
      assert(note.includes(item.translation), `the note carries the passage's translation after answering`);
      assert(note.includes(item.note), `the note still carries the explanation as well`);
      assert(
        note.indexOf(item.translation) < note.indexOf(item.note),
        `the translation comes before the explanation`
      );
      await page.close();
    }

    // --- 독해 furigana: the annotated copy must never drift from the passage ---
    // `ruby` carries the same text with 漢字（かな）, and the app strips the
    // annotations to render. If the two ever diverge the passage silently changes,
    // so this checks every entry with the page's own stripRuby, not a copy of it.
    {
      const page = await browser.newPage({ viewport: PHONE });
      await page.goto(URL, { waitUntil: "networkidle" });
      const r = await page.evaluate(async () => {
        const all = await fetch("data/n4/reading.json").then((x) => x.json());
        const bad = [];
        let annotated = 0;
        let words = 0;
        for (const e of all) {
          if (!e.ruby) { bad.push(`${e.passage.slice(0, 16)}: no ruby`); continue; }
          annotated++;
          if (stripRuby(e.ruby) !== e.passage) bad.push(`${e.passage.slice(0, 16)}: strip mismatch`);
          const n = [...e.ruby.matchAll(/([\u4E00-\u9FFF]+)（([\u3040-\u309F]+)）/gu)].length;
          words += n;
          // nothing may be left outside an annotation, or some kanji has no reading
          const left = e.ruby.replace(/([\u4E00-\u9FFF]+)（([\u3040-\u309F]+)）/gu, "").match(/[\u4E00-\u9FFF]/gu);
          if (left) bad.push(`${e.passage.slice(0, 16)}: ${left.join("")} unannotated`);
        }
        return { total: all.length, annotated, words, bad };
      });
      assert(r.annotated === r.total, `every 독해 passage carries furigana (${r.annotated}/${r.total})`);
      assert(
        r.bad.length === 0,
        `every ruby strips back to its passage with no kanji left over (${r.bad.length} bad: ${r.bad.slice(0, 3).join(" | ")})`
      );
      assert(r.words > 1000, `the furigana is substantial, not a token few (${r.words} words)`);
      await page.close();
    }

    // --- 독해: tapping a word in the passage shows its reading ---
    {
      const page = await browser.newPage({ viewport: PHONE });
      await page.goto(URL, { waitUntil: "networkidle" });
      await page.click('.tab-btn[data-tab="quiz"]');
      await page.click("#start-reading");
      await page.waitForSelector("#quiz-choices .choice-btn");

      // The rendered passage must read exactly as the data does — the annotations
      // are stripped out of the text and only survive as tap targets.
      const shown = await page.textContent("#quiz-prompt");
      const item = await page.evaluate(() => quiz.pool[quiz.index]);
      assert(shown === item.passage, `the passage renders without its furigana markup`);
      const taps = await page.locator("#quiz-prompt .ruby-word").count();
      assert(taps > 0, `the passage offers tappable words (got ${taps})`);

      const cue = (await page.textContent("#quiz-reveal")).trim();
      assert(cue === "한자를 누르면 읽는 법", `the reveal line cues the tap before anything is tapped (got "${cue}")`);

      const first = await page.evaluate(() => {
        const m = [...quiz.pool[quiz.index].ruby.matchAll(/([\u4E00-\u9FFF]+)（([\u3040-\u309F]+)）/gu)][0];
        return { word: m[1], reading: m[2] };
      });
      await page.locator("#quiz-prompt .ruby-word").first().click();
      const revealed = (await page.textContent("#quiz-reveal")).trim();
      assert(
        revealed === `${first.word} → ${first.reading}`,
        `tapping a word shows its reading (expected "${first.word} → ${first.reading}", got "${revealed}")`
      );

      // Reading a word is not the 독해 answer, so the peek is free — the same rule
      // that penalizes the 한자 quiz's reading peek and spares the 단어 quiz's.
      await page.locator("#quiz-choices .choice-btn", { hasText: item.answer }).first().click();
      const queued = await page.evaluate(
        () => JSON.parse(localStorage.getItem("jlpt_wrong_items_n4") || "{}").reading || []
      );
      assert(
        !queued.includes(item.passage),
        `a tapped reading still counts as recall when answered right (passage not in the review queue)`
      );
      await page.close();
    }

    // --- 문법 renders at its own size, not the single-kanji 2.6rem ---
    // Its sentences carry furigana as 漢字（かな）, which roughly doubles the
    // character count; at 2.6rem one ran over three lines on a phone.
    {
      // One page each: #quiz-retry only exists on the result screen, so you can't
      // switch quiz type mid-round.
      const promptSize = async (type) => {
        const page = await browser.newPage({ viewport: PHONE });
        await page.goto(URL, { waitUntil: "networkidle" });
        await page.click('.tab-btn[data-tab="quiz"]');
        await page.click(`#start-${type}`);
        await page.waitForSelector("#quiz-choices .choice-btn");
        const px = await page.evaluate(
          () => parseFloat(getComputedStyle(document.getElementById("quiz-prompt")).fontSize)
        );
        await page.close();
        return px;
      };
      const grammarPx = await promptSize("grammar");
      const kanjiPx = await promptSize("kanji");
      assert(
        grammarPx < kanjiPx / 2,
        `the 문법 sentence is less than half the single-kanji prompt (${grammarPx}px vs ${kanjiPx}px)`
      );
      // the class must be cleared again, or 한자 would inherit the small size
      assert(
        kanjiPx > 40,
        `한자 keeps the oversized prompt so strokes stay legible (${kanjiPx}px)`
      );
    }

    // --- Picking an answer reads it aloud ---
    // Asked for from the 외래어 quiz, where the whole question is a spelling you
    // still can't pronounce after getting it right. The field spoken differs by
    // type: 단어 asks for the Korean meaning, so it speaks the entry's reading
    // rather than the answer the choices show.
    {
      const EXPECT = {
        hiragana: (i) => i.char,
        katakana: (i) => i.char,
        loanword: (i) => i.word,
        vocab: (i) => i.reading,
        kanji: (i) => i.reading,
        reading: (i) => i.answer,
      };
      for (const [type, expected] of Object.entries(EXPECT)) {
        const page = await browser.newPage({ viewport: PHONE });
        await spyOnSpeech(page);
        await page.goto(URL, { waitUntil: "networkidle" });
        await page.click('.tab-btn[data-tab="quiz"]');
        await page.click(`#start-${type}`);
        await page.waitForSelector("#quiz-choices .choice-btn");

        const before = await page.evaluate(() => window.__spoken.length);
        assert(before === 0, `${type}: silent until the question is answered (got ${before})`);
        assert(
          !(await page.isVisible("#quiz-say")),
          `${type}: no 발음 듣기 button before answering`
        );

        const item = await page.evaluate(() => quiz.pool[quiz.index]);
        // Deliberately the first choice, not the right one: a wrong answer is
        // exactly when hearing the correct reading matters most.
        await page.locator("#quiz-choices .choice-btn").first().click();
        const spoken = await page.evaluate(() => window.__spoken);
        assert(spoken.length === 1, `${type}: the answer is spoken once (got ${spoken.length})`);
        assert(
          spoken[0].text === expected(item),
          `${type}: speaks ${JSON.stringify(expected(item))} (got ${JSON.stringify(spoken[0].text)})`
        );
        assert(spoken[0].lang === "ja-JP", `${type}: spoken with a Japanese voice (got "${spoken[0].lang}")`);
        assert(spoken[0].rate === 1, `${type}: spoken at the plain answer rate (got ${spoken[0].rate})`);

        await page.click("#quiz-say");
        const repeated = await page.evaluate(() => window.__spoken.length);
        assert(repeated === 2, `${type}: 발음 듣기 repeats the answer (got ${repeated} utterances)`);

        await page.click("#quiz-next");
        assert(
          !(await page.isVisible("#quiz-say")),
          `${type}: the button is cleared again on the next question`
        );
        await page.close();
      }
    }

    // --- 문법 speaks the whole sentence with the blank filled ---
    // A bare suffix has nothing to attach to, and 접속 is half of what the section
    // tests. Both the sentence and the answer can carry 漢字（かな）, and a reading
    // read aloud beside the kanji it annotates would double every word.
    {
      const page = await browser.newPage({ viewport: PHONE });
      await spyOnSpeech(page);
      await page.goto(URL, { waitUntil: "networkidle" });
      await page.click('.tab-btn[data-tab="quiz"]');
      await page.click("#start-grammar");
      await page.waitForSelector("#quiz-choices .choice-btn");
      await page.locator("#quiz-choices .choice-btn").first().click();
      const { spoken, want } = await page.evaluate(() => {
        const e = quiz.pool[quiz.index];
        return {
          spoken: window.__spoken,
          want: stripRuby(e.sentence).replace("＿＿＿", stripRuby(e.answer)),
        };
      });
      assert(spoken.length === 1, `문법: the filled sentence is spoken once (got ${spoken.length})`);
      assert(spoken[0].text === want, `문법: speaks "${want}" (got "${spoken[0].text}")`);
      assert(
        !/[（）＿]/.test(spoken[0].text),
        `문법: no furigana parens or blank left to read aloud (got "${spoken[0].text}")`
      );

      // Whole-file version of the same thing. A half-width ")" in one entry's
      // furigana (休（やす)み) slipped past stripRuby and would have been spoken as
      // part of the sentence — the kind of drift the 독해 ruby check already pins.
      const g = await page.evaluate(async () => {
        const all = await fetch("data/n4/grammar.json").then((x) => x.json());
        const bad = [];
        for (const e of all) {
          const head = e.sentence.slice(0, 16);
          if (!/^[^＿]*＿＿＿[^＿]*$/.test(e.sentence)) bad.push(`${head}: not exactly one blank`);
          const left = e.sentence.replace(/([\u4E00-\u9FFF]+)（([\u3040-\u309F]+)）/gu, "")
            .match(/[\u4E00-\u9FFF]/gu);
          if (left) bad.push(`${head}: ${left.join("")} unannotated`);
          const filled = stripRuby(e.sentence).replace("＿＿＿", stripRuby(e.answer));
          if (/[（）()＿]/.test(filled)) bad.push(`${head}: "${filled}" still has markup`);
        }
        return { total: all.length, bad };
      });
      assert(
        g.bad.length === 0,
        `every 문법 sentence fills to clean Japanese (${g.bad.length} bad of ${g.total}: ${g.bad.slice(0, 3).join(" | ")})`
      );
      await page.close();
    }

    // --- 청해 says nothing extra on answering ---
    // Its script is spoken already and both replay buttons go unlimited the moment
    // you answer, so a third control repeating the same sentence would only crowd
    // the screen.
    {
      const page = await browser.newPage({ viewport: PHONE });
      await spyOnSpeech(page);
      await page.goto(URL, { waitUntil: "networkidle" });
      await page.click('.tab-btn[data-tab="quiz"]');
      await page.click("#start-listening");
      await page.waitForSelector("#quiz-choices .choice-btn");
      const script = await page.evaluate(() => window.__spoken.map((u) => u.text));
      assert(
        script.length === 1,
        `청해: the script is spoken when the question opens (got ${script.length})`
      );
      await page.locator("#quiz-choices .choice-btn").first().click();
      const after = await page.evaluate(() => window.__spoken.length);
      assert(after === 1, `청해: answering doesn't speak again (got ${after} utterances)`);
      assert(!(await page.isVisible("#quiz-say")), `청해: no 발음 듣기 button`);
      // The replay buttons are the ones that do this job here, and they're free now.
      await page.click("#quiz-replay");
      const replayed = await page.evaluate(() => window.__spoken.length);
      assert(replayed === 2, `청해: 다시 듣기 still replays the script (got ${replayed})`);
      await page.close();
    }

    // --- Every 독해 / 청해 / 문법 entry leaves the 다음 button on screen ---
    // These three have the tallest cards: 독해 shows a passage up to 107 characters
    // plus a note, 청해 shows four full-sentence Korean choices plus a note that
    // repeats the script, and 문법 renders its sentence at the oversized 2.6rem
    // .quiz-prompt so it wraps over several lines. Before selectAnswer scrolled the
    // button into view, 23 of reading.json's 41 entries pushed it past the fold at
    // phone size. A round only draws 10, so this walks each whole file rather than
    // trusting the draw.
    for (const { type, file, keyField, answerField } of [
      { type: "reading", file: "reading.json", keyField: "passage", answerField: "answer" },
      { type: "listening", file: "listening.json", keyField: "script", answerField: "meaning" },
      { type: "grammar", file: "grammar.json", keyField: "sentence", answerField: "answer" },
    ]) {
      const page = await browser.newPage({ viewport: PHONE });
      await page.goto(URL, { waitUntil: "networkidle" });
      await page.click('.tab-btn[data-tab="quiz"]');
      await page.click(`#start-${type}`);
      await page.waitForSelector("#quiz-choices .choice-btn");
      const total = await page.evaluate(async (f) => {
        const all = await fetch(`data/n4/${f}`).then((r) => r.json());
        quiz.pool = all;
        quiz.index = 0;
        renderQuestion();
        return all.length;
      }, file);
      assert(total >= 10, `${file} has enough entries to fill a round (got ${total})`);
      const offScreen = [];
      for (let i = 0; i < total; i++) {
        await page.waitForSelector("#quiz-choices .choice-btn");
        const answer = await page.evaluate((f) => quiz.pool[quiz.index][f], answerField);
        await page.locator("#quiz-choices .choice-btn", { hasText: answer }).first().click();
        if (!(await nextButtonOnScreen(page))) {
          offScreen.push(await page.evaluate((f) => quiz.pool[quiz.index][f].slice(0, 20), keyField));
        }
        await page.click("#quiz-next");
      }
      assert(
        offScreen.length === 0,
        `all ${total} ${type} entries leave 다음 on screen at ${PHONE.width}x${PHONE.height}` +
          (offScreen.length ? ` (${offScreen.length} did not: ${offScreen.join(" | ")})` : "")
      );
      await page.close();
    }

    // --- A round is at most half review, so new words still come up ---
    {
      const page = await browser.newPage();
      await page.goto(URL, { waitUntil: "networkidle" });
      const pools = await page.evaluate(() => {
        const items = Array.from({ length: 40 }, (_, i) => ({ word: `w${i}` }));
        // A queue twice the size of a round — the case that used to make every
        // round 100% review, so a word added today could never be drawn.
        const wrong = items.slice(0, 20).map((v) => v.word);
        const run = (wrongKeys, size, pickFrom = items) =>
          buildQuizPool(pickFrom, wrongKeys, "word", size);
        return {
          share: REVIEW_SHARE,
          bigQueue: run(wrong, 10).map((v) => v.word),
          // Nothing fresh left to pull: review spills past the cap rather than
          // leaving the round short.
          nothingFresh: run(wrong.slice(0, 8), 8, items.slice(0, 8)).map((v) => v.word),
          wrong,
        };
      });
      const cap = Math.max(1, Math.round(10 * pools.share));
      const reviewed = pools.bigQueue.filter((w) => pools.wrong.includes(w)).length;
      assert(
        pools.bigQueue.length === 10,
        `a round stays full with an oversized review queue (got ${pools.bigQueue.length})`
      );
      assert(
        reviewed === cap,
        `at most half a round is review, so today's new words still come up (got ${reviewed} of 10, cap ${cap})`
      );
      assert(
        new Set(pools.bigQueue).size === 10,
        "a round never repeats an item"
      );
      assert(
        pools.nothingFresh.length === 8 && new Set(pools.nothingFresh).size === 8,
        `with no fresh items left the round fills from review instead of running short (got ${pools.nothingFresh.length})`
      );
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
