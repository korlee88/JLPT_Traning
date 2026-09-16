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
- **The quiz prompt is deliberately oversized.** `.quiz-prompt` is `2.6rem` — double its original `1.3rem` — because the owner studies off a phone and has to make out kanji strokes. Don't "tidy" it back down. `.quiz-prompt.passage` keeps its own `1rem` override so 독해 passages stay paragraph-sized; long 문법 sentences do wrap over several lines at this size, which was the accepted trade.
- **Verify every merge, even a clean one.** Realigning the working branch with `main` after a squash-merge has twice produced *silently duplicated code with no conflict markers* — once a duplicated `speak()`/`pickDistractors()` in `app.js`, once a duplicated `const` in `test/smoke.js` that would have been an outright `SyntaxError`. After any merge, before pushing: run `node --check app.js && node --check test/smoke.js`, grep for duplicate declarations, and diff against the pre-merge commit (a realign-only merge should produce an **empty** diff). Then `npm test`.

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
reading.json    [{ passage, question, choices: [4 strings], answer, note }]
listening.json  [{ script, meaning }]                   quiz speaks `script` via Web Speech API,
                                                          distractors drawn from other entries' meanings
```

**Every quiz type shows an explanation after answering** (right or wrong), via `explanationFor()` in `app.js` — not just a red/green highlight. For `grammar`/`reading` this is the data's own `note` field. Write one for every new entry, and make it earn its place: quote the exact sentence/clause that decides the answer, say *why* that leads to the correct choice, and account for the wrong choices — a superseded detail (the pre-change time/floor in the 会議 passage), a statement the text contradicts, or simply "not mentioned in the passage at all". `reading.json`'s notes were rewritten to that bar in #9 because a bare sentence pointer was too thin to learn from; match them rather than regressing. The other types don't need authored notes; `explanationFor()` builds the recap straight from the entry's own fields (e.g. `word (reading) = meaning`).

`hiragana`/`katakana` cover only the base 46-character gojuon table each (no dakuten/handakuten or combination sounds yet) — extend them the same way if that's ever wanted. `hangul` uses the **word-initial** form from 국립국어원's 외래어 표기법 (e.g. か→가, つ→쓰, て→데), consistently, even though real words shift か/た/て/と etc. to the aspirated 어중 form (카/타/테/토) mid-word — that distinction is out of scope for a single-character reading quiz and would need actual word context to teach correctly. ん is shown as 응, a teaching convention for the isolated mora — the official rule (always ㄴ batchim) only applies to ん attached to a word.

`vocab`/`listening` use the shared `pickDistractors()` helper in `app.js` to build the 3 wrong choices at random from other entries in the same file, rather than hand-authoring distractors — keep new entries reasonably distinct in meaning so auto-picked distractors stay plausible-but-wrong, not nonsensical.

**The kanji quiz picks its distractors by shape, not at random** (`pickReadingDistractors`). Random readings let the answer be found without reading the kanji at all: `売れる` against れんしゅう/げんき/いちど is settled by the trailing れる. The picker now prefers readings sharing the word's okurigana tail (`okuriganaTail`), then a similar mora count, then the same opening mora — measured over the current data, that cut "answerable from the okurigana tail alone" from 24% to 8% and "answerable from length alone" from 43% to 1%. It also dedupes by reading, because preferring similar readings would otherwise show a homophone pair as the same choice twice (none in `kanji.json` yet — `姉`/`お姉さん` collide on *meaning*, which the kanji quiz only shows as a hint). The remaining 8% is data-bound: `売れる` is still the lone `〜れる` reading in the file, so nothing can match its tail until another arrives.

**Wrong answers resurface in later rounds.** `QUIZ_KEY_FIELD` in `app.js` names the field that uniquely identifies an entry per quiz type (`word` for vocab/kanji, `char` for hiragana/katakana, `sentence`/`passage`/`script` for grammar/reading/listening). `recordAnswerOutcome()` adds a wrong item's key to `jlpt_wrong_items_<level>` (not day-keyed — it accumulates until mastered) and removes it once answered correctly again; `buildQuizPool()` fills a round with every currently-wrong item first, then tops up with fresh ones. It's a leaky-bucket review queue, not real spaced repetition with intervals — if that's ever wanted, it needs a due-date per item, not just a wrong/not-wrong set. A new quiz type must get an entry in `QUIZ_KEY_FIELD` (using a field that's actually unique within that file) or its wrong answers are silently never tracked.

**Round length is per quiz type.** `QUIZ_ROUND_SIZE` in `app.js` gives `hiragana`/`katakana`/`kanji` 20 questions — they're single-item recall and go fast — and every other type falls back to `DEFAULT_ROUND_SIZE` (10). A round is still capped at the data file's entry count, which is why 독해 asks 8: `reading.json` only has 8 entries. `test/smoke.js` asserts each type's expected round length, so changing one means updating `EXPECTED_ROUND_SIZE` there too (and 독해's 8 becomes 10 once `reading.json` passes 10 entries).

**Finishing a quiz can auto-check the daily checklist.** `CHECKLIST_AUTO_MAP` in `app.js` maps each quiz type to a `CHECKLIST_ITEMS` index; completing a mapped quiz ticks that box for today if it isn't already (never unticks). `전날 내용 복습` (index 3) has no quiz proxy and stays manual-only — don't force a mapping onto it just to make everything automatic. If a new quiz type is added, decide whether it belongs in this map too.

**Listening quiz depends on the browser's Web Speech API** (`speechSynthesis`, `lang: "ja-JP"`) — there are no audio files. This means quality depends on whatever Japanese TTS voice the visitor's browser/OS provides (works well on Chrome desktop; may be silent or absent elsewhere). It degrades gracefully either way: the transcript is always revealed in the note after answering, so the quiz stays usable without audio.

## Daily 기출 어휘 batches (ongoing)

The owner is working through the 동양북스 textbook's **기출 어휘 → もんだい1 한자 읽기** list at roughly 20 words a day, photographing the page after each day's study. Each photo gets transcribed into `data/n4/kanji.json` so exactly those words come up in the 한자 쪽지시험.

- **Where the list stands:** p.17 (あ행) is complete — items 1–20 (`青い` … `以上`) went in 2026-09-14 as batch 1 (#10), items 21–39 (`急ぐ` … `送る`) on 2026-09-15 as batch 2 (#13). Batch 3 on 2026-09-16 took p.18's left column: the あ행 tail (`起こす` … `音楽`) plus か행 through `考える`. The next batch picks up after `考える` (p.18's right column).
- `kanji.json` is the real source of truth — if a photo's range is ambiguous, cross-check what's already in the file rather than trusting the line above.
- The photos carry the owner's own handwritten progress marks (batch 1's read `1.20 9/14` — items 1–20, studied 9/14). Use them to read off where a batch begins and ends, and say which range you inferred when reporting back, so a misread is easy to catch.
- **Check for an existing entry before adding.** `word` is the uniqueness key the wrong-answer queue depends on (`QUIZ_KEY_FIELD`), so a second `安心` wouldn't merely duplicate a question — it would corrupt that tracking. Batch 1 skipped `安心` for exactly this reason; expect more overlaps as the list advances into rows the early hand-authored entries already covered.
- Entries from this list include い-adjectives and verbs (`青い`, `開ける`, `集まる`), not just the noun compounds `kanji.json` started with. That's correct — real JLPT 한자 읽기 questions cover all of them.
- A word already in `vocab.json` may still be added here: `vocab.json` quizzes meaning, `kanji.json` quizzes reading, so they drill different things. `明るい`, `洗う`, `歩く` are deliberately in both.
- Ship each batch the same way as any other change: validate (no duplicate `word` keys, every field present), `npm test`, then commit → PR → squash-merge → realign the branch.

## Content accuracy and copyright

- Vocab/grammar entries must be standard, verifiable JLPT-level content — don't invent a word/reading/meaning or a grammar pattern that isn't real.
- Never transcribe the textbook's own exercises, example sentences, or passages into `data/`. Write original example sentences for the same grammar point instead — reference the pattern/level, not the book's text.
- A **word/reading/meaning list** is on the right side of that line and may be transcribed (this is what the daily 기출 어휘 batches above do): `青い / あおい / 파랗다` is dictionary-level fact, not authored expression. What stays off-limits is the book's own sentences — its exercise items, example sentences, and reading passages.
