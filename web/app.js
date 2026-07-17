let vocabTerms = {};
let settings = {};
let currentTermKey = "";
let currentSentence = null;
let currentTerm = null;
let currentClozeAnswers = [];
let currentClozeRevealHtml = "";
let awaitingCopy = false;
let manageFilterText = "";
const viewState = {}; // key -> { open: boolean }
const REVIEW_GAP_UNIT_MS = 24 * 60 * 60 * 1000;


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

const settingsPanel = document.getElementById("settingsPanel");
const settingsLang = document.getElementById("settingsLang");
const settingsAudioMode = document.getElementById("settingsAudioMode");
const settingsAccentMode = document.getElementById("settingsAccentMode");
const exportDataBtn = document.getElementById("exportData");
const importDataInput = document.getElementById("importData");
const dataStatus = document.getElementById("dataStatus");

const syncSignedOut = document.getElementById("syncSignedOut");
const syncSignedIn = document.getElementById("syncSignedIn");
const syncEmail = document.getElementById("syncEmail");
const syncPassword = document.getElementById("syncPassword");
const syncStatus = document.getElementById("syncStatus");

document.getElementById("options").addEventListener("click", () => {
  settingsPanel.classList.toggle("hidden");
});
document.getElementById("closeSettings").addEventListener("click", () => settingsPanel.classList.add("hidden"));
document.getElementById("saveSettings").addEventListener("click", saveSettingsPanel);
document.getElementById("start").addEventListener("click", startNext);
document.getElementById("speak").addEventListener("click", () => { if (currentSentence) speak(currentSentence.text, settings.lang); });
termSelect.addEventListener("change", () => { currentTermKey = termSelect.value; startNext({ preferredKey: currentTermKey }); });

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

exportDataBtn.addEventListener("click", exportVocabJson);
importDataInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    await importVocabJson(file);
    dataStatus.textContent = "Imported vocab JSON.";
  } catch (error) {
    dataStatus.textContent = `Import failed: ${error.message}`;
  }
  importDataInput.value = "";
});

document.getElementById("syncSignIn").addEventListener("click", async () => {
  syncStatus.textContent = "Signing in…";
  const result = await window.sync.signIn(syncEmail.value.trim(), syncPassword.value);
  if (!result.ok) {
    syncStatus.textContent = result.error;
    return;
  }
  syncPassword.value = "";
  renderSyncUi();
  await runSync();
});

document.getElementById("syncSignInGoogle").addEventListener("click", async () => {
  syncStatus.textContent = "Signing in with Google…";
  const result = await window.sync.signInWithGoogle();
  if (!result.ok) {
    syncStatus.textContent = result.error;
    return;
  }
  renderSyncUi();
  await runSync();
});

document.getElementById("syncSignOut").addEventListener("click", () => {
  window.sync.signOut();
  renderSyncUi();
});

document.getElementById("syncNowBtn").addEventListener("click", runSync);

init();

function renderSyncUi() {
  const session = window.sync.getSession();
  syncSignedOut.classList.toggle("hidden", Boolean(session));
  syncSignedIn.classList.toggle("hidden", !session);
  if (session) {
    const lastSyncedAt = window.sync.getLastSyncedAt();
    const lastSynced = lastSyncedAt ? new Date(lastSyncedAt).toLocaleString() : "never";
    syncStatus.textContent = `Signed in as ${session.email} · last synced ${lastSynced}`;
  }
}

async function runSync() {
  syncStatus.textContent = "Syncing…";
  const result = await window.sync.syncNow();
  if (!result.ok) {
    syncStatus.textContent = `Sync failed: ${result.error}`;
    return;
  }
  vocabTerms = window.storage.getVocabTerms();
  settings = window.storage.getSettings();
  settingsLang.value = settings.lang;
  settingsAudioMode.value = settings.audioMode;
  settingsAccentMode.value = settings.accentMode;
  renderTermSelect();
  renderTable();
  renderVocabList();
  renderSyncUi();
  if (result.pushError) syncStatus.textContent = `Synced locally, but couldn't push: ${result.pushError}`;
}

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
  settings = window.storage.getSettings();
  settingsLang.value = settings.lang;
  settingsAudioMode.value = settings.audioMode;
  settingsAccentMode.value = settings.accentMode;

  vocabTerms = window.storage.getVocabTerms();
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

  renderSyncUi();
  if (window.sync.getSession()) await runSync();
}

function saveSettingsPanel() {
  settings = window.storage.setSettings({
    lang: settingsLang.value,
    audioMode: settingsAudioMode.value,
    accentMode: settingsAccentMode.value
  });
  settingsPanel.classList.add("hidden");
}

async function persist() {
  window.storage.setVocabTerms(vocabTerms);
  if (window.sync.getSession()) window.sync.schedulePush();
}

function exportVocabJson() {
  const payload = {
    app: "Inline Language Toolkit",
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    vocabTerms: window.storage.getVocabTerms()
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `language-toolkit-vocab-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  dataStatus.textContent = "Exported vocab JSON.";
}

async function importVocabJson(file) {
  const text = await file.text();
  const payload = JSON.parse(text);
  const incoming = payload.vocabTerms || payload;
  if (!incoming || typeof incoming !== "object") throw new Error("No vocabTerms object found.");
  const merged = { ...window.storage.getVocabTerms(), ...incoming };
  window.storage.setVocabTerms(merged);
  vocabTerms = merged;
  saveAndRefreshAll();
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

async function startNext(options = {}) {
  currentTermKey = choosePracticeTermKey(options.preferredKey);
  if (currentTermKey) termSelect.value = currentTermKey;
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

  sentenceDisplay.textContent = "Loading vocabulary match…";
  const sentenceForCloze = currentSentence;
  const cloze = await clozeSentence(sentenceForCloze.text, currentTerm, sentenceForCloze.id);
  if (termSelect.value !== currentTermKey || currentSentence !== sentenceForCloze) return;
  currentClozeAnswers = cloze.answers;
  currentClozeRevealHtml = cloze.revealHtml;
  sentenceDisplay.innerHTML = cloze.html;
  statusLine.textContent = `${currentTerm.term} · ${currentTerm.status || "new"} · confidence ${Math.round(currentTerm.stats?.confidence || 0)}`;
  answer.focus();
}

function choosePracticeTermKey(preferredKey = null) {
  if (preferredKey && vocabTerms[preferredKey]?.sentences?.length) return preferredKey;

  const candidates = Object.entries(vocabTerms)
    .filter(([, term]) => term.sentences?.length)
    .map(([key, term]) => ({ key, term }))
    .filter(candidate => candidate.term.status !== "graduated");

  const pool = candidates.length
    ? candidates
    : Object.entries(vocabTerms)
        .filter(([, term]) => term.sentences?.length)
        .map(([key, term]) => ({ key, term }));

  if (!pool.length) return "";

  const alternatives = pool.filter(candidate => candidate.key !== currentTermKey);
  return chooseDueItem(alternatives.length ? alternatives : pool, candidate => candidate.term.stats).key;
}

function chooseSentence(term) {
  const sentences = term.sentences || [];
  if (sentences.length <= 1) return sentences[0];

  const alternatives = sentences.filter(sentence => sentence.id !== currentSentence?.id);
  return chooseDueItem(alternatives.length ? alternatives : sentences, sentence => sentence.stats);
}

function chooseDueItem(items, getStats) {
  const now = Date.now();
  return items
    .map(item => ({ item, priority: reviewPriority(getStats(item), now) + Math.random() * 0.01 }))
    .sort((a, b) => b.priority - a.priority)[0].item;
}

function reviewPriority(stats, now) {
  if (!stats?.lastReviewedAt) return Number.POSITIVE_INFINITY;
  const gap = Math.max(1, stats.nextEncounterGap || 1) * REVIEW_GAP_UNIT_MS;
  const elapsed = now - new Date(stats.lastReviewedAt).getTime();
  const dueRatio = elapsed / gap;
  const confidencePenalty = (100 - Math.min(100, Math.max(0, stats.confidence || 0))) / 100;
  return dueRatio + confidencePenalty;
}

async function clozeSentence(sentence, term, sentenceId) {
  const safeSentence = escapeHtml(sentence);
  const blank = `<span class="cloze-blank">&nbsp;</span>`;
  const answers = [term.term, ...(term.forms || [])].filter(Boolean);

  const response = await window.lexicon.matchVocabTermInSentence({
    term: term.term,
    sentence,
    forms: term.forms || [],
    lexicalEntry: term.lexicalEntry || null,
    lang: settings.lang
  });

  if (response?.lexicalEntry && !term.lexicalEntry) term.lexicalEntry = response.lexicalEntry;

  if (response?.match) {
    const matchedText = sentence.slice(response.match.start, response.match.end);
    const matchedAnswers = [...new Set([matchedText, ...answers])];
    const before = escapeHtml(sentence.slice(0, response.match.start));
    const after = escapeHtml(sentence.slice(response.match.end));
    const reveal = `<span class="cloze-answer-reveal">${escapeHtml(matchedText)}</span>`;
    return { html: `${before}${blank}${after}`, revealHtml: `${before}${reveal}${after}`, answers: matchedAnswers, sentenceId };
  }

  const reveal = `<span class="cloze-answer-reveal">${escapeHtml(answers[0] || term.term)}</span>`;
  return { html: `${blank} — ${safeSentence}`, revealHtml: `${reveal} — ${safeSentence}`, answers, sentenceId };
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
    revealClozeAnswer();
    answer.disabled = true;
    await speakAsync(currentSentence.text, settings.lang);
    answer.disabled = false;

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
    revealClozeAnswer();
    copyBox.disabled = true;
    await speakAsync(currentSentence.text, settings.lang);
    copyBox.disabled = false;
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

function revealClozeAnswer() {
  if (currentClozeRevealHtml) sentenceDisplay.innerHTML = currentClozeRevealHtml;
}

function speak(text, lang) {
  return speakAsync(text, lang);
}

function speakAsync(text, lang) {
  if (!text || !("speechSynthesis" in window)) return Promise.resolve();
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  utterance.rate = 0.9;
  const voices = window.speechSynthesis.getVoices();
  const bestVoice = voices.find(v => v.lang.toLowerCase() === lang.toLowerCase()) || voices.find(v => v.lang.toLowerCase().startsWith(lang.split("-")[0].toLowerCase()));
  if (bestVoice) utterance.voice = bestVoice;

  return new Promise(resolve => {
    utterance.onend = resolve;
    utterance.onerror = resolve;
    window.speechSynthesis.speak(utterance);
  });
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

async function commitAddTerm() {
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

  const createResult = await window.lexicon.createVocabTermRecord({ term });
  if (!createResult?.ok) {
    alert(createResult?.error || "Could not add term.");
    return;
  }

  vocabTerms = window.storage.getVocabTerms();
  currentTermKey = createResult.key;
  termSelect.value = currentTermKey;

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

  window.sync.recordTermTombstone(key);
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

  window.sync.recordSentenceTombstone(key, id);
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
