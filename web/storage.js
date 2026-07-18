const SETTINGS_KEY = "languageToolkit.settings";

const SETTINGS_DEFAULTS = { lang: "fr-FR", audioMode: "sentence", accentMode: "flexible", settingsUpdatedAt: null };

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
  const merged = { ...getSettings(), ...patch, settingsUpdatedAt: new Date().toISOString() };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(merged));
  return merged;
}

window.storage = { SETTINGS_DEFAULTS, getSettings, setSettings };
