/* Runs only on the companion web app's origin (see manifest.json content_scripts
   match + popup.js's WEB_APP_URL). Mirrors the Firebase session between the
   extension's chrome.storage.local and the web app's localStorage (see
   web/sync.js), so signing in or out on either surface is reflected on the
   other instantly, on this same Chrome browser — without this, JSON imported
   on the web app could silently stay local because the user assumed Options
   sign-in covered both surfaces.

   AUTH_SESSION_INITIAL vs AUTH_SESSION_CHANGED matters: on first contact (a
   freshly opened tab), a null session here just means "the extension hasn't
   signed in on this browser yet" — the web app must not treat that as a
   live sign-out and wipe a session it already had; it hands its own session
   over instead. Once past that handshake, AUTH_SESSION_CHANGED reflects a
   real transition (sign-in or sign-out) and the web app mirrors it exactly. */
(() => {
  // This file is both a manifest content script and is injected into tabs that
  // were already open when the extension started. Keep repeated injections
  // from registering duplicate storage/message listeners.
  if (globalThis.__languageToolkitAuthBridgeInstalled) return;
  globalThis.__languageToolkitAuthBridgeInstalled = true;

  const AUTH_BRIDGE_SOURCE = "language-toolkit-extension";

  function postToPage(type, session) {
    window.postMessage({ source: AUTH_BRIDGE_SOURCE, type, session }, window.location.origin);
  }

  async function sendCurrentSession(type = "AUTH_SESSION_INITIAL") {
    const { authSession } = await chrome.storage.local.get({ authSession: null });
    postToPage(type, authSession);
  }

  async function sendSyncConfig() {
    try {
      const config = await chrome.runtime.sendMessage({ type: "LANGUAGE_TOOLKIT_GET_SYNC_CONFIG" });
      if (config?.ok) postToPage("AUTH_SYNC_CONFIG", config);
    } catch {
      // The page remains usable without the extension bridge.
    }
  }

  async function signInWithExtensionGoogle() {
    try {
      const result = await chrome.runtime.sendMessage({ type: "LANGUAGE_TOOLKIT_GOOGLE_SIGN_IN" });
      postToPage("EXTENSION_GOOGLE_SIGN_IN_RESULT", result || { ok: false, error: "Google sign-in failed." });
    } catch {
      postToPage("EXTENSION_GOOGLE_SIGN_IN_RESULT", { ok: false, error: "Google sign-in requires the extension." });
    }
  }

  // Used by the service worker after it injects this bridge into an already
  // open tab in response to a real storage transition. An INITIAL null means
  // "unknown extension state" during first contact; this explicit CHANGED
  // null means the user actually signed out and must clear the page session.
  globalThis.__languageToolkitAuthBridgePostCurrentSession = sendCurrentSession;

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.source !== AUTH_BRIDGE_SOURCE) return;

    if (data.type === "REQUEST_AUTH_SESSION") {
      sendSyncConfig();
      sendCurrentSession();
    } else if (data.type === "REQUEST_EXTENSION_GOOGLE_SIGN_IN") {
      signInWithExtensionGoogle();
    } else if (data.type === "SET_AUTH_SESSION") {
      if (data.session) chrome.storage.local.set({ authSession: data.session });
      else chrome.storage.local.remove("authSession");
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.authSession) {
      postToPage("AUTH_SESSION_CHANGED", changes.authSession.newValue || null);
    }
  });

  sendCurrentSession();
})();
