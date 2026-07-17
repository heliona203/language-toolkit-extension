/* Talks directly to Firebase's REST APIs (no SDK, no build step). Session is
   kept in chrome.storage.local so it survives browser restarts without
   needing a sign-up flow to recover. options.html and review.html are
   same-origin (chrome-extension://<id>/...) and share this storage, so
   signing in once via Options is enough for review.html to sync too. */

const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const AUTH_SIGNIN_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`;
const AUTH_REFRESH_URL = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`;

const TOMBSTONE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const PUSH_DEBOUNCE_MS = 1000;

let pushTimer = null;

/* ---------------- session ---------------- */

async function getSession() {
  const data = await chrome.storage.local.get({ authSession: null });
  return data.authSession;
}

async function setSession(session) {
  if (session) await chrome.storage.local.set({ authSession: session });
  else await chrome.storage.local.remove("authSession");
  return session;
}

async function signIn(email, password) {
  let res;
  try {
    res = await fetch(AUTH_SIGNIN_URL, {
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
  await setSession(session);
  return { ok: true, session };
}

async function signInWithGoogle() {
  const redirectUri = chrome.identity.getRedirectURL();
  const authUrl = "https://accounts.google.com/o/oauth2/v2/auth"
    + `?client_id=${encodeURIComponent(GOOGLE_EXTENSION_CLIENT_ID)}`
    + "&response_type=token"
    + `&redirect_uri=${encodeURIComponent(redirectUri)}`
    + `&scope=${encodeURIComponent("openid email profile")}`;

  let responseUrl;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  } catch {
    return { ok: false, error: "Google sign-in was cancelled or failed." };
  }

  const params = new URLSearchParams(new URL(responseUrl).hash.slice(1));
  const token = params.get("access_token");
  if (!token) return { ok: false, error: "Google sign-in did not return a token." };

  return exchangeGoogleToken(token);
}

async function exchangeGoogleToken(accessToken) {
  let res;
  try {
    res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${FIREBASE_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        postBody: `access_token=${encodeURIComponent(accessToken)}&providerId=google.com`,
        requestUri: "http://localhost",
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
  await setSession(session);
  return { ok: true, session };
}

async function signOut() {
  await setSession(null);
}

async function refreshIdToken(refreshToken) {
  let res;
  try {
    res = await fetch(AUTH_REFRESH_URL, {
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
  let session = await getSession();
  if (!session) return null;

  if (session.expiresAt - Date.now() < REFRESH_MARGIN_MS) {
    const refreshed = await refreshIdToken(session.refreshToken);
    if (!refreshed) return null;
    session = { ...session, ...refreshed };
    await setSession(session);
  }
  return session;
}

/* ---------------- Firestore REST ---------------- */

function docPath(uid) {
  return `${FIRESTORE_BASE}/vocab_data/${uid}`;
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

/* ---------------- local storage (chrome.storage) ---------------- */

async function getLocalVocabTerms() {
  const data = await chrome.storage.local.get({ vocabTerms: {} });
  return data.vocabTerms || {};
}

async function setLocalVocabTerms(vocabTerms) {
  await chrome.storage.local.set({ vocabTerms });
}

async function getLocalDeletedKeys() {
  const data = await chrome.storage.local.get({ deletedKeys: {} });
  return data.deletedKeys || {};
}

async function setLocalDeletedKeys(deletedKeys) {
  await chrome.storage.local.set({ deletedKeys });
}

async function getLocalSettings() {
  return await chrome.storage.sync.get({ lang: "fr-FR", audioMode: "sentence", accentMode: "flexible", settingsUpdatedAt: null });
}

async function setLocalSettings(settings) {
  await chrome.storage.sync.set(settings);
}

async function recordTermTombstone(key) {
  const deletedKeys = await getLocalDeletedKeys();
  deletedKeys[key] = new Date().toISOString();
  await setLocalDeletedKeys(deletedKeys);
}

async function recordSentenceTombstone(termKey, sentenceId) {
  const deletedKeys = await getLocalDeletedKeys();
  deletedKeys[`${termKey}/${sentenceId}`] = new Date().toISOString();
  await setLocalDeletedKeys(deletedKeys);
}

async function getLastSyncedAt() {
  const data = await chrome.storage.local.get({ lastSyncedAt: null });
  return data.lastSyncedAt;
}

async function setLastSyncedAt() {
  await chrome.storage.local.set({ lastSyncedAt: new Date().toISOString() });
}

/* ---------------- orchestration ---------------- */

async function syncNow() {
  const session = await ensureFreshIdToken();
  if (!session) return { ok: false, error: "Not signed in." };

  let remoteDoc;
  try {
    remoteDoc = await fetchRemoteDoc(session.idToken, session.uid);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const localVocabTerms = await getLocalVocabTerms();
  const localDeletedKeys = await getLocalDeletedKeys();
  const localSettings = await getLocalSettings();

  const mergedDeletedKeys = mergeDeletedKeys(localDeletedKeys, remoteDoc?.deletedKeys);
  const mergedVocabTerms = mergeVocabTerms(localVocabTerms, remoteDoc?.vocabTerms, mergedDeletedKeys);
  const mergedSettings = mergeSettings(localSettings, remoteDoc?.settings);

  await setLocalVocabTerms(mergedVocabTerms);
  await setLocalDeletedKeys(mergedDeletedKeys);
  if (mergedSettings !== localSettings) await setLocalSettings(mergedSettings);

  try {
    await pushRemoteDoc(session.idToken, session.uid, {
      vocabTerms: mergedVocabTerms,
      settings: mergedSettings,
      deletedKeys: mergedDeletedKeys
    });
  } catch (err) {
    return { ok: true, vocabTerms: mergedVocabTerms, pushError: err.message };
  }

  await setLastSyncedAt();
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
        vocabTerms: await getLocalVocabTerms(),
        settings: await getLocalSettings(),
        deletedKeys: await getLocalDeletedKeys()
      });
      await setLastSyncedAt();
    } catch {
      // best-effort; the next syncNow()/schedulePush() will retry
    }
  }, PUSH_DEBOUNCE_MS);
}

window.sync = {
  signIn, signInWithGoogle, signOut, getSession, syncNow, schedulePush,
  recordTermTombstone, recordSentenceTombstone, getLastSyncedAt
};
