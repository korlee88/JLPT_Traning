# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project goal

A personal JLPT study tracker for the repo owner. Currently targeting **N4** (exam 2026-12-06). The plan is to keep extending this same project level by level — **N4 → N3 → N2 → N1** — over however long that takes. Treat every change as something that has to still make sense once a second and third level exist, not just as a one-off for N4.

## Commands

```bash
npm install       # once, for the test toolchain (playwright)
npm start         # serve locally: python3 -m http.server 8000
npm test          # test/smoke.js — headless-browser regression check
```

There is no build step and no linter configured — it's intentionally a plain static site (`index.html` / `style.css` / `app.js`, no framework, no bundler). Don't introduce one without a concrete reason.

Deploy is automatic: push to `main` → `.github/workflows/deploy-pages.yml` → GitHub Pages at `https://<owner>.github.io/JLPT_Traning/`. There is no CI beyond that workflow, so `npm test` is the only thing standing between a bad commit and production — run it before every push that touches `app.js`, `index.html`, `style.css`, or any `data/**/*.json`.

## Architecture

- **One active level at a time.** `CURRENT_LEVEL` in `app.js` picks which `data/<level>/` folder the app reads. `data/levels.json` is a registry of levels that exist, but the app doesn't read it yet — there's no level switcher UI. Don't build one until a second level actually has data; until then it's dead code.
- **All state is client-side.** `localStorage` only, keyed per level (`jlpt_daily_checklist_<level>`, `jlpt_quiz_results_<level>`), no backend, no accounts. This is a single-user personal tool — don't add a server or auth for it. Both are day-keyed (`{ "2026-09-13": {...} }`) the same way, so "resets at midnight" falls out for free from `todayStr()` returning a new key — no explicit reset logic exists or should be added.
- **Two views of the same schedule, kept in sync by hand.** `STUDY_PLAN.md` (human-readable) and `data/<level>/plan.json` (what the app renders) describe the same weekly breakdown. There is no generator linking them — if you change one, update the other, or they will silently drift.
- **Dates come from the real clock, always.** `todayStr()` formats `Date` using local `getFullYear/getMonth/getDate`, never `toISOString()`. `toISOString()` converts to UTC, which shifts the calendar date during early-morning hours in KST and would make the app show the wrong week/D-day for part of the day. `test/smoke.js` mocks `Date` (see `withFixedDate`) to check week/D-day logic at plan boundaries (before start, week 1, exam day, after exam) — extend those cases if you touch that logic.
- **GitHub Pages deploy gotcha (already hit once):** the first deploy failed with `Branch "main" is not allowed to deploy to github-pages due to environment protection rules`. Fix is in the repo owner's GitHub Settings, not in code: Settings → Environments → `github-pages` → Deployment branches and tags → set to "No restriction". Claude's GitHub App token also cannot call the Actions API to trigger or re-run a workflow (`403 Resource not accessible by integration`) — recovering a failed Pages deploy needs a human to click "Re-run jobs" or push a new commit.

## Adding a new level (N3, then N2, then N1)

1. Create `data/<level>/` with `plan.json`, `vocab.json`, `grammar.json` matching the schemas below.
2. Add an entry to `data/levels.json`.
3. Write the human-readable plan (a new `STUDY_PLAN_<LEVEL>.md`, or extend `STUDY_PLAN.md`) — whichever the repo owner prefers at the time; ask if it's not obvious from how N4's was used.
4. When that level becomes the one actively being studied, switch `CURRENT_LEVEL` in `app.js`. Old levels' checklist history stays intact under its own storage key.
5. `npm test` before pushing.

**Schemas** (see `data/n4/*.json` for real examples):

```
plan.json       { startDate, examDate, textbook, weeks: [{ week, start, end, focus }] }
hiragana.json   [{ char, hangul }]                      quiz asks for the Korean reading
katakana.json   [{ char, hangul }]                      same shape as hiragana.json
vocab.json      [{ word, reading, meaning }]           quiz asks for meaning
kanji.json      [{ word, reading, meaning }]            same shape, quiz asks for reading instead
grammar.json    [{ sentence, meaning, choices: [4 strings], answer, note }]
reading.json    [{ passage, question, choices: [4 strings], answer }]
listening.json  [{ script, meaning }]                   quiz speaks `script` via Web Speech API,
                                                          distractors drawn from other entries' meanings
```

`hiragana`/`katakana` cover only the base 46-character gojuon table each (no dakuten/handakuten or combination sounds yet) — extend them the same way if that's ever wanted. `hangul` uses the **word-initial** form from 국립국어원's 외래어 표기법 (e.g. か→가, つ→쓰, て→데), consistently, even though real words shift か/た/て/と etc. to the aspirated 어중 form (카/타/테/토) mid-word — that distinction is out of scope for a single-character reading quiz and would need actual word context to teach correctly. ん is shown as 응, a teaching convention for the isolated mora — the official rule (always ㄴ batchim) only applies to ん attached to a word.

`vocab`/`kanji`/`listening` all use the shared `pickDistractors()` helper in `app.js` to build the 3 wrong choices from other entries in the same file, rather than hand-authoring distractors — keep new entries in those files reasonably distinct in meaning/reading so auto-picked distractors stay plausible-but-wrong, not nonsensical.

**Finishing a quiz can auto-check the daily checklist.** `CHECKLIST_AUTO_MAP` in `app.js` maps each quiz type to a `CHECKLIST_ITEMS` index; completing a mapped quiz ticks that box for today if it isn't already (never unticks). `전날 내용 복습` (index 3) has no quiz proxy and stays manual-only — don't force a mapping onto it just to make everything automatic. If a new quiz type is added, decide whether it belongs in this map too.

**Listening quiz depends on the browser's Web Speech API** (`speechSynthesis`, `lang: "ja-JP"`) — there are no audio files. This means quality depends on whatever Japanese TTS voice the visitor's browser/OS provides (works well on Chrome desktop; may be silent or absent elsewhere). It degrades gracefully either way: the transcript is always revealed in the note after answering, so the quiz stays usable without audio.

## Content accuracy and copyright

- Vocab/grammar entries must be standard, verifiable JLPT-level content — don't invent a word/reading/meaning or a grammar pattern that isn't real.
- Never transcribe the textbook's own exercises, example sentences, or passages into `data/`. Write original example sentences for the same grammar point instead — reference the pattern/level, not the book's text.
