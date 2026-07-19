/* Talks directly to Firebase's REST APIs (no SDK, no build step). Mirrors
   ../sync.js (the extension's version) but backed by localStorage/window.storage
   instead of chrome.storage — kept as a near-duplicate rather than a shared
   module, matching this repo's existing style. */

let firebaseApiKey = FIREBASE_API_KEY;
let firebaseProjectId = FIREBASE_PROJECT_ID;

function firestoreBase() {
  return `https://firestore.googleapis.com/v1/projects/${firebaseProjectId}/databases/(default)/documents`;
}

function authSignInUrl() {
  return `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${firebaseApiKey}`;
}

function authRefreshUrl() {
  return `https://securetoken.googleapis.com/v1/token?key=${firebaseApiKey}`;
}

function configureFirebase({ apiKey, projectId } = {}) {
  // Firebase web API keys are intentionally public. Receiving these values
  // from the signed-in extension lets the static companion page use the same
  // project even when its checked-in configuration is left blank.
  if (apiKey) firebaseApiKey = apiKey;
  if (projectId) firebaseProjectId = projectId;
}

function isFirebaseConfigured() {
  return Boolean(firebaseApiKey && firebaseProjectId);
}

const AUTH_SESSION_KEY = "languageToolkit.authSession";
const DELETED_KEYS_KEY = "languageToolkit.deletedKeys";
const LAST_SYNCED_KEY = "languageToolkit.lastSyncedAt";

const TOMBSTONE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const PUSH_DEBOUNCE_MS = 1000;

let pushTimer = null;

/* ---------------- session ---------------- */

function getSession() {
  try { return JSON.parse(localStorage.getItem(AUTH_SESSION_KEY) || "null"); } catch { return null; }
}

function setSession(session) {
  if (session) localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(AUTH_SESSION_KEY);
  return session;
}

async function signIn(email, password) {
  let res;
  try {
    res = await fetch(authSignInUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, returnSecureToken: true })
    });
  } catch {
    return { ok: false, error: "Network error — check your connection." };
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false, error: body?.error?.message || "Sign-in failed." };

  const session = {
    idToken: body.idToken,
    refreshToken: body.refreshToken,
    expiresAt: Date.now() + Number(body.expiresIn) * 1000,
    uid: body.localId,
    email: body.email
  };
  setSession(session);
  broadcastSessionToExtension(session);
  return { ok: true, session };
}

function requestGoogleAccessToken() {
  if (!GOOGLE_WEB_CLIENT_ID) {
    // The extension can safely run its Chrome OAuth flow for this tab. This
    // avoids requiring a second web OAuth client in the static GitHub Pages build.
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Google sign-in requires the extension or a web OAuth client.")), 3000);
      const onResult = (event) => {
        if (event.source !== window || event.origin !== window.location.origin) return;
        const data = event.data;
        if (!data || data.source !== AUTH_BRIDGE_SOURCE || data.type !== "EXTENSION_GOOGLE_SIGN_IN_RESULT") return;
        window.removeEventListener("message", onResult);
        clearTimeout(timeout);
        if (data.session?.ok) resolve({ extensionResult: data.session });
        else reject(new Error(data.session?.error || "Google sign-in failed."));
      };
      window.addEventListener("message", onResult);
      window.postMessage({ source: AUTH_BRIDGE_SOURCE, type: "REQUEST_EXTENSION_GOOGLE_SIGN_IN" }, window.location.origin);
    });
  }
  if (!globalThis.google?.accounts?.oauth2) {
    return Promise.reject(new Error("Google sign-in is still loading. Please try again."));
  }
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_WEB_CLIENT_ID,
      scope: "openid email profile",
      callback: (response) => response.access_token ? resolve(response.access_token) : reject(new Error("Google sign-in failed."))
    });
    client.requestAccessToken();
  });
}

async function signInWithGoogle() {
  let token;
  try {
    token = await requestGoogleAccessToken();
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (token?.extensionResult) {
    if (token.extensionResult.ok && token.extensionResult.session) setSession(token.extensionResult.session);
    return token.extensionResult;
  }
  return exchangeGoogleToken(token);
}

async function exchangeGoogleToken(accessToken) {
  let res;
  try {
    res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${firebaseApiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        postBody: `access_token=${encodeURIComponent(accessToken)}&providerId=google.com`,
        requestUri: window.location.origin,
        returnIdpCredential: true,
        returnSecureToken: true
      })
    });
  } catch {
    return { ok: false, error: "Network error — check your connection." };
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.idToken) return { ok: false, error: body?.error?.message || "Google sign-in failed." };

  const session = {
    idToken: body.idToken,
    refreshToken: body.refreshToken,
    expiresAt: Date.now() + Number(body.expiresIn) * 1000,
    uid: body.localId,
    email: body.email
  };
  setSession(session);
  broadcastSessionToExtension(session);
  return { ok: true, session };
}

function signOut() {
  setSession(null);
  broadcastSessionToExtension(null);
}

async function refreshIdToken(refreshToken) {
  let res;
  try {
    res = await fetch(authRefreshUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
    });
  } catch {
    return null;
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return null;
  return {
    idToken: body.id_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + Number(body.expires_in) * 1000,
    uid: body.user_id
  };
}

async function ensureFreshIdToken() {
  let session = getSession();
  if (!session) return null;

  if (session.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
    const refreshed = await refreshIdToken(session.refreshToken);
    if (!refreshed) return null;
    session = { ...session, ...refreshed };
    setSession(session);
  }
  return session;
}

/* ---------------- Firestore REST ---------------- */

function docPath(uid) {
  return `${firestoreBase()}/vocab_data/${uid}`;
}

function parseJsonField(field) {
  if (!field?.stringValue) return null;
  try { return JSON.parse(field.stringValue); } catch { return null; }
}

async function fetchRemoteDoc(idToken, uid) {
  const res = await fetch(docPath(uid), { headers: { Authorization: `Bearer ${idToken}` } });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  const body = await res.json();
  const fields = body.fields || {};
  return {
    vocabTerms: parseJsonField(fields.vocabTerms),
    settings: parseJsonField(fields.settings),
    deletedKeys: parseJsonField(fields.deletedKeys)
  };
}

async function pushRemoteDoc(idToken, uid, { vocabTerms, settings, deletedKeys }) {
  const url = `${docPath(uid)}?updateMask.fieldPaths=vocabTerms&updateMask.fieldPaths=settings&updateMask.fieldPaths=deletedKeys&updateMask.fieldPaths=updatedAt`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      fields: {
        vocabTerms: { stringValue: JSON.stringify(vocabTerms || {}) },
        settings: { stringValue: JSON.stringify(settings || {}) },
        deletedKeys: { stringValue: JSON.stringify(deletedKeys || {}) },
        updatedAt: { timestampValue: new Date().toISOString() }
      }
    })
  });
  if (!res.ok) throw new Error(`Push failed: ${res.status}`);
}

/* ---------------- merge (last-write-wins + tombstones) ---------------- */

function pruneDeletedKeys(deletedKeys) {
  const cutoff = Date.now() - TOMBSTONE_MAX_AGE_MS;
  const pruned = {};
  for (const [key, at] of Object.entries(deletedKeys || {})) {
    if (new Date(at).getTime() >= cutoff) pruned[key] = at;
  }
  return pruned;
}

function mergeDeletedKeys(local, remote) {
  const merged = { ...(remote || {}) };
  for (const [key, at] of Object.entries(local || {})) {
    if (!merged[key] || new Date(at) > new Date(merged[key])) merged[key] = at;
  }
  return pruneDeletedKeys(merged);
}

function isTombstoned(deletedKeys, key, updatedAt) {
  const at = deletedKeys?.[key];
  if (!at) return false;
  return new Date(at) >= new Date(updatedAt || 0);
}

function mergeSentences(termKey, localSentences, remoteSentences, deletedKeys) {
  const byId = new Map();
  for (const s of localSentences || []) byId.set(s.id, s);
  for (const s of remoteSentences || []) {
    const existing = byId.get(s.id);
    if (!existing || new Date(s.updatedAt || s.createdAt || 0) > new Date(existing.updatedAt || existing.createdAt || 0)) {
      byId.set(s.id, s);
    }
  }
  for (const [id, s] of [...byId]) {
    if (isTombstoned(deletedKeys, `${termKey}/${id}`, s.updatedAt || s.createdAt)) byId.delete(id);
  }
  return [...byId.values()];
}

function mergeTerm(termKey, localTerm, remoteTerm, deletedKeys) {
  if (!localTerm && !remoteTerm) return null;
  const base = (!remoteTerm || (localTerm && new Date(localTerm.updatedAt || 0) >= new Date(remoteTerm.updatedAt || 0)))
    ? localTerm
    : remoteTerm;
  const sentences = mergeSentences(termKey, localTerm?.sentences, remoteTerm?.sentences, deletedKeys);
  return { ...base, sentences };
}

function mergeVocabTerms(local, remote, deletedKeys) {
  const keys = new Set([...Object.keys(local || {}), ...Object.keys(remote || {})]);
  const merged = {};
  for (const key of keys) {
    const localTerm = local?.[key];
    const remoteTerm = remote?.[key];
    const latestUpdatedAt = [localTerm?.updatedAt, remoteTerm?.updatedAt].filter(Boolean).sort().pop();
    if (isTombstoned(deletedKeys, key, latestUpdatedAt)) continue;
    const mergedTerm = mergeTerm(key, localTerm, remoteTerm, deletedKeys);
    if (mergedTerm) merged[key] = mergedTerm;
  }
  return merged;
}

function mergeSettings(localSettings, remoteSettings) {
  const localAt = new Date(localSettings?.settingsUpdatedAt || 0);
  const remoteAt = new Date(remoteSettings?.settingsUpdatedAt || 0);
  if (remoteSettings && remoteAt > localAt) return remoteSettings;
  return localSettings;
}

/* ---------------- local storage (localStorage) ---------------- */

function getLocalDeletedKeys() {
  try { return JSON.parse(localStorage.getItem(DELETED_KEYS_KEY) || "{}"); } catch { return {}; }
}

function setLocalDeletedKeys(deletedKeys) {
  localStorage.setItem(DELETED_KEYS_KEY, JSON.stringify(deletedKeys || {}));
}

function recordTermTombstone(key) {
  const deletedKeys = getLocalDeletedKeys();
  deletedKeys[key] = new Date().toISOString();
  setLocalDeletedKeys(deletedKeys);
}

function recordSentenceTombstone(termKey, sentenceId) {
  const deletedKeys = getLocalDeletedKeys();
  deletedKeys[`${termKey}/${sentenceId}`] = new Date().toISOString();
  setLocalDeletedKeys(deletedKeys);
}

function getLastSyncedAt() {
  return localStorage.getItem(LAST_SYNCED_KEY);
}

function setLastSyncedAt() {
  localStorage.setItem(LAST_SYNCED_KEY, new Date().toISOString());
}

/* ---------------- auth bridge (mirror sign-in/out with the extension, if present) ---------------- */

const AUTH_BRIDGE_SOURCE = "language-toolkit-extension";

function sessionsMatch(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return a.uid === b.uid && a.idToken === b.idToken;
}

function broadcastSessionToExtension(session) {
  // Only a page running inside the extension's content-script match (see
  // manifest.json) will ever answer this; on any other origin/browser it's a no-op.
  window.postMessage({ source: AUTH_BRIDGE_SOURCE, type: "SET_AUTH_SESSION", session }, window.location.origin);
}

function initAuthBridge(onSessionAdopted) {
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.source !== AUTH_BRIDGE_SOURCE) return;

    if (data.type === "AUTH_SYNC_CONFIG") {
      configureFirebase(data.session);
      const current = getSession();
      if (current) onSessionAdopted?.(current);
      return;
    }

    if (data.type === "AUTH_SESSION_INITIAL") {
      const bridgedSession = data.session;
      const current = getSession();
      if (sessionsMatch(current, bridgedSession)) return;
      if (bridgedSession) {
        setSession(bridgedSession);
        onSessionAdopted?.(bridgedSession);
      } else if (current) {
        // Extension hasn't signed in on this browser yet, but this page already
        // has — hand it over instead of treating the extension's blank state as a sign-out.
        broadcastSessionToExtension(current);
      }
      return;
    }

    if (data.type === "AUTH_SESSION_CHANGED") {
      const bridgedSession = data.session;
      const current = getSession();
      if (sessionsMatch(current, bridgedSession)) return;
      setSession(bridgedSession);
      onSessionAdopted?.(bridgedSession);
    }
  });

  window.postMessage({ source: AUTH_BRIDGE_SOURCE, type: "REQUEST_AUTH_SESSION" }, window.location.origin);
}

/* ---------------- orchestration ---------------- */

async function syncNow() {
  if (!isFirebaseConfigured()) return { ok: false, error: "Sync is not configured. Open this page from the extension once, or add Firebase settings to web/firebase-config.js." };
  const session = await ensureFreshIdToken();
  if (!session) return { ok: false, error: "Not signed in." };

  let remoteDoc;
  try {
    remoteDoc = await fetchRemoteDoc(session.idToken, session.uid);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const localVocabTerms = window.storage.getVocabTerms();
  const localDeletedKeys = getLocalDeletedKeys();
  const localSettings = window.storage.getSettings();

  const mergedDeletedKeys = mergeDeletedKeys(localDeletedKeys, remoteDoc?.deletedKeys);
  const mergedVocabTerms = mergeVocabTerms(localVocabTerms, remoteDoc?.vocabTerms, mergedDeletedKeys);
  const mergedSettings = mergeSettings(localSettings, remoteDoc?.settings);

  window.storage.setVocabTerms(mergedVocabTerms);
  setLocalDeletedKeys(mergedDeletedKeys);
  if (mergedSettings !== localSettings) window.storage.setSettingsRaw(mergedSettings);

  try {
    await pushRemoteDoc(session.idToken, session.uid, {
      vocabTerms: mergedVocabTerms,
      settings: mergedSettings,
      deletedKeys: mergedDeletedKeys
    });
  } catch (err) {
    return { ok: true, vocabTerms: mergedVocabTerms, pushError: err.message };
  }

  setLastSyncedAt();
  return { ok: true, vocabTerms: mergedVocabTerms };
}

function schedulePush() {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    pushTimer = null;
    const session = await ensureFreshIdToken();
    if (!session) return;
    try {
      await pushRemoteDoc(session.idToken, session.uid, {
        vocabTerms: window.storage.getVocabTerms(),
        settings: window.storage.getSettings(),
        deletedKeys: getLocalDeletedKeys()
      });
      setLastSyncedAt();
    } catch {
      // best-effort; the next syncNow()/schedulePush() will retry
    }
  }, PUSH_DEBOUNCE_MS);
}

window.sync = {
  signIn, signInWithGoogle, signOut, getSession, syncNow, schedulePush,
  recordTermTombstone, recordSentenceTombstone, getLastSyncedAt, initAuthBridge, configureFirebase
};
