const CURRENT_LEVEL = "n4"; // active JLPT level; see data/levels.json. Switch this (and eventually add a picker) once a new level's data/<level>/ folder exists.
const CHECKLIST_ITEMS = ["단어·한자 학습/복습", "문법·진도 학습", "청해 연습", "전날 내용 복습"];
const STORAGE_KEY = `jlpt_daily_checklist_${CURRENT_LEVEL}`;
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
// Which CHECKLIST_ITEMS index each quiz type's completion auto-checks (see
// autoCheckFromQuiz). Index 3 ("전날 내용 복습") has no quiz proxy and stays manual.
const CHECKLIST_AUTO_MAP = [
  { index: 0, quizTypes: ["hiragana", "katakana", "loanword", "vocab", "kanji"] },
  { index: 1, quizTypes: ["grammar", "reading"] },
  { index: 2, quizTypes: ["listening"] },
];
// The field that uniquely identifies an entry within each quiz type's data
// file, used to track which specific items were answered wrong (see
// WRONG_ITEMS_KEY / buildQuizPool) so they resurface in later rounds.
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
const WRONG_ITEMS_KEY = `jlpt_wrong_items_${CURRENT_LEVEL}`;
// Questions per round. Kana and kanji are single-item recall — fast per
// question — so they run longer rounds; types not listed here use the default.
// A round is still capped at the number of entries the data file actually has.
const DEFAULT_ROUND_SIZE = 10;
const QUIZ_ROUND_SIZE = { hiragana: 20, katakana: 20, kanji: 20 };

function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function loadChecklist() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    return {};
  }
}

function saveChecklist(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    /* localStorage unavailable (private mode etc.) — progress just won't persist */
  }
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
function renderToday(plan) {
  const today = todayStr();
  const ddayEl = document.getElementById("dday");
  const diff = daysUntil(plan.examDate);
  ddayEl.textContent = diff > 0 ? `시험까지 D-${diff}` : diff === 0 ? "오늘이 시험일입니다!" : "시험이 종료되었습니다";

  const week = findWeek(today, plan.weeks);
  const weekTitleEl = document.getElementById("week-title");
  const weekFocusEl = document.getElementById("week-focus");
  if (week) {
    weekTitleEl.textContent = `Week ${week.week} (${week.start} ~ ${week.end})`;
    weekFocusEl.textContent = week.focus;
  } else if (today < plan.startDate) {
    weekTitleEl.textContent = "학습 시작 전";
    weekFocusEl.textContent = `${plan.startDate}부터 계획이 시작됩니다.`;
  } else {
    weekTitleEl.textContent = "계획 기간 종료";
    weekFocusEl.textContent = "수고하셨습니다!";
  }

  renderChecklist(today);
  renderStreak(plan);
}

function renderChecklist(today) {
  const data = loadChecklist();
  const todayState = data[today] || CHECKLIST_ITEMS.map(() => false);
  const ul = document.getElementById("checklist");
  ul.innerHTML = "";
  CHECKLIST_ITEMS.forEach((label, i) => {
    const li = document.createElement("li");
    const id = `check-${i}`;
    li.className = todayState[i] ? "done" : "";
    li.innerHTML = `<input type="checkbox" id="${id}" ${todayState[i] ? "checked" : ""} /><label for="${id}">${label}</label>`;
    li.querySelector("input").addEventListener("change", (e) => {
      const d = loadChecklist();
      const arr = d[today] || CHECKLIST_ITEMS.map(() => false);
      arr[i] = e.target.checked;
      d[today] = arr;
      saveChecklist(d);
      li.className = e.target.checked ? "done" : "";
      renderStreakFromCache();
    });
    ul.appendChild(li);
  });
}

let _planCache = null;
function renderStreakFromCache() {
  if (_planCache) renderStreak(_planCache);
}

function renderStreak(plan) {
  _planCache = plan;
  const data = loadChecklist();
  const container = document.getElementById("streak");
  container.innerHTML = "";
  const today = new Date();
  for (let i = 13; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = todayStr(d);
    const state = data[key];
    const div = document.createElement("div");
    let cls = "day";
    if (state) {
      const doneCount = state.filter(Boolean).length;
      if (doneCount === CHECKLIST_ITEMS.length) cls += " done";
      else if (doneCount > 0) cls += " partial";
    }
    if (i === 0) cls += " today";
    div.className = cls;
    div.title = key;
    div.textContent = String(d.getDate());
    container.appendChild(div);
  }
}

// ---------- Plan tab ----------
function renderPlanTable(plan) {
  const tbody = document.querySelector("#plan-table tbody");
  tbody.innerHTML = "";
  plan.weeks.forEach((w) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${w.week}</td><td>${w.start}~${w.end}</td><td>${w.focus}</td>`;
    tbody.appendChild(tr);
  });
}

// ---------- Quiz tab ----------
const quiz = { type: null, pool: [], index: 0, score: 0, allItems: [] };

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
  document.getElementById("quiz-replay").addEventListener("click", () => {
    const item = quiz.pool[quiz.index];
    if (item && item.script) speak(item.script);
  });
  document.getElementById("quiz-retry").addEventListener("click", () => {
    document.getElementById("quiz-result").hidden = true;
    document.getElementById("quiz-start").hidden = false;
    renderQuizStartStatus();
  });
  renderQuizStartStatus();
}

function speak(text) {
  if (!("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = "ja-JP";
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

// Ticks any 오늘 체크리스트 item mapped (via CHECKLIST_AUTO_MAP) to this quiz
// type, so finishing a quiz counts as having done that checklist item today.
// Never unchecks anything — only fills in items still unchecked.
function autoCheckFromQuiz(type) {
  const today = todayStr();
  const data = loadChecklist();
  const arr = data[today] || CHECKLIST_ITEMS.map(() => false);
  let changed = false;
  CHECKLIST_AUTO_MAP.forEach(({ index, quizTypes }) => {
    if (quizTypes.includes(type) && !arr[index]) {
      arr[index] = true;
      changed = true;
    }
  });
  if (changed) {
    data[today] = arr;
    saveChecklist(data);
    renderChecklist(today);
    renderStreakFromCache();
  }
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

function pickDistractors(items, correctValue, field) {
  return shuffle(items.filter((v) => v[field] !== correctValue))
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

function loadWrongItems() {
  try {
    return JSON.parse(localStorage.getItem(WRONG_ITEMS_KEY)) || {};
  } catch {
    return {};
  }
}

function saveWrongItems(data) {
  try {
    localStorage.setItem(WRONG_ITEMS_KEY, JSON.stringify(data));
  } catch {
    /* localStorage unavailable — wrong-answer tracking just won't persist */
  }
}

// Marks an item right or wrong for a quiz type. Wrong items stay flagged
// (so they resurface in later rounds via buildQuizPool) until answered
// correctly, at which point they're cleared — a simple leaky-bucket review
// queue, not full spaced repetition with intervals.
function recordAnswerOutcome(type, itemKey, correct) {
  if (!itemKey) return;
  const data = loadWrongItems();
  const set = new Set(data[type] || []);
  if (correct) set.delete(itemKey);
  else set.add(itemKey);
  data[type] = [...set];
  saveWrongItems(data);
}

// Fills a quiz round by putting every currently-wrong item first (shuffled),
// then topping up with fresh items so previously-missed questions keep
// coming back until mastered, without the round being *only* review items.
function buildQuizPool(items, wrongKeys, keyField, size) {
  if (!keyField || wrongKeys.length === 0) return shuffle(items).slice(0, size);
  const wrongItems = items.filter((v) => wrongKeys.includes(v[keyField]));
  const otherItems = items.filter((v) => !wrongKeys.includes(v[keyField]));
  const pool = shuffle(wrongItems).slice(0, size);
  if (pool.length < size) pool.push(...shuffle(otherItems).slice(0, size - pool.length));
  return shuffle(pool);
}

// Which quiz types get the "같은 글자를 쓰는 다른 단어" line, and which files the
// related words are drawn from. Crossing kanji.json with vocab.json is what makes
// it worth having: measured over the current data it lifts the share of questions
// that can show anything from 54% to 59% for 한자, and 23% to 39% for 단어.
const XREF_TYPES = ["kanji", "vocab"];
const XREF_SOURCES = ["kanji", "vocab"];
let _xrefIndex = null; // char -> [{ word, reading, meaning }], built once per page load
let _radicalIndex = null; // char -> { rad, name, sense, siblings[] }

const CJK = /[\u4E00-\u9FFF]/gu;

async function buildXrefIndex() {
  if (_xrefIndex) return _xrefIndex;
  const files = await Promise.all(
    XREF_SOURCES.map((t) => fetch(`data/${CURRENT_LEVEL}/${t}.json`).then((r) => r.json()))
  );
  const index = new Map();
  const seen = new Set();
  for (const item of files.flat()) {
    if (seen.has(item.word)) continue; // a word in both files is one entry here
    seen.add(item.word);
    for (const c of new Set(item.word.match(CJK) || [])) {
      if (!index.has(c)) index.set(c, []);
      index.get(c).push({ word: item.word, reading: item.reading, meaning: item.meaning });
    }
  }
  _xrefIndex = index;
  return index;
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
// there. Capped so the note stays a note: 3 characters, 2 words each.
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

async function startQuiz(type) {
  const res = await fetch(`data/${CURRENT_LEVEL}/${type}.json`);
  const items = await res.json();
  if (XREF_TYPES.includes(type)) await Promise.all([buildXrefIndex(), buildRadicalIndex()]);
  quiz.type = type;
  quiz.allItems = items;
  const keyField = QUIZ_KEY_FIELD[type];
  const wrongKeys = loadWrongItems()[type] || [];
  const roundSize = QUIZ_ROUND_SIZE[type] || DEFAULT_ROUND_SIZE;
  quiz.pool = buildQuizPool(items, wrongKeys, keyField, Math.min(roundSize, items.length));
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

function renderQuestion() {
  const item = quiz.pool[quiz.index];
  document.getElementById("quiz-progress").textContent = `${quiz.index + 1} / ${quiz.pool.length}`;
  document.getElementById("quiz-note").hidden = true;
  document.getElementById("quiz-next").hidden = true;

  const promptEl = document.getElementById("quiz-prompt");
  const hintEl = document.getElementById("quiz-hint");
  const replayBtn = document.getElementById("quiz-replay");
  const revealEl = document.getElementById("quiz-reveal");
  const meaningEl = document.getElementById("quiz-meaning");
  promptEl.classList.remove("passage", "tappable");
  promptEl.onclick = null;
  revealEl.hidden = true;
  revealEl.classList.remove("revealed");
  revealEl.onclick = null;
  meaningEl.hidden = true;
  meaningEl.classList.remove("revealed");
  meaningEl.onclick = null;
  quiz.peeked = false;
  replayBtn.hidden = true;
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
    promptEl.textContent = item.sentence;
    hintEl.textContent = item.meaning;
    choices = shuffle(item.choices);
    answer = item.answer;
  } else if (quiz.type === "reading") {
    promptEl.classList.add("passage");
    promptEl.textContent = item.passage;
    hintEl.textContent = item.question;
    choices = shuffle(item.choices);
    answer = item.answer;
  } else {
    // listening
    promptEl.textContent = "🔊 음성을 듣고 뜻을 고르세요";
    hintEl.textContent = "";
    replayBtn.hidden = false;
    choices = shuffle([item.meaning, ...pickDistractors(quiz.allItems, item.meaning, "meaning")]);
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
      return item.note || null;
    case "listening":
      return `스크립트: ${item.script}\n뜻: ${item.meaning}`;
    default:
      return null;
  }
}

function selectAnswer(btn, choice, answer, item) {
  const buttons = document.querySelectorAll(".choice-btn");
  buttons.forEach((b) => (b.disabled = true));
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
  document.getElementById("quiz-next").hidden = false;
}

function nextQuestion() {
  quiz.index++;
  if (quiz.index >= quiz.pool.length) {
    document.getElementById("quiz-play").hidden = true;
    document.getElementById("quiz-result").hidden = false;
    document.getElementById("quiz-score").textContent = `${quiz.score} / ${quiz.pool.length} 정답!`;
    recordQuizResult(quiz.type, quiz.score, quiz.pool.length);
    autoCheckFromQuiz(quiz.type);
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
  renderToday(plan);
  renderPlanTable(plan);
}

init();
