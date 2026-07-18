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

async function getSettings() {
  return await chrome.storage.sync.get(DEFAULTS);
}

async function sendToActiveTab(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return null;
  return await chrome.tabs.sendMessage(tab.id, message);
}

function modeName(mode) {
  if (mode === "userDriven") return "User-driven";
  if (mode === "userControlled") return "User-controlled";
  return "Normal";
}

document.getElementById("activate").addEventListener("click", async () => {
  const settings = await getSettings();
  await sendToActiveTab({ type: "ACTIVATE_PAGE", settings });
  document.getElementById("status").textContent = "Activated.";
});

document.getElementById("makeCloze").addEventListener("click", async () => {
  const settings = await getSettings();
  await sendToActiveTab({ type: "MAKE_CLOZE_NOW", settings });
  document.getElementById("status").textContent = "Cloze populated.";
});

document.getElementById("clear").addEventListener("click", async () => {
  await sendToActiveTab({ type: "CLEAR_CLOZE" });
  document.getElementById("status").textContent = "Page restored.";
});

document.getElementById("lookupSelection").addEventListener("click", async () => {
  const response = await sendToActiveTab({ type: "GET_SELECTED_TEXT" });
  const term = (response?.text || "").trim();
  if (!term) {
    document.getElementById("status").textContent = "Select a term first.";
    return;
  }
  await chrome.runtime.sendMessage({ type: "OPEN_LOOKUP_FOR_TERM", term });
  document.getElementById("status").textContent = `Opened lookup for “${term}”.`;
});

document.getElementById("saveSentence").addEventListener("click", async () => {
  const response = await sendToActiveTab({ type: "GET_SELECTED_SENTENCE_FOR_SAVE" });
  if (!response?.sentence) {
    document.getElementById("status").textContent = "Select a sentence first.";
    return;
  }
  const result = await chrome.runtime.sendMessage({ type: "SAVE_SENTENCE", payload: response });
  document.getElementById("status").textContent = result?.ok ? `Saved for “${result.term}”.` : (result?.error || "Could not save.");
});

const WEB_APP_URL = "https://heliona203.github.io/language-toolkit-extension/";

document.getElementById("review").addEventListener("click", () => {
  chrome.tabs.create({ url: WEB_APP_URL });
});

document.getElementById("manageVocab").addEventListener("click", () => {
  chrome.tabs.create({ url: `${WEB_APP_URL}#manage` });
});

document.getElementById("options").addEventListener("click", () => chrome.runtime.openOptionsPage());

getSettings().then(settings => {
  document.getElementById("modeLabel").textContent = `Current cloze mode: ${modeName(settings.mode)}`;
});
