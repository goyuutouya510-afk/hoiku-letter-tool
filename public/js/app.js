import { initAuth, getIdTokenOrNull } from "./auth.js";
import { fetchUserStatus, generateJapaneseLetter, generateEnglishLetter } from "./api.js";
import { createUI } from "./ui.js";

function requireIdToken() {
  return getIdTokenOrNull().then((token) => {
    if (!token) {
      throw new Error("ログインが必要です。Googleログイン後に実行してください。");
    }
    return token;
  });
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
    ui.refs.submitButton.disabled = jaData.remainingCount <= 0;

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
    ui.refs.submitButton.disabled = enData.remainingCount <= 0;

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
    submitButton.disabled = !token || ui.getPlanStatus().remainingCount <= 0;
    submitButton.textContent = "ChatGPTに作成してもらう";
  }
}

const ui = createUI();

ui.refs.plusPlanBtn.addEventListener("click", () => {
  ui.setStatus("plusプラン申込導線は準備中です。近日公開予定です。", "info");
});

async function refreshUserStatus() {
  const token = await getIdTokenOrNull();
  if (!token) {
    ui.setPlanStatus({
      plan: "free",
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
    ui.refs.submitButton.disabled = status.remainingCount <= 0;
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
