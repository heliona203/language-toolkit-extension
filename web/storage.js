const SETTINGS_KEY = "languageToolkit.settings";
const VOCAB_KEY = "languageToolkit.vocabTerms";

const SETTINGS_DEFAULTS = { lang: "fr-FR", audioMode: "sentence", accentMode: "flexible" };

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function getSettings() {
  return { ...SETTINGS_DEFAULTS, ...readJson(SETTINGS_KEY, {}) };
}

function setSettings(patch) {
  const merged = { ...getSettings(), ...patch };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
  return merged;
}

function getVocabTerms() {
  return readJson(VOCAB_KEY, {});
}

function setVocabTerms(vocabTerms) {
  localStorage.setItem(VOCAB_KEY, JSON.stringify(vocabTerms || {}));
}

window.storage = { SETTINGS_DEFAULTS, getSettings, setSettings, getVocabTerms, setVocabTerms };
