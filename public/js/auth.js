import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const isLocalhost = ["localhost", "127.0.0.1"].includes(window.location.hostname);

// Firebase Web config is public client configuration. Do not place server-side secrets here.
const firebaseConfig = {
  apiKey: "AIzaSyD1bgwMp6e0Pqux4tEqqe0550XUdyFADTc",
  authDomain: isLocalhost ? "hoiku-letter-tool.firebaseapp.com" : "hoiku-letter-tool.web.app",
  projectId: "hoiku-letter-tool",
  storageBucket: "hoiku-letter-tool.firebasestorage.app",
  messagingSenderId: "448453988298",
  appId: "1:448453988298:web:6dc32c24ef2b79d0ae0933",
  measurementId: "G-VV4VCGL86X",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();
const REDIRECT_SIGN_IN_KEY = "hoiku_letter_redirect_sign_in";

function getRedirectFlag() {
  return localStorage.getItem(REDIRECT_SIGN_IN_KEY) === "1";
}

function setRedirectFlag(value) {
  if (value) {
    localStorage.setItem(REDIRECT_SIGN_IN_KEY, "1");
    return;
  }
  localStorage.removeItem(REDIRECT_SIGN_IN_KEY);
}

function shouldUseRedirectSignIn() {
  return /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
}

export async function getIdTokenOrNull() {
  const user = auth.currentUser;
  if (!user) return null;
  return user.getIdToken();
}

export function initAuth({ loginBtn, logoutBtn, userLabel, generateBtn, onUserChanged }) {
  loginBtn.addEventListener("click", async () => {
    try {
      if (shouldUseRedirectSignIn()) {
        if (getRedirectFlag()) {
          return;
        }
        setRedirectFlag(true);
        await signInWithRedirect(auth, provider);
        return;
      }

      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error(error);
      alert(error?.message || error);
    }
  });

  logoutBtn.addEventListener("click", async () => {
    setRedirectFlag(false);
    await signOut(auth);
  });

  getRedirectResult(auth).catch((error) => {
    if (!error) return;
    console.error(error);
    alert(error?.message || error);
  }).finally(() => {
    setRedirectFlag(false);
  });

  onAuthStateChanged(auth, (user) => {
    if (user) {
      setRedirectFlag(false);
      userLabel.textContent = `ログイン中：${user.displayName || user.email || "ユーザー"}`;
      loginBtn.style.display = "none";
      logoutBtn.style.display = "inline-block";
      generateBtn.disabled = false;
    } else {
      userLabel.textContent = "未ログイン";
      loginBtn.style.display = "inline-block";
      logoutBtn.style.display = "none";
      generateBtn.disabled = true;
    }

    if (typeof onUserChanged === "function") {
      onUserChanged(user);
    }
  });
}
