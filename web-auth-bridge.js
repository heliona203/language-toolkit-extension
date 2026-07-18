/* Runs only on the companion web app's origin (see manifest.json content_scripts
   match + popup.js's WEB_APP_URL). Relays the extension's Firebase session from
   chrome.storage.local into the page via postMessage, so signing in once on the
   Options page also signs the user into the web app on this same browser —
   without that, JSON imported on the web app silently stayed local because the
   user assumed Options sign-in covered both surfaces. Only ever pushes a
   session *in*; the web app decides whether to adopt it (see web/sync.js). */
(() => {
  const AUTH_BRIDGE_SOURCE = "language-toolkit-extension";

  function postSession(session) {
    window.postMessage({ source: AUTH_BRIDGE_SOURCE, type: "AUTH_SESSION", session }, window.location.origin);
  }

  async function sendCurrentSession() {
    const { authSession } = await chrome.storage.local.get({ authSession: null });
    postSession(authSession);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    if (event.data?.source === AUTH_BRIDGE_SOURCE && event.data?.type === "REQUEST_AUTH_SESSION") {
      sendCurrentSession();
    }
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.authSession) {
      postSession(changes.authSession.newValue || null);
    }
  });

  sendCurrentSession();
})();
