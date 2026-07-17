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
  hoverCaptureHotkey: { ctrl: true, shift: true, alt: false, meta: false, code: "KeyK" },
  lookupSites: [
    { id: "wordReference", name: "WordReference", enabled: true, urlTemplate: "https://www.wordreference.com/{wordReferencePair}/{term}" },
    { id: "linguee", name: "Linguee", enabled: true, urlTemplate: "https://www.linguee.com/{lingueePair}/search?source=auto&query={term}" }
  ]
};

let lookupSitesState = DEFAULTS.lookupSites.map(site => ({ ...site }));

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
  lookupSitesState = normalizeLookupSites(settings.lookupSites);
  renderLookupSites();
}

function normalizeLookupSites(sites) {
  const incoming = Array.isArray(sites) ? sites : [];
  const normalized = [];
  const seenIds = new Set();

  for (const site of incoming) {
    const normalizedSite = normalizeLookupSite(site);
    if (!normalizedSite || seenIds.has(normalizedSite.id)) continue;
    normalized.push(normalizedSite);
    seenIds.add(normalizedSite.id);
  }

  for (const site of DEFAULTS.lookupSites) {
    if (!seenIds.has(site.id)) normalized.push({ ...site });
  }

  return normalized;
}

function normalizeLookupSite(site) {
  if (!site || typeof site !== "object") return null;
  const matchingDefault = DEFAULTS.lookupSites.find(defaultSite => defaultSite.id === site.id);
  const id = String(site.id || crypto.randomUUID()).trim();
  const name = String(site.name || matchingDefault?.name || "Lookup site").trim();
  const urlTemplate = String(site.urlTemplate || matchingDefault?.urlTemplate || "").trim();
  if (!id || !name || !urlTemplate) return null;
  return { id, name, urlTemplate, enabled: site.enabled !== false };
}

function renderLookupSites() {
  const list = document.getElementById("lookupSites");
  list.replaceChildren(...lookupSitesState.map((site, index) => {
    const item = document.createElement("li");
    item.className = "lookupSite";

    const enabledLabel = document.createElement("label");
    enabledLabel.className = "lookupSiteEnabled";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = site.enabled;
    checkbox.addEventListener("change", async () => {
      lookupSitesState[index] = { ...lookupSitesState[index], enabled: checkbox.checked };
      await saveLookupSites("Search websites saved.");
    });
    enabledLabel.append(checkbox, document.createTextNode(" Enabled"));

    const nameLabel = document.createElement("label");
    nameLabel.textContent = "Website name";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = site.name;
    nameInput.placeholder = "Website name";
    nameInput.addEventListener("input", () => {
      lookupSitesState[index] = { ...lookupSitesState[index], name: nameInput.value };
    });
    nameInput.addEventListener("change", async () => {
      lookupSitesState[index] = { ...lookupSitesState[index], name: nameInput.value.trim() || "Lookup site" };
      renderLookupSites();
      await saveLookupSites("Search website updated.");
    });
    nameLabel.append(nameInput);

    const urlLabel = document.createElement("label");
    urlLabel.textContent = "Search URL";
    const urlInput = document.createElement("input");
    urlInput.type = "url";
    urlInput.value = site.urlTemplate;
    urlInput.placeholder = "https://example.com/search?q={term}";
    urlInput.addEventListener("input", () => {
      lookupSitesState[index] = { ...lookupSitesState[index], urlTemplate: urlInput.value };
    });
    urlInput.addEventListener("change", async () => {
      lookupSitesState[index] = { ...lookupSitesState[index], urlTemplate: urlInput.value.trim() };
      await saveLookupSites("Search website updated.");
    });
    urlLabel.append(urlInput);

    const controls = document.createElement("div");
    controls.className = "lookupSiteControls";
    const up = document.createElement("button");
    up.type = "button";
    up.textContent = "↑";
    up.setAttribute("aria-label", `Move ${site.name} up`);
    up.disabled = index === 0;
    up.addEventListener("click", () => moveLookupSite(index, -1));

    const down = document.createElement("button");
    down.type = "button";
    down.textContent = "↓";
    down.setAttribute("aria-label", `Move ${site.name} down`);
    down.disabled = index === lookupSitesState.length - 1;
    down.addEventListener("click", () => moveLookupSite(index, 1));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "Delete";
    remove.setAttribute("aria-label", `Delete ${site.name}`);
    remove.addEventListener("click", () => removeLookupSite(index));
    controls.append(up, down, remove);

    item.append(enabledLabel, nameLabel, urlLabel, controls);
    return item;
  }));
}

async function moveLookupSite(index, direction) {
  const nextIndex = index + direction;
  if (nextIndex < 0 || nextIndex >= lookupSitesState.length) return;
  [lookupSitesState[index], lookupSitesState[nextIndex]] = [lookupSitesState[nextIndex], lookupSitesState[index]];
  renderLookupSites();
  await saveLookupSites("Search website order saved.");
}

async function removeLookupSite(index) {
  lookupSitesState.splice(index, 1);
  renderLookupSites();
  await saveLookupSites("Search website deleted.");
}

async function addLookupSite() {
  lookupSitesState.push({
    id: crypto.randomUUID(),
    name: "New search site",
    enabled: true,
    urlTemplate: "https://example.com/search?q={term}"
  });
  renderLookupSites();
  await saveLookupSites("Search website added. Edit its name and URL.");
}

async function saveLookupSites(message = "Search websites saved.") {
  lookupSitesState = lookupSitesState.map(normalizeLookupSite).filter(Boolean);
  await chrome.storage.sync.set({ lookupSites: lookupSitesState });
  document.getElementById("status").textContent = message;
}

async function resetLookupSites() {
  lookupSitesState = DEFAULTS.lookupSites.map(site => ({ ...site }));
  renderLookupSites();
  await saveLookupSites("Search websites reset.");
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
    userLevel: document.getElementById("userLevel").value,
    lookupSites: lookupSitesState,
    settingsUpdatedAt: new Date().toISOString()
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
document.getElementById("addLookupSite").addEventListener("click", addLookupSite);
document.getElementById("resetLookupSites").addEventListener("click", resetLookupSites);
document.getElementById("exportData").addEventListener("click", exportData);
document.getElementById("importData").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try { await importData(file); }
  catch (err) { document.getElementById("status").textContent = `Import failed: ${err.message}`; }
});

document.getElementById("syncSignIn").addEventListener("click", async () => {
  const status = document.getElementById("syncStatus");
  status.textContent = "Signing in…";
  const emailInput = document.getElementById("syncEmail");
  const passwordInput = document.getElementById("syncPassword");
  const result = await window.sync.signIn(emailInput.value.trim(), passwordInput.value);
  if (!result.ok) {
    status.textContent = result.error;
    return;
  }
  passwordInput.value = "";
  await renderSyncUi();
  await runSync();
});

document.getElementById("syncSignInGoogle").addEventListener("click", async () => {
  const status = document.getElementById("syncStatus");
  status.textContent = "Signing in with Google…";
  const result = await window.sync.signInWithGoogle();
  if (!result.ok) {
    status.textContent = result.error;
    return;
  }
  await renderSyncUi();
  await runSync();
});

document.getElementById("syncSignOut").addEventListener("click", async () => {
  await window.sync.signOut();
  await renderSyncUi();
});

document.getElementById("syncNowBtn").addEventListener("click", runSync);

async function renderSyncUi() {
  const session = await window.sync.getSession();
  document.getElementById("syncSignedOut").classList.toggle("hidden", Boolean(session));
  document.getElementById("syncSignedIn").classList.toggle("hidden", !session);
  const status = document.getElementById("syncStatus");
  if (session) {
    const lastSyncedAt = await window.sync.getLastSyncedAt();
    const lastSynced = lastSyncedAt ? new Date(lastSyncedAt).toLocaleString() : "never";
    status.textContent = `Signed in as ${session.email} · last synced ${lastSynced}`;
  }
}

async function runSync() {
  const status = document.getElementById("syncStatus");
  status.textContent = "Syncing…";
  const result = await window.sync.syncNow();
  if (!result.ok) {
    status.textContent = `Sync failed: ${result.error}`;
    return;
  }
  await renderSyncUi();
  if (result.pushError) status.textContent = `Synced locally, but couldn't push: ${result.pushError}`;
}

load();
renderSyncUi();
