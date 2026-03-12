import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyA7AccAmKVEH9ZeCL2Uhnak0qV1lumKCrE",
  authDomain: "hoiku-letter-tool.firebaseapp.com",
  projectId: "hoiku-letter-tool",
  storageBucket: "hoiku-letter-tool.firebasestorage.app",
  messagingSenderId: "448453988298",
  appId: "1:448453988298:web:6dc32c24ef2b79d0ae0933",
  measurementId: "G-VV4VCGL86X",
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const provider = new GoogleAuthProvider();

export async function getIdTokenOrNull() {
  const user = auth.currentUser;
  if (!user) return null;
  return user.getIdToken();
}

export function initAuth({ loginBtn, logoutBtn, userLabel, generateBtn, onUserChanged }) {
  loginBtn.addEventListener("click", async () => {
    try {
      await signInWithPopup(auth, provider);
    } catch (error) {
      console.error(error);
      alert(error?.message || error);
    }
  });

  logoutBtn.addEventListener("click", async () => {
    await signOut(auth);
  });

  onAuthStateChanged(auth, (user) => {
    if (user) {
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
