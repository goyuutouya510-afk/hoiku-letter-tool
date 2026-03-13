import { initAuth, getIdTokenOrNull } from "./auth.js";
import { fetchUserStatus, generateJapaneseLetter, generateEnglishLetter } from "./api.js";
import { createUI } from "./ui.js";

const PLUS_FORM_URL = "https://docs.google.com/forms/d/1NzqTuhnk-jhkro0xLwPOVDjnrKMVGizzkJeQ6ZTFD4o/edit";

function canGenerate(status) {
  return status?.remainingCount === null || (status?.remainingCount ?? 0) > 0;
}

function requireIdToken() {
  return getIdTokenOrNull().then((token) => {
    if (!token) {
      throw new Error("ログインが必要です。Googleログイン後に実行してください。");
    }
    return token;
  });
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "absolute";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);

  if (!copied) {
    throw new Error("コピーに失敗しました。");
  }
}

async function handleSubmit(event, ui) {
  event.preventDefault();

  const { submitButton } = ui.refs;
  ui.setStatus("お便りを作成中です（約5秒）…", "info");
  submitButton.disabled = true;
  submitButton.textContent = "生成中…";

  try {
    const idToken = await requireIdToken();
    const payload = ui.getPayload();

    submitButton.textContent = "日本語生成中…";
    const jaData = await generateJapaneseLetter(payload, idToken);
    ui.setPlanStatus(jaData);
    ui.refs.submitButton.disabled = !canGenerate(jaData);

    ui.setGenerated({
      ja: jaData.ja || jaData.text || "日本語の文章を取得できませんでした。",
      en: jaData.supportsEnglish ? "英語を生成中…" : "plusプランで英語翻訳を利用できます。",
    });
    ui.setStatus(
      jaData.supportsEnglish ? "日本語ができました。英語を生成中…" : "日本語の生成が完了しました。",
      "success"
    );

    if (!jaData.supportsEnglish) {
      return;
    }

    submitButton.textContent = "英語生成中…";
    const enData = await generateEnglishLetter(ui.getGenerated().ja, idToken);
    ui.setPlanStatus(enData);
    ui.refs.submitButton.disabled = !canGenerate(enData);

    ui.setGenerated({
      ...ui.getGenerated(),
      en: enData.en || enData.text || "English version was not provided.",
    });
    ui.setStatus("生成が完了しました。", "success");
  } catch (error) {
    console.error(error);
    ui.setStatus(error.message || "エラーが発生しました。", "error");
  } finally {
    const token = await getIdTokenOrNull();
    submitButton.disabled = !token || !canGenerate(ui.getPlanStatus());
    submitButton.textContent = "ChatGPTに作成してもらう";
  }
}

const ui = createUI();

ui.refs.plusPlanBtn.addEventListener("click", () => {
  window.open(PLUS_FORM_URL, "_blank", "noopener,noreferrer");
});

ui.refs.copyBtn.addEventListener("click", async () => {
  const text = ui.getCurrentOutputText().trim();
  if (!text) {
    ui.setCopyMessage("コピーできる文章がありません。");
    return;
  }

  try {
    await copyText(text);
    ui.setCopyMessage("コピーしました");
  } catch (error) {
    console.error(error);
    ui.setCopyMessage(error.message || "コピーに失敗しました。");
  }
});

async function refreshUserStatus() {
  const token = await getIdTokenOrNull();
  if (!token) {
    ui.setPlanStatus({
      plan: "free",
      basePlan: "free",
      testMode: null,
      isTestMode: false,
      dailyCount: 0,
      dailyLimit: 1,
      remainingCount: 1,
      supportsLength: false,
      supportsEnglish: false,
    });
    return;
  }

  try {
    const status = await fetchUserStatus(token);
    ui.setPlanStatus(status);
    ui.refs.submitButton.disabled = !canGenerate(status);
  } catch (error) {
    console.error(error);
    ui.setStatus(error.message || "プラン情報の取得に失敗しました。", "error");
  }
}

initAuth({
  loginBtn: ui.refs.loginBtn,
  logoutBtn: ui.refs.logoutBtn,
  userLabel: ui.refs.userLabel,
  generateBtn: ui.refs.submitButton,
  onUserChanged: () => {
    refreshUserStatus();
  },
});

ui.refs.form.addEventListener("submit", (event) => {
  handleSubmit(event, ui);
});

refreshUserStatus();
