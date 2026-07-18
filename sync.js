/* Talks directly to Firebase's REST APIs (no SDK, no build step). Session is
   kept in chrome.storage.local so it survives browser restarts without
   needing a sign-up flow to recover. options.html and review.html are
   same-origin (chrome-extension://<id>/...) and share this storage, so
   signing in once via Options is enough for review.html to sync too.

   Vocab data itself is NOT kept in chrome.storage.local once signed in:
   getVocabTerms()/setVocabTerms() talk to Firestore directly on every call,
   so Firestore is the single copy of a signed-in user's vocab. Anonymous
   (signed-out) users keep using chrome.storage.local as before. The first
   time a session is seen with leftover anonymous data still on disk, that
   data is merged into Firestore and then erased locally (see
   migrateAnonymousDataToRemote). settings stay in chrome.storage.sync
   (Chrome's own account sync already covers that) and are out of scope
   here. */

const FIRESTORE_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents`;
const AUTH_SIGNIN_URL = `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_API_KEY}`;
const AUTH_REFRESH_URL = `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_API_KEY}`;

const TOMBSTONE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

// Tombstones recorded while signed in, waiting to be folded into the next
// setVocabTerms() push (mirrors how the anonymous path stages them in
// chrome.storage.local until the next persist()).
let pendingTombstones = [];
let migratePromise = null;

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
  pendingTombstones = [];
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

// `patch` may include any subset of {vocabTerms, settings, deletedKeys} —
// only the fields present are sent, so e.g. a vocab-only save can't clobber
// a value it never read.
async function pushRemoteDoc(idToken, uid, patch) {
  const fieldPaths = ["updatedAt"];
  const fields = { updatedAt: { timestampValue: new Date().toISOString() } };
  if ("vocabTerms" in patch) {
    fieldPaths.push("vocabTerms");
    fields.vocabTerms = { stringValue: JSON.stringify(patch.vocabTerms || {}) };
  }
  if ("settings" in patch) {
    fieldPaths.push("settings");
    fields.settings = { stringValue: JSON.stringify(patch.settings || {}) };
  }
  if ("deletedKeys" in patch) {
    fieldPaths.push("deletedKeys");
    fields.deletedKeys = { stringValue: JSON.stringify(patch.deletedKeys || {}) };
  }

  const url = `${docPath(uid)}?${fieldPaths.map(fp => `updateMask.fieldPaths=${fp}`).join("&")}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${idToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields })
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

/* ---------------- local storage (chrome.storage.local) — anonymous path only ---------------- */

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

async function getLastSyncedAt() {
  const data = await chrome.storage.local.get({ lastSyncedAt: null });
  return data.lastSyncedAt;
}

async function setLastSyncedAt() {
  await chrome.storage.local.set({ lastSyncedAt: new Date().toISOString() });
}

/* ---------------- one-time migration off chrome.storage.local ---------------- */

// Runs the first time a signed-in call sees leftover anonymous data on disk:
// merges it into Firestore, then erases it locally so chrome.storage.local
// stops being a copy of the vocab. Safe to call repeatedly — it's a no-op
// once there's nothing local left, and if the push fails (e.g. offline) the
// local copy is left alone so nothing is lost; the next call retries.
async function migrateAnonymousDataToRemote(session) {
  if (!migratePromise) migratePromise = runMigration(session).finally(() => { migratePromise = null; });
  return migratePromise;
}

async function runMigration(session) {
  const localVocabTerms = await getLocalVocabTerms();
  const localDeletedKeys = await getLocalDeletedKeys();
  if (!Object.keys(localVocabTerms).length && !Object.keys(localDeletedKeys).length) return;

  let remoteDoc = null;
  try {
    remoteDoc = await fetchRemoteDoc(session.idToken, session.uid);
  } catch {
    return;
  }

  const mergedDeletedKeys = mergeDeletedKeys(localDeletedKeys, remoteDoc?.deletedKeys);
  const mergedVocabTerms = mergeVocabTerms(localVocabTerms, remoteDoc?.vocabTerms, mergedDeletedKeys);

  try {
    await pushRemoteDoc(session.idToken, session.uid, { vocabTerms: mergedVocabTerms, deletedKeys: mergedDeletedKeys });
  } catch {
    return;
  }

  await chrome.storage.local.remove(["vocabTerms", "deletedKeys"]);
  await setLastSyncedAt();
}

/* ---------------- public vocab API ---------------- */

function pendingTombstonesAsMap() {
  const map = {};
  for (const { key, at } of pendingTombstones) map[key] = at;
  return map;
}

async function getVocabTerms() {
  const session = await ensureFreshIdToken();
  if (!session) return await getLocalVocabTerms();

  await migrateAnonymousDataToRemote(session);

  const remoteDoc = await fetchRemoteDoc(session.idToken, session.uid);
  return remoteDoc?.vocabTerms || {};
}

async function setVocabTerms(vocabTerms) {
  const session = await ensureFreshIdToken();
  if (!session) {
    await setLocalVocabTerms(vocabTerms);
    return vocabTerms;
  }

  await migrateAnonymousDataToRemote(session);

  const remoteDoc = await fetchRemoteDoc(session.idToken, session.uid);
  const mergedDeletedKeys = mergeDeletedKeys(pendingTombstonesAsMap(), remoteDoc?.deletedKeys);
  const mergedVocabTerms = mergeVocabTerms(vocabTerms, remoteDoc?.vocabTerms, mergedDeletedKeys);

  await pushRemoteDoc(session.idToken, session.uid, { vocabTerms: mergedVocabTerms, deletedKeys: mergedDeletedKeys });
  pendingTombstones = [];
  await setLastSyncedAt();
  return mergedVocabTerms;
}

async function recordTombstone(key) {
  const session = await ensureFreshIdToken();
  if (!session) {
    const deletedKeys = await getLocalDeletedKeys();
    deletedKeys[key] = new Date().toISOString();
    await setLocalDeletedKeys(deletedKeys);
    return;
  }
  pendingTombstones.push({ key, at: new Date().toISOString() });
}

function recordTermTombstone(key) {
  return recordTombstone(key);
}

function recordSentenceTombstone(termKey, sentenceId) {
  return recordTombstone(`${termKey}/${sentenceId}`);
}

globalThis.sync = {
  signIn, signInWithGoogle, signOut, getSession,
  getVocabTerms, setVocabTerms,
  recordTermTombstone, recordSentenceTombstone, getLastSyncedAt
};
