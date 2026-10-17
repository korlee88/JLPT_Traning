const CURRENT_LEVEL = "n4"; // active JLPT level; see data/levels.json. Switch this (and eventually add a picker) once a new level's data/<level>/ folder exists.
const QUIZ_RESULTS_KEY = `jlpt_quiz_results_${CURRENT_LEVEL}`;
const QUIZ_TYPE_LABELS = {
  hiragana: "히라가나 쪽지시험",
  katakana: "가타카나 쪽지시험",
  loanword: "외래어 쪽지시험",
  vocab: "단어 쪽지시험",
  kanji: "한자 쪽지시험",
  grammar: "문법 쪽지시험",
  reading: "독해 쪽지시험",
  listening: "청해 쪽지시험",
};
// The field that uniquely identifies an entry within each quiz type's data
// file, used to track which specific items were answered wrong (see
// REVIEW_KEY / buildQuizPool) so they come back on schedule.
const QUIZ_KEY_FIELD = {
  hiragana: "char",
  katakana: "char",
  loanword: "word",
  vocab: "word",
  kanji: "word",
  grammar: "sentence",
  reading: "passage",
  listening: "script",
};
const WRONG_ITEMS_KEY = `jlpt_wrong_items_${CURRENT_LEVEL}`; // pre-2026-10-16 queue, migrated once
const REVIEW_KEY = `jlpt_review_${CURRENT_LEVEL}`;
// Days until an item comes back, indexed by its Leitner box. Each correct recall
// moves it one box up; any miss drops it straight back to box 0, due the same day.
// Six boxes reach 외움 after 0+1+3+7+14 = 25 days of correct recalls, so a word
// learned today can get there twice over before the exam.
const REVIEW_INTERVALS = [0, 1, 3, 7, 14, 30];
const MASTERED_BOX = REVIEW_INTERVALS.length - 1;
// Questions per round. Five, for every type (2026-10-15). 2026-10-08 took the
// three 20s down to 10 and 독해/청해 to 5 against "다하기 많네"; a week of the plan
// put the rest at 5 too. The unit of work is the day — eight quizzes beside the
// day's main block — not one round, and five questions is what actually gets done
// daily. A round is still capped at the number of entries the data file has.
//
// QUIZ_ROUND_SIZE is empty on purpose rather than deleted: it is the per-type
// override and has been used twice in the last week, so this records "nothing
// differs right now" instead of removing a mechanism that keeps coming back.
const DEFAULT_ROUND_SIZE = 5;
const QUIZ_ROUND_SIZE = {};

function roundSizeFor(type) {
  return QUIZ_ROUND_SIZE[type] || DEFAULT_ROUND_SIZE;
}
// How much of a round the review queue may take (see buildQuizPool). Half
// keeps missed items coming back often without crowding out new material.
const REVIEW_SHARE = 0.5;

// Local-clock arithmetic on a YYYY-MM-DD string, the same way todayStr() formats
// one. Never via toISOString(), for the reason stated above it.
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + n);
  return todayStr(d);
}

function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}



function findWeek(dateStr, weeks) {
  return weeks.find((w) => dateStr >= w.start && dateStr <= w.end) || null;
}

function daysUntil(dateStr) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const target = new Date(dateStr + "T00:00:00");
  return Math.round((target - today) / 86400000);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- Tabs ----------
function setupTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
      btn.classList.add("active");
      document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");
      if (btn.dataset.tab === "radical") renderRadicalTab();
      // Not guarded like renderRadicalTab: the counts move with every round, so
      // this repaints each time the tab is opened. Still not at startup — its
      // fetches would delay the 오늘 체크 screen for a list nobody is looking at.
      if (btn.dataset.tab === "quiz") renderWrongNote();
    });
  });
}

// ---------- 한자 기초 tab ----------
// A browsable view of the same radical.json the post-answer note draws on. The
// note only reaches you mid-quiz and on about half the questions; this is the
// place to actually sit and look at the groups. Built on first open rather than
// at startup, so the two index fetches don't delay the 오늘 체크 screen.
let _radicalTabRendered = false;

async function renderRadicalTab() {
  if (_radicalTabRendered) return;
  const container = document.getElementById("radical-groups");
  const [, xref] = await Promise.all([buildRadicalIndex(), buildXrefIndex()]);
  const groups = new Map();
  for (const [char, g] of _radicalIndex) {
    if (!groups.has(g.rad)) groups.set(g.rad, { name: g.name, sense: g.sense, base: g.base, chars: [] });
    groups.get(g.rad).chars.push(char);
  }

  for (const [rad, g] of groups) {
    const card = document.createElement("div");
    card.className = "card";

    const head = document.createElement("div");
    head.className = "radical-head";
    const glyph = document.createElement("span");
    glyph.className = "radical-glyph";
    glyph.lang = "ja";
    // A variant radical gets its standalone parent beside it: 礻 (示). U+793B and
    // friends are rare codepoints that some phones render from a fallback font,
    // so the glyph can come out looking unlike the same part inside 社 — which is
    // exactly what the owner hit. 示 is a common character every CJK font has, so
    // it anchors what the radical is even when the variant glyph renders oddly.
    glyph.textContent = g.base ? `${rad} (${g.base})` : rad;
    const name = document.createElement("span");
    name.className = "radical-name";
    name.textContent = `${g.name} · ${g.sense} · ${g.chars.length}자`;
    head.append(glyph, name);

    const row = document.createElement("div");
    row.className = "radical-chars";
    row.lang = "ja";
    const words = document.createElement("p");
    words.className = "radical-words";
    words.lang = "ja";
    words.hidden = true;

    for (const c of g.chars) {
      const btn = document.createElement("button");
      btn.className = "radical-char";
      btn.textContent = c;
      btn.onclick = () => {
        const wasOpen = btn.classList.contains("open");
        row.querySelectorAll(".radical-char.open").forEach((b) => b.classList.remove("open"));
        if (wasOpen) {
          words.hidden = true;
          return;
        }
        btn.classList.add("open");
        const found = (xref.get(c) || []).map(labelFor);
        words.textContent = found.length ? `${c} — ${found.join(", ")}` : `${c} — 아직 이 글자가 쓰인 단어가 없습니다`;
        words.hidden = false;
      };
      row.append(btn);
    }

    card.append(head, row, words);
    container.append(card);
  }
  _radicalTabRendered = true;
}

// ---------- Today tab ----------
const DAY_NAMES = ["일", "월", "화", "수", "목", "금", "토"];

// The day's own line, from the week's `days` array. Stored Monday-first because
// every week in the plan starts on a Monday and that is how the table reads;
// Date#getDay() counts from Sunday, hence the shift. Built from the date string
// the same way todayStr() produces it — local, never toISOString().
function dayTaskFor(dateStr, week) {
  if (!week || !Array.isArray(week.days)) return null;
  const weekday = new Date(`${dateStr}T00:00:00`).getDay();
  return week.days[(weekday + 6) % 7] || null;
}

function dayLabel(dateStr) {
  const [, m, d] = dateStr.split("-");
  return `${Number(m)}/${Number(d)} (${DAY_NAMES[new Date(`${dateStr}T00:00:00`).getDay()]})`;
}

// The topbar: D-day, and what to do today. The 오늘 체크 and 전체 계획 tabs this
// used to fill were removed on 2026-10-17 — the owner had been looking at them
// for four days and called them "쓸대없는 모니터". The plan itself stays in
// plan.json, because this one line is the part of it that was being read.
function renderTopbar(plan) {
  const today = todayStr();
  const ddayEl = document.getElementById("dday");
  const diff = daysUntil(plan.examDate);
  ddayEl.textContent = diff > 0 ? `시험까지 D-${diff}` : diff === 0 ? "오늘이 시험일입니다!" : "시험이 종료되었습니다";

  const week = findWeek(today, plan.weeks);
  const taskEl = document.getElementById("today-task");
  const task = dayTaskFor(today, week);
  if (task) {
    taskEl.textContent = `${dayLabel(today)} · ${task}`;
  } else if (today < plan.startDate && plan.preStart) {
    taskEl.textContent = plan.preStart;
  } else {
    taskEl.textContent = "";
  }
  taskEl.hidden = !taskEl.textContent;
}

// ---------- Quiz tab ----------
// Replays per listening question. The exam plays each clip once; unlimited
// replays here turned 청해 into a transcription exercise you could grind at.
const MAX_REPLAYS = 1;
const quiz = {
  type: null, pool: [], index: 0, score: 0, allItems: [],
  replays: 0, slowReplays: 0, answered: false, wrongOnly: false,
};

// Replays left at `speed` on the current question. The slow pass keeps its own
// budget because it tests a different thing — parsing a sentence you couldn't
// catch at speed is still listening, where a second pass at full speed is just
// another go at the same attempt.
//
// After answering both are unlimited. The cap exists to stop the question
// becoming a transcription exercise you can grind at; once the answer and the
// transcript are both on screen there is nothing left to grind, and replaying
// while reading the script is the most useful moment in the whole question.
function replaysLeft(speed) {
  if (quiz.answered) return Infinity;
  return MAX_REPLAYS - (speed === "slow" ? quiz.slowReplays : quiz.replays);
}

// Repaints both 다시 듣기 buttons for what's left on the current question.
function renderReplayButtons() {
  const normal = document.getElementById("quiz-replay");
  const slow = document.getElementById("quiz-replay-slow");
  const n = replaysLeft("normal");
  const sl = replaysLeft("slow");
  normal.disabled = n <= 0;
  slow.disabled = sl <= 0;
  normal.textContent = quiz.answered ? "🔊 다시 듣기" : `🔊 다시 듣기 (${n}회)`;
  slow.textContent = quiz.answered ? "🐢 천천히 듣기" : `🐢 천천히 (${sl}회)`;
}

function playCurrentScript(speed) {
  const item = quiz.pool[quiz.index];
  if (!item || !item.script || replaysLeft(speed) <= 0) return;
  if (!quiz.answered) {
    if (speed === "slow") quiz.slowReplays += 1;
    else quiz.replays += 1;
  }
  speak(item.script, speed === "slow" ? SLOW_SPEECH_RATE : SPEECH_RATE);
  renderReplayButtons();
}

function setupQuiz() {
  document.getElementById("start-hiragana").addEventListener("click", () => startQuiz("hiragana"));
  document.getElementById("start-katakana").addEventListener("click", () => startQuiz("katakana"));
  document.getElementById("start-loanword").addEventListener("click", () => startQuiz("loanword"));
  document.getElementById("start-vocab").addEventListener("click", () => startQuiz("vocab"));
  document.getElementById("start-kanji").addEventListener("click", () => startQuiz("kanji"));
  document.getElementById("start-grammar").addEventListener("click", () => startQuiz("grammar"));
  document.getElementById("start-reading").addEventListener("click", () => startQuiz("reading"));
  document.getElementById("start-listening").addEventListener("click", () => startQuiz("listening"));
  document.getElementById("quiz-next").addEventListener("click", nextQuestion);
  document.getElementById("quiz-replay").addEventListener("click", () => playCurrentScript("normal"));
  document.getElementById("quiz-replay-slow").addEventListener("click", () => playCurrentScript("slow"));
  document.getElementById("quiz-retry").addEventListener("click", () => {
    document.getElementById("quiz-result").hidden = true;
    document.getElementById("quiz-start").hidden = false;
    renderQuizStartStatus();
    renderWrongNote();
  });
  renderQuizStartStatus();
}

// Above the default 1.0: real 청해 audio runs at natural conversational speed,
// and the default TTS rate is slower than that, so the quiz was easier than the
// exam. 1.15 is faster without blurring — the transcript is in the note either way.
const SPEECH_RATE = 1.15;
// The 천천히 듣기 pass, for a sentence that went by too fast to parse. Slow
// enough to separate the moras, not so slow the pitch accent falls apart.
const SLOW_SPEECH_RATE = 0.7;
// The answer read aloud after you pick one. Back at the plain default, not 청해's
// 1.15: that rate exists to match exam audio, and this isn't a listening test —
// it's "so how is this actually pronounced", where clarity is the whole job.
const ANSWER_SPEECH_RATE = 1.0;

function speak(text, rate = SPEECH_RATE) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = "ja-JP";
  utter.rate = rate;
  window.speechSynthesis.speak(utter);
}

function loadQuizResults() {
  try {
    return JSON.parse(localStorage.getItem(QUIZ_RESULTS_KEY)) || {};
  } catch {
    return {};
  }
}

function saveQuizResults(data) {
  try {
    localStorage.setItem(QUIZ_RESULTS_KEY, JSON.stringify(data));
  } catch {
    /* localStorage unavailable — today's completion mark just won't persist */
  }
}

function recordQuizResult(type, score, total) {
  const today = todayStr();
  const data = loadQuizResults();
  data[today] = data[today] || {};
  data[today][type] = { score, total };
  saveQuizResults(data);
}


// Marks each quiz-type button with today's result (✓ + score), if it's been
// taken today. Resets naturally at midnight since it's keyed by todayStr().
function renderQuizStartStatus() {
  const todayResults = loadQuizResults()[todayStr()] || {};
  document.querySelectorAll(".quiz-type-btn").forEach((btn) => {
    const type = btn.dataset.type;
    const label = QUIZ_TYPE_LABELS[type];
    const result = todayResults[type];
    if (result) {
      btn.textContent = `✓ ${label} (${result.score}/${result.total})`;
      btn.classList.add("done-today");
    } else {
      btn.textContent = label;
      btn.classList.remove("done-today");
    }
  });
}

// ---------- 오답 노트 ----------
// The wrong-answer queue has been steering review rounds since #33, but you could
// never *see* it: the only way to learn what you keep missing was to keep missing
// it. This renders the queue itself — per quiz type, with a button to run a round
// of nothing but those items. It is also the short answer to "다하기 많네"
// (2026-10-08): drilling the six words you actually got wrong beats redoing eight
// full quizzes to meet them again.
let _wrongData = {}; // type -> entries, so reopening the note doesn't refetch

async function wrongEntriesFor(type) {
  if (!_wrongData[type]) {
    _wrongData[type] = await fetch(`data/${CURRENT_LEVEL}/${type}.json`).then((r) => r.json());
  }
  return _wrongData[type];
}

// One line per missed item. The word-shaped types reuse the post-answer recap's
// own first line rather than formatting it again, so the two can't drift; the
// lines explanationFor puts under it (부수, 같은 글자를 쓰는 단어) belong in a note
// and not in a list. The three sentence-shaped types need their own label — a
// 문법 note is a paragraph, and what identifies a 독해 entry in a list is its
// question, not the translation that heads its recap.
function reviewLine(type, item) {
  switch (type) {
    case "grammar":
      return `${answerSpeech(type, item)} — ${item.meaning}`;
    case "reading":
      return `${item.question} — ${item.answer}`;
    case "listening":
      return `${item.script} — ${item.meaning}`;
    default:
      return (explanationFor(type, item) || "").split("\n")[0];
  }
}

// Quiz labels without the "쪽지시험" tail — derived rather than kept as a second
// table, which would be one more pair of things to hold in sync.
function shortTypeLabel(type) {
  return QUIZ_TYPE_LABELS[type].replace(" 쪽지시험", "");
}

async function renderWrongNote() {
  const groupsEl = document.getElementById("wrong-groups");
  const emptyEl = document.getElementById("wrong-empty");
  const totalEl = document.getElementById("wrong-total");
  const progressEl = document.getElementById("wrong-progress");
  const store = loadReview();
  const today = todayStr();
  groupsEl.innerHTML = "";
  let total = 0;
  let learningAll = 0;
  let masteredAll = 0;
  let pruned = false;

  // Object.keys(QUIZ_TYPE_LABELS) rather than the store's own key order, so the
  // groups come out in the same order as the quiz buttons above them.
  for (const type of Object.keys(QUIZ_TYPE_LABELS)) {
    const schedule = store.types[type];
    if (!schedule || !Object.keys(schedule).length) continue;
    const entries = await wrongEntriesFor(type);
    const keyField = QUIZ_KEY_FIELD[type];
    const byKey = new Map(entries.map((e) => [e[keyField], e]));

    // A key whose entry has since left the data file can never come up again, so
    // it would sit in the schedule forever and make the counts disagree with the
    // list. Dropped here, where the file is already loaded.
    for (const k of Object.keys(schedule)) {
      if (!byKey.has(k)) {
        delete schedule[k];
        pruned = true;
      }
    }
    const keys = Object.keys(schedule);
    if (!keys.length) continue;

    const due = dueKeys(schedule, today);
    const mastered = keys.filter((k) => schedule[k].box >= MASTERED_BOX).length;
    const learning = keys.length - mastered;
    learningAll += learning;
    masteredAll += mastered;
    // A card per type with something due *now*. Eight cards reading "오늘 0개"
    // would bury the one that has work in it; the running totals go in the one
    // progress line under the heading instead.
    if (!due.length) continue;
    total += due.length;

    const group = document.createElement("div");
    group.className = "wrong-group";

    // The drill button stays outside the collapsible part: it is the reason the
    // note exists, and burying the one action behind a tap to expand would undo
    // the point of it. Only the list collapses — a 40-word 한자 queue would
    // otherwise push the quiz buttons it sits under off the screen.
    const head = document.createElement("div");
    head.className = "wrong-head";
    const name = document.createElement("span");
    name.className = "wrong-name";
    name.textContent = `${shortTypeLabel(type)} 오늘 ${due.length}개`;
    const drill = document.createElement("button");
    drill.className = "btn wrong-drill";
    drill.dataset.type = type;
    drill.textContent = `오늘 복습 (${Math.min(due.length, roundSizeFor(type))}문제)`;
    drill.addEventListener("click", () => startQuiz(type, { wrongOnly: true }));
    head.append(name, drill);
    group.append(head);

    // What the boxes are actually for: a word is not done the first time you get
    // it right, and this is where that shows.
    const sub = document.createElement("p");
    sub.className = "wrong-sub";
    sub.textContent = `외우는 중 ${learning}개 · 외움 ${mastered}개`;
    group.append(sub);

    const detail = document.createElement("details");
    detail.className = "wrong-detail";
    const summary = document.createElement("summary");
    summary.textContent = "목록 보기";
    detail.append(summary);
    const list = document.createElement("ul");
    list.className = "wrong-list";
    list.lang = "ja";
    for (const k of due) {
      const li = document.createElement("li");
      li.textContent = reviewLine(type, byKey.get(k));
      list.append(li);
    }
    detail.append(list);
    group.append(detail);
    groupsEl.append(group);
  }

  if (pruned) saveReview(store);
  totalEl.textContent = total ? `(${total})` : "";
  // Shown even on a day with nothing due, because "외움 12개" is the answer to
  // "am I getting anywhere" and a day off from reviews is not a day of no progress.
  progressEl.textContent = `외우는 중 ${learningAll}개 · 외움 ${masteredAll}개`;
  progressEl.hidden = learningAll + masteredAll === 0;
  emptyEl.hidden = groupsEl.children.length > 0;
}

// Deduped by value, not just filtered against the answer. Entries can legitimately
// share one: お/を are both 오, and 탁음 brought じ/ぢ (지) and ず/づ (즈) with it,
// since those really are homophones in modern Japanese. Without the dedupe a kana
// round could render 지 as two separate choices.
function pickDistractors(items, correctValue, field) {
  const seen = new Set([correctValue]);
  return shuffle(items)
    .filter((v) => !seen.has(v[field]) && seen.add(v[field]))
    .slice(0, 3)
    .map((v) => v[field]);
}

// Near-miss katakana spellings, for the 외래어 quiz. The whole skill being
// tested is spelling, so the wrong choices have to be the traps learners
// actually fall into: a dropped or added 장음 ー (パートタイム/パトタイム),
// the visually confusable pairs ソ/ン and シ/ツ, and 촉음 ッ vs full-size ツ.
// Generating them keeps loanword.json a plain word list with nothing authored.
// Shapes that look alike (ソ/ン, シ/ツ), size (ツ/ッ), and voicing — a missing
// or stray 탁점 is one of the commonest spelling slips.
const KATAKANA_SWAPS = [
  "ソン", "シツ", "ツッ", "クケ",
  "カガ", "キギ", "クグ", "ケゲ", "コゴ", "サザ", "シジ", "スズ", "セゼ", "ソゾ",
  "タダ", "チヂ", "ツヅ", "テデ", "トド", "ハバ", "ヒビ", "フブ", "ヘベ", "ホボ",
];

function katakanaVariants(word) {
  const chars = [...word];
  const last = chars.length - 1;
  const variants = new Set();
  chars.forEach((c, i) => {
    if (c === "ー") {
      variants.add(chars.filter((_, j) => j !== i).join("")); // dropped 장음
    } else if (i !== last && chars[i + 1] !== "ー") {
      // Added 장음 — but never past the final mora: nobody writes バスー, and a
      // choice that obviously broken is eliminated without reading it.
      const lengthened = [...chars];
      lengthened.splice(i + 1, 0, "ー");
      variants.add(lengthened.join(""));
    }
    for (const pair of KATAKANA_SWAPS) {
      const swap = c === pair[0] ? pair[1] : c === pair[1] ? pair[0] : null;
      if (!swap) continue;
      const swapped = [...chars];
      swapped[i] = swap;
      variants.add(swapped.join(""));
    }
  });
  variants.delete(word);
  return [...variants];
}

// Three wrong spellings for `item`, topped up from other entries' words on the
// rare short word that yields fewer than three variants of its own.
function pickSpellingDistractors(items, item) {
  const picked = shuffle(katakanaVariants(item.word)).slice(0, 3);
  if (picked.length < 3) {
    const seen = new Set([item.word, ...picked]);
    for (const other of shuffle(items)) {
      if (picked.length === 3) break;
      if (!seen.has(other.word)) {
        picked.push(other.word);
        seen.add(other.word);
      }
    }
  }
  return picked;
}

// Trailing hiragana of a word: 売れる -> "れる", 重い -> "い", 会場 -> "".
function okuriganaTail(word) {
  const match = word.match(/[぀-ゟ]+$/);
  return match ? match[0] : "";
}

// Distractor readings for the kanji quiz. Picking them at random made the
// answer guessable without reading the kanji at all — 売れる against
// れんしゅう/げんき/いちど is decided by the trailing れる alone. This prefers
// readings that survive that shortcut: same okurigana tail first, then a
// similar mora count, then the same opening mora. Shuffling before the sort
// keeps equally-good candidates from always landing in the same order.
function pickReadingDistractors(items, item) {
  const answer = item.reading;
  const tail = okuriganaTail(item.word);
  const score = (reading) => {
    let s = 0;
    if (tail) s += reading.endsWith(tail) ? 4 : -2;
    s += Math.max(0, 3 - Math.abs(reading.length - answer.length));
    if (reading[0] === answer[0]) s += 1;
    return s;
  };
  // Dedupe by reading: preferring similar readings makes homophones likely to
  // be picked together, which would show the same choice twice.
  const seen = new Set([answer]);
  return shuffle(items)
    .filter((v) => !seen.has(v.reading) && seen.add(v.reading))
    .sort((a, b) => score(b.reading) - score(a.reading))
    .slice(0, 3)
    .map((v) => v.reading);
}

// { version: 1, types: { <quizType>: { <itemKey>: { box, due } } } }
//
// Replaces the wrong/not-wrong set this app ran on until 2026-10-16. That set
// had one defect that no amount of tuning could reach: **a single correct answer
// retired a word permanently.** In a 4-choice quiz a pure guess is right a
// quarter of the time, so an item you do not know leaves the queue after four
// encounters on average — measured over the shipped code, 60 simulated days of
// guessing retired 29 kanji that way. That is what "반복해서 봐도 잘 안 외워진다"
// feels like from the inside: the app kept declaring victory on your behalf.
function loadReview() {
  let store = null;
  try {
    store = JSON.parse(localStorage.getItem(REVIEW_KEY));
  } catch {
    store = null;
  }
  if (!store || store.version !== 1 || !store.types) store = { version: 1, types: {} };

  // One-time merge of the pre-2026-10-16 queue. Everything it held was by
  // definition not yet learned, so it all starts in box 0, due today.
  // WRONG_ITEMS_KEY is left where it is rather than deleted — it costs nothing
  // and is the only copy of that history.
  //
  // The guard is `store.migrated`, NOT "does a schedule exist yet": an empty
  // schedule gets written the first time any screen reads one, which on a phone
  // can easily happen before the legacy key is ever looked at. Keying off
  // existence meant a real queue could be skipped and silently lost.
  if (!store.migrated) {
    let legacy = {};
    try {
      legacy = JSON.parse(localStorage.getItem(WRONG_ITEMS_KEY)) || {};
    } catch {
      legacy = {};
    }
    const today = todayStr();
    for (const [type, keys] of Object.entries(legacy)) {
      if (!Array.isArray(keys)) continue;
      const forType = (store.types[type] = store.types[type] || {});
      // never knock a real schedule entry back to box 0
      for (const k of keys) if (!forType[k]) forType[k] = { box: 0, due: today };
    }
    store.migrated = true;
    saveReview(store);
  }
  return store;
}

function saveReview(data) {
  try {
    localStorage.setItem(REVIEW_KEY, JSON.stringify(data));
  } catch {
    /* localStorage unavailable — the schedule just won't persist */
  }
}

// Moves an item through the boxes. Right: up one, and the next sighting is
// REVIEW_INTERVALS[box] days out. Wrong: straight back to box 0, due today.
// A first correct answer lands in box 1 (tomorrow) rather than retiring the
// item — which is the whole change.
function recordAnswerOutcome(type, itemKey, correct) {
  if (!itemKey) return;
  const store = loadReview();
  const forType = (store.types[type] = store.types[type] || {});
  const prev = forType[itemKey];
  const box = correct ? Math.min((prev ? prev.box : 0) + 1, MASTERED_BOX) : 0;
  forType[itemKey] = { box, due: addDays(todayStr(), REVIEW_INTERVALS[box]) };
  saveReview(store);
}

// The keys of `schedule` that are due today or overdue, most overdue first and
// then lowest box — the words you keep missing come before the ones merely
// scheduled for today.
function dueKeys(schedule, today = todayStr()) {
  // Shuffled BEFORE the sort, which Array#sort then preserves because it is
  // stable: priority still decides across different (due, box) pairs, and ties
  // come out in a fresh order every call.
  //
  // Without the shuffle this returned Object.keys order, and after the migration
  // every item was (box 0, due today) — one single tie covering the whole queue.
  // The round's two review slots therefore served the same two words every day,
  // for ever, which is exactly what "매일같은게 보임" was (2026-10-17). The bug
  // was mine, from the day before.
  return shuffle(Object.keys(schedule).filter((k) => schedule[k].due <= today))
    .sort((a, b) => {
      const x = schedule[a];
      const y = schedule[b];
      return x.due === y.due ? x.box - y.box : x.due < y.due ? -1 : 1;
    });
}

// Fills a round: whatever the schedule says is due, up to REVIEW_SHARE of it,
// then material you have never been asked. The cap is the old lesson and still
// holds — the first version took `size` review items, so once the queue held a
// round's worth every round was 100% review and a word added today could not
// come up until every earlier mistake cleared.
//
// What the schedule adds is the other half of that: an item that is scheduled
// but **not due yet** is deliberately skipped. Pulling it early is exactly what
// spacing exists to avoid, and before this the app had no way to express
// "ask me about this one on Thursday".
function buildQuizPool(items, keyField, size, schedule = {}) {
  if (!keyField) return shuffle(items).slice(0, size);
  const today = todayStr();
  const due = [];
  const notDue = [];
  const unseen = [];
  for (const v of items) {
    const entry = schedule[v[keyField]];
    if (!entry) unseen.push(v);
    else if (entry.due <= today) due.push(v);
    else notDue.push({ v, due: entry.due });
  }
  const order = dueKeys(schedule, today);
  const rank = new Map(order.map((k, i) => [k, i]));
  due.sort((a, b) => rank.get(a[keyField]) - rank.get(b[keyField]));
  notDue.sort((a, b) => (a.due < b.due ? -1 : 1));

  // floor, not round: at a round of 5 rounding would hand review 3 of the 5
  // slots, which is more than half — the exact thing REVIEW_SHARE is here to
  // bound. Even round sizes come out the same either way.
  const reviewCap = Math.max(1, Math.floor(size * REVIEW_SHARE));
  const pool = due.slice(0, reviewCap);
  for (const v of shuffle(unseen)) {
    if (pool.length >= size) break;
    pool.push(v);
  }
  // Only once the file cannot fill the round: overflow review, then items whose
  // day has not come. A short round would be worse than either.
  for (const v of due.slice(reviewCap)) {
    if (pool.length >= size) break;
    pool.push(v);
  }
  for (const x of notDue) {
    if (pool.length >= size) break;
    pool.push(x.v);
  }
  return shuffle(pool);
}

// Which quiz types get the "같은 글자를 쓰는 다른 단어" line, and which files the
// related words are drawn from. Crossing kanji.json with vocab.json is what makes
// it worth having: measured over the current data it lifts the share of questions
// that can show anything from 54% to 59% for 한자, and 23% to 39% for 단어.
const XREF_TYPES = ["kanji", "vocab"];
// Types that want the word index for a tap gloss but not the xref note itself.
const GLOSS_TYPES = ["reading"];
const XREF_SOURCES = ["kanji", "vocab"];
let _xrefIndex = null; // char -> [{ word, reading, meaning }], built once per page load
let _wordIndex = null; // word -> { word, reading, meaning }, from the same files
let _radicalIndex = null; // char -> { rad, name, sense, siblings[] }

const CJK = /[\u4E00-\u9FFF]/gu;

async function buildXrefIndex() {
  if (_xrefIndex) return _xrefIndex;
  const files = await Promise.all(
    XREF_SOURCES.map((t) => fetch(`data/${CURRENT_LEVEL}/${t}.json`).then((r) => r.json()))
  );
  const index = new Map();
  const words = new Map();
  const seen = new Set();
  for (const item of files.flat()) {
    if (seen.has(item.word)) continue; // a word in both files is one entry here
    seen.add(item.word);
    words.set(item.word, item);
    for (const c of new Set(item.word.match(CJK) || [])) {
      if (!index.has(c)) index.set(c, []);
      index.get(c).push({ word: item.word, reading: item.reading, meaning: item.meaning });
    }
  }
  _xrefIndex = index;
  _wordIndex = words;
  return index;
}

// The Korean meaning of a tapped word, when the data already knows that exact
// word. **Exact match only, deliberately.** The misses are single characters
// mid-inflection (痛 out of 痛かった, 行 out of 行きます), and guessing a
// dictionary form to look up would eventually attach the wrong meaning to a
// character — 行く vs 行う is the same trap the per-passage furigana exists to
// avoid, and a wrong fact in a study tool is worse than a missing one. Where
// there is no match the reading alone still shows, so the tap is never dead.
function glossFor(word) {
  const hit = _wordIndex && _wordIndex.get(word);
  return hit ? hit.meaning : null;
}

// data/<level>/radical.json is a hand-verified table, not a derived one. The IDS
// decomposition that powers the cross-reference above cannot give the semantic
// radical: it recurses into nested parts, so it files 知 under 口 (really 矢), 社
// under 土 (really 礻) and 館 under 宀 (really 食). Those would teach the wrong
// thing, so the file only carries groups checked by hand — narrow on purpose.
async function buildRadicalIndex() {
  if (_radicalIndex) return _radicalIndex;
  const groups = await fetch(`data/${CURRENT_LEVEL}/radical.json`).then((r) => r.json());
  const index = new Map();
  for (const [rad, g] of Object.entries(groups)) {
    for (const c of g.chars) {
      index.set(c, { rad, name: g.name, sense: g.sense, base: g.base, siblings: g.chars.filter((x) => x !== c) });
    }
  }
  _radicalIndex = index;
  return index;
}

// Lines like "氵(삼수변·물): 池 泳 海 港" — the category the character belongs to,
// which is the half of a 形声字 that carries meaning. Deduped by radical, so 洗濯
// yields one line rather than the same one twice.
function radicalLines(word) {
  if (!_radicalIndex) return [];
  const lines = [];
  const seen = new Set();
  for (const c of new Set(word.match(CJK) || [])) {
    const g = _radicalIndex.get(c);
    if (!g || seen.has(g.rad) || !g.siblings.length) continue;
    seen.add(g.rad);
    lines.push(`${g.rad}(${g.name}, ${g.sense}): ${g.siblings.slice(0, 5).join(" ")}`);
    if (lines.length === 2) break;
  }
  return lines;
}

// "会社(かいしゃ, 회사)" — the reading is in there because the owner is still
// learning to read these: a bare 会社(회사) is no use if you can't read 会社. A
// kana-only vocab entry has reading === word, so it shows the word alone rather
// than repeating itself.
function labelFor(entry) {
  const reading = entry.reading && entry.reading !== entry.word ? `${entry.reading}, ` : "";
  return `${entry.word}(${reading}${entry.meaning})`;
}

// Lines like "社: 会社(かいしゃ, 회사)" — the meaning of a character isn't stored
// anywhere, and inventing one would be authoring a dictionary; showing the words it
// already appears in teaches the same sense by triangulation, from data that's
// there. Capped so the note stays a note: 3 characters, 1 word each — it was 2
// until each word started carrying its reading, which roughly doubled line width.
function relatedWordLines(word) {
  if (!_xrefIndex) return [];
  const lines = [];
  for (const c of new Set(word.match(CJK) || [])) {
    const others = (_xrefIndex.get(c) || []).filter((o) => o.word !== word);
    if (!others.length) continue;
    lines.push(`${c}: ${others.slice(0, 1).map(labelFor).join(", ")}`);
    if (lines.length === 3) break;
  }
  return lines;
}

// `wrongOnly` runs a round drawn entirely from what the schedule says is due
// today — still capped at the type's round length, since the point of it is a
// short targeted session. A normal round mixes review with fresh material
// instead (buildQuizPool).
async function startQuiz(type, { wrongOnly = false } = {}) {
  const res = await fetch(`data/${CURRENT_LEVEL}/${type}.json`);
  const items = await res.json();
  if (XREF_TYPES.includes(type)) await Promise.all([buildXrefIndex(), buildRadicalIndex()]);
  // 독해 doesn't use the cross-reference note, but its tap-to-read line shows a
  // meaning when the word index has one, and that index rides along with it.
  else if (GLOSS_TYPES.includes(type)) await buildXrefIndex();
  quiz.type = type;
  quiz.allItems = items;
  const keyField = QUIZ_KEY_FIELD[type];
  const schedule = loadReview().types[type] || {};
  const roundSize = roundSizeFor(type);
  quiz.wrongOnly = wrongOnly;
  if (wrongOnly) {
    const queued = new Set(dueKeys(schedule));
    const only = items.filter((v) => queued.has(v[keyField]));
    // Cleared between opening the note and tapping the button: nothing to drill,
    // so repaint the note instead of starting an empty round.
    if (!only.length) {
      renderWrongNote();
      return;
    }
    quiz.pool = shuffle(only).slice(0, roundSize);
  } else {
    quiz.pool = buildQuizPool(items, keyField, Math.min(roundSize, items.length), schedule);
  }
  quiz.index = 0;
  quiz.score = 0;

  document.getElementById("quiz-start").hidden = true;
  document.getElementById("quiz-result").hidden = true;
  document.getElementById("quiz-play").hidden = false;
  renderQuestion();
}

// Wires one tap-to-reveal hint line. `penalize` is true only when what's being
// revealed IS the quiz's own answer — the reading in the 한자 quiz — in which
// case reading it off isn't recall and selectAnswer keeps the item in the review
// queue. A hint that isn't the answer is free: the meaning in the 한자 quiz, the
// reading in the 단어 quiz (which asks for the meaning).
function wireReveal(el, cue, value, { penalize = false, alsoTap = null } = {}) {
  el.textContent = cue;
  el.hidden = false;
  const reveal = () => {
    el.textContent = value;
    el.classList.add("revealed");
    if (penalize) quiz.peeked = true;
  };
  el.onclick = reveal;
  if (alsoTap) {
    alsoTap.classList.add("tappable");
    alsoTap.onclick = reveal;
  }
}

// A 독해 passage's furigana lives in its own `ruby` field as 漢字（かな）, the same
// notation grammar.json already uses. It is authored per passage rather than
// derived, because a kanji's reading depends on the word it sits in — 行きます is
// い but 行います is おこな, 時 is とき but 時間 is じ — so guessing one per
// character would teach wrong readings, which is the worst failure mode here. The
// passage text itself is NOT duplicated: stripRuby(ruby) must equal `passage`
// exactly, and a smoke test checks that for every entry, so the two cannot drift.
const RUBY = /([\u4E00-\u9FFF]+)（([\u3040-\u309F]+)）/gu;

function stripRuby(ruby) {
  return ruby.replace(RUBY, "$1");
}

// Builds the passage with each annotated word as its own tappable span. Tapping
// one shows its reading in #quiz-reveal — the same line the 한자/단어 quizzes use.
// Not penalized: the rule across the app is that a reveal costs the review-queue
// credit only when what it reveals IS that quiz's answer, and 독해 asks which
// statement matches the passage, not how a word is read.
function renderRubyPassage(promptEl, item, revealEl) {
  promptEl.textContent = "";
  if (!item.ruby) {
    promptEl.textContent = item.passage;
    return;
  }
  const show = (word, reading) => {
    const gloss = glossFor(word);
    revealEl.textContent = gloss ? `${word} → ${reading} · ${gloss}` : `${word} → ${reading}`;
    revealEl.classList.add("revealed");
    revealEl.hidden = false;
  };
  let last = 0;
  for (const m of item.ruby.matchAll(RUBY)) {
    if (m.index > last) promptEl.append(item.ruby.slice(last, m.index));
    const span = document.createElement("span");
    span.className = "ruby-word";
    span.textContent = m[1];
    span.onclick = () => show(m[1], m[2]);
    promptEl.append(span);
    last = m.index + m[0].length;
  }
  promptEl.append(item.ruby.slice(last));
  // No cue line: the owner knows the words are tappable (2026-10-17, "이건 내가
  // 알고 있으니 삭제해줘") and the dotted underline says it anyway. The line
  // stays hidden until something is actually tapped.
}

function renderQuestion() {
  const item = quiz.pool[quiz.index];
  document.getElementById("quiz-progress").textContent = `${quiz.index + 1} / ${quiz.pool.length}`;
  document.getElementById("quiz-note").hidden = true;
  document.getElementById("quiz-next").hidden = true;
  const sayEl = document.getElementById("quiz-say");
  sayEl.hidden = true;
  sayEl.onclick = null;

  const promptEl = document.getElementById("quiz-prompt");
  const hintEl = document.getElementById("quiz-hint");
  const hintKoEl = document.getElementById("quiz-hint-ko");
  const replaysEl = document.getElementById("quiz-replays");
  const revealEl = document.getElementById("quiz-reveal");
  const meaningEl = document.getElementById("quiz-meaning");
  promptEl.classList.remove("passage", "sentence", "tappable");
  promptEl.onclick = null;
  revealEl.hidden = true;
  revealEl.classList.remove("revealed");
  revealEl.onclick = null;
  meaningEl.hidden = true;
  meaningEl.classList.remove("revealed");
  meaningEl.onclick = null;
  hintKoEl.hidden = true;
  hintKoEl.textContent = "";
  quiz.peeked = false;
  quiz.replays = 0;
  quiz.slowReplays = 0;
  quiz.answered = false;
  replaysEl.hidden = true;
  renderReplayButtons();
  let choices, answer;

  if (quiz.type === "hiragana" || quiz.type === "katakana") {
    promptEl.textContent = item.char;
    hintEl.textContent = "읽는 법(한글)을 고르세요";
    choices = shuffle([item.hangul, ...pickDistractors(quiz.allItems, item.hangul, "hangul")]);
    answer = item.hangul;
  } else if (quiz.type === "loanword") {
    // Korean meaning in, katakana spelling out — the direction that actually
    // tests 장음/촉음, which reading the word back to Korean never would.
    promptEl.textContent = item.meaning;
    hintEl.textContent = "가타카나 표기를 고르세요";
    choices = shuffle([item.word, ...pickSpellingDistractors(quiz.allItems, item)]);
    answer = item.word;
  } else if (quiz.type === "vocab") {
    // The reading used to ride along in the prompt, so the kanji never had to be
    // read at all. It sits behind a tap now. 19 entries are written in kana only,
    // where word and reading are the same string — nothing to reveal there, so the
    // cue line stays off rather than offering a hint that repeats the prompt.
    promptEl.textContent = item.word;
    hintEl.textContent = "뜻을 고르세요";
    if (item.reading !== item.word) {
      wireReveal(revealEl, "글자를 누르면 읽는 법", item.reading, { alsoTap: promptEl });
    }
    choices = shuffle([item.meaning, ...pickDistractors(quiz.allItems, item.meaning, "meaning")]);
    answer = item.meaning;
  } else if (quiz.type === "kanji") {
    promptEl.textContent = item.word;
    hintEl.textContent = "읽는 법을 고르세요";
    // The meaning used to sit in this hint line, visible before the question was
    // even read — for a word you half-know that hands over the reading. It's a
    // hint now, shown only on tap. Unlike the reading peek below it doesn't set
    // quiz.peeked: the meaning isn't the answer here, so using it is still recall.
    wireReveal(meaningEl, "💡 뜻 힌트", `뜻: ${item.meaning}`);
    // Tap the word to see its reading when it's unreadable — better to look it up
    // and learn it than to guess blind. Penalized, because here the reading is
    // the answer: selectAnswer won't clear a peeked item from the review queue.
    wireReveal(revealEl, "글자를 누르면 읽는 법", item.reading, { penalize: true, alsoTap: promptEl });
    choices = shuffle([item.reading, ...pickReadingDistractors(quiz.allItems, item)]);
    answer = item.reading;
  } else if (quiz.type === "grammar") {
    promptEl.classList.add("sentence");
    promptEl.textContent = item.sentence;
    hintEl.textContent = item.meaning;
    choices = shuffle(item.choices);
    answer = item.answer;
  } else if (quiz.type === "reading") {
    promptEl.classList.add("passage");
    renderRubyPassage(promptEl, item, revealEl);
    hintEl.textContent = item.question;
    // Shown outright rather than behind a tap, unlike the 한자 quiz's 뜻 힌트:
    // the question is not what 독해 tests — the passage is — and a question you
    // cannot read stops the exercise before it starts (2026-10-16, "한자가
    // 어렵구만"). The furigana on the passage does not reach this line, since
    // `ruby` covers the passage only.
    if (item.questionTranslation) {
      hintKoEl.textContent = item.questionTranslation;
      hintKoEl.hidden = false;
    }
    choices = shuffle(item.choices);
    answer = item.answer;
  } else {
    // listening
    promptEl.textContent = "🔊 음성을 듣고 뜻을 고르세요";
    hintEl.textContent = `다시 듣기는 각 ${MAX_REPLAYS}회, 정답 확인 후에는 자유롭게`;
    replaysEl.hidden = false;
    // Authored near-miss distractors where the entry has them: a random meaning
    // from another sentence is eliminated by one caught word, so the question
    // tested nothing past that. item.choices differ by a single detail — a time,
    // a day, a direction, who is doing it — so the whole sentence has to land.
    const listeningDistractors =
      item.choices || pickDistractors(quiz.allItems, item.meaning, "meaning");
    choices = shuffle([item.meaning, ...listeningDistractors]);
    answer = item.meaning;
    speak(item.script);
  }

  const choicesEl = document.getElementById("quiz-choices");
  choicesEl.innerHTML = "";
  choices.forEach((choice) => {
    const btn = document.createElement("button");
    btn.className = "choice-btn";
    btn.textContent = choice;
    btn.addEventListener("click", () => selectAnswer(btn, choice, answer, item));
    choicesEl.appendChild(btn);
  });
}

// Recap shown after every answer (right or wrong), so wrong picks always come
// with the correct word/reading/meaning, not just a red highlight.
// Only ever appended to the post-answer note. During the question it would hand
// over the 한자 quiz's answer — 新聞社 beside 会社(회사) gives away しゃ.
function withRelated(text, word) {
  // Radical first (which category the character is in), then the words that show
  // that category in use — the general lesson before the instances.
  const lines = [...radicalLines(word), ...relatedWordLines(word)];
  return lines.length ? `${text}\n${lines.join("\n")}` : text;
}

function explanationFor(type, item) {
  switch (type) {
    case "hiragana":
    case "katakana":
      return `${item.char} = ${item.hangul}`;
    case "loanword":
      return `${item.word} = ${item.meaning}`;
    case "vocab":
      return withRelated(`${item.word} (${item.reading}) = ${item.meaning}`, item.word);
    case "kanji":
      return withRelated(`${item.word} → ${item.reading} (${item.meaning})`, item.word);
    case "grammar":
      return item.note || null;
    case "reading":
      // The Korean translation of the passage comes first, then the explanation.
      // Asked for on 2026-10-07: the furigana gets you through the reading, but
      // you still finish the question without knowing what the passage said.
      return [item.translation && `번역: ${item.translation}`, item.note]
        .filter(Boolean)
        .join("\n\n") || null;
    case "listening":
      return `스크립트: ${item.script}\n뜻: ${item.meaning}`;
    default:
      return null;
  }
}

// What gets read aloud once an answer is picked — the Japanese the question was
// about, in its correct reading. Asked for on 2026-10-08 from the 외래어 quiz,
// where the entire question is a spelling (파티 → パーティー) you still can't
// pronounce after getting it right, and extended to 단어 in the same breath.
//
// 단어 is the type where "the answer" and "what to speak" come apart: that quiz
// asks for the Korean meaning, and reading 만나다 back in a Japanese voice would
// teach nothing — so it speaks the entry's reading, あう, which is the thing the
// prompt 会う actually sounds like. 한자 lands on the same field from the other
// direction, where the reading IS the answer.
//
// 청해 gets nothing: its script is spoken already and both replay buttons go
// unlimited the moment you answer, so a third control saying the same sentence
// would only crowd the screen.
function answerSpeech(type, item) {
  switch (type) {
    case "hiragana":
    case "katakana":
      return item.char;
    case "loanword":
      return item.word;
    case "vocab":
    case "kanji":
      return item.reading;
    case "grammar":
      // The blank filled in, so the pattern is heard where it attaches rather
      // than as a bare suffix — 접속 is half of what 문법 tests. Both halves need
      // stripRuby: the sentence carries 漢字（かな）and several answers carry
      // their own (召（め）し上（あ）がり), and a 「かな」read aloud beside the
      // kanji it annotates would double every word.
      return stripRuby(item.sentence).replace("＿＿＿", stripRuby(item.answer));
    case "reading":
      return item.answer;
    default:
      return null;
  }
}

function selectAnswer(btn, choice, answer, item) {
  const buttons = document.querySelectorAll(".choice-btn");
  buttons.forEach((b) => (b.disabled = true));
  // Frees both replay buttons: the transcript is about to be on screen, and
  // listening again while reading it is where the question actually teaches.
  quiz.answered = true;
  renderReplayButtons();
  const isCorrect = choice === answer;
  if (isCorrect) {
    btn.classList.add("correct");
    quiz.score++;
  } else {
    btn.classList.add("wrong");
    buttons.forEach((b) => {
      if (b.textContent === answer) b.classList.add("correct");
    });
  }
  // Reading the answer off the peek isn't recall, so a peeked item stays in the
  // review queue even when answered right — otherwise "몰라서 보기" would clear
  // exactly the words that still need drilling.
  recordAnswerOutcome(quiz.type, item[QUIZ_KEY_FIELD[quiz.type]], isCorrect && !quiz.peeked);
  const noteEl = document.getElementById("quiz-note");
  const note = explanationFor(quiz.type, item);
  if (note) {
    noteEl.textContent = note;
    noteEl.hidden = false;
  }
  // Say the answer out loud, and leave the button for a repeat — one pass over a
  // 문법 sentence isn't enough. Everything that changes the page height has to
  // happen before the scrollIntoView below, or it measures a layout that's about
  // to move. Hidden when there's nothing to say (청해) or no voice to say it
  // with, rather than left on screen as a dead control.
  const sayEl = document.getElementById("quiz-say");
  const speech = answerSpeech(quiz.type, item);
  if (speech && "speechSynthesis" in window) {
    sayEl.hidden = false;
    sayEl.onclick = () => speak(speech, ANSWER_SPEECH_RATE);
    speak(speech, ANSWER_SPEECH_RATE);
  }

  const nextBtn = document.getElementById("quiz-next");
  nextBtn.hidden = false;
  // 독해 passages plus a full note run past a phone screen — 23 of reading.json's
  // 41 entries put this button below the fold at 390x844 — and hunting for 다음
  // after every question is friction the quiz doesn't need. `block: "nearest"`
  // scrolls the minimum required and does nothing at all when the button is
  // already on screen, so short questions don't jump.
  nextBtn.scrollIntoView({ block: "nearest" });
}

function nextQuestion() {
  quiz.index++;
  if (quiz.index >= quiz.pool.length) {
    document.getElementById("quiz-play").hidden = true;
    document.getElementById("quiz-result").hidden = false;
    document.getElementById("quiz-score").textContent = `${quiz.score} / ${quiz.pool.length} 정답!`;
    // A 오답만 풀기 round is drawn entirely from items you already missed, so its
    // score isn't comparable to a normal round's. It fills today's badge for a
    // type you haven't taken yet — you did study it — but never overwrites a
    // fuller round's result with a narrower one.
    const takenToday = (loadQuizResults()[todayStr()] || {})[quiz.type];
    if (!quiz.wrongOnly || !takenToday) {
      recordQuizResult(quiz.type, quiz.score, quiz.pool.length);
    }
  } else {
    renderQuestion();
  }
}

// ---------- Init ----------
async function init() {
  setupTabs();
  setupQuiz();
  const res = await fetch(`data/${CURRENT_LEVEL}/plan.json`);
  const plan = await res.json();
  renderTopbar(plan);
}

init();
