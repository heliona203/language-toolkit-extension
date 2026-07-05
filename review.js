const DEFAULTS = { lang: "fr-FR", audioMode: "sentence", accentMode: "flexible" };

let vocabTerms = {};
let settings = {};
let currentTermKey = "";
let currentSentence = null;
let currentTerm = null;
let currentClozeAnswers = [];
let awaitingCopy = false;
let manageFilterText = "";
const viewState = {}; // key -> { open: boolean }

const termSelect = document.getElementById("termSelect");
const practiceMode = document.getElementById("practiceMode");
const card = document.getElementById("card");
const emptyPractice = document.getElementById("emptyPractice");
const sentenceDisplay = document.getElementById("sentenceDisplay");
const answer = document.getElementById("answer");
const copyBox = document.getElementById("copyBox");
const feedback = document.getElementById("feedback");
const statusLine = document.getElementById("statusLine");
const statsFilter = document.getElementById("statsFilter");

const vocabList = document.getElementById("vocabList");
const emptyManage = document.getElementById("emptyManage");
const noManageMatches = document.getElementById("noManageMatches");
const manageSearch = document.getElementById("manageSearch");
const addTermBtn = document.getElementById("addTermBtn");
const addTermForm = document.getElementById("addTermForm");
const newTermInput = document.getElementById("newTermInput");

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

statsFilter.addEventListener("input", () => renderTable());

document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
});

addTermBtn.addEventListener("click", () => {
  addTermForm.classList.remove("hidden");
  newTermInput.value = "";
  newTermInput.focus();
});

document.getElementById("cancelNewTermBtn").addEventListener("click", () => {
  addTermForm.classList.add("hidden");
});

document.getElementById("saveNewTermBtn").addEventListener("click", () => commitAddTerm());

newTermInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); commitAddTerm(); }
  if (event.key === "Escape") addTermForm.classList.add("hidden");
});

manageSearch.addEventListener("input", () => {
  manageFilterText = manageSearch.value.trim().toLowerCase();
  applyManageFilter();
});

vocabList.addEventListener("click", handleVocabListClick);

init();

function activateTab(name) {
  document.querySelectorAll(".tab").forEach(tab => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  document.getElementById("practiceTab").classList.toggle("hidden", name !== "practice");
  document.getElementById("manageTab").classList.toggle("hidden", name !== "manage");
}

async function init() {
  settings = await chrome.storage.sync.get(DEFAULTS);
  const data = await chrome.storage.local.get({ vocabTerms: {} });
  vocabTerms = data.vocabTerms || {};
  renderTermSelect();
  renderTable();
  renderVocabList();

  const keys = Object.keys(vocabTerms);
  if (keys.length) {
    currentTermKey = keys[0];
    termSelect.value = currentTermKey;
    startNext();
  } else {
    emptyPractice.classList.remove("hidden");
    card.classList.add("hidden");
  }

  if (location.hash === "#manage") activateTab("manage");
}

async function persist() {
  await chrome.storage.local.set({ vocabTerms });
}

/* ---------------- Practice tab ---------------- */

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
  const filter = statsFilter.value.trim().toLowerCase();

  const keys = Object.keys(vocabTerms)
    .filter(key => !filter || vocabTerms[key].term.toLowerCase().includes(filter))
    .sort((a, b) => vocabTerms[a].term.localeCompare(vocabTerms[b].term));

  for (const key of keys) {
    const term = vocabTerms[key];
    const status = term.status || "new";
    const confidence = Math.round(term.stats?.confidence || 0);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(term.term)}</td>
      <td>${term.sentences?.length || 0}</td>
      <td><span class="badge badge-${escapeHtml(status)}">${escapeHtml(status)}</span></td>
      <td><div class="confidenceBar"><span style="width:${Math.min(100, Math.max(0, confidence))}%"></span></div></td>
      <td>${term.stats?.timesReviewed || 0}</td>`;
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

  sentenceDisplay.innerHTML = clozeSentence(currentSentence.text, currentTerm.term, currentTerm.forms);
  statusLine.textContent = `${currentTerm.term} · ${currentTerm.status || "new"} · confidence ${Math.round(currentTerm.stats?.confidence || 0)}`;
  answer.focus();
}

function chooseSentence(term) {
  const sentences = term.sentences || [];
  return sentences[Math.floor(Math.random() * sentences.length)];
}

function clozeSentence(sentence, term, forms) {
  const safeSentence = escapeHtml(sentence);
  const blank = `<span class="cloze-blank">&nbsp;</span>`;
  currentClozeAnswers = [term, ...(forms || [])].filter(Boolean);
  // Longest first so a more specific override (e.g. "aboutissant") wins over
  // a shorter one that might also happen to appear inside it.
  const candidates = [term, ...(forms || [])]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  const exactCandidates = candidates.map(candidate => escapeRegex(escapeHtml(candidate)));
  const re = new RegExp(exactCandidates.join("|"), "iu");
  if (re.test(safeSentence)) {
    const exactMatch = String(sentence || "").match(new RegExp(candidates.map(escapeRegex).join("|"), "iu"));
    if (exactMatch) currentClozeAnswers = [...new Set([exactMatch[0], ...currentClozeAnswers])];
    return safeSentence.replace(re, blank);
  }

  const fuzzyMatch = findFuzzyTermMatch(sentence, candidates);
  if (fuzzyMatch) {
    const matchedText = sentence.slice(fuzzyMatch.start, fuzzyMatch.end);
    currentClozeAnswers = [...new Set([matchedText, ...currentClozeAnswers])];
    const before = escapeHtml(sentence.slice(0, fuzzyMatch.start));
    const after = escapeHtml(sentence.slice(fuzzyMatch.end));
    return `${before}${blank}${after}`;
  }

  return `${blank} — ${safeSentence}`;
}

function findFuzzyTermMatch(sentence, candidates) {
  const sentenceWords = [...String(sentence || "").matchAll(/\p{L}+(?:[’']\p{L}+)*/gu)];
  if (!sentenceWords.length) return null;

  for (const candidate of candidates) {
    const candidateWords = extractFuzzyCandidateWords(candidate);
    for (const candidateWord of candidateWords) {
      for (const wordMatch of sentenceWords) {
        if (fuzzyWordsMatch(candidateWord, wordMatch[0])) {
          return { start: wordMatch.index, end: wordMatch.index + wordMatch[0].length };
        }
      }
    }
  }

  return null;
}

function extractFuzzyCandidateWords(value) {
  return [...String(value || "").matchAll(/\p{L}+(?:[’']\p{L}+)*/gu)]
    .map(match => match[0])
    .filter(word => normalizeFuzzyWord(word).length >= 4);
}

function fuzzyWordsMatch(a, b) {
  const left = normalizeFuzzyWord(a);
  const right = normalizeFuzzyWord(b);
  if (left.length < 4 || right.length < 4) return false;

  const prefixLength = commonPrefixLength(left, right);
  const shorterLength = Math.min(left.length, right.length);
  return prefixLength >= 4 && prefixLength / shorterLength >= 0.7;
}

function normalizeFuzzyWord(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[’‘]/g, "'");
}

function commonPrefixLength(a, b) {
  let length = 0;
  while (length < a.length && length < b.length && a[length] === b[length]) length += 1;
  return length;
}

async function checkClozeAnswer() {
  const user = answer.value.trim();
  const correctAnswers = currentClozeAnswers.length ? currentClozeAnswers : [currentTerm.term];
  const correct = correctAnswers[0];

  const exactCorrect = correctAnswers.some(correctAnswer => answersMatch(user, correctAnswer, false));
  const flexibleCorrect = correctAnswers.some(correctAnswer => answersMatch(user, correctAnswer, true));
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

  term.stats ||= createStats();
  currentSentence.stats ||= createStats();

  applyReviewToStats(term.stats, correct, type, now);
  applyReviewToStats(currentSentence.stats, correct, type, now);

  updateGraduation(term);
  currentSentence.stats.confidence = computeConfidence(currentSentence.stats);
  term.updatedAt = now;
  await persist();
  renderTable();
  renderVocabList();
}

function createStats() {
  return {
    timesReviewed: 0, clozeCorrect: 0, clozeWrong: 0, copyCorrect: 0, copyWrong: 0,
    consecutiveCorrect: 0, lastReviewedAt: null, nextEncounterGap: 1, confidence: 0
  };
}

function applyReviewToStats(stats, correct, type, now) {
  stats.timesReviewed += 1;
  stats.lastReviewedAt = now;

  if (type === "copy") correct ? stats.copyCorrect += 1 : stats.copyWrong += 1;
  else correct ? stats.clozeCorrect += 1 : stats.clozeWrong += 1;

  if (correct) {
    stats.consecutiveCorrect += 1;
    stats.nextEncounterGap = Math.min(25, Math.max(1, stats.nextEncounterGap * 2));
  } else {
    stats.consecutiveCorrect = 0;
    stats.nextEncounterGap = 1;
  }
}

function computeConfidence(stats) {
  const correct = stats.clozeCorrect + stats.copyCorrect;
  const wrong = stats.clozeWrong + stats.copyWrong;
  const total = Math.max(1, correct + wrong);
  const accuracy = correct / total;
  const streak = stats.consecutiveCorrect || 0;
  return accuracy * 70 + Math.min(30, streak * 4);
}

function updateGraduation(term) {
  const stats = term.stats;
  const correct = stats.clozeCorrect + stats.copyCorrect;
  const wrong = stats.clozeWrong + stats.copyWrong;
  const streak = stats.consecutiveCorrect || 0;
  stats.confidence = computeConfidence(stats);

  if (stats.confidence >= 92 && correct >= 15 && streak >= 8) term.status = "graduated";
  else if (stats.confidence >= 75 && correct >= 8) term.status = "familiar";
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

/* ---------------- Manage Vocab tab ---------------- */

function commitAddTerm() {
  const term = cleanTerm(newTermInput.value);
  if (!term) return;

  const key = normalizeKey(term);
  if (vocabTerms[key]) {
    alert(`"${vocabTerms[key].term}" already exists.`);
    viewState[key] = { open: true };
    addTermForm.classList.add("hidden");
    renderVocabList();
    return;
  }

  const now = new Date().toISOString();
  vocabTerms[key] = {
    term,
    normalized: key,
    createdAt: now,
    updatedAt: now,
    status: "new",
    selectedByUser: true,
    forms: [],
    stats: createStats(),
    sentences: []
  };

  viewState[key] = { open: true };
  addTermForm.classList.add("hidden");
  saveAndRefreshAll();
}

function renameTerm(oldKey, rawNewTerm) {
  const term = vocabTerms[oldKey];
  if (!term) return;

  const newTerm = cleanTerm(rawNewTerm);
  if (!newTerm) { renderVocabList(); return; }

  const newKey = normalizeKey(newTerm);
  const now = new Date().toISOString();

  if (newKey === oldKey) {
    term.term = newTerm;
    term.updatedAt = now;
    saveAndRefreshAll();
    return;
  }

  if (vocabTerms[newKey]) {
    const merge = confirm(`"${vocabTerms[newKey].term}" already exists. Merge these sentences into it?`);
    if (!merge) { renderVocabList(); return; }

    const target = vocabTerms[newKey];
    for (const sentence of term.sentences || []) {
      const exists = target.sentences.some(s => normalizeWhitespace(s.text) === normalizeWhitespace(sentence.text));
      if (!exists) target.sentences.push(sentence);
    }
    target.forms = Array.from(new Set([...(target.forms || []), ...(term.forms || [])]));
    target.updatedAt = now;
    delete vocabTerms[oldKey];
    delete viewState[oldKey];
    viewState[newKey] = { open: true };
    saveAndRefreshAll();
    return;
  }

  vocabTerms[newKey] = { ...term, term: newTerm, normalized: newKey, updatedAt: now };
  delete vocabTerms[oldKey];
  delete viewState[oldKey];
  viewState[newKey] = { open: true };
  saveAndRefreshAll();
}

function resetTermProgress(key) {
  const term = vocabTerms[key];
  if (!term) return;
  const count = term.sentences?.length || 0;
  const confirmed = confirm(`Reset all practice progress for "${term.term}"?${count ? ` This also resets progress for its ${count} sentence${count === 1 ? "" : "s"}.` : ""}`);
  if (!confirmed) return;

  term.stats = createStats();
  term.status = "new";
  for (const sentence of term.sentences || []) {
    sentence.stats = createStats();
  }
  term.updatedAt = new Date().toISOString();
  saveAndRefreshAll();
}

function resetSentenceProgress(key, id) {
  const term = vocabTerms[key];
  if (!term) return;
  const sentence = term.sentences?.find(s => s.id === id);
  if (!sentence) return;

  const confirmed = confirm("Reset practice progress for this sentence?");
  if (!confirmed) return;

  sentence.stats = createStats();
  term.updatedAt = new Date().toISOString();
  viewState[key] = { open: true };
  saveAndRefreshAll();
}

function saveTermForms(key, forms) {
  const term = vocabTerms[key];
  if (!term) return;
  term.forms = forms;
  term.updatedAt = new Date().toISOString();
  saveAndRefreshAll();
}

function deleteTerm(key) {
  const term = vocabTerms[key];
  if (!term) return;
  const count = term.sentences?.length || 0;
  const confirmed = confirm(`Delete "${term.term}"${count ? ` and its ${count} sentence${count === 1 ? "" : "s"}` : ""}? This cannot be undone.`);
  if (!confirmed) return;

  delete vocabTerms[key];
  delete viewState[key];
  saveAndRefreshAll();
}

function addSentenceToTerm(key, rawText) {
  const term = vocabTerms[key];
  if (!term) return;

  const text = cleanSentence(rawText);
  if (!text) return;

  const exists = term.sentences.some(s => normalizeWhitespace(s.text) === normalizeWhitespace(text));
  if (exists) { alert("That sentence is already saved for this term."); return; }

  term.sentences.push({
    id: crypto.randomUUID(),
    text,
    sourceUrl: "",
    sourceTitle: "",
    sourceSite: "",
    createdAt: new Date().toISOString(),
    stats: createStats()
  });
  term.updatedAt = new Date().toISOString();
  viewState[key] = { open: true };
  saveAndRefreshAll();
}

function editSentence(key, id, rawText) {
  const term = vocabTerms[key];
  if (!term) return;
  const sentence = term.sentences.find(s => s.id === id);
  if (!sentence) return;

  const text = cleanSentence(rawText);
  if (!text) { alert("Sentence text can't be empty. Delete it instead if you want to remove it."); renderVocabList(); return; }
  if (normalizeWhitespace(text) === normalizeWhitespace(sentence.text)) return;

  sentence.text = text;
  sentence.updatedAt = new Date().toISOString();
  term.updatedAt = sentence.updatedAt;
  viewState[key] = { open: true };
  saveAndRefreshAll();
}

function deleteSentence(key, id) {
  const term = vocabTerms[key];
  if (!term) return;
  const confirmed = confirm("Delete this sentence?");
  if (!confirmed) return;

  term.sentences = term.sentences.filter(s => s.id !== id);
  term.updatedAt = new Date().toISOString();
  viewState[key] = { open: true };
  saveAndRefreshAll();
}

async function saveAndRefreshAll() {
  await persist();
  renderTermSelect();
  renderTable();
  renderVocabList();
  if (Object.keys(vocabTerms).length) {
    emptyPractice.classList.add("hidden");
    if (!vocabTerms[currentTermKey]) {
      currentTermKey = Object.keys(vocabTerms)[0];
      termSelect.value = currentTermKey;
    }
    startNext();
  } else {
    emptyPractice.classList.remove("hidden");
    card.classList.add("hidden");
  }
}

function renderVocabList() {
  vocabList.innerHTML = "";
  const keys = Object.keys(vocabTerms).sort((a, b) => vocabTerms[a].term.localeCompare(vocabTerms[b].term));
  emptyManage.classList.toggle("hidden", keys.length > 0);

  for (const key of keys) {
    vocabList.appendChild(buildVocabCard(key));
  }
  applyManageFilter();
}

function buildVocabCard(key) {
  const term = vocabTerms[key];
  const state = (viewState[key] ||= { open: false });
  const status = term.status || "new";
  const confidence = Math.round(term.stats?.confidence || 0);
  const sentenceCount = term.sentences?.length || 0;

  const card = document.createElement("div");
  card.className = "vocabCard" + (state.open ? " open" : "");
  card.dataset.key = key;

  card.innerHTML = `
    <div class="vocabCardHeader" data-action="toggle">
      <span class="chevron">▶</span>
      <span class="vocabTermName">${escapeHtml(term.term)}</span>
      <span class="badge badge-${escapeHtml(status)}">${escapeHtml(status)}</span>
      <span class="vocabTermMeta">${sentenceCount} sentence${sentenceCount === 1 ? "" : "s"} · ${confidence}% confidence</span>
      <div class="vocabCardActions">
        <button class="small ghost" data-action="reset-term" type="button">Reset progress</button>
        <button class="small ghost" data-action="rename" type="button">Rename</button>
        <button class="small danger" data-action="delete-term" type="button">Delete</button>
      </div>
    </div>
    <div class="vocabCardBody">
      <div class="editTermRow hidden">
        <input type="text" class="renameInput" value="${escapeHtml(term.term)}">
        <button class="small" data-action="save-rename" type="button">Save</button>
        <button class="small ghost" data-action="cancel-rename" type="button">Cancel</button>
      </div>
      <div class="formsRow">
        <div class="formsLabel">Manual forms <span class="hint">— conjugations, plurals, etc. found in captured sentences that the exact matcher won't recognize on its own (comma-separated)</span></div>
        <div class="formsInputRow">
          <input type="text" class="formsInput" placeholder="e.g. abouti, aboutit, aboutissant" value="${escapeHtml((term.forms || []).join(", "))}">
          <button class="small" data-action="save-forms" type="button">Save</button>
        </div>
      </div>
      <div class="sentenceList"></div>
      <div class="addSentenceRow">
        <textarea rows="2" placeholder="Add a new sentence for “${escapeHtml(term.term)}”…"></textarea>
        <button class="small" data-action="add-sentence" type="button">Add</button>
      </div>
    </div>
  `;

  const sentenceListEl = card.querySelector(".sentenceList");
  const sentences = term.sentences || [];
  if (!sentences.length) {
    sentenceListEl.innerHTML = `<div class="noSentences">No sentences yet — add one below.</div>`;
  } else {
    for (const sentence of sentences) {
      sentenceListEl.appendChild(buildSentenceRow(sentence));
    }
  }

  return card;
}

function buildSentenceRow(sentence) {
  const row = document.createElement("div");
  row.className = "sentenceRow";
  row.dataset.id = sentence.id;

  const metaParts = [sentence.sourceSite, sentence.createdAt ? new Date(sentence.createdAt).toLocaleDateString() : ""].filter(Boolean);
  if (sentence.stats?.timesReviewed) {
    metaParts.push(`${sentence.stats.timesReviewed} reviewed · ${Math.round(sentence.stats.confidence || 0)}% confidence`);
  }
  const meta = metaParts.join(" · ");

  row.innerHTML = `
    <div class="sentenceText">
      <textarea rows="2">${escapeHtml(sentence.text)}</textarea>
      ${meta ? `<div class="sentenceMeta">${escapeHtml(meta)}</div>` : ""}
    </div>
    <div class="sentenceRowActions">
      <button class="small" data-action="save-sentence" type="button">Save</button>
      <button class="small ghost" data-action="reset-sentence" type="button">Reset progress</button>
      <button class="small danger" data-action="delete-sentence" type="button">Delete</button>
    </div>
  `;
  return row;
}

function handleVocabListClick(event) {
  const actionEl = event.target.closest("[data-action]");
  const cardEl = event.target.closest(".vocabCard");
  if (!cardEl) return;
  const key = cardEl.dataset.key;

  if (actionEl?.dataset.action === "toggle") {
    if (event.target.closest(".vocabCardActions")) return;
    const state = (viewState[key] ||= { open: false });
    state.open = !state.open;
    cardEl.classList.toggle("open", state.open);
    return;
  }

  if (!actionEl) return;
  const action = actionEl.dataset.action;

  if (action === "rename") {
    const state = (viewState[key] ||= { open: false });
    state.open = true;
    cardEl.classList.add("open");
    cardEl.querySelector(".editTermRow").classList.remove("hidden");
    const input = cardEl.querySelector(".renameInput");
    input.focus();
    input.select();
    return;
  }

  if (action === "cancel-rename") {
    cardEl.querySelector(".editTermRow").classList.add("hidden");
    return;
  }

  if (action === "save-rename") {
    const input = cardEl.querySelector(".renameInput");
    renameTerm(key, input.value);
    return;
  }

  if (action === "save-forms") {
    const input = cardEl.querySelector(".formsInput");
    const forms = input.value.split(",").map(f => cleanTerm(f)).filter(Boolean);
    saveTermForms(key, forms);
    return;
  }

  if (action === "delete-term") {
    deleteTerm(key);
    return;
  }

  if (action === "reset-term") {
    resetTermProgress(key);
    return;
  }

  if (action === "reset-sentence") {
    const sentenceRow = actionEl.closest(".sentenceRow");
    resetSentenceProgress(key, sentenceRow.dataset.id);
    return;
  }

  if (action === "add-sentence") {
    const textarea = cardEl.querySelector(".addSentenceRow textarea");
    addSentenceToTerm(key, textarea.value);
    return;
  }

  if (action === "save-sentence") {
    const sentenceRow = actionEl.closest(".sentenceRow");
    const textarea = sentenceRow.querySelector("textarea");
    editSentence(key, sentenceRow.dataset.id, textarea.value);
    return;
  }

  if (action === "delete-sentence") {
    const sentenceRow = actionEl.closest(".sentenceRow");
    deleteSentence(key, sentenceRow.dataset.id);
    return;
  }
}

function applyManageFilter() {
  const filter = manageFilterText;
  const cards = vocabList.querySelectorAll(".vocabCard");
  let visibleCount = 0;

  cards.forEach(cardEl => {
    const key = cardEl.dataset.key;
    const term = vocabTerms[key];
    if (!term) return;
    const matches = !filter
      || term.term.toLowerCase().includes(filter)
      || (term.sentences || []).some(s => s.text.toLowerCase().includes(filter))
      || (term.forms || []).some(f => f.toLowerCase().includes(filter));
    cardEl.classList.toggle("hidden", !matches);
    if (matches) visibleCount += 1;
  });

  const hasTerms = Object.keys(vocabTerms).length > 0;
  emptyManage.classList.toggle("hidden", hasTerms);
  noManageMatches.classList.toggle("hidden", !hasTerms || !filter || visibleCount > 0);
}

/* ---------------- Shared helpers ---------------- */

function cleanTerm(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 120);
}

function cleanSentence(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 1200);
}

function normalizeKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ");
}

function normalizeWhitespace(value) {
  return String(value || "").trim().replace(/\s+/g, " ");
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value) {
  return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
