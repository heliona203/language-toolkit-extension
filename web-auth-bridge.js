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
  const AUTH_BRIDGE_SOURCE = "language-toolkit-extension";

  function postToPage(type, session) {
    window.postMessage({ source: AUTH_BRIDGE_SOURCE, type, session }, window.location.origin);
  }

  async function sendCurrentSession() {
    const { authSession } = await chrome.storage.local.get({ authSession: null });
    postToPage("AUTH_SESSION_INITIAL", authSession);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = event.data;
    if (!data || data.source !== AUTH_BRIDGE_SOURCE) return;

    if (data.type === "REQUEST_AUTH_SESSION") {
      sendCurrentSession();
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
