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
