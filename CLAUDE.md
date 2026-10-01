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
- **Assets are cache-busted at deploy time, and the page says which build it is.** Twice the owner reported a just-shipped feature "안 보여" while the deployed files were verifiably correct — their phone was holding an `app.js` from several deploys back. `index.html` therefore references `app.js?v=dev` / `style.css?v=dev` and carries `<footer class="buildstamp">build dev</footer>`; the deploy workflow runs one `sed` that rewrites every `dev` marker to the commit SHA before the artifact is uploaded. Each build then has its own asset URL, so a cached `index.html` is the only thing that can go stale, and only until it revalidates. **This is the single exception to "no build step"** — it runs in CI only, so `npm start` and `npm test` see the plain `dev` marker and are untouched. When a report of "it isn't showing" comes in, ask what the footer says first: if it isn't the current SHA, it's cache, not code. `test/smoke.js` asserts both hooks exist, so renaming them can't silently pin phones to an old build.
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
loanword.json   [{ word, meaning }]                     katakana 외래어; quiz gives the Korean
                                                          meaning and asks for the spelling
vocab.json      [{ word, reading, meaning }]           quiz asks for meaning
kanji.json      [{ word, reading, meaning }]            same shape, quiz asks for reading instead
grammar.json    [{ sentence, meaning, choices: [4 strings], answer, note }]
reading.json    [{ passage, question, choices: [4 strings], answer, note }]
listening.json  [{ script, meaning }]                   quiz speaks `script` via Web Speech API,
                                                          distractors drawn from other entries' meanings
radical.json    { "<부수>": { name, sense, chars: [..] } }  hand-verified 부수 groups; no quiz of
                                                          its own, feeds the post-answer note
```

**Every quiz type shows an explanation after answering** (right or wrong), via `explanationFor()` in `app.js` — not just a red/green highlight. For `grammar`/`reading` this is the data's own `note` field. Write one for every new entry, and make it earn its place: quote the exact sentence/clause that decides the answer, say *why* that leads to the correct choice, and account for the wrong choices — a superseded detail (the pre-change time/floor in the 会議 passage), a statement the text contradicts, or simply "not mentioned in the passage at all". `reading.json`'s notes were rewritten to that bar in #9 because a bare sentence pointer was too thin to learn from; match them rather than regressing. The other types don't need authored notes; `explanationFor()` builds the recap straight from the entry's own fields (e.g. `word (reading) = meaning`).

`hiragana`/`katakana` cover only the base 46-character gojuon table each (no dakuten/handakuten or combination sounds yet) — extend them the same way if that's ever wanted.

`hangul` uses the **어중·어말 (aspirated) form** from 국립국어원's 외래어 표기법: か→카, た→타, ち→치, て→테, と→토. `つ`→쓰 is unchanged because the 표기법 gives it 쓰 in both positions. **Don't "correct" these back to the 어두 forms (가/다/지/데/도)** — the owner raised this on 2026-09-17 and the switch was deliberate:

- A lone kana has no word position at all, so applying the 어두 rule to it was already an arbitrary choice, not the standard being followed.
- Japanese word-initial voiceless stops sit *between* Korean 예사소리 and 거센소리, which is why perception splits; the 1986 committee judged them closer to 예사소리, and that call is still disputed.
- Decisively: the 어두 form collides with dakuten. か=가 *and* が=가, た=다 *and* だ=다, ち=지 *and* ぢ=지 — so the quiz would become unanswerable the moment が행 is added. The aspirated form keeps each pair distinct (か=카 vs が=가).

Two characters legitimately share a hangul value: お and を are both 오, because を really is pronounced /o/ in modern Japanese. That's not a bug to fix — but note `pickDistractors` doesn't dedupe, so if a future row ever duplicates a hangul value, the kana quiz can show the same choice twice (the kanji quiz's `pickReadingDistractors` already guards against this).

ん is shown as 응, a teaching convention for the isolated mora — the official rule (always ㄴ batchim) only applies to ん attached to a word.

`vocab`/`listening` use the shared `pickDistractors()` helper in `app.js` to build the 3 wrong choices at random from other entries in the same file, rather than hand-authoring distractors — keep new entries reasonably distinct in meaning so auto-picked distractors stay plausible-but-wrong, not nonsensical.

**The 외래어 quiz asks in the spelling direction, and generates its own traps.** `loanword.json` is katakana loanwords; the quiz shows the Korean meaning and asks which katakana spelling is right, because that's the direction where 장음/촉음 actually matter — reading a katakana word back to Korean would never test them. `pickSpellingDistractors`/`katakanaVariants` build the wrong choices from the answer itself: a dropped or added `ー`, the look-alike pairs ソ/ン and シ/ツ, ツ vs small ッ, and a flipped 탁점 (`スーツ` → `スーヅ`/`スーシ`/`スーッ`). A `ー` is never appended past the final mora — nobody writes `バスー`, and a choice that broken is eliminated without being read. Six of the 52 entries are short enough to yield fewer than three variants; those top up from other entries' words.

**The kanji quiz picks its distractors by shape, not at random** (`pickReadingDistractors`). Random readings let the answer be found without reading the kanji at all: `売れる` against れんしゅう/げんき/いちど is settled by the trailing れる. The picker now prefers readings sharing the word's okurigana tail (`okuriganaTail`), then a similar mora count, then the same opening mora — measured over the current data, that cut "answerable from the okurigana tail alone" from 24% to 8% and "answerable from length alone" from 43% to 1%. It also dedupes by reading, because preferring similar readings would otherwise show a homophone pair as the same choice twice (none in `kanji.json` yet — `姉`/`お姉さん` collide on *meaning*, which the kanji quiz only shows as a hint). The remaining 8% is data-bound: `売れる` is still the lone `〜れる` reading in the file, so nothing can match its tail until another arrives.

**The 한자 and 단어 quizzes both let you peek at the reading.** Tapping the word (or the cue line under it) swaps `#quiz-reveal` from "글자를 누르면 읽는 법" to the actual reading — for when a kanji is simply unreadable and guessing blind would teach nothing. The reading *is* the answer here, so the peek is deliberately not free: `quiz.peeked` makes `selectAnswer` record the item as **not** recalled even when the chosen answer is right, so it stays in the wrong-answer queue below. Without that, peeking would clear exactly the words that still need drilling.

The 단어 quiz got the same line on 2026-10-01 — the owner wants to read the kanji rather than the furigana, and the reading used to ride along in the prompt as `用事 (ようじ)`, so the kanji never had to be read at all. It is **not** penalized there: that quiz asks for the meaning, so the reading is a hint, not the answer. The rule across the app is that a reveal costs you the review-queue credit only when what it reveals *is* that quiz's answer — which is why the 한자 quiz's 뜻 힌트 is free too. `wireReveal(el, cue, value, { penalize, alsoTap })` in `app.js` is the one place this is implemented; pass `penalize: true` only in that case. 19 of `vocab.json`'s entries are kana-only (`word === reading`), and the 단어 quiz skips the cue line for those rather than offering a reveal that repeats the prompt. `renderQuestion` resets both lines, their handlers and `quiz.peeked` on every question.

**The kanji quiz's meaning is a hint, not part of the prompt.** It used to sit in the hint line (`읽는 법을 고르세요 (뜻: …)`), which for a half-known word handed over the reading before the question was read; the owner asked for it behind a tap on 2026-09-24. `#quiz-meaning` now shows `💡 뜻 힌트` and swaps to the meaning on tap. Unlike the reading peek it deliberately does **not** set `quiz.peeked` — the meaning isn't the answer in a 한자 읽기 question, so using it is still recall. Its CSS sets no `display`, so `[hidden]` keeps working (the `.quiz-replay` trap).

**한자·단어 quizzes cross-link words that share a character.** The owner's observation on 2026-10-01 — knowing the base kanji helps infer a compound's meaning — measured out like this over the 273 words then in `kanji.json` + `vocab.json`: 257 distinct characters, only 68 of them in more than one word, and you would need the top 150 to cover 72% of the kanji entries. A separate 낱자 quiz is therefore close to as much memorisation as the words themselves and was **not** built. What was: 59% of 한자 questions and 39% of 단어 questions already share a character with another word in the data, so `relatedWordLines()` appends lines like `社: 会社(회사), 社会(사회)` to the post-answer note and lets the character's sense come out by triangulation.

- **Derived, never authored.** A character's own meaning is nowhere in the data, and writing one would be authoring a dictionary. The index (`buildXrefIndex`, `_xrefIndex`) is built once per page load from the files in `XREF_SOURCES`, so it gets denser on its own with every daily batch and there is nothing to keep in sync.
- **Crossing the two files is the point.** `kanji.json` alone reaches 54% of 한자 questions and 23% of 단어 ones; the union reaches 59% and 39%. A word in both files is indexed once.
- **Post-answer only.** During the question it would hand over the 한자 quiz's answer — `新聞社` shown beside `会社(회사)` gives away しゃ. `withRelated()` is called from `explanationFor`, nowhere else.
- Capped at 3 characters × 2 words so the note stays a note. `test/smoke.js` asks the page what `relatedWordLines` produced and checks the note carries exactly that, including the no-shared-character case.

**The same note names the 부수 the character belongs to** (`radicalLines`, `data/<level>/radical.json`), added 2026-10-01 after the owner pointed out that the basic characters combine into new ones. They do: of the 211 characters then in `kanji.json`, 164 (78%) share a component with another. But a component plays one of two roles — the 부수 carries the meaning category, the 음부 carries the sound — and 1,306 of the 2,136 상용한자 (61%) are 形声字 built from both. The 부수 half is what helps infer a meaning, so that is what the line shows: `氵(삼수변, 물): 池 泳 海 港`.

- **`radical.json` is hand-verified, not derived — and that is the whole point.** The CHISE/IDS decomposition behind the cross-reference *cannot* give the 부수: it recurses into nested parts, so an automatic pass files `知` under `口` (really 矢), `社` under `土` (really 礻), `館` under `宀` (really 食), `集` under `木` (really 隹) and `起` under `土` (really 走). Shipping that would teach wrong facts in a study tool. The file therefore carries only groups checked one by one — **21 groups, 105 characters**, deliberately narrower than what an automatic pass would claim. Don't regenerate it from IDS.
- Invariants the data must keep: every character is one that actually appears in `kanji.json`/`vocab.json`, no character is in two groups, no group has fewer than 2 members (a lone member has no siblings to show), and a 부수 that is itself a character in the data leads its own group (`言` heads 計試誘説語話議).
- **There is also a `한자 기초` tab**, added 2026-10-02 because the owner asked for a separate study page three times and kept being answered with the in-quiz line. The note only reaches you mid-quiz and on about half the questions; the tab is where you sit and look at the groups. It renders the same `radical.json` as cards — glyph, 부수 name, sense, member count — and tapping a character shows the words it appears in, from the cross-reference index. Built on first open (`renderRadicalTab`, guarded by `_radicalTabRendered`) so its two index fetches don't delay the 오늘 체크 screen. The tab row is four buttons now and wraps 2×2 on a phone rather than shrinking the labels. `test/smoke.js` checks the page against `radical.json` itself rather than hardcoded counts, so growing the file can't leave the tab behind.
- Fires on 53% of 한자 and 52% of 단어 questions. Capped at 2 lines × 5 siblings, printed before the related-word lines (the category, then the instances). The longest note on current data is `自動車` at 6 lines, verified at 390×844 with the 다음 button still visible — `test/smoke.js` asserts that too, alongside a block that forces a word known to have a radical line, since a random round draws one only half the time.

**Wrong answers resurface in later rounds.** `QUIZ_KEY_FIELD` in `app.js` names the field that uniquely identifies an entry per quiz type (`word` for vocab/kanji, `char` for hiragana/katakana, `sentence`/`passage`/`script` for grammar/reading/listening). `recordAnswerOutcome()` adds a wrong item's key to `jlpt_wrong_items_<level>` (not day-keyed — it accumulates until mastered) and removes it once answered correctly again; `buildQuizPool()` fills a round with every currently-wrong item first, then tops up with fresh ones. It's a leaky-bucket review queue, not real spaced repetition with intervals — if that's ever wanted, it needs a due-date per item, not just a wrong/not-wrong set. A new quiz type must get an entry in `QUIZ_KEY_FIELD` (using a field that's actually unique within that file) or its wrong answers are silently never tracked.

**Round length is per quiz type.** `QUIZ_ROUND_SIZE` in `app.js` gives `hiragana`/`katakana`/`kanji` 20 questions — they're single-item recall and go fast — and every other type falls back to `DEFAULT_ROUND_SIZE` (10). A round is still capped at the data file's entry count, which is why 독해 asks 8: `reading.json` only has 8 entries. `test/smoke.js` asserts each type's expected round length, so changing one means updating `EXPECTED_ROUND_SIZE` there too (and 독해's 8 becomes 10 once `reading.json` passes 10 entries).

**Finishing a quiz can auto-check the daily checklist.** `CHECKLIST_AUTO_MAP` in `app.js` maps each quiz type to a `CHECKLIST_ITEMS` index; completing a mapped quiz ticks that box for today if it isn't already (never unticks). `전날 내용 복습` (index 3) has no quiz proxy and stays manual-only — don't force a mapping onto it just to make everything automatic. If a new quiz type is added, decide whether it belongs in this map too.

**Listening quiz depends on the browser's Web Speech API** (`speechSynthesis`, `lang: "ja-JP"`) — there are no audio files. This means quality depends on whatever Japanese TTS voice the visitor's browser/OS provides (works well on Chrome desktop; may be silent or absent elsewhere). It degrades gracefully either way: the transcript is always revealed in the note after answering, so the quiz stays usable without audio.

## Daily 기출 어휘 batches (ongoing)

The owner is working through the 동양북스 textbook's **기출 어휘 → もんだい1 한자 읽기** list at roughly 20 words a day, photographing the page after each day's study. Each photo gets transcribed into `data/n4/kanji.json` so exactly those words come up in the 한자 쪽지시험.

- **Where the list stands:** p.17 (あ행) is complete — items 1–20 (`青い` … `以上`) went in 2026-09-14 as batch 1 (#10), items 21–39 (`急ぐ` … `送る`) on 2026-09-15 as batch 2 (#13). Batch 3 on 2026-09-16 took p.18's left column: the あ행 tail (`起こす` … `音楽`) plus か행 through `考える`. Batch 4 on 2026-09-21 took the middle column, `北` … `声`. Batch 5 on 2026-09-22 took p.19's left column, `氷` … `女性` — the か행 tail (`氷`/`心`/`答える`/`今度`) plus さ행 through `女性`, skipping `出発` (already in the file from the early hand-authored entries). Batch 6 on 2026-09-30 finished p.19: `知る` (that column's last row) plus the whole right column, `白い` … `中止` — さ행's tail and た행 through `中止`, 25 entries, no overlap with anything already in the file. The next batch starts on p.20.
- `kanji.json` is the real source of truth — if a photo's range is ambiguous, cross-check what's already in the file rather than trusting the line above.
- The photos carry the owner's own handwritten progress marks (batch 1's read `1.20 9/14` — items 1–20, studied 9/14). Use them to read off where a batch begins and ends, and say which range you inferred when reporting back, so a misread is easy to catch.
- **Check for an existing entry before adding.** `word` is the uniqueness key the wrong-answer queue depends on (`QUIZ_KEY_FIELD`), so a second `安心` wouldn't merely duplicate a question — it would corrupt that tracking. Batch 1 skipped `安心` for exactly this reason; expect more overlaps as the list advances into rows the early hand-authored entries already covered.
- Entries from this list include い-adjectives and verbs (`青い`, `開ける`, `集まる`), not just the noun compounds `kanji.json` started with. That's correct — real JLPT 한자 읽기 questions cover all of them.
- A word already in `vocab.json` may still be added here: `vocab.json` quizzes meaning, `kanji.json` quizzes reading, so they drill different things. `明るい`, `洗う`, `歩く` are deliberately in both.
- **This list is a parallel track, not a schedule gate.** The 2026-09-13 plan put 문자·어휘 first as a block to finish before 문법 started, but a 기출 어휘 list has no finish line — so everything else waited behind it and nothing but kanji got studied for eleven days. `STUDY_PLAN.md`/`plan.json` were rebuilt on 2026-09-24 around that: the 20-a-day batch is a fixed daily background slot, and the week's main block runs independently of it. Don't reschedule the plan so that a later block depends on this list being "done".
- Ship each batch the same way as any other change: validate (no duplicate `word` keys, every field present), `npm test`, then commit → PR → squash-merge → realign the branch.

## Content accuracy and copyright

- Vocab/grammar entries must be standard, verifiable JLPT-level content — don't invent a word/reading/meaning or a grammar pattern that isn't real.
- Never transcribe the textbook's own exercises, example sentences, or passages into `data/`. Write original example sentences for the same grammar point instead — reference the pattern/level, not the book's text.
- **What the line actually rests on is publishing, not the words.** The owner pushed back on this (2026-09-21) and was right: vocabulary, readings and meanings are facts about the language, nobody's property, and JLPT publishes no official word list — so transcribing them was never the issue, and `loanword.json`'s 52 words are as fine as any daily batch. Two things do matter. **Scope:** any single drill item is too short and too obvious to be anyone's property, but lifting a whole exercise set item by item reproduces the *compilation*, which is the book's work. **Use:** copying a textbook for your own study is ordinary private use; this app is a public repo on public Pages, so the same copy becomes distribution. Treat a scan as a source of words, not as a set of questions to mirror, and the rest follows.
- Generating the 외래어 distractors was the better design regardless — the book's decoys vary item to item, while `katakanaVariants` hits 장음/촉음/탁점 systematically every round. Don't present it as merely a legal workaround.
- A **word/reading/meaning list** is on the right side of that line and may be transcribed (this is what the daily 기출 어휘 batches above do): `青い / あおい / 파랗다` is dictionary-level fact, not authored expression. What stays off-limits is the book's own sentences — its exercise items, example sentences, and reading passages.
