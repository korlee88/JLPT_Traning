const CURRENT_LEVEL = "n4"; // active JLPT level; see data/levels.json. Switch this (and eventually add a picker) once a new level's data/<level>/ folder exists.
const CHECKLIST_ITEMS = ["단어·한자 학습/복습", "문법·진도 학습", "청해 연습", "전날 내용 복습"];
const STORAGE_KEY = `jlpt_daily_checklist_${CURRENT_LEVEL}`;
const QUIZ_RESULTS_KEY = `jlpt_quiz_results_${CURRENT_LEVEL}`;
const QUIZ_TYPE_LABELS = {
  hiragana: "히라가나 쪽지시험",
  katakana: "가타카나 쪽지시험",
  vocab: "단어 쪽지시험",
  kanji: "한자 쪽지시험",
  grammar: "문법 쪽지시험",
  reading: "독해 쪽지시험",
  listening: "청해 쪽지시험",
};
// Which CHECKLIST_ITEMS index each quiz type's completion auto-checks (see
// autoCheckFromQuiz). Index 3 ("전날 내용 복습") has no quiz proxy and stays manual.
const CHECKLIST_AUTO_MAP = [
  { index: 0, quizTypes: ["hiragana", "katakana", "vocab", "kanji"] },
  { index: 1, quizTypes: ["grammar", "reading"] },
  { index: 2, quizTypes: ["listening"] },
];

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
    });
  });
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

async function startQuiz(type) {
  const res = await fetch(`data/${CURRENT_LEVEL}/${type}.json`);
  const items = await res.json();
  quiz.type = type;
  quiz.allItems = items;
  quiz.pool = shuffle(items).slice(0, Math.min(10, items.length));
  quiz.index = 0;
  quiz.score = 0;

  document.getElementById("quiz-start").hidden = true;
  document.getElementById("quiz-result").hidden = true;
  document.getElementById("quiz-play").hidden = false;
  renderQuestion();
}

function renderQuestion() {
  const item = quiz.pool[quiz.index];
  document.getElementById("quiz-progress").textContent = `${quiz.index + 1} / ${quiz.pool.length}`;
  document.getElementById("quiz-note").hidden = true;
  document.getElementById("quiz-next").hidden = true;

  const promptEl = document.getElementById("quiz-prompt");
  const hintEl = document.getElementById("quiz-hint");
  const replayBtn = document.getElementById("quiz-replay");
  promptEl.classList.remove("passage");
  replayBtn.hidden = true;
  let choices, answer;

  if (quiz.type === "hiragana" || quiz.type === "katakana") {
    promptEl.textContent = item.char;
    hintEl.textContent = "읽는 법(로마자)을 고르세요";
    choices = shuffle([item.romaji, ...pickDistractors(quiz.allItems, item.romaji, "romaji")]);
    answer = item.romaji;
  } else if (quiz.type === "vocab") {
    promptEl.textContent = `${item.word} (${item.reading})`;
    hintEl.textContent = "뜻을 고르세요";
    choices = shuffle([item.meaning, ...pickDistractors(quiz.allItems, item.meaning, "meaning")]);
    answer = item.meaning;
  } else if (quiz.type === "kanji") {
    promptEl.textContent = item.word;
    hintEl.textContent = `읽는 법을 고르세요 (뜻: ${item.meaning})`;
    choices = shuffle([item.reading, ...pickDistractors(quiz.allItems, item.reading, "reading")]);
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

function selectAnswer(btn, choice, answer, item) {
  const buttons = document.querySelectorAll(".choice-btn");
  buttons.forEach((b) => (b.disabled = true));
  if (choice === answer) {
    btn.classList.add("correct");
    quiz.score++;
  } else {
    btn.classList.add("wrong");
    buttons.forEach((b) => {
      if (b.textContent === answer) b.classList.add("correct");
    });
  }
  const noteEl = document.getElementById("quiz-note");
  if (quiz.type === "grammar" && item.note) {
    noteEl.textContent = item.note;
    noteEl.hidden = false;
  } else if (quiz.type === "listening") {
    noteEl.textContent = `스크립트: ${item.script}`;
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
