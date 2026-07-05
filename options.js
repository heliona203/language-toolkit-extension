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
  userLevel: "B1",
  hoverCaptureHotkey: { ctrl: true, shift: true, alt: false, meta: false, code: "KeyK" }
};

async function load() {
  const settings = await chrome.storage.sync.get(DEFAULTS);
  document.querySelector(`input[name="mode"][value="${settings.mode}"]`).checked = true;
  document.getElementById("lang").value = settings.lang;
  document.getElementById("lookupSourceLang").value = settings.lookupSourceLang;
  document.getElementById("lookupTargetLang").value = settings.lookupTargetLang;
  document.getElementById("density").value = String(settings.density);
  document.getElementById("minLength").value = String(settings.minLength);
  document.getElementById("audioMode").value = settings.audioMode;
  document.getElementById("accentMode").value = settings.accentMode;
  document.getElementById("foreignLanguageDetection").checked = Boolean(settings.foreignLanguageDetection);
  document.getElementById("userLevel").value = settings.userLevel;
  document.getElementById("hoverCaptureHotkeyDisplay").value = formatHotkey(settings.hoverCaptureHotkey);
}

function formatHotkey(hotkey) {
  if (!hotkey || !hotkey.code) return "Not set";

  const parts = [];
  if (hotkey.ctrl) parts.push("Ctrl");
  if (hotkey.meta) parts.push("Cmd");
  if (hotkey.alt) parts.push("Alt");
  if (hotkey.shift) parts.push("Shift");
  parts.push(codeToLabel(hotkey.code));
  return parts.join("+");
}

function codeToLabel(code) {
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
}

const IGNORED_RECORDING_CODES = new Set([
  "ControlLeft", "ControlRight",
  "ShiftLeft", "ShiftRight",
  "AltLeft", "AltRight",
  "MetaLeft", "MetaRight"
]);

function recordHoverCaptureHotkey() {
  const button = document.getElementById("recordHoverCaptureHotkey");
  const display = document.getElementById("hoverCaptureHotkeyDisplay");

  const previousValue = display.value;
  button.disabled = true;
  button.textContent = "Press a key combo…";
  display.value = "";

  const onKeydown = async (event) => {
    if (IGNORED_RECORDING_CODES.has(event.code)) return;

    event.preventDefault();
    event.stopPropagation();

    if (!event.ctrlKey && !event.altKey && !event.metaKey) {
      document.getElementById("status").textContent =
        "Include at least one modifier key (Ctrl, Alt, or Cmd).";
      display.value = previousValue;
      finish();
      return;
    }

    const hotkey = {
      ctrl: event.ctrlKey,
      shift: event.shiftKey,
      alt: event.altKey,
      meta: event.metaKey,
      code: event.code
    };

    await chrome.storage.sync.set({ hoverCaptureHotkey: hotkey });
    display.value = formatHotkey(hotkey);
    document.getElementById("status").textContent = "Hover-capture hotkey saved.";
    finish();
  };

  function finish() {
    document.removeEventListener("keydown", onKeydown, true);
    button.disabled = false;
    button.textContent = "Record";
  }

  document.addEventListener("keydown", onKeydown, true);
}

async function save() {
  const settings = {
    mode: document.querySelector('input[name="mode"]:checked').value,
    lang: document.getElementById("lang").value,
    lookupSourceLang: document.getElementById("lookupSourceLang").value,
    lookupTargetLang: document.getElementById("lookupTargetLang").value,
    density: Number(document.getElementById("density").value),
    minLength: Number(document.getElementById("minLength").value),
    audioMode: document.getElementById("audioMode").value,
    accentMode: document.getElementById("accentMode").value,
    foreignLanguageDetection: document.getElementById("foreignLanguageDetection").checked,
    userLevel: document.getElementById("userLevel").value
  };
  await chrome.storage.sync.set(settings);
  document.getElementById("status").textContent = "Saved.";
}

async function exportData() {
  const data = await chrome.storage.local.get({ vocabTerms: {}, pendingVocabTerm: "" });
  const payload = {
    app: "Inline Language Toolkit",
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    vocabTerms: data.vocabTerms || {}
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const filename = `language-toolkit-vocab-${new Date().toISOString().slice(0,10)}.json`;
  await chrome.downloads.download({ url, filename, saveAs: true });
  document.getElementById("status").textContent = "Export started.";
}

async function importData(file) {
  const text = await file.text();
  const payload = JSON.parse(text);
  const incoming = payload.vocabTerms || payload;
  if (!incoming || typeof incoming !== "object") throw new Error("No vocabTerms object found.");
  const data = await chrome.storage.local.get({ vocabTerms: {} });
  const merged = { ...(data.vocabTerms || {}), ...incoming };
  await chrome.storage.local.set({ vocabTerms: merged });
  document.getElementById("status").textContent = "Imported vocab JSON.";
}

document.getElementById("save").addEventListener("click", save);
document.querySelectorAll("input, select").forEach(el => {
  if (el.type !== "file") el.addEventListener("change", save);
});
document.getElementById("recordHoverCaptureHotkey").addEventListener("click", recordHoverCaptureHotkey);
document.getElementById("exportData").addEventListener("click", exportData);
document.getElementById("importData").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try { await importData(file); }
  catch (err) { document.getElementById("status").textContent = `Import failed: ${err.message}`; }
});

load();
