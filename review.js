const DEFAULTS = { lang: "fr-FR", audioMode: "sentence", accentMode: "flexible" };

let vocabTerms = {};
let settings = {};
let currentTermKey = "";
let currentSentence = null;
let currentTerm = null;
let awaitingCopy = false;

const termSelect = document.getElementById("termSelect");
const practiceMode = document.getElementById("practiceMode");
const card = document.getElementById("card");
const sentenceDisplay = document.getElementById("sentenceDisplay");
const answer = document.getElementById("answer");
const copyBox = document.getElementById("copyBox");
const feedback = document.getElementById("feedback");
const statusLine = document.getElementById("statusLine");

document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());
document.getElementById("start").addEventListener("click", startNext);
document.getElementById("speak").addEventListener("click", () => { if (currentSentence) speak(currentSentence.text, settings.lang); });
termSelect.addEventListener("change", () => { currentTermKey = termSelect.value; startNext(); });

answer.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  await checkClozeAnswer();
});

copyBox.addEventListener("keydown", async (event) => {
  if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
  event.preventDefault();
  await checkCopyAnswer();
});

init();

async function init() {
  settings = await chrome.storage.sync.get(DEFAULTS);
  const data = await chrome.storage.local.get({ vocabTerms: {} });
  vocabTerms = data.vocabTerms || {};
  renderTermSelect();
  renderTable();

  const keys = Object.keys(vocabTerms);
  if (keys.length) {
    currentTermKey = keys[0];
    termSelect.value = currentTermKey;
    startNext();
  }
}

function renderTermSelect() {
  termSelect.innerHTML = "";
  const keys = Object.keys(vocabTerms).sort((a, b) => vocabTerms[a].term.localeCompare(vocabTerms[b].term));
  for (const key of keys) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = vocabTerms[key].term;
    termSelect.appendChild(option);
  }
}

function renderTable() {
  const tbody = document.getElementById("termsTable");
  tbody.innerHTML = "";

  for (const key of Object.keys(vocabTerms).sort()) {
    const term = vocabTerms[key];
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${escapeHtml(term.term)}</td><td>${term.sentences?.length || 0}</td><td>${escapeHtml(term.status || "new")}</td><td>${Math.round(term.stats?.confidence || 0)}</td><td>${term.stats?.timesReviewed || 0}</td>`;
    tbody.appendChild(tr);
  }
}

function startNext() {
  currentTermKey = termSelect.value;
  currentTerm = vocabTerms[currentTermKey];

  if (!currentTerm || !currentTerm.sentences?.length) {
    card.classList.add("hidden");
    return;
  }

  currentSentence = chooseSentence(currentTerm);
  awaitingCopy = false;

  card.classList.remove("hidden");
  feedback.textContent = "";
  answer.value = "";
  copyBox.value = "";
  copyBox.classList.add("hidden");

  sentenceDisplay.innerHTML = clozeSentence(currentSentence.text, currentTerm.term);
  statusLine.textContent = `${currentTerm.term} · ${currentTerm.status || "new"} · confidence ${Math.round(currentTerm.stats?.confidence || 0)}`;
  answer.focus();
}

function chooseSentence(term) {
  const sentences = term.sentences || [];
  return sentences[Math.floor(Math.random() * sentences.length)];
}

function clozeSentence(sentence, term) {
  const safeSentence = escapeHtml(sentence);
  const re = new RegExp(escapeRegex(escapeHtml(term)), "iu");
  const blank = `<span class="cloze-blank">&nbsp;</span>`;
  if (re.test(safeSentence)) return safeSentence.replace(re, blank);
  return `${blank} — ${safeSentence}`;
}

async function checkClozeAnswer() {
  const user = answer.value.trim();
  const correct = currentTerm.term;

  const exactCorrect = answersMatch(user, correct, false);
  const flexibleCorrect = answersMatch(user, correct, true);
  const strictAccents = settings.accentMode === "strict";
  const accepted = exactCorrect || (!strictAccents && flexibleCorrect);

  if (accepted) {
    feedback.innerHTML = exactCorrect ? `<span class="good">Correct.</span>` : `<span class="good">Accepted.</span> Accent form: <span class="warn">${escapeHtml(correct)}</span>`;
    speak(currentSentence.text, settings.lang);

    if (practiceMode.value === "clozeThenCopy") {
      awaitingCopy = true;
      copyBox.classList.remove("hidden");
      copyBox.focus();
      return;
    }

    await recordReview(true, "cloze");
    startNext();
  } else {
    feedback.innerHTML = `<span class="bad">Not quite.</span> Correct: <strong>${escapeHtml(correct)}</strong>`;
    speak(currentSentence.text, settings.lang);
    await recordReview(false, "cloze");
  }
}

async function checkCopyAnswer() {
  if (!awaitingCopy) return;
  const accepted = normalizeSentence(copyBox.value) === normalizeSentence(currentSentence.text);

  if (accepted) {
    feedback.innerHTML = `<span class="good">Sentence copied correctly.</span>`;
    await recordReview(true, "copy");
    startNext();
  } else {
    feedback.innerHTML = `<span class="bad">Sentence copy does not match yet.</span>`;
    await recordReview(false, "copy");
  }
}

async function recordReview(correct, type) {
  const term = vocabTerms[currentTermKey];
  const now = new Date().toISOString();

  term.stats ||= {
    timesReviewed: 0, clozeCorrect: 0, clozeWrong: 0, copyCorrect: 0, copyWrong: 0,
    consecutiveCorrect: 0, lastReviewedAt: null, nextEncounterGap: 1, confidence: 0
  };

  term.stats.timesReviewed += 1;
  term.stats.lastReviewedAt = now;

  if (type === "copy") correct ? term.stats.copyCorrect += 1 : term.stats.copyWrong += 1;
  else correct ? term.stats.clozeCorrect += 1 : term.stats.clozeWrong += 1;

  if (correct) {
    term.stats.consecutiveCorrect += 1;
    term.stats.nextEncounterGap = Math.min(25, Math.max(1, term.stats.nextEncounterGap * 2));
  } else {
    term.stats.consecutiveCorrect = 0;
    term.stats.nextEncounterGap = 1;
  }

  updateGraduation(term);
  term.updatedAt = now;
  await chrome.storage.local.set({ vocabTerms });
  renderTable();
}

function updateGraduation(term) {
  const stats = term.stats;
  const correct = stats.clozeCorrect + stats.copyCorrect;
  const wrong = stats.clozeWrong + stats.copyWrong;
  const total = Math.max(1, correct + wrong);
  const accuracy = correct / total;
  const streak = stats.consecutiveCorrect || 0;
  const confidence = accuracy * 70 + Math.min(30, streak * 4);
  stats.confidence = confidence;

  if (confidence >= 92 && correct >= 15 && streak >= 8) term.status = "graduated";
  else if (confidence >= 75 && correct >= 8) term.status = "familiar";
  else if (correct >= 2 || wrong >= 1) term.status = "learning";
  else term.status = "new";
}

function speak(text, lang) {
  if (!text || !("speechSynthesis" in window)) return;
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  utterance.rate = 0.9;
  const voices = window.speechSynthesis.getVoices();
  const bestVoice = voices.find(v => v.lang.toLowerCase() === lang.toLowerCase()) || voices.find(v => v.lang.toLowerCase().startsWith(lang.split("-")[0].toLowerCase()));
  if (bestVoice) utterance.voice = bestVoice;
  window.speechSynthesis.speak(utterance);
}

function answersMatch(userAnswer, correctAnswer, ignoreAccents) {
  return normalizeAnswer(userAnswer, ignoreAccents) === normalizeAnswer(correctAnswer, ignoreAccents);
}

function normalizeAnswer(value, ignoreAccents) {
  let out = String(value || "").trim().toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ");
  if (ignoreAccents) out = out.normalize("NFD").replace(/\p{Diacritic}/gu, "");
  return out;
}

function normalizeSentence(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value) {
  return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
