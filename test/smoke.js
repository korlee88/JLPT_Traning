// Headless-browser smoke test for the static site. Run with `npm test`.
// Starts a local static server, drives the app with Playwright, and asserts
// the core flows work: the topbar, both quizzes,
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

// Clicks the choice whose text is exactly `text`. Playwright's hasText is a
// substring match, which picked the wrong button whenever one choice contained
// another — vocab.json has 정하다 (決める) and 다정하다/친절하다, so a round drawing
// both answered the question wrong and the failure blamed the review queue.
async function clickChoice(page, text) {
  const i = await page.evaluate(
    (want) => [...document.querySelectorAll("#quiz-choices .choice-btn")]
      .findIndex((b) => b.textContent === want),
    text
  );
  assert(i >= 0, `the choice "${text}" is on screen to click`);
  await page.locator("#quiz-choices .choice-btn").nth(i).click();
}

// The Leitner box an item sits in, or null when the schedule has never seen it.
// Box 0 means "missed, due today"; any box above 0 means a correct recall was
// credited and the next sighting is days out.
async function boxOf(page, type, key) {
  return page.evaluate(
    ([t, k]) => {
      const raw = JSON.parse(localStorage.getItem("jlpt_review_n4") || "null");
      const e = raw && raw.types && raw.types[t] && raw.types[t][k];
      return e ? e.box : null;
    },
    [type, key]
  );
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

    // --- Core flow: topbar / quizzes ---
    {
      const page = await browser.newPage();
      const consoleErrors = [];
      page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
      page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));

      await withFixedDate(page, plan.weeks[2].start); // safely mid-plan, avoids boundary flakiness
      await page.goto(URL, { waitUntil: "networkidle" });
      await page.waitForSelector("#today-task");

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

      // plan.json is prefetched in the head so the topbar's line doesn't wait a
      // round trip behind app.js. The href spells the level out, which the app
      // otherwise keeps in one place — so check it against CURRENT_LEVEL rather
      // than letting a level switch leave a prefetch pointing at the old folder.
      const prefetched = await page.$$eval('link[rel="prefetch"]', (els) => els.map((e) => e.getAttribute("href")));
      const level = await page.evaluate(() => CURRENT_LEVEL);
      assert(
        prefetched.includes(`data/${level}/plan.json`),
        `the head prefetches the active level's plan.json (CURRENT_LEVEL is ${level}, head has ${prefetched.join(", ") || "nothing"})`
      );
      for (const href of prefetched) {
        assert(!href.includes("?v="), `a prefetched data file carries no cache-busting query (got "${href}")`);
      }

      for (const sel of ["#quiz-prompt", "#quiz-reveal", "#quiz-meaning", "#quiz-choices", "#quiz-note"]) {
        const lang = await page.getAttribute(sel, "lang");
        assert(lang === "ja", `${sel} is marked lang="ja" so kanji use Japanese glyph shapes (got "${lang}")`);
      }

      // Two tabs since 2026-10-17 (the plan reaches the screen as the topbar
      // line), plus 모의고사 from 2026-10-22. Three is the most that fits one
      // phone row at 390px, which is why the count is pinned and not just the
      // names — a fourth would wrap and the row would be 3+1.
      const tabs = await page.$$eval(".tab-btn", (els) => els.map((e) => e.textContent));
      assert(
        tabs.join(" | ") === "쪽지시험 | 한자 기초 | 모의고사",
        `only the tabs that get used are there (got "${tabs.join(" | ")}")`
      );
      const rows = await page.evaluate(
        () => new Set([...document.querySelectorAll(".tab-btn")].map((b) => b.getBoundingClientRect().top)).size
      );
      assert(rows === 1, `the tab row still fits one line on a phone (${rows} rows)`);
      assert(await page.isVisible("#quiz-start"), "쪽지시험 is the tab that opens");
      const topLine = (await page.textContent("#today-task")).trim();
      assert(topLine.length > 0, "the topbar still says what to do today");

      // Runs one full 10-question round for `startButtonId`, calling `onFirstQuestion`
      // (if given) after the first question renders but before answering it, and
      // `onFirstAnswer` right after that first answer is submitted. Ends back at the
      // quiz list screen via "쪽지시험 목록으로", and checks that button now shows
      // today's completion badge.
      // Questions expected per round, mirroring QUIZ_ROUND_SIZE/DEFAULT_ROUND_SIZE
      // in app.js. A round is also capped at the data file's size, which is what
      // used to hold 독해 to 8; reading.json passed 10 entries on 2026-10-05, so
      // every type now runs its full configured length.
      // Every type is at DEFAULT_ROUND_SIZE; listed one by one anyway so a
      // per-type override can't be added without this file noticing.
      const EXPECTED_ROUND_SIZE = {
        "#start-hiragana": 5,
        "#start-katakana": 5,
        "#start-loanword": 5,
        "#start-kanji": 5,
        "#start-vocab": 5,
        "#start-grammar": 5,
        "#start-reading": 5,
        "#start-listening": 5,
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


      await page.click('.tab-btn[data-tab="quiz"]');
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
        await page.waitForSelector("#quiz-choices .choice-btn");
        // Read the length off the page rather than hardcoding it — this loop sat
        // at a stale 20 when the round shrank to 10, and the failure it produced
        // (clicking a disabled button on the result screen) said nothing about why.
        const kanaRound = await page.evaluate(() => quiz.pool.length);
        for (let i = 0; i < kanaRound; i++) {
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
      await runQuizRound("#start-grammar", null, async () => {
        assert(!(await page.isVisible("#quiz-reveal")), "reading cue stays hidden in quiz types that don't wire it (grammar)");
        assert(await page.isVisible("#quiz-note"), "grammar quiz shows an explanation note after answering");
      });

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
          // The reading line is not wired on this quiz type at all — revealing
          // it would be revealing the answer.
          assert(
            await page.isHidden("#quiz-reveal"),
            "kanji quiz offers no reading reveal, the one hint that would be its own answer"
          );
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

          // Tapping the big glyph opens that same 뜻 힌트 — asserted in the
          // block below, on a question whose hint is still closed.
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

      const nextDay = addDaysToDateStr(plan.weeks[2].start, 1);
      await withFixedDate(page, nextDay);
      await page.reload({ waitUntil: "networkidle" });
      await page.click('.tab-btn[data-tab="quiz"]');
      const vocabBtnTextNextDay = await page.textContent("#start-vocab");
      assert(!vocabBtnTextNextDay.startsWith("✓"), `completion badge resets on a new day (got "${vocabBtnTextNextDay}")`);

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

      // Read off the page, never hardcoded — this block sat at 10 when the round
      // became 5 and spent its last iterations clicking a disabled button on the
      // result screen, a timeout that says nothing about the cause.
      const roundLen = await page.evaluate(() => quiz.pool.length);
      const missed = [];
      for (let i = 0; i < roundLen; i++) {
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
      for (let i = 0; i < roundLen; i++) {
        await page.waitForSelector("#quiz-choices .choice-btn");
        seen.push(await page.textContent("#quiz-prompt"));
        await page.locator("#quiz-choices .choice-btn").first().click();
        await page.click("#quiz-next");
      }
      // Review items are prioritized, but only up to REVIEW_SHARE of the round —
      // asserting one *specific* missed word comes back would be flaky now that
      // random clicking misses more than the cap. The count is exact: fresh items
      // are by definition not in the wrong set, so nothing else can inflate it.
      // floor, matching buildQuizPool — with Math.round an odd round size would
      // expect 3 of 5 here while the app gives 2.
      const cap = await page.evaluate(
        (n) => Math.max(1, Math.floor(n * REVIEW_SHARE)),
        roundLen
      );
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
      for (const sel of [".radical-glyph", ".kanji-glyph", ".kanji-note", ".kanji-words"]) {
        const tagged = await page.$$eval(sel, (els) => els.every((e) => e.lang === "ja"));
        assert(tagged, `${sel} is marked lang="ja"`);
      }
      const expectedGroups = Object.keys(groups).length;
      const expectedChars = Object.values(groups).reduce((n, g) => n + g.chars.length, 0);
      const cards = await page.$$eval("#radical-groups .card", (e) => e.length);
      const glyphs = await page.$$eval(".kanji-glyph", (e) => e.map((b) => b.textContent));
      assert(cards === expectedGroups, `한자 기초 renders one card per radical group (got ${cards}, expected ${expectedGroups})`);
      assert(glyphs.length === expectedChars, `한자 기초 renders every group member (got ${glyphs.length}, expected ${expectedChars})`);
      assert(
        glyphs.every((c) => Object.values(groups).some((g) => g.chars.includes(c))),
        "every glyph is a character radical.json actually lists"
      );

      // Every character carries its 뜻 and what it is built from, straight from
      // kanjichar.json — checked against the file, not against hardcoded text.
      const chars = JSON.parse(fs.readFileSync(path.join(ROOT, "data/n4/kanjichar.json"), "utf8"));
      const rendered = await page.$$eval(".kanji-row", (rows) =>
        rows.map((r) => ({
          char: r.dataset.char,
          sense: r.querySelector(".kanji-sense").textContent.trim(),
          note: r.querySelector(".kanji-note").textContent.trim(),
        }))
      );
      const badRow = rendered.find(
        (r) => !chars[r.char] || r.sense !== chars[r.char].meaning || r.note !== chars[r.char].note
      );
      assert(
        !badRow,
        `every character shows its 뜻 and composition note from the data (first mismatch: ${JSON.stringify(badRow)})`
      );

      // Tapping a character opens the words it appears in.
      const probe = glyphs.includes("港") ? "港" : glyphs[0];
      const rowFor = (c) => page.locator(`.kanji-row[data-char="${c}"]`);
      await rowFor(probe).locator(".kanji-glyph").click();
      const shown = (await rowFor(probe).locator(".kanji-words").textContent()).trim();
      assert(await rowFor(probe).locator(".kanji-words").isVisible(), `tapping ${probe} opens its word list`);
      assert(
        /\([\u3040-\u309F]/.test(shown),
        `한자 기초 word list carries readings, not just meanings (got "${shown}")`
      );
      // Tapping the same glyph again closes it.
      await rowFor(probe).locator(".kanji-glyph").click();
      assert(
        !(await rowFor(probe).locator(".kanji-words").isVisible()),
        "tapping the same character again closes the word list"
      );

      // 가리기: the flashcard side of the tab.
      const sense0 = page.locator(".kanji-row").first().locator(".kanji-sense");
      assert(await sense0.isVisible(), "the 뜻 is visible before 가리기 is turned on");
      await page.click("#radical-mask");
      assert(!(await sense0.isVisible()), "가리기 covers the 뜻");
      assert(
        (await page.textContent("#radical-mask")).includes("뜻 보기"),
        "the button says how to turn 가리기 back off"
      );
      await page.locator(".kanji-row").first().locator(".kanji-glyph").click();
      assert(await sense0.isVisible(), "tapping a covered character turns that one card over");
      const stillCovered = page.locator(".kanji-row").nth(1).locator(".kanji-sense");
      assert(!(await stillCovered.isVisible()), "the rest stay covered");
      await page.click("#radical-mask");
      assert(await stillCovered.isVisible(), "turning 가리기 off shows everything again");
      assert(errs.length === 0, `한자 기초 tab renders with no console errors (got ${JSON.stringify(errs)})`);
      await page.close();
    }

    // --- kanjichar.json covers radical.json exactly ---
    // The tab renders one row per character in radical.json; a character with no
    // entry would render a blank 뜻 and a blank note rather than fail, so the
    // coverage is checked here instead of waiting to be noticed on screen.
    {
      const groups = JSON.parse(fs.readFileSync(path.join(ROOT, "data/n4/radical.json"), "utf8"));
      const chars = JSON.parse(fs.readFileSync(path.join(ROOT, "data/n4/kanjichar.json"), "utf8"));
      const listed = Object.values(groups).flatMap((g) => g.chars);
      const missing = listed.filter((c) => !chars[c]);
      const extra = Object.keys(chars).filter((c) => !listed.includes(c));
      assert(missing.length === 0, `every 부수 group member has a 뜻 and a note (missing: ${missing.join(" ")})`);
      assert(extra.length === 0, `no entry for a character the groups don't list (extra: ${extra.join(" ")})`);
      const thin = Object.entries(chars).filter(
        ([, e]) => !e.meaning || !e.meaning.trim() || !e.note || e.note.length < 10
      );
      assert(thin.length === 0, `no placeholder entries (thin: ${thin.map(([c]) => c).join(" ")})`);
      // Two characters sharing a 뜻 means one was pasted onto the wrong row.
      const senses = Object.values(chars).map((e) => e.meaning);
      assert(
        new Set(senses).size === senses.length,
        `no two characters share a 뜻 (${senses.length - new Set(senses).size} duplicated)`
      );
      // A note earns its place by saying either what the character is built from
      // (a component named with its gloss, so a paren) or what shape it draws —
      // the radicals themselves and the pictographs are the second kind. A note
      // that does neither is a restatement of the 뜻, which teaches nothing.
      // A "(소리)" label may only appear as "(소리 → カタカナ)". Bare, it was a
      // false lead half the time: 海 carries 毎, and the data's own 毎日(まいにち)
      // invites まい where 海 is かい; 空 carries 工 with 工場(こうじょう) beside it
      // where 空 is くう. The arrow form claims the reading really does carry over
      // (先 セン → 洗 セン), which is the one fact a 한자 읽기 quiz can use.
      const bareSound = Object.entries(chars).filter(([, e]) => /소리[)）]/.test(e.note));
      assert(
        bareSound.length === 0,
        `a 소리 label says which reading it gives (bare: ${bareSound.map(([c]) => c).join(" ")})`
      );
      const claims = Object.entries(chars)
        .map(([c, e]) => [c, (e.note.match(/소리 → ([\u30A0-\u30FF]+)\)/) || [])[1]])
        .filter(([, kana]) => kana);
      assert(claims.length >= 25, `the carried readings are a real set, not a token few (${claims.length})`);
      // Hand-verified like radical.json, but grounded where the data can ground
      // it: the claimed reading must show up in a word the app itself teaches.
      // Not every one can — 捨/シャ has only 捨てる in the files — so this asserts
      // the attested share rather than demanding all of them.
      const kanjiWords = JSON.parse(fs.readFileSync(path.join(ROOT, "data/n4/kanji.json"), "utf8"));
      const vocabWords = JSON.parse(fs.readFileSync(path.join(ROOT, "data/n4/vocab.json"), "utf8"));
      const toHira = (k) => k.replace(/[\u30A1-\u30F6]/g, (m) => String.fromCharCode(m.charCodeAt(0) - 0x60));
      const attested = claims.filter(([c, kana]) =>
        [...kanjiWords, ...vocabWords].some((w) => w.word.includes(c) && w.reading.includes(toHira(kana)))
      );
      assert(
        attested.length >= 8,
        `most carried readings are visible in the app's own words (${attested.length} of ${claims.length}: ${attested.map(([c]) => c).join("")})`
      );

      const noParts = Object.entries(chars).filter(
        ([, e]) => !/[(（]/.test(e.note) && !e.note.includes("모양")
      );
      assert(
        noParts.length === 0,
        `every note names a component or describes the shape (bare: ${noParts.map(([c]) => c).join(" ")})`
      );

      // --- kun / on: the Japanese the 쓰기 연습 prompts with ---
      // 훈독 in hiragana (with its okurigana in parens, the way a dictionary
      // prints it), 음독 in katakana, so the two kinds are told apart on screen
      // without a label. A character may legitimately have no common 훈독 at
      // this level (社, 電, 週) but never neither.
      const hira = /^[\u3041-\u3096()]+$/;
      const kata = /^[\u30A1-\u30FA]+$/;
      const badReading = Object.entries(chars).filter(([, e]) => {
        const kun = e.kun || [];
        const on = e.on || [];
        if (kun.length + on.length === 0) return true;
        return !kun.every((r) => hira.test(r)) || !on.every((r) => kata.test(r));
      });
      assert(
        badReading.length === 0,
        `every character carries 훈독 in hiragana and 음독 in katakana (bad: ${badReading.map(([c]) => c).join(" ")})`
      );
      // Same bar as the 소리 claims above and for the same reason — these are
      // dictionary facts, so they are checked against the words the app itself
      // teaches wherever it has one. 達 is the kind that cannot be: the only
      // word carrying it is 友達(ともだち), where だち is not its タツ.
      const readingAttested = Object.entries(chars).filter(([c, e]) => {
        const forms = [...(e.kun || []).map((r) => r.split("(")[0]), ...(e.on || []).map(toHira)];
        return [...kanjiWords, ...vocabWords].some(
          (w) => w.word.includes(c) && forms.some((f) => f && w.reading.includes(f))
        );
      });
      assert(
        readingAttested.length >= 100,
        `the readings are visible in the app's own words (${readingAttested.length} of ${Object.keys(chars).length})`
      );

      // --- freq: how much of the N4 material actually uses the character ---
      // The 쓰기 연습 weights its five cards by this, so a stale number quietly
      // spends the round on the wrong characters. Recomputed here from the whole
      // corpus; the check is that the ordering still holds at the top rather than
      // exact equality, because every daily 기출 batch shifts the counts a little
      // and breaking the suite on that would be friction for nothing.
      {
        const corpus = [];
        for (const w of [...kanjiWords, ...vocabWords]) corpus.push(w.word);
        for (const e of JSON.parse(fs.readFileSync(path.join(ROOT, "data/n4/reading.json"), "utf8")))
          corpus.push(e.passage + e.question);
        for (const e of JSON.parse(fs.readFileSync(path.join(ROOT, "data/n4/grammar.json"), "utf8")))
          corpus.push(e.sentence.replace(/（[^）]*）/g, ""));
        for (const e of JSON.parse(fs.readFileSync(path.join(ROOT, "data/n4/listening.json"), "utf8")))
          corpus.push(e.script);
        for (const arr of Object.values(JSON.parse(fs.readFileSync(path.join(ROOT, "data/n4/exam.json"), "utf8"))))
          for (const e of arr) corpus.push(JSON.stringify(e));
        const text = corpus.join("");
        const live = Object.fromEntries(
          Object.keys(chars).map((c) => [c, (text.match(new RegExp(c, "g")) || []).length])
        );
        const noFreq = Object.entries(chars).filter(([, e]) => !Number.isInteger(e.freq) || e.freq < 1);
        assert(
          noFreq.length === 0,
          `every character carries a positive freq (bad: ${noFreq.map(([c]) => c).join(" ")})`
        );
        const byStored = Object.keys(chars).sort((a, b) => chars[b].freq - chars[a].freq);
        const liveTop = new Set(Object.keys(live).sort((a, b) => live[b] - live[a]).slice(0, 20));
        const drifted = byStored.slice(0, 10).filter((c) => !liveTop.has(c));
        assert(
          drifted.length === 0,
          `the stored freq still ranks the corpus (stale: ${drifted.map((c) => `${c} stored ${chars[c].freq} live ${live[c]}`).join(", ")})`
        );
      }
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
      await clickChoice(page, probe.reading);
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
    // The 단어 quiz asks for the meaning, so the reading is a hint rather than
    // the answer. No hint in the app costs the review credit any more — the 한자
    // quiz's reading reveal, the one that did, is gone (see the block below).
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
      await clickChoice(page, item.meaning);
      const vocabBox = await boxOf(page, "vocab", item.word);
      assert(
        vocabBox !== null && vocabBox > 0,
        `a peeked vocab reading still counts as recall when answered right (${item.word} is in box ${vocabBox}, expected above 0)`
      );
      await page.close();
    }

    // --- The 한자 quiz's hint is the 뜻, and never the reading it asks for ---
    // It used to reveal the reading on tap, which is the answer to the question
    // on screen (2026-10-24, "힌트가 답이야"). The reading must now be nowhere
    // above the choices however much of the card is tapped — and because the
    // remaining hint is not the answer, using it credits a right answer in full.
    {
      const page = await browser.newPage();
      await page.goto(URL, { waitUntil: "networkidle" });
      await page.evaluate(() => localStorage.clear());
      await page.reload({ waitUntil: "networkidle" });
      await page.click('.tab-btn[data-tab="quiz"]');
      await page.click("#start-kanji");
      await page.waitForSelector("#quiz-choices .choice-btn");

      const item = await page.evaluate(() => quiz.pool[quiz.index]);
      await page.click("#quiz-prompt");
      const hinted = (await page.textContent("#quiz-meaning")).trim();
      assert(
        hinted === `뜻: ${item.meaning}`,
        `tapping the kanji shows its meaning (got "${hinted}", expected "뜻: ${item.meaning}")`
      );
      // Every line of the question card except the choices, which legitimately
      // carry the reading as one of the four.
      const above = await page.evaluate(() =>
        ["quiz-prompt", "quiz-reveal", "quiz-meaning", "quiz-hint", "quiz-hint-ko"]
          .map((id) => document.getElementById(id))
          .filter((el) => el && !el.hidden)
          .map((el) => el.textContent)
          .join(" | ")
      );
      assert(
        !above.includes(item.reading),
        `the 한자 quiz shows no reading above the choices (${item.word} asks for ${item.reading}; card reads "${above}")`
      );
      await clickChoice(page, item.reading);
      const box = await boxOf(page, "kanji", item.word);
      assert(
        box !== null && box > 0,
        `using the 뜻 힌트 still counts as recall when answered right (${item.word} is in box ${box}, expected above 0)`
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

    // --- 독해 questions carry a Korean translation, shown with the question ---
    // The furigana only covers the passage (`ruby`), so the question line stayed
    // unreadable and stopped the exercise before it started. Unlike the 한자
    // quiz's 뜻 힌트 this is not behind a tap: the question is not what 독해 tests.
    {
      const page = await browser.newPage({ viewport: PHONE });
      await page.goto(URL, { waitUntil: "networkidle" });
      const q = await page.evaluate(async () => {
        const all = await fetch("data/n4/reading.json").then((x) => x.json());
        const bad = [];
        for (const e of all) {
          const head = e.question.slice(0, 14);
          if (!e.questionTranslation || !e.questionTranslation.trim()) {
            bad.push(`${head}: no translation`);
            continue;
          }
          // 「それ」 quotes the Japanese word the question is about; every other
          // translation has to be free of Japanese, the bar `translation` clears.
          const ja = /[\u3040-\u30FF\u4E00-\u9FFF]/.test(e.questionTranslation);
          if (ja && !e.questionTranslation.includes("それ")) {
            bad.push(`${head}: Japanese left in the translation`);
          }
        }
        const uniq = new Set(all.map((e) => e.questionTranslation));
        return { total: all.length, bad, uniq: uniq.size };
      });
      assert(
        q.bad.length === 0,
        `every 독해 question has a Korean translation with no Japanese left in it (${q.bad.length} bad of ${q.total}: ${q.bad.slice(0, 3).join(" | ")})`
      );
      assert(
        q.uniq === q.total,
        `no two questions share a translation, which would mean one was pasted onto the wrong entry (${q.uniq} distinct of ${q.total})`
      );

      await page.click('.tab-btn[data-tab="quiz"]');
      await page.click("#start-reading");
      await page.waitForSelector("#quiz-choices .choice-btn");
      const item = await page.evaluate(() => quiz.pool[quiz.index]);
      assert(
        (await page.textContent("#quiz-hint")).trim() === item.question,
        "the Japanese question still leads"
      );
      assert(
        (await page.textContent("#quiz-hint-ko")).trim() === item.questionTranslation,
        `the Korean question shows under it (expected "${item.questionTranslation}")`
      );
      assert(await page.isVisible("#quiz-hint-ko"), "the Korean question is visible before answering");
      await page.close();
    }

    // --- The Korean question line belongs to 독해 alone ---
    {
      for (const type of ["kanji", "grammar", "listening"]) {
        const page = await browser.newPage({ viewport: PHONE });
        await page.goto(URL, { waitUntil: "networkidle" });
        await page.click('.tab-btn[data-tab="quiz"]');
        await page.click(`#start-${type}`);
        await page.waitForSelector("#quiz-choices .choice-btn");
        assert(
          !(await page.isVisible("#quiz-hint-ko")),
          `${type}: no Korean question line`
        );
        await page.close();
      }
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

      // No cue line any more — the dotted underline is the affordance, and the
      // owner knows it ("이건 내가 알고 있으니 삭제해줘", 2026-10-17).
      assert(
        !(await page.isVisible("#quiz-reveal")),
        `the reveal line stays off until something is tapped (got "${(await page.textContent("#quiz-reveal")).trim()}")`
      );

      const first = await page.evaluate(() => {
        const m = [...quiz.pool[quiz.index].ruby.matchAll(/([\u4E00-\u9FFF]+)（([\u3040-\u309F]+)）/gu)][0];
        return { word: m[1], reading: m[2], gloss: glossFor(m[1], m[2]) };
      });
      await page.locator("#quiz-prompt .ruby-word").first().click();
      const revealed = (await page.textContent("#quiz-reveal")).trim();
      // The meaning rides along only when the data knows that exact word; the
      // reading alone is the honest fallback, never a guessed dictionary form.
      const wantReveal = first.gloss
        ? `${first.word} → ${first.reading} · ${first.gloss}`
        : `${first.word} → ${first.reading}`;
      assert(
        revealed === wantReveal,
        `tapping a word shows its reading, and its meaning when known (expected "${wantReveal}", got "${revealed}")`
      );

      // Reading a word is not the 독해 answer, so the tap is free — like every
      // other hint in the app now that the 한자 reading reveal is gone.
      await clickChoice(page, item.answer);
      const readingBox = await boxOf(page, "reading", item.passage);
      assert(
        readingBox !== null && readingBox > 0,
        `a tapped reading still counts as recall when answered right (box ${readingBox}, expected above 0)`
      );
      await page.close();
    }

    // --- A tapped 독해 word shows its meaning when the data has that word ---
    // A random passage may draw only single characters mid-inflection, which
    // glossFor deliberately does not guess at, so this forces a passage holding
    // a word that kanji.json/vocab.json carry outright.
    {
      const page = await browser.newPage({ viewport: PHONE });
      await page.goto(URL, { waitUntil: "networkidle" });
      await page.click('.tab-btn[data-tab="quiz"]');
      await page.click("#start-reading");
      await page.waitForSelector("#quiz-choices .choice-btn");
      const picked = await page.evaluate(async () => {
        const all = await fetch("data/n4/reading.json").then((r) => r.json());
        const RE = /([\u4E00-\u9FFF]+)（([\u3040-\u309F]+)）/gu;
        for (const e of all) {
          for (const m of e.ruby.matchAll(RE)) {
            if (glossFor(m[1], m[2])) {
              quiz.pool = [e];
              quiz.index = 0;
              renderQuestion();
              return { word: m[1], reading: m[2], gloss: glossFor(m[1], m[2]) };
            }
          }
        }
        return null;
      });
      assert(picked, "at least one 독해 word resolves to a meaning");
      const idx = await page.evaluate(
        (w) => [...document.querySelectorAll("#quiz-prompt .ruby-word")].findIndex((s) => s.textContent === w),
        picked.word
      );
      await page.locator("#quiz-prompt .ruby-word").nth(idx).click();
      const line = (await page.textContent("#quiz-reveal")).trim();
      assert(
        line === `${picked.word} → ${picked.reading} · ${picked.gloss}`,
        `the tap line carries reading and meaning (expected "${picked.word} → ${picked.reading} · ${picked.gloss}", got "${line}")`
      );
      await page.close();
    }

    // --- Every tappable run in 독해 and 문법 resolves to a meaning ---
    // The tap used to answer with a reading and nothing else on 83% of 독해 runs,
    // which from the owner's side looked like the feature had not shipped at all
    // (2026-10-17). gloss.json closes that, and the gap can only stay closed if
    // the whole corpus is checked rather than whichever run a round draws.
    {
      const page = await browser.newPage({ viewport: PHONE });
      await page.goto(URL, { waitUntil: "networkidle" });
      const cover = await page.evaluate(async () => {
        await Promise.all([buildXrefIndex(), buildGloss()]);
        const RE = /([\u4E00-\u9FFF]+)（([\u3040-\u309F]+)）/gu;
        const out = { reading: { total: 0, bad: [] }, grammar: { total: 0, bad: [] } };
        const walk = async (file, field, bucket) => {
          const all = await fetch(`data/n4/${file}`).then((r) => r.json());
          for (const e of all) {
            for (const m of e[field].matchAll(RE)) {
              out[bucket].total++;
              if (!glossFor(m[1], m[2])) out[bucket].bad.push(`${m[1]}（${m[2]}）`);
            }
          }
        };
        await walk("reading.json", "ruby", "reading");
        await walk("grammar.json", "sentence", "grammar");
        return out;
      });
      for (const [kind, r] of Object.entries(cover)) {
        assert(
          r.bad.length === 0,
          `every tappable ${kind} run has a meaning (${r.bad.length} of ${r.total} without: ${[...new Set(r.bad)].slice(0, 6).join(" ")})`
        );
        assert(r.total > 200, `${kind} really has runs to check (got ${r.total})`);
      }
      await page.close();
    }

    // --- A run with two readings gets the meaning of the right one ---
    // 行（い）is 가다 and 行（おこな）is 행하다; keying the glossary by the run
    // alone would have printed one of those on both.
    {
      const page = await browser.newPage({ viewport: PHONE });
      await page.goto(URL, { waitUntil: "networkidle" });
      const split = await page.evaluate(async () => {
        const gloss = await buildGloss();
        await buildXrefIndex();
        const multi = Object.entries(gloss).filter(([, m]) => Object.keys(m).length > 1);
        return {
          count: multi.length,
          sample: multi.slice(0, 3).map(([run, m]) => ({ run, readings: m })),
          iku: glossFor("行", "い"),
          okonau: glossFor("行", "おこな"),
        };
      });
      assert(split.count >= 15, `the glossary distinguishes readings on many runs (got ${split.count})`);
      assert(
        split.iku !== split.okonau && /가다/.test(split.iku) && /행하/.test(split.okonau),
        `行 reads as 가다 or 행하다 depending on the reading (got "${split.iku}" / "${split.okonau}")`
      );
      // Every multi-reading run must give a *different* meaning per reading, or
      // the split is doing nothing and one of them is wrong.
      const sameness = await page.evaluate(async () => {
        const gloss = await buildGloss();
        return Object.entries(gloss)
          .filter(([, m]) => Object.keys(m).length > 1)
          .filter(([, m]) => new Set(Object.values(m)).size !== Object.keys(m).length)
          .map(([run]) => run);
      });
      assert(
        sameness.length <= 2,
        `a run with two readings should mean two things (same on: ${sameness.join(" ")})`
      );
      await page.close();
    }

    // --- 문법 words are tappable too ---
    {
      const page = await browser.newPage({ viewport: PHONE });
      await page.goto(URL, { waitUntil: "networkidle" });
      await page.click("#start-grammar");
      await page.waitForSelector("#quiz-choices .choice-btn");
      assert(
        !(await page.isVisible("#quiz-reveal")),
        "the 문법 reveal line stays off until something is tapped"
      );
      const taps = await page.locator("#quiz-prompt .ruby-word").count();
      assert(taps > 0, `the 문법 sentence offers tappable words (got ${taps})`);
      // The furigana stays on screen here, unlike 독해 — it is the only reading
      // support the sentence has, so the span keeps the parens.
      const shownText = await page.textContent("#quiz-prompt");
      const sentence = await page.evaluate(() => quiz.pool[quiz.index].sentence);
      assert(shownText === sentence, "the 문법 sentence still renders with its furigana");
      const want = await page.evaluate(() => {
        const m = [...quiz.pool[quiz.index].sentence.matchAll(/([\u4E00-\u9FFF]+)（([\u3040-\u309F]+)）/gu)][0];
        const g = glossFor(m[1], m[2]);
        return g ? `${m[1]} → ${m[2]} · ${g}` : `${m[1]} → ${m[2]}`;
      });
      await page.locator("#quiz-prompt .ruby-word").first().click();
      const got = (await page.textContent("#quiz-reveal")).trim();
      assert(got === want, `tapping a 문법 word shows its reading and meaning (expected "${want}", got "${got}")`);
      await page.close();
    }

    // --- Grammar chunks are tappable, over the whole corpus ---
    // Asked for on 2026-10-18 from a screenshot of Chrome's text-selection
    // toolbar: the owner had long-pressed ました and the browser offered to
    // search the web for it, because only kanji runs were tap targets. This
    // renders every 독해 passage and every 문법 sentence rather than whichever a
    // round draws, and asserts three things the data can silently lose:
    //   - the chunker puts back exactly the text it was given (no dropped or
    //     doubled character), the same bar stripRuby(ruby) === passage clears;
    //   - every chunk in pattern.json fires somewhere, so a dead entry can't
    //     accumulate — the file is hand-verified in context, like radical.json;
    //   - no chunk starts inside a blocked string. Those three are the places a
    //     match would teach something false: 分からない would gloss から as the
    //     particle, 私のではありません would gloss ので as the reason, and
    //     寒くないです would gloss ないで as "~하지 말고".
    {
      const page = await browser.newPage({ viewport: PHONE });
      await page.goto(URL, { waitUntil: "networkidle" });
      const sweep = await page.evaluate(async () => {
        await Promise.all([buildXrefIndex(), buildGloss(), buildPatterns()]);
        const file = await fetch("data/n4/pattern.json").then((r) => r.json());
        const prompt = document.getElementById("quiz-prompt");
        const out = { chunks: 0, used: {}, mismatch: [], inBlocked: [], blockedSeen: {}, entries: 0 };
        const walk = async (name, field, render) => {
          const all = await fetch(`data/n4/${name}`).then((r) => r.json());
          for (const e of all) {
            out.entries++;
            render(e);
            const text = prompt.textContent;
            if (text !== e[field]) out.mismatch.push(e[field].slice(0, 20));
            const starts = new Set();
            let off = 0;
            for (const node of prompt.childNodes) {
              if (node.nodeType === 1 && node.classList.contains("gram-chunk")) {
                starts.add(off);
                out.chunks++;
                out.used[node.textContent] = (out.used[node.textContent] || 0) + 1;
              }
              off += node.textContent.length;
            }
            for (const b of file.blocked) {
              for (let i = text.indexOf(b); i >= 0; i = text.indexOf(b, i + 1)) {
                out.blockedSeen[b] = (out.blockedSeen[b] || 0) + 1;
                if (starts.has(i)) out.inBlocked.push(`${b} in ${text.slice(0, 16)}`);
              }
            }
          }
        };
        await walk("reading.json", "passage", (e) =>
          renderRubyPassage(prompt, e, document.getElementById("quiz-reveal"))
        );
        await walk("grammar.json", "sentence", (e) =>
          renderGlossedSentence(prompt, e.sentence, document.getElementById("quiz-reveal"))
        );
        out.unused = Object.keys(file.chunks).filter((k) => !out.used[k]);
        out.deadBlocks = file.blocked.filter((b) => !out.blockedSeen[b]);
        out.total = Object.keys(file.chunks).length;
        return out;
      });
      assert(
        sweep.mismatch.length === 0,
        `chunking a passage puts back the same text (${sweep.mismatch.length} changed: ${sweep.mismatch.slice(0, 3).join(" | ")})`
      );
      assert(sweep.entries > 170, `the sweep really walked both files (${sweep.entries} entries)`);
      assert(
        sweep.unused.length === 0,
        `every chunk in pattern.json is one the corpus actually uses (dead: ${sweep.unused.join(" ")})`
      );
      assert(
        sweep.deadBlocks.length === 0,
        `every blocked string is one the corpus actually contains (dead: ${sweep.deadBlocks.join(" ")})`
      );
      assert(
        sweep.inBlocked.length === 0,
        `no chunk starts inside a blocked string (${sweep.inBlocked.slice(0, 3).join(" | ")})`
      );
      assert(
        sweep.chunks > 600,
        `the chunks fire across the corpus, not on a handful of entries (${sweep.chunks} spans over ${sweep.total} patterns)`
      );
      await page.close();
    }

    // --- Tapping a grammar chunk explains it, in 독해 and in 문법 ---
    // Free, like every hint in the app: neither 독해 nor 문법 asks what ました
    // means.
    {
      for (const [type, btn] of [["reading", "#start-reading"], ["grammar", "#start-grammar"]]) {
        const page = await browser.newPage({ viewport: PHONE });
        await page.goto(URL, { waitUntil: "networkidle" });
        await page.click('.tab-btn[data-tab="quiz"]');
        await page.click(btn);
        await page.waitForSelector("#quiz-choices .choice-btn");
        // 5 of the 89 문법 sentences put the whole ending in the blank
        // (明日、雨が降る＿＿＿。), so the chunk is in the *answer* and the
        // sentence really has none. A round drawing one is about 1 in 18, which
        // is exactly how this failed once it had run enough times. Force an
        // entry that has a chunk, the way the 독해 gloss and 부수 blocks already
        // force theirs rather than trusting the draw.
        const picked = await page.evaluate(() => {
          for (const item of quiz.allItems) {
            quiz.pool = [item];
            quiz.index = 0;
            renderQuestion();
            if (document.querySelector("#quiz-prompt .gram-chunk")) return true;
          }
          return false;
        });
        assert(picked, `${type} has an entry carrying a tappable grammar chunk`);
        const n = await page.locator("#quiz-prompt .gram-chunk").count();
        assert(n > 0, `the ${type} prompt offers tappable grammar chunks (got ${n})`);
        const want = await page.evaluate(() => {
          const el = document.querySelector("#quiz-prompt .gram-chunk");
          return `${el.textContent} → ${_patterns[el.textContent]}`;
        });
        await page.locator("#quiz-prompt .gram-chunk").first().click();
        const got = (await page.textContent("#quiz-reveal")).trim();
        assert(got === want, `tapping a chunk explains it (expected "${want}", got "${got}")`);
        const item = await page.evaluate(() => quiz.pool[quiz.index]);
        await clickChoice(page, item.answer);
        const key = type === "reading" ? item.passage : item.sentence;
        const box = await boxOf(page, type, key);
        assert(box !== null && box > 0, `a tapped chunk still counts as recall (box ${box})`);
        await page.close();
      }
    }

    // --- The chunk explanation never pushes the choices off a phone screen ---
    // The reveal line is 1.5rem and the longest explanation runs three lines on
    // top of a 독해 passage, which is the one combination that could bury the
    // answers. Measured at 390x844 against the longest line the data can show.
    {
      const page = await browser.newPage({ viewport: PHONE });
      await page.goto(URL, { waitUntil: "networkidle" });
      await page.click('.tab-btn[data-tab="quiz"]');
      await page.click("#start-reading");
      await page.waitForSelector("#quiz-choices .choice-btn");
      const worst = await page.evaluate(async () => {
        const all = await fetch("data/n4/reading.json").then((r) => r.json());
        let best = null;
        let bestLen = -1;
        for (const e of all) {
          for (const k of _patternKeys) {
            const len = e.ruby.length + k.length + _patterns[k].length;
            if (e.ruby.includes(k) && len > bestLen) {
              bestLen = len;
              best = { e, k };
            }
          }
        }
        quiz.pool = [best.e];
        quiz.index = 0;
        renderQuestion();
        const i = [...document.querySelectorAll("#quiz-prompt .gram-chunk")].findIndex(
          (s) => s.textContent === best.k
        );
        document.querySelectorAll("#quiz-prompt .gram-chunk")[i].click();
        const last = [...document.querySelectorAll("#quiz-choices .choice-btn")].pop();
        return { chunk: best.k, bottom: Math.round(last.getBoundingClientRect().bottom) };
      });
      assert(
        worst.bottom <= PHONE.height,
        `the longest chunk explanation leaves the choices on screen (last choice ends at y=${worst.bottom} after tapping ${worst.chunk}, fold ${PHONE.height})`
      );
      await page.close();
    }

    // --- strokes.json covers every character the app can ask you to write ---
    // KanjiVG data (CC BY-SA 3.0), so the licence header travels with it — a
    // test, not a comment, because dropping it is the one way redistributing
    // this becomes a problem.
    {
      const file = JSON.parse(fs.readFileSync(path.join(ROOT, "data/strokes.json"), "utf8"));
      assert(/CC BY-SA/.test(file.license || ""), `strokes.json carries its licence (got "${file.license}")`);
      assert(/KanjiVG/.test(file.source || ""), `strokes.json names its source (got "${file.source}")`);
      const strokes = file.strokes;
      const kanji = JSON.parse(fs.readFileSync(path.join(ROOT, "data/n4/kanji.json"), "utf8"));
      const vocab = JSON.parse(fs.readFileSync(path.join(ROOT, "data/n4/vocab.json"), "utf8"));
      const chars = new Set();
      for (const e of [...kanji, ...vocab]) for (const c of e.word.match(/[一-鿿]/gu) || []) chars.add(c);
      const missing = [...chars].filter((c) => !strokes[c]);
      assert(
        missing.length === 0,
        `every kanji in the word files has stroke data (${missing.length} missing: ${missing.slice(0, 6).join("")})`
      );
      const broken = Object.entries(strokes).filter(
        ([, list]) => !Array.isArray(list) || list.length === 0 || list.some((d) => !/^[Mm]/.test(d))
      );
      assert(broken.length === 0, `every character has ordered path data (${broken.length} broken)`);
      assert(chars.size > 300, `the set is the real one, not a sample (${chars.size} characters)`);
    }

    // --- 쓰기 연습: watch, copy, then recall, on the 한자 기초 tab ---
    // Rebuilt twice on 2026-10-23. v1 drilled all 321 word-characters with the
    // guide off and the owner could not write one ("한자를 너무 모르니까 하나도
    // 못 쓴다"); v2 moved it to 한자 기초 and added the copying pass; v3 put the
    // stroke-order playback in front of it ("획순 먼저 보여주고 혼자 따라쓰고
    // 블라인드로 써보는 순서로 하자"). Watch → copy → recall.
    {
      const page = await browser.newPage({ viewport: PHONE });
      await page.goto(URL, { waitUntil: "networkidle" });
      // It is not on the 쪽지시험 tab any more, and a leftover launcher there
      // would be a dead button nobody notices.
      assert(
        (await page.$("#tab-quiz #start-writing")) === null,
        "the launcher is gone from the 쪽지시험 tab"
      );
      await page.click('.tab-btn[data-tab="radical"]');
      await page.click("#start-writing");
      await page.waitForSelector("#write-prompt");

      const chars = JSON.parse(fs.readFileSync(path.join(ROOT, "data/n4/kanjichar.json"), "utf8"));
      const snap = () =>
        page.evaluate(() => ({
          step: write.step,
          char: write.pool[write.index].char,
          progress: document.getElementById("write-progress").textContent,
          hint: document.getElementById("write-hint").textContent,
          traced: document.getElementById("write-guide").classList.contains("traced"),
          animating: document.getElementById("write-guide").classList.contains("animating"),
          watching: document.getElementById("write-tools").classList.contains("watching"),
          advance: document.getElementById("write-advance").hidden
            ? null
            : document.getElementById("write-advance").textContent,
          check: !document.getElementById("write-check").hidden,
          strokes: write.strokes.length,
          stroke: getComputedStyle(document.querySelector("#write-guide .write-stroke")).stroke,
        }));

      // --- pass 1: 획순 보기 ---
      const watch = await snap();
      const setup = await page.evaluate(() => ({
        size: write.pool.length,
        intro: document.getElementById("radical-intro").hidden,
        groups: document.getElementById("radical-groups").hidden,
        prompt: document.getElementById("write-prompt").textContent,
        meaning: document.getElementById("write-meaning").textContent,
        note: document.getElementById("write-note-line").textContent,
        allBasic: write.pool.every((c) => c.meaning && c.note),
        guideStrokes: document.querySelectorAll("#write-guide .write-stroke").length,
      }));
      assert(setup.size === 5, `a writing round is five characters (${setup.size})`);
      assert(setup.intro && setup.groups, "the practice takes over the tab rather than sitting under the list");
      assert(
        setup.allBasic && chars[watch.char],
        `the round draws the 기초 characters this tab teaches (${watch.char})`
      );
      // The prompt is the Japanese — the readings, 훈독 then 음독 — not a blanked
      // word and not the Korean 훈음 alone. A beginner still needs to be told
      // what to write, so the 훈음 stays, one line down and smaller.
      const want = [...chars[watch.char].kun, ...chars[watch.char].on].join(" ・ ");
      assert(
        setup.prompt === want,
        `the prompt is the character's Japanese readings (got "${setup.prompt}", expected "${want}")`
      );
      assert(
        /[\u3041-\u30FA]/.test(setup.prompt) && !/[\uAC00-\uD7A3]/.test(setup.prompt),
        `the prompt is kana, with no Hangul in it (got "${setup.prompt}")`
      );
      assert(
        setup.meaning === chars[watch.char].meaning && setup.note === chars[watch.char].note,
        `the 훈음 and the composition stay under it (got "${setup.meaning}")`
      );
      assert(
        setup.guideStrokes === (await page.evaluate(() => _strokeData[write.pool[write.index].char].length)),
        "the guide carries one path per stroke"
      );
      assert(watch.step === "watch", `the round opens on the stroke-order pass (${watch.step})`);
      assert(/획순 보기/.test(watch.progress), `the first pass names itself (${watch.progress})`);
      // The whole point of this pass is the order, so it plays itself.
      assert(watch.animating, "the stroke order plays without being asked");
      // Nothing to undo, clear or toggle while watching — the row collapses.
      assert(watch.watching, "the tool row collapses to the replay button while watching");
      assert(watch.advance === "따라 써보기 ▸", `the watch pass leads to the copying one (${watch.advance})`);
      assert(!watch.check, "확인 is not offered until the last pass");

      // Drawing is refused while watching: this pass is not a writing pass.
      const box = await page.locator("#write-canvas").boundingBox();
      await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.5, { steps: 8 });
      await page.mouse.up();
      assert(
        (await page.evaluate(() => write.strokes.length)) === 0,
        "the pad takes no ink during the stroke-order pass"
      );

      // --- pass 2: 따라 쓰기 ---
      await page.click("#write-advance");
      const trace = await snap();
      assert(trace.char === watch.char, `the copying pass is the same character (${trace.char})`);
      assert(/따라 쓰기/.test(trace.progress), `the second pass names itself (${trace.progress})`);
      assert(!trace.watching, "the full tool row is back once you are writing");
      assert(trace.traced, "the example is on the pad for the copying pass");
      assert(
        trace.stroke !== "rgba(0, 0, 0, 0)",
        `the example really is drawn, not just flagged (${trace.stroke})`
      );
      assert(trace.advance === "혼자 써보기 ▸", `the copying pass leads to the blind one (${trace.advance})`);
      assert(!trace.check, "확인 is still not offered");

      for (const [x1, y1, x2, y2] of [[0.3, 0.3, 0.7, 0.4], [0.5, 0.2, 0.5, 0.8]]) {
        await page.mouse.move(box.x + box.width * x1, box.y + box.height * y1);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * x2, box.y + box.height * y2, { steps: 10 });
        await page.mouse.up();
      }
      const inked = await page.evaluate(() => {
        const c = document.getElementById("write-canvas");
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
        return { strokes: write.strokes.length, pixels: n };
      });
      assert(inked.strokes === 2, `two drags make two strokes (${inked.strokes})`);
      assert(inked.pixels > 500, `the canvas actually holds ink (${inked.pixels} px)`);
      await page.click("#write-undo");
      assert((await page.evaluate(() => write.strokes.length)) === 1, "한 획 removes the last stroke");

      // --- pass 3: 혼자 쓰기 ---
      await page.click("#write-advance");
      const recall = await snap();
      assert(recall.char === watch.char, `the blind pass is still the same character (${recall.char})`);
      assert(/혼자 쓰기/.test(recall.progress), `the third pass names itself (${recall.progress})`);
      assert(
        !recall.traced && recall.stroke === "rgba(0, 0, 0, 0)",
        "the example is gone for the blind pass"
      );
      assert(recall.strokes === 0, `the pad is cleared between passes (${recall.strokes} strokes left)`);
      assert(recall.advance === null && recall.check, "the blind pass offers 확인 and nothing further");

      // 확인 reveals the glyph and brings the example back to compare against.
      await page.click("#write-check");
      await page.waitForSelector("#write-answer:not([hidden])");
      const after = await page.evaluate(() => ({
        shown: document.getElementById("write-answer-char").textContent,
        traced: document.getElementById("write-guide").classList.contains("traced"),
        next: !document.getElementById("write-next").hidden,
      }));
      assert(after.shown === watch.char, `확인 shows the character (${after.shown} vs ${watch.char})`);
      assert(after.traced, "확인 brings the example back so you can compare your strokes against it");
      assert(after.next, "확인 offers the next character");

      // 다음 글자 starts the next one back at the stroke-order pass.
      await page.click("#write-next");
      const second = await page.evaluate(() => ({ index: write.index, step: write.step }));
      assert(second.index === 1 && second.step === "watch", "the next character starts at 획순 보기 again");

      // Nothing is scored or scheduled — the same call the 가리기 deck makes.
      // The review KEY does appear, because buildWritePool reads the schedule and
      // loadReview writes its empty skeleton on first read (that write is what
      // guards the legacy migration). What must stay at zero is scheduled
      // ENTRIES, which is what a stray recordAnswerOutcome would add.
      const wrote = await page.evaluate(() => {
        const r = JSON.parse(localStorage.getItem("jlpt_review_n4") || "null");
        return {
          entries: Object.values((r && r.types) || {}).reduce((a, t) => a + Object.keys(t).length, 0),
          results: localStorage.getItem("jlpt_quiz_results_n4"),
        };
      });
      assert(wrote.entries === 0, `쓰기 연습 schedules nothing (${wrote.entries} entries written)`);
      assert(!wrote.results, `쓰기 연습 records no score (got ${wrote.results})`);

      // 그만두기 puts the tab back rather than leaving a blank screen.
      await page.click("#write-quit");
      const back = await page.evaluate(() => ({
        groups: document.getElementById("radical-groups").hidden,
        panel: document.getElementById("write-play").hidden,
      }));
      assert(!back.groups && back.panel, "그만두기 restores the 한자 기초 list");
      await page.close();
    }

    // --- The five cards lean on the characters the exam actually uses ---
    // Asked for on 2026-10-26, "가장 출제가 높은 한자들을 위주로". 間 appears 69
    // times across the N4 corpus and 捨 once, so a five-card round that treats
    // them alike is four fifths wasted. The draw is weighted by `freq`, which
    // has to show up as a real bias — and must not collapse into serving the
    // same five every day, which is the other half of this and the failure the
    // review queue already shipped once ("매일같은게 보임").
    {
      const page = await browser.newPage({ viewport: PHONE });
      await page.goto(URL, { waitUntil: "networkidle" });
      await page.click('.tab-btn[data-tab="radical"]');
      await page.click("#start-writing");
      await page.waitForSelector("#write-prompt");

      const sim = await page.evaluate(() => {
        const all = Object.entries(_kanjiChars);
        const flat = all.reduce((a, [, v]) => a + v.freq, 0) / all.length;
        const counts = new Map();
        let sum = 0;
        let n = 0;
        for (let i = 0; i < 2000; i++) {
          for (const c of buildWritePool(5)) {
            counts.set(c.char, (counts.get(c.char) || 0) + 1);
            sum += c.freq;
            n++;
          }
        }
        const top = [...all].sort((a, b) => b[1].freq - a[1].freq).slice(0, 10).map(([c]) => c);
        return {
          flat: +flat.toFixed(1),
          drawn: +(sum / n).toFixed(1),
          reached: counts.size,
          total: all.length,
          topShare: +((100 * top.reduce((a, c) => a + (counts.get(c) || 0), 0)) / n).toFixed(0),
          leads: new Set(Array.from({ length: 40 }, () => buildWritePool(5)[0].char)).size,
        };
      });
      assert(
        sim.drawn > sim.flat * 1.5,
        `a drawn card is far likelier to be a frequent character (mean freq ${sim.drawn} drawn vs ${sim.flat} flat)`
      );
      assert(
        sim.topShare >= 20,
        `the ten most-used characters take a real share of the round (${sim.topShare}% of slots, 9.5% of the set)`
      );
      // Weighted, not filtered: 捨 is rare, not excluded.
      assert(
        sim.reached === sim.total,
        `every 기초 character can still come up (${sim.reached} of ${sim.total})`
      );
      assert(
        sim.leads >= 15,
        `the round is not the same five every day (${sim.leads} distinct lead characters over 40 rounds)`
      );
      await page.close();
    }

    // --- The stroke-order animation cleans up after itself ---
    // It writes inline dash offsets on every path; left behind, the next
    // character would render half-drawn.
    {
      const page = await browser.newPage({ viewport: PHONE });
      await page.goto(URL, { waitUntil: "networkidle" });
      await page.click('.tab-btn[data-tab="radical"]');
      await page.click("#start-writing");
      await page.waitForSelector("#write-prompt");
      await page.click("#write-order");
      const mid = await page.evaluate(
        () => document.getElementById("write-guide").classList.contains("animating")
      );
      assert(mid, "획순 puts the guide into its animating state");
      // Moving on must not wait for the animation to finish.
      await page.evaluate(() => { write.index = 1; write.step = "trace"; renderWriteCard(); });
      // "trace" on purpose: rendering a "watch" card starts a new animation, which
      // is the opposite of what this block is checking.
      const clean = await page.evaluate(() => ({
        leftovers: [...document.querySelectorAll("#write-guide .write-stroke")].filter(
          (p) => p.style.strokeDasharray || p.style.strokeDashoffset
        ).length,
        pending: write.anim,
        animating: document.getElementById("write-guide").classList.contains("animating"),
        stroke: getComputedStyle(document.querySelector("#write-guide .write-stroke")).stroke,
      }));
      assert(clean.leftovers === 0, `no half-drawn strokes carry over (${clean.leftovers})`);
      assert(clean.pending === null, "the pending animation timer is cancelled on the next card");
      // The class is the half that bit: `.animating .write-stroke` is transparent,
      // so leaving it on after an interrupted playback hid the 밑글씨 for the
      // whole copying pass. You advance mid-animation most of the time.
      assert(!clean.animating, "the animating class is dropped too, not just the inline styles");
      assert(
        clean.stroke !== "rgba(0, 0, 0, 0)",
        `the guide is visible again after an interrupted playback (${clean.stroke})`
      );
      await page.close();
    }

    // --- A character sitting in a due word is written first ---
    // The practice has no schedule of its own, but it reads the 한자 one as a
    // source: the characters you keep missing are the ones you draw. The unit is
    // the character, so unlike the first version a due one cannot be claimed by
    // some other word and dropped.
    {
      const page = await browser.newPage({ viewport: PHONE });
      await page.goto(URL, { waitUntil: "networkidle" });
      const lead = await page.evaluate(async () => {
        await Promise.all([buildXrefIndex(), buildStrokeData(), buildKanjiChars()]);
        // A word whose characters are all in the 기초 set, so the round must pick them.
        const target = [..._wordIndex.values()].find(
          (w) => /^[一-鿿]{2}$/u.test(w.word) && [...w.word].every((c) => _kanjiChars[c] && _strokeData[c])
        );
        recordAnswerOutcome("kanji", target.word, false);
        const pool = buildWritePool(8).map((c) => c.char);
        return { word: target.word, pool: pool.join(""), lead: pool.slice(0, 2).join("") };
      });
      assert(
        [...lead.word].every((c) => lead.lead.includes(c)),
        `both characters of the due word lead the round (${lead.word} vs "${lead.lead}")`
      );
      await page.close();
    }


    // --- exam.json keeps the shape every もんだい renderer assumes ---
    // Ten formats live in one file because the exam page is their only consumer;
    // the per-shape invariants are checked here instead of per file.
    {
      const ex = JSON.parse(fs.readFileSync(path.join(ROOT, "data/n4/exam.json"), "utf8"));
      const FOUR = ["context", "synonym", "usage"];
      const THREE = ["utterance", "response"];
      for (const key of [...FOUR, ...THREE]) {
        const list = ex[key];
        assert(list && list.length >= 6, `exam.json ${key} has enough entries (${list ? list.length : 0})`);
        const want = FOUR.includes(key) ? 4 : 3;
        const bad = list.filter(
          (e) => e.choices.length !== want || new Set(e.choices).size !== want || !e.choices.includes(e.answer)
        );
        assert(bad.length === 0, `every ${key} entry has ${want} distinct choices including its answer (${bad.length} bad)`);
        const thin = list.filter((e) => !e.note || e.note.length < 20);
        assert(thin.length === 0, `every ${key} entry explains itself (${thin.length} thin)`);
      }
      // 문맥규정 and 문법1 share the ＿＿＿ blank convention; 유의표현 does not.
      assert(
        ex.context.every((e) => e.sentence.includes("＿＿＿")),
        "every 문맥규정 sentence carries the blank the instruction promises"
      );
      for (const e of ex.cloze) {
        assert(e.blanks.length === 4, `${e.title} has four blanks (${e.blanks.length})`);
        e.blanks.forEach((b, i) => {
          assert(e.ruby.includes(`＿${i + 1}＿`), `${e.title} marks blank ${i + 1} in the text`);
          assert(b.choices.length === 4 && b.choices.includes(b.answer), `${e.title} blank ${i + 1} is answerable`);
        });
        assert(e.translation && !/[぀-ヿ一-鿿]/.test(e.translation), `${e.title} has a Korean translation with no Japanese left in it`);
      }
      for (const e of [...ex.longread, ...ex.infosearch]) {
        const want = ex.longread.includes(e) ? 3 : 2;
        assert(e.questions.length === want, `${e.title} carries ${want} questions (${e.questions.length})`);
        assert(
          e.questions.every((q) => q.choices.length === 4 && new Set(q.choices).size === 4 && q.choices.includes(q.answer)),
          `${e.title}'s questions are answerable`
        );
        assert(
          e.questions.every((q) => q.questionTranslation && !/[一-鿿]/.test(q.questionTranslation)),
          `${e.title}'s questions each carry a Korean line with no kanji left in it`
        );
      }
      // The 청해 scripts are spoken by the Web Speech API, so a stray Latin
      // letter is read in the wrong language rather than rendered oddly.
      const spoken = [
        ...ex.task.flatMap((e) => e.lines.map(([, t]) => t)),
        ...ex.response.map((e) => e.line),
        ...ex.utterance.flatMap((e) => e.choices),
      ];
      const latin = spoken.filter((t) => /[A-Za-z]/.test(t));
      assert(latin.length === 0, `no spoken line carries Latin letters (${latin.slice(0, 2).join(" | ")})`);
      const kinds = { task: 0, point: 0 };
      ex.task.forEach((e) => { kinds[e.kind] = (kinds[e.kind] || 0) + 1; });
      assert(
        kinds.task >= 8 && kinds.point >= 7,
        `enough 課題理解/ポイント理解 items to fill 問題1 and 問題2 (${kinds.task}/${kinds.point}, need 8/7)`
      );
      assert(
        ex.task.every((e) => e.lines.length >= 2),
        "every 청해 item is a dialogue rather than one line"
      );
      // A duplicate prompt means two questions can be drawn that read the same.
      for (const [key, field] of [["context", "sentence"], ["synonym", "sentence"], ["usage", "word"], ["response", "line"]]) {
        const vals = ex[key].map((e) => e[field]);
        assert(new Set(vals).size === vals.length, `no two ${key} entries share a ${field}`);
      }
    }

    // --- Every section builds to the official shape ---
    // 85 questions across three sittings, in the counts JEES publishes. The
    // build draws five もんだい from the quiz files, so this runs the real
    // builders rather than trusting the spec it is checking.
    {
      const page = await browser.newPage({ viewport: PHONE });
      await page.goto(URL, { waitUntil: "networkidle" });
      const built = await page.evaluate(async () => {
        const out = [];
        for (const spec of EXAM_SPEC) {
          const { questions } = await buildExamSection(spec.id);
          const per = {};
          questions.forEach((q) => { per[q.mondai.n] = (per[q.mondai.n] || 0) + 1; });
          out.push({
            id: spec.id,
            want: spec.mondai.map((m) => `${m.n}:${m.count}`).join(","),
            got: spec.mondai.map((m) => `${m.n}:${per[m.n] || 0}`).join(","),
            total: questions.length,
            broken: questions.filter(
              (q) => !q.choices || q.choices.length < 3 || new Set(q.choices).size !== q.choices.length || !q.choices.includes(q.answer)
            ).length,
            noNote: questions.filter((q) => !q.note).length,
          });
        }
        return out;
      });
      let grand = 0;
      for (const sec of built) {
        assert(sec.got === sec.want, `${sec.id} fills every もんだい to its official count (want ${sec.want}, got ${sec.got})`);
        assert(sec.broken === 0, `${sec.id}: every question has distinct choices containing its answer (${sec.broken} broken)`);
        assert(sec.noNote === 0, `${sec.id}: every question carries an explanation for the review (${sec.noNote} without)`);
        grand += sec.total;
      }
      assert(grand === 85, `the three sittings come to the real exam's 85 questions (got ${grand})`);
      await page.close();
    }

    // --- Sitting the same paper twice gives a different paper ---
    // The five file-drawn もんだい always varied; the nine authored ones did not,
    // and four of them repeated in full — 課題理解 and ポイント理解 handed back
    // every item every time, because exam.json held exactly as many as a paper
    // needs (8 and 7). Measured before the 2026-10-28 batch: 100/100/83/80/68/
    // 67/59/55/52/48/40% overlap on those nine. Tripling exam.json to 213 items
    // puts every もんだい at or under 35%. This asserts the ceiling rather than
    // the counts, so growing a pool can't be undone by raising a count.
    {
      const page = await browser.newPage({ viewport: PHONE });
      await page.goto(URL, { waitUntil: "networkidle" });
      const worst = await page.evaluate(async () => {
        // Identity = everything the builder does NOT re-shuffle per render.
        // Including `choices` would make every render look unique and the whole
        // measurement would read 0%.
        const id = (q) => JSON.stringify([q.prompt, q.sub, q.speech, q.answer, q.note, q.context && q.context.body]);
        const out = [];
        for (const spec of EXAM_SPEC) {
          const runs = [];
          for (let i = 0; i < 60; i++) runs.push((await buildExamSection(spec.id)).questions);
          for (const m of spec.mondai) {
            const sets = runs.map((qs) => new Set(qs.filter((q) => q.mondai.n === m.n).map(id)));
            let ov = 0;
            let n = 0;
            for (let i = 0; i + 1 < sets.length; i += 2) {
              const a = sets[i];
              const c = sets[i + 1];
              ov += [...a].filter((x) => c.has(x)).length / a.size;
              n++;
            }
            out.push({
              who: `${spec.id} 問題${m.n} ${m.ko}`,
              count: m.count,
              pool: new Set(sets.flatMap((x) => [...x])).size,
              repeat: Math.round((100 * ov) / n),
            });
          }
        }
        return out.sort((a, b) => b.repeat - a.repeat);
      });
      const over = worst.filter((x) => x.repeat > 50);
      assert(
        over.length === 0,
        `no もんだい repeats more than half its questions on a second sitting (worst: ${worst
          .slice(0, 3)
          .map((x) => `${x.who} ${x.repeat}%`)
          .join(", ")})`
      );
      // The ceiling comes from pool size, so say that out loud: a もんだい whose
      // pool is barely its paper count cannot vary however the draw is written.
      const thin = worst.filter((x) => x.pool < x.count * 2);
      assert(
        thin.length === 0,
        `every もんだい draws from at least twice what one paper uses (thin: ${thin
          .map((x) => `${x.who} ${x.pool}/${x.count}`)
          .join(", ")})`
      );
      await page.close();
    }

    // --- 문장 만들기's star is a 0-based index into `ordered` ---
    // app.js answers with item.ordered[item.star]. A 1-based value reads one
    // part to the right and, on the last position, makes the answer undefined —
    // which is what 16 new items did when they first went in. The round-trip
    // test below catches it as "choices don't contain the answer"; this names it.
    {
      const order = JSON.parse(fs.readFileSync(path.join(ROOT, "data/n4/exam.json"), "utf8")).order;
      const bad = order.filter((it) => !(it.star >= 0 && it.star < it.ordered.length));
      assert(
        bad.length === 0,
        `every 문장 만들기 item's star points at one of its parts (bad: ${bad.map((b) => b.ordered.join("/")).join(", ")})`
      );
    }

    // --- A paper never asks the same thing twice ---
    // 問題1 prints 飛行機 and asks for its reading; 問題2 then asks you to spell
    // ひこうき with the answer already on the paper above. The two もんだい drew
    // from kanji.json independently, which put a duplicate in 12% of 문자·어휘
    // papers — and because both carry the same reviewKey, whichever landed
    // second silently overwrote the other outcome in the schedule. 40 papers
    // per section catches a regression of that rate with room to spare.
    {
      const page = await browser.newPage({ viewport: PHONE });
      await page.goto(URL, { waitUntil: "networkidle" });
      const r = await page.evaluate(async () => {
        const out = { papers: 0, dupKey: [], dupQuestion: [] };
        for (let i = 0; i < 40; i++) {
          for (const spec of EXAM_SPEC) {
            const { questions } = await buildExamSection(spec.id);
            out.papers++;
            const keys = questions.map((q) => q.reviewKey).filter(Boolean);
            const seen = new Set();
            for (const k of keys) {
              if (seen.has(k)) out.dupKey.push(`${spec.id}:${k}`);
              seen.add(k);
            }
            const prompts = questions.map((q) => `${q.mondai.n}|${q.prompt}|${q.choices.join("/")}`);
            if (new Set(prompts).size !== prompts.length) out.dupQuestion.push(spec.id);
          }
        }
        return out;
      });
      assert(r.papers === 120, `the sweep built every section 40 times (${r.papers})`);
      assert(
        r.dupKey.length === 0,
        `no paper asks the same word twice (${r.dupKey.length}: ${[...new Set(r.dupKey)].slice(0, 3).join(" ")})`
      );
      assert(
        r.dupQuestion.length === 0,
        `no paper repeats a question (${[...new Set(r.dupQuestion)].join(" ")})`
      );
      await page.close();
    }

    // --- 表記 distractors always exist, and look like the answer ---
    // A wrong spelling you can throw out without reading the kanji tests
    // nothing: 飛行機 against 有名だ is settled by the trailing kana alone. The
    // generator prefers a radical-group sibling swap, then a word of the same
    // kanji/kana shape. お正月 is the one word with no same-shape partner in the
    // file, which is why the last-resort fill has to be there at all.
    {
      const page = await browser.newPage({ viewport: PHONE });
      await page.goto(URL, { waitUntil: "networkidle" });
      const r = await page.evaluate(async () => {
        const d = await buildExamData();
        const words = d.kanji.filter((v) => /[一-鿿]/.test(v.word));
        let short = 0, dup = 0, closeN = 0, total = 0;
        const close = (w, g) => {
          if (g.length === w.length && [...g].filter((c, i) => c !== w[i]).length === 1) return true;
          const cs = new Set(w);
          return [...g].some((c) => cs.has(c));
        };
        for (const item of words) {
          const got = kanjiLookalikes(item.word, d.kanji);
          if (got.length !== 3) short++;
          if (new Set(got).size !== 3 || got.includes(item.word)) dup++;
          total += got.length;
          closeN += got.filter((g) => close(item.word, g)).length;
        }
        return { words: words.length, short, dup, closePct: Math.round((closeN / total) * 100) };
      });
      assert(r.short === 0, `every kanji word yields three distractors (${r.short} short of ${r.words})`);
      assert(r.dup === 0, `no distractor repeats or equals the answer (${r.dup} bad)`);
      assert(r.closePct >= 80, `most distractors are a one-character swap or share a character (${r.closePct}%)`);
      await page.close();
    }

    // --- Nothing is marked until the paper is submitted ---
    // That is the whole difference from 쪽지시험. A picked choice is styled
    // "picked", never "correct"/"wrong", and no note is on screen.
    {
      const page = await browser.newPage({ viewport: PHONE });
      await page.goto(URL, { waitUntil: "networkidle" });
      await page.click('.tab-btn[data-tab="exam"]');
      await page.evaluate(() => startExamSection("moji"));
      await page.waitForSelector(".exam-choice");
      await page.locator(".exam-choice").first().click();
      const marks = await page.evaluate(() => ({
        picked: document.querySelectorAll(".exam-choice.picked").length,
        graded: document.querySelectorAll(".exam-choice.correct, .exam-choice.wrong").length,
        notes: document.querySelectorAll("#exam-body .exam-review-note").length,
        resultHidden: document.getElementById("exam-result").hidden,
      }));
      assert(marks.picked === 1, `the chosen answer is marked as picked (${marks.picked})`);
      assert(marks.graded === 0, `no choice is graded before submitting (${marks.graded} graded)`);
      assert(marks.notes === 0, `no explanation is on screen during the paper (${marks.notes})`);
      assert(marks.resultHidden, "the score screen stays hidden until the paper is in");
      await page.close();
    }

    // --- The official scale, including the 과락 and the untaken paper ---
    // 언어지식·독해 is one 120-point block sat as two papers, 청해 its own 60.
    // A paper never sat reports 미응시 rather than scoring zero — a paper you
    // did not take is not a paper you failed.
    {
      const page = await browser.newPage({ viewport: PHONE });
      await page.goto(URL, { waitUntil: "networkidle" });
      await page.click('.tab-btn[data-tab="exam"]');
      const scored = await page.evaluate(async () => {
        await startExamSection("moji");
        const n = exam.questions.length;
        // 20 right of 28, the rest wrong, so the scale has something to scale.
        exam.answers = exam.questions.map((q, i) => (i < 20 ? q.answer : q.choices.find((c) => c !== q.answer)));
        submitExam();
        const blocks = examBlockScore(examStore());
        return {
          raw: `${exam.answers.filter((a, i) => a === exam.questions[i].answer).length}/${n}`,
          goi: blocks[0], choukai: blocks[1],
          text: document.getElementById("exam-score").textContent,
        };
      });
      assert(scored.raw === "20/28", `the fixture answered what it meant to (${scored.raw})`);
      // 20 correct of the 57 that make up the 120-point block.
      assert(
        scored.goi.score === Math.round((20 / 57) * 120),
        `언어지식·독해 scales onto 120 (got ${scored.goi.score}, expected ${Math.round((20 / 57) * 120)})`
      );
      assert(scored.goi.complete === false, "the block knows 문법·독해 has not been sat yet");
      assert(scored.choukai.score === 0 && scored.choukai.complete === false, "an untaken 청해 is reported as not sat");
      assert(/미응시/.test(scored.text), "the score screen says a paper is missing rather than implying a zero");
      await page.close();
    }

    // --- A missed exam question comes back in the 복습 노트 ---
    // The five もんだい drawn from the quiz files feed the same Leitner schedule;
    // a word you missed under a clock is exactly a word to see again tomorrow.
    {
      const page = await browser.newPage({ viewport: PHONE });
      await page.goto(URL, { waitUntil: "networkidle" });
      await page.click('.tab-btn[data-tab="exam"]');
      const probe = await page.evaluate(async () => {
        await startExamSection("moji");
        const q = exam.questions.find((x) => x.reviewType === "kanji");
        exam.answers = exam.questions.map((x) => (x === q ? x.choices.find((c) => c !== x.answer) : x.answer));
        submitExam();
        const store = JSON.parse(localStorage.getItem("jlpt_review_n4") || "null");
        return { key: q.reviewKey, entry: store && store.types.kanji && store.types.kanji[q.reviewKey] };
      });
      assert(probe.entry, `the missed exam word was scheduled (${probe.key})`);
      assert(probe.entry.box === 0, `a missed exam word goes back to box 0 (got ${probe.entry.box})`);
      await page.close();
    }

    // --- A full paper stays usable on a phone ---
    // Measured at 390x844 like every other budget in CLAUDE.md. The longest
    // question in the file is a 중문 passage plus four choices, so this walks
    // every question of the longest section rather than whichever one loads.
    {
      const page = await browser.newPage({ viewport: PHONE });
      await page.goto(URL, { waitUntil: "networkidle" });
      await page.click('.tab-btn[data-tab="exam"]');
      await page.evaluate(() => startExamSection("bunpou"));
      await page.waitForSelector(".exam-choice");
      const n = await page.evaluate(() => exam.questions.length);
      let worst = 0;
      for (let i = 0; i < n; i++) {
        await page.evaluate((k) => { exam.index = k; renderExamQuestion(); }, i);
        const over = await page.evaluate(() => {
          const el = document.documentElement;
          return el.scrollWidth - el.clientWidth;
        });
        worst = Math.max(worst, over);
      }
      assert(worst === 0, `no question scrolls sideways at ${PHONE.width}px (worst overflow ${worst}px)`);
      // The clock has to stay put while a long passage scrolls under it.
      const sticky = await page.evaluate(
        () => getComputedStyle(document.querySelector(".exam-bar")).position
      );
      assert(sticky === "sticky", `the clock stays on screen while the paper scrolls (position: ${sticky})`);
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
        await clickChoice(page, answer);
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

    // --- 오답 노트: the review queue, rendered ---
    // The queue has steered review rounds since #33 while being invisible, so
    // nothing here could regress noticeably. These checks are the floor: the
    // groups match the store, the lines match what the page itself formats, and a
    // key whose entry has left the data file is dropped rather than counted.
    {
      let page = await browser.newPage({ viewport: PHONE });
      await page.goto(URL, { waitUntil: "networkidle" });
      await page.click('.tab-btn[data-tab="quiz"]');
      await page.waitForSelector("#wrong-note");
      assert(await page.isVisible("#wrong-empty"), "복습 노트 says so while nothing is scheduled");
      assert(!(await page.isVisible("#wrong-progress")), "no progress line before anything is scheduled");
      assert(
        (await page.textContent("#wrong-total")).trim() === "",
        "no count badge on an empty queue"
      );
      assert((await page.locator(".wrong-group").count()) === 0, "no groups on an empty queue");

      // Seeded the way wrong answers would leave it, plus one key whose entry is
      // gone — that one can never be answered right again, so it has to be pruned
      // or it inflates the count forever.
      await page.close();

      // A fresh page, with the OLD key already in place before any script runs —
      // which is how a phone that has been using the app meets this change.
      const STALE = "存在しない語";
      const seeded = await (async () => {
        const probe = await browser.newPage({ viewport: PHONE });
        await probe.goto(URL, { waitUntil: "networkidle" });
        const keys = await probe.evaluate(async () => {
          const kanji = await fetch("data/n4/kanji.json").then((r) => r.json());
          const vocab = await fetch("data/n4/vocab.json").then((r) => r.json());
          return {
            kanjiKeys: kanji.slice(0, 12).map((e) => e.word),
            vocabKeys: vocab.slice(0, 2).map((e) => e.word),
          };
        });
        await probe.close();
        return keys;
      })();
      page = await browser.newPage({ viewport: PHONE });
      await page.addInitScript(
        ([k, v, stale]) => {
          localStorage.setItem(
            "jlpt_wrong_items_n4",
            JSON.stringify({ kanji: [...k, stale], vocab: v })
          );
        },
        [seeded.kanjiKeys, seeded.vocabKeys, STALE]
      );
      await page.goto(URL, { waitUntil: "networkidle" });
      await page.click('.tab-btn[data-tab="quiz"]');
      await page.waitForFunction(() => document.querySelectorAll(".wrong-group").length === 2);

      const summaries = await page.$$eval(".wrong-name", (els) => els.map((e) => e.textContent));
      assert(
        summaries.join(" | ") === "단어 오늘 2개 | 한자 오늘 12개",
        `the note groups by type in the quiz buttons' order (got "${summaries.join(" | ")}")`
      );
      const totalBadge = (await page.textContent("#wrong-total")).trim();
      assert(totalBadge === "(14)", `the heading counts every queued item (got "${totalBadge}")`);
      assert(!(await page.isVisible("#wrong-empty")), "the empty line is gone once something is queued");

      // Seeding the OLD key also exercises the one-time migration: everything the
      // leaky-bucket queue held was by definition not learned, so it lands in box
      // 0 due today — which is why all 12 show as due above.
      const migrated = await page.evaluate(() => {
        const raw = JSON.parse(localStorage.getItem("jlpt_review_n4"));
        const kanji = raw.types.kanji;
        return {
          version: raw.version,
          keys: Object.keys(kanji),
          boxes: [...new Set(Object.values(kanji).map((e) => e.box))],
          dues: [...new Set(Object.values(kanji).map((e) => e.due))],
          today: todayStr(),
        };
      });
      assert(migrated.version === 1, `the schedule is written at version 1 (got ${migrated.version})`);
      assert(
        !migrated.keys.includes(STALE) && migrated.keys.length === 12,
        `a key with no entry left in the data file is pruned from the schedule (got ${migrated.keys.length} keys)`
      );
      assert(
        migrated.boxes.join() === "0" && migrated.dues.join() === migrated.today,
        `the old wrong-answer queue migrates into box 0, due today (boxes ${migrated.boxes}, dues ${migrated.dues})`
      );

      const progress = (await page.textContent("#wrong-progress")).trim();
      assert(
        progress === "외우는 중 14개 · 외움 0개",
        `the progress line counts everything scheduled, not just what is due (got "${progress}")`
      );
      const subs = await page.$$eval(".wrong-sub", (els) => els.map((e) => e.textContent));
      assert(
        subs.join(" | ") === "외우는 중 2개 · 외움 0개 | 외우는 중 12개 · 외움 0개",
        `each card says how far along that type is (got "${subs.join(" | ")}")`
      );

      // The lines are asked of the page, not reimplemented here — the word-shaped
      // types take the post-answer recap's own first line, so this also pins that
      // the two haven't drifted apart.
      const lines = await page.evaluate(async (keys) => {
        const kanji = await fetch("data/n4/kanji.json").then((r) => r.json());
        const byWord = new Map(kanji.map((e) => [e.word, e]));
        const group = [...document.querySelectorAll(".wrong-group")]
          .find((g) => g.querySelector(".wrong-name").textContent.startsWith("한자"));
        return {
          want: keys.map((k) => reviewLine("kanji", byWord.get(k))),
          got: [...group.querySelectorAll(".wrong-list li")].map((li) => li.textContent),
        };
      }, seeded.kanjiKeys);
      // Compared as sets: dueKeys shuffles within equal priority on purpose, so
      // the list order is not stable and asserting it would be asserting the bug.
      assert(
        lines.got.length === lines.want.length &&
          [...lines.got].sort().join("\n") === [...lines.want].sort().join("\n"),
        `every queued item is listed as the page formats it (got ${lines.got.length} lines, wanted ${lines.want.length})`
      );
      assert(
        lines.want[0].includes("\u2192") && lines.want[0].includes("("),
        `a 한자 line carries word, reading and meaning (got "${lines.want[0]}")`
      );

      const drillLabels = await page.$$eval(".wrong-drill", (els) => els.map((e) => e.textContent));
      assert(
        drillLabels.join(" | ") === "오늘 복습 (2문제) | 오늘 복습 (5문제)",
        `the drill button says how long the round will be, capped at the round size (got "${drillLabels.join(" | ")}")`
      );
      await page.close();
    }

    // --- Equally-due items don't come up in the same order every round ---
    // After the migration every item was (box 0, due today) — one tie covering
    // the whole queue — and dueKeys returned Object.keys order, so the round's
    // review slots served the same two words every day for ever. That is what
    // "매일같은게 보임" was (2026-10-17).
    {
      const page = await browser.newPage({ viewport: PHONE });
      await page.goto(URL, { waitUntil: "networkidle" });
      const spread = await page.evaluate(() => {
        const sched = {};
        for (let i = 0; i < 20; i++) sched[`w${i}`] = { box: 0, due: todayStr() };
        const firsts = new Set();
        for (let i = 0; i < 40; i++) firsts.add(dueKeys(sched)[0]);
        // priority must still hold: one genuinely overdue item always leads
        sched.overdue = { box: 0, due: addDays(todayStr(), -3) };
        const leads = new Set();
        for (let i = 0; i < 20; i++) leads.add(dueKeys(sched)[0]);
        return { distinctFirsts: firsts.size, leads: [...leads] };
      });
      assert(
        spread.distinctFirsts > 5,
        `equally-due items are drawn in a fresh order each round (only ${spread.distinctFirsts} distinct leads in 40 calls)`
      );
      assert(
        spread.leads.length === 1 && spread.leads[0] === "overdue",
        `the shuffle does not override priority — the overdue item still leads (got ${spread.leads.join(", ")})`
      );
      await page.close();
    }

    // --- 오늘 복습 drills what is due, and a right answer pushes it out ---
    {
      const page = await browser.newPage({ viewport: PHONE });
      await page.goto(URL, { waitUntil: "networkidle" });
      const seeded = await page.evaluate(async () => {
        const vocab = await fetch("data/n4/vocab.json").then((r) => r.json());
        // Exactly a round's worth: the drill is capped at the round size, so a
        // longer queue could not be emptied in one go and the assertion below
        // would be testing the cap rather than the leaky bucket.
        const keys = vocab.slice(0, 5).map((e) => e.word);
        localStorage.setItem("jlpt_wrong_items_n4", JSON.stringify({ vocab: keys }));
        // Today's 단어 result already recorded, from a full round.
        localStorage.setItem(
          "jlpt_quiz_results_n4",
          JSON.stringify({ [todayStr()]: { vocab: { score: 9, total: 10 } } })
        );
        return keys;
      });
      await page.reload({ waitUntil: "networkidle" });
      await page.click('.tab-btn[data-tab="quiz"]');
      await page.waitForSelector(".wrong-drill");
      await page.click(".wrong-drill");
      await page.waitForSelector("#quiz-choices .choice-btn");

      const pool = await page.evaluate(() => ({
        words: quiz.pool.map((v) => v.word),
        wrongOnly: quiz.wrongOnly,
      }));
      assert(pool.wrongOnly, "the drill round is marked wrongOnly");
      assert(
        pool.words.length === 5 && pool.words.every((w) => seeded.includes(w)),
        `every question in the drill comes from the queue (got ${pool.words.length}: ${pool.words.join(", ")})`
      );
      assert(new Set(pool.words).size === pool.words.length, "the drill round never repeats an item");

      // Answer all five right. Under the old leaky bucket this retired them for
      // good; now each moves to box 1, due tomorrow — so today's list empties
      // while the words stay scheduled.
      for (let i = 0; i < pool.words.length; i++) {
        await page.waitForSelector("#quiz-choices .choice-btn");
        const want = await page.evaluate(() => quiz.pool[quiz.index].meaning);
        await clickChoice(page, want);
        await page.click("#quiz-next");
      }
      await page.waitForSelector("#quiz-result:not([hidden])");
      await page.click("#quiz-retry");
      await page.waitForFunction(() => document.querySelectorAll(".wrong-group").length === 0);
      assert(await page.isVisible("#wrong-empty"), "answering everything due empties today's 복습 노트");

      // The point of the whole change: right once is not done.
      const after = await page.evaluate(() => {
        const t = JSON.parse(localStorage.getItem("jlpt_review_n4")).types.vocab;
        return {
          boxes: [...new Set(Object.values(t).map((e) => e.box))],
          dues: [...new Set(Object.values(t).map((e) => e.due))],
          tomorrow: addDays(todayStr(), 1),
          count: Object.keys(t).length,
        };
      });
      assert(
        after.count === 5 && after.boxes.join() === "1" && after.dues.join() === after.tomorrow,
        `a correct answer schedules the word again instead of retiring it (${after.count} words, boxes ${after.boxes}, due ${after.dues} vs tomorrow ${after.tomorrow})`
      );
      const stillShown = (await page.textContent("#wrong-progress")).trim();
      assert(
        stillShown === "외우는 중 5개 · 외움 0개",
        `the progress line still counts them while nothing is due (got "${stillShown}")`
      );

      // The badge is "today's 쪽지시험": a 6-item drill of items you already missed
      // must not overwrite a full round's score.
      const badge = await page.evaluate(
        () => JSON.parse(localStorage.getItem("jlpt_quiz_results_n4"))[todayStr()].vocab
      );
      assert(
        badge.score === 9 && badge.total === 10,
        `a drill round leaves an existing result alone (got ${badge.score}/${badge.total})`
      );
      await page.close();
    }

    // --- A round is at most half review, so new words still come up ---
    {
      const page = await browser.newPage();
      await page.goto(URL, { waitUntil: "networkidle" });
      const pools = await page.evaluate(() => {
        const items = Array.from({ length: 40 }, (_, i) => ({ word: `w${i}` }));
        // Due twice over a round — the case that used to make every round 100%
        // review, so a word added today could never be drawn.
        const wrong = items.slice(0, 20).map((v) => v.word);
        const dueToday = Object.fromEntries(wrong.map((k) => [k, { box: 0, due: todayStr() }]));
        const run = (schedule, size, pickFrom = items) =>
          buildQuizPool(pickFrom, "word", size, schedule);
        return {
          share: REVIEW_SHARE,
          bigQueue: run(dueToday, 10).map((v) => v.word),
          // a round of 5 is where rounding the cap would quietly push review
          // past half the round.
          shortRound: run(dueToday, 5).map((v) => v.word),
          // Nothing fresh left to pull: review spills past the cap rather than
          // leaving the round short.
          nothingFresh: run(
            Object.fromEntries(wrong.slice(0, 8).map((k) => [k, { box: 0, due: todayStr() }])),
            8,
            items.slice(0, 8)
          ).map((v) => v.word),
          // Scheduled but not due: skipped entirely while unseen material is
          // left, which is the whole point of spacing.
          notDueSkipped: run(
            Object.fromEntries(items.slice(0, 20).map((v) => [v.word, { box: 3, due: "2099-01-01" }])),
            10
          ).map((v) => v.word),
          wrong,
        };
      });
      const cap = Math.max(1, Math.floor(10 * pools.share));
      const shortCap = Math.max(1, Math.floor(5 * pools.share));
      // 20 of the 40 are scheduled far in the future; a round of 10 must come
      // entirely from the other 20. Pulling a not-yet-due item early is exactly
      // what the schedule exists to prevent.
      const early = pools.notDueSkipped.filter((w) => pools.wrong.includes(w)).length;
      assert(
        pools.notDueSkipped.length === 10 && early === 0,
        `an item scheduled for later is not pulled early while unseen material is left (${early} came early)`
      );
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
      const shortReviewed = pools.shortRound.filter((w) => pools.wrong.includes(w)).length;
      assert(
        pools.shortRound.length === 5 && shortReviewed <= shortCap,
        `a 5-question round keeps review at or under half (got ${shortReviewed} of ${pools.shortRound.length}, cap ${shortCap})`
      );
      assert(
        pools.nothingFresh.length === 8 && new Set(pools.nothingFresh).size === 8,
        `with no fresh items left the round fills from review instead of running short (got ${pools.nothingFresh.length})`
      );
      await page.close();
    }

    // --- No data file is downloaded twice in one session ---
    // Every caller used to fetch its own copy of whatever it needed, which read
    // fine one function at a time and cost 255KB of 650KB over a day's use:
    // kanji.json came three times (the round, the cross-reference index, the
    // exam), reading.json and grammar.json twice each, kanjichar.json twice.
    // loadJson owns them now. This walks the paths that overlap — the two quiz
    // types that build an index, the tab that reads kanjichar.json behind
    // buildKanjiChars, the 복습 노트, and an exam section drawing from three
    // quiz files — and fails on any URL requested twice, so a new bare fetch()
    // reintroducing the waste shows up as a failing test rather than as a
    // slower phone.
    {
      const page = await browser.newPage({ viewport: PHONE });
      const seen = new Map();
      page.on("request", (r) => {
        const u = r.url().replace(URL, "").replace(/^\//, "").split("?")[0];
        if (u.startsWith("data/")) seen.set(u, (seen.get(u) || 0) + 1);
      });
      await page.goto(URL, { waitUntil: "networkidle" });
      await page.evaluate(() => startQuiz("kanji"));
      await page.evaluate(() => startQuiz("reading"));
      await page.click('.tab-btn[data-tab="radical"]');
      await page.waitForSelector(".kanji-row");
      await page.evaluate(() => buildExamSection("moji"));
      await page.evaluate(() => renderWrongNote());
      await page.waitForLoadState("networkidle");

      // plan.json is the one URL asked for twice on purpose: the head prefetches
      // it, and app.js then reads it from the HTTP cache rather than the network.
      // That second request is the point of the prefetch, not a duplicate.
      const prefetched = await page.$$eval('link[rel="prefetch"]', (els) =>
        els.map((e) => e.getAttribute("href"))
      );
      const twice = [...seen].filter(([u, n]) => n > (prefetched.includes(u) ? 2 : 1));
      assert(
        twice.length === 0,
        `no data file is fetched twice in a session (got ${twice.map(([u, n]) => `${u} x${n}`).join(", ")})`
      );
      // A guard that passed because nothing loaded would be worthless.
      assert(
        seen.size >= 7,
        `the walk really loaded the overlapping files (got ${seen.size}: ${[...seen.keys()].join(", ")})`
      );
      await page.close();
    }

    // --- The plan's own shape ---
    // STUDY_PLAN.md and plan.json are kept in sync by hand, so the parts a
    // machine *can* check are checked: the weeks have to tile the period with no
    // gap, start where startDate says, end on the exam, and carry a full week of
    // day lines — a short `days` array would silently blank the top of the page
    // on whichever weekday is missing.
    {
      const weeks = plan.weeks;
      assert(weeks.length > 0 && weeks[0].start === plan.startDate,
        `week 1 starts on startDate (${weeks[0].start} vs ${plan.startDate})`);
      assert(weeks[weeks.length - 1].end === plan.examDate,
        `the last week ends on the exam (${weeks[weeks.length - 1].end} vs ${plan.examDate})`);
      const bad = [];
      weeks.forEach((w, i) => {
        if (!Array.isArray(w.days) || w.days.length !== 7) {
          bad.push(`week ${w.week}: ${Array.isArray(w.days) ? w.days.length : "no"} day lines`);
        } else if (w.days.some((d) => typeof d !== "string" || !d.trim())) {
          bad.push(`week ${w.week}: an empty day line`);
        }
        if (w.start > w.end) bad.push(`week ${w.week}: starts after it ends`);
        if (i > 0 && addDaysToDateStr(weeks[i - 1].end, 1) !== w.start) {
          bad.push(`week ${w.week}: gap after ${weeks[i - 1].end}`);
        }
      });
      assert(bad.length === 0, `the weeks tile the period with 7 day lines each (${bad.join(" | ")})`);
      assert(Boolean(plan.preStart), "the plan says what to do before it starts");
    }

    // --- 그날 할 일 shows at the top of the page ---
    // The day line is indexed Monday-first while Date#getDay() counts from
    // Sunday, which is exactly the kind of off-by-one that renders the wrong
    // day's task every day without ever throwing. Checked against the data.
    {
      const samples = [plan.weeks[0].start, plan.weeks[0].end, plan.weeks[4].start, plan.examDate];
      for (const date of samples) {
        const page = await browser.newPage({ viewport: PHONE });
        await withFixedDate(page, date);
        await page.goto(URL, { waitUntil: "networkidle" });
        await page.waitForSelector("#dday");
        const week = plan.weeks.find((w) => date >= w.start && date <= w.end);
        const weekday = new Date(`${date}T00:00:00`).getDay();
        const want = week.days[(weekday + 6) % 7];
        const shown = (await page.textContent("#today-task")).trim();
        assert(
          shown.endsWith(`· ${want}`),
          `${date}: the top line carries that day's task (expected "… · ${want}", got "${shown}")`
        );
        const [, m, d] = date.split("-");
        assert(
          shown.startsWith(`${Number(m)}/${Number(d)} (`),
          `${date}: the top line is dated (got "${shown}")`
        );
        await page.close();
      }
    }

    // --- Outside the plan period the top line says something useful, or nothing ---
    {
      const before = await browser.newPage({ viewport: PHONE });
      await withFixedDate(before, addDaysToDateStr(plan.startDate, -1));
      await before.goto(URL, { waitUntil: "networkidle" });
      await before.waitForSelector("#dday");
      assert(
        (await before.textContent("#today-task")).trim() === plan.preStart,
        "before the plan starts, the top line says when it does"
      );
      await before.close();

      const after = await browser.newPage({ viewport: PHONE });
      await withFixedDate(after, addDaysToDateStr(plan.examDate, 1));
      await after.goto(URL, { waitUntil: "networkidle" });
      await after.waitForSelector("#dday");
      assert(!(await after.isVisible("#today-task")), "after the exam the top line is gone, not blank-but-boxed");
      await after.close();
    }

    // --- Date-boundary logic ---
    // The week card is gone, so these read the topbar: the D-day line, and the
    // day's task (which is empty outside the plan period).
    const cases = [
      { date: "2000-01-01", expect: (task, d) => task === plan.preStart && d.startsWith("시험까지") },
      { date: plan.weeks[0].start, expect: (task) => task.startsWith("10/13 (") },
      { date: plan.examDate, expect: (task, d) => d.includes("시험일") },
      { date: "2099-01-01", expect: (task, d) => d.includes("종료") && task === "" },
    ];
    for (const c of cases) {
      const page = await browser.newPage();
      await withFixedDate(page, c.date);
      await page.goto(URL, { waitUntil: "networkidle" });
      await page.waitForSelector("#dday");
      const task = (await page.textContent("#today-task")).trim();
      const dday = await page.textContent("#dday");
      assert(c.expect(task, dday), `date ${c.date} -> today-task="${task}" dday="${dday}"`);
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
