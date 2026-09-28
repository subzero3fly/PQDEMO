const firebaseConfig = {
  apiKey:            "AIzaSyBoogP0o-DYQs2PSwk7QSwaQAVFINT2x0Y",
  authDomain:        "pg-demo-48d8a.firebaseapp.com",
  projectId:         "pg-demo-48d8a",
  storageBucket:     "pg-demo-48d8a.firebasestorage.app",
  messagingSenderId: "601845838807",
  appId:             "1:601845838807:web:2ec96e135991ccbe859192"
};

firebase.initializeApp(firebaseConfig);
const db   = firebase.firestore();
const auth = firebase.auth();

// ── Guest chat sessions ─────────────────────────────────────────────────────
// The support chat widget signs guests in anonymously so they get a real
// Firestore thread. Every page's auth logic assumes "signed in" means "real
// account", so hide anonymous sessions from auth.onAuthStateChanged (pages see
// them as signed-out, as before). The chat widget uses onAuthStateChangedRaw.
(function () {
  var raw = auth.onAuthStateChanged.bind(auth);
  auth.onAuthStateChangedRaw = raw;
  auth.onAuthStateChanged = function (next, error, completed) {
    if (typeof next !== 'function') return raw(next, error, completed);
    return raw(function (user) { next(user && user.isAnonymous ? null : user); }, error, completed);
  };
})();
