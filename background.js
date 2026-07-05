const DEFAULTS = {
  mode: "normal",
  lang: "fr-FR",
  lookupSourceLang: "en",
  lookupTargetLang: "fr",
  density: 12,
  minLength: 4,
  audioMode: "sentence",
  accentMode: "flexible",
  foreignLanguageDetection: true,
  userLevel: "B1"
};

chrome.commands.onCommand.addListener(async (command) => {
  if (command === "open_vocab_lookup") await openLookupForSelectedTerm();
  if (command === "save_selected_sentence") await saveSelectedSentenceForPendingTerm();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    if (message.type === "OPEN_LOOKUP_FOR_TERM") {
      const term = cleanTerm(message.term || "");
      if (!term) return sendResponse({ ok: false, error: "No term provided." });
      await setPendingTerm(term);
      await openLookupTabs(term);
      return sendResponse({ ok: true });
    }

    if (message.type === "SAVE_SENTENCE") {
      const result = await saveSentenceRecord(message.payload || {});
      return sendResponse(result);
    }

    if (message.type === "GET_PENDING_TERM") {
      const data = await chrome.storage.local.get({ pendingVocabTerm: "" });
      return sendResponse({ ok: true, term: data.pendingVocabTerm || "" });
    }
  })();

  return true;
});

async function openLookupForSelectedTerm() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, { type: "GET_SELECTED_TEXT" });
  } catch {
    return;
  }

  const term = cleanTerm(response?.text || "");
  if (!term) return;

  await setPendingTerm(term);
  await openLookupTabs(term);
}

async function saveSelectedSentenceForPendingTerm() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, { type: "GET_SELECTED_SENTENCE_FOR_SAVE" });
  } catch {
    return;
  }

  if (!response?.sentence) return;

  const data = await chrome.storage.local.get({ pendingVocabTerm: "" });
  const term = cleanTerm(response.term || data.pendingVocabTerm || "");
  if (!term) return;

  await saveSentenceRecord({
    term,
    sentence: response.sentence,
    sourceUrl: response.sourceUrl,
    sourceTitle: response.sourceTitle,
    sourceSite: response.sourceSite
  });
}

async function setPendingTerm(term) {
  await chrome.storage.local.set({ pendingVocabTerm: cleanTerm(term) });
}

async function openLookupTabs(term) {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  const urls = buildLookupUrls(term, settings);
  for (const url of urls) await chrome.tabs.create({ url, active: false });
}

function buildLookupUrls(term, settings) {
  const encoded = encodeURIComponent(term);
  const pair = getLanguagePair(settings.lookupSourceLang, settings.lookupTargetLang);
  return [
    pair.wordReference ? `https://www.wordreference.com/${pair.wordReference}/${encoded}` : `https://www.wordreference.com/definition/${encoded}`,
    pair.linguee ? `https://www.linguee.com/${pair.linguee}/search?source=auto&query=${encoded}` : `https://www.linguee.com/search?source=auto&query=${encoded}`
  ];
}

function getLanguagePair(source, target) {
  const pairs = {
    "en-fr": { wordReference: "enfr", linguee: "english-french" },
    "fr-en": { wordReference: "fren", linguee: "french-english" },
    "en-es": { wordReference: "enes", linguee: "english-spanish" },
    "es-en": { wordReference: "esen", linguee: "spanish-english" },
    "en-it": { wordReference: "enit", linguee: "english-italian" },
    "it-en": { wordReference: "iten", linguee: "italian-english" },
    "en-de": { wordReference: "ende", linguee: "english-german" },
    "de-en": { wordReference: "deen", linguee: "german-english" }
  };
  return pairs[`${source}-${target}`] || pairs[`${target}-${source}`] || {};
}

async function saveSentenceRecord(payload) {
  const term = cleanTerm(payload.term || "");
  const sentence = cleanSentence(payload.sentence || "");
  if (!term || !sentence) return { ok: false, error: "Missing term or sentence." };

  const now = new Date().toISOString();
  const data = await chrome.storage.local.get({ vocabTerms: {} });
  const vocabTerms = data.vocabTerms || {};
  const key = normalizeKey(term);

  if (!vocabTerms[key]) {
    vocabTerms[key] = {
      term,
      normalized: key,
      createdAt: now,
      updatedAt: now,
      status: "new",
      selectedByUser: true,
      forms: [],
      stats: {
        timesReviewed: 0,
        clozeCorrect: 0,
        clozeWrong: 0,
        copyCorrect: 0,
        copyWrong: 0,
        consecutiveCorrect: 0,
        lastReviewedAt: null,
        nextEncounterGap: 1,
        confidence: 0
      },
      sentences: []
    };
  }

  const exists = vocabTerms[key].sentences.some(s => normalizeWhitespace(s.text) === normalizeWhitespace(sentence));
  if (!exists) {
    vocabTerms[key].sentences.push({
      id: crypto.randomUUID(),
      text: sentence,
      sourceUrl: payload.sourceUrl || "",
      sourceTitle: payload.sourceTitle || "",
      sourceSite: payload.sourceSite || guessSourceSite(payload.sourceUrl || ""),
      createdAt: now
    });
  }

  vocabTerms[key].updatedAt = now;
  await chrome.storage.local.set({ vocabTerms, pendingVocabTerm: term });
  return { ok: true, term, count: vocabTerms[key].sentences.length };
}

function guessSourceSite(url) {
  try {
    const host = new URL(url).hostname;
    if (host.includes("wordreference")) return "WordReference";
    if (host.includes("linguee")) return "Linguee";
    return host;
  } catch {
    return "";
  }
}

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
