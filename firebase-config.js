// Fill these in from Firebase Console → Project settings → General, after
// creating the project and completing the one-time setup in the Firestore
// and Authentication tabs (see the plan/README for exact steps). The Web API
// Key is not a secret — Firebase's security model relies on Firestore
// security rules, not on hiding this key.
const FIREBASE_API_KEY = "";
const FIREBASE_PROJECT_ID = "";

// Google Cloud Console → Credentials → OAuth client ID → Application type
// "Web application" (a client dedicated to this extension, separate from the
// web app's client below). Authorized redirect URIs must include this exact
// extension's chrome.identity.getRedirectURL() value.
const GOOGLE_EXTENSION_CLIENT_ID = "";
