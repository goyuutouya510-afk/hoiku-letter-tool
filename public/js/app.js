import { initAuth, getIdTokenOrNull } from "./auth.js";
import {
  activateTestPlus,
  createCustomerPortalSession,
  createCheckoutSession,
  fetchUserStatus,
  generateJapaneseLetter,
  generateEnglishLetter,
  submitFeedback,
} from "./api.js";
import { createUI } from "./ui.js";

const IS_TEST_PLUS_URL = new URLSearchParams(window.location.search).get("test") === "plus";
const TEST_PLUS_INTENT_KEY = "hoiku_letter_test_plus_intent";

if (IS_TEST_PLUS_URL) {
  localStorage.setItem(TEST_PLUS_INTENT_KEY, "1");
}

function shouldActivateTestPlus() {
  return IS_TEST_PLUS_URL || localStorage.getItem(TEST_PLUS_INTENT_KEY) === "1";
}

function clearTestPlusIntent() {
  localStorage.removeItem(TEST_PLUS_INTENT_KEY);

  const url = new URL(window.location.href);
  if (url.searchParams.get("test") === "plus") {
    url.searchParams.delete("test");
    const nextUrl = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState({}, "", nextUrl || "/");
  }
}

function canGenerate(status) {
  return status?.remainingCount === null || (status?.remainingCount ?? 0) > 0;
}

function scrollToGeneratedResult(ui) {
  const target = ui?.refs?.output?.closest(".preview") || ui?.refs?.output;

  if (target) {
    requestAnimationFrame(() => {
      const top = target.getBoundingClientRect().top + window.scrollY - 16;
      window.scrollTo({
        top: Math.max(top, 0),
        behavior: "smooth",
      });
    });
  }
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
    ui.rememberFormHistory();

    submitButton.textContent = "日本語生成中…";
    const jaData = await generateJapaneseLetter(payload, idToken);
    ui.setPlanStatus(jaData);
    ui.refs.submitButton.disabled = !canGenerate(jaData);

    ui.setGenerated({
      ja: jaData.ja || jaData.text || "日本語の文章を取得できませんでした。",
      en: jaData.supportsEnglish ? "英語を生成中…" : "plus / test_plus で英語翻訳を利用できます。",
    });
    scrollToGeneratedResult(ui);
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
    scrollToGeneratedResult(ui);
    ui.setStatus("生成が完了しました。", "success");
  } catch (error) {
    console.error(error);
    await refreshStatusAfterError(ui, error);
  } finally {
    const token = await getIdTokenOrNull();
    submitButton.disabled = !token || !canGenerate(ui.getPlanStatus());
    submitButton.textContent = "ChatGPTに作成してもらう";
  }
}

async function handleFeedbackSubmit(event, ui) {
  event.preventDefault();

  const submitButton = ui.refs.feedbackSubmitBtn;
  submitButton.disabled = true;
  ui.setFeedbackStatus("送信中です…", "info");

  try {
    const idToken = await requireIdToken();
    const payload = ui.getFeedbackPayload();
    await submitFeedback(payload, idToken);
    ui.resetFeedbackForm();
    ui.setFeedbackStatus("送信ありがとうございました。", "success");
  } catch (error) {
    console.error(error);
    ui.setFeedbackStatus(error.message || "感想送信に失敗しました。", "error");
  } finally {
    const token = await getIdTokenOrNull();
    submitButton.disabled = !token;
  }
}

const ui = createUI();

async function handlePlusPlanClick() {
  ui.showPlusPlanInfo();
}

async function handlePlusPlanPurchaseClick() {
  const button = ui.refs.plusPlanPurchaseBtn;
  button.disabled = true;
  ui.setStatus("決済画面を準備しています…", "info");

  try {
    const idToken = await requireIdToken();
    const data = await createCheckoutSession(idToken);
    if (!data?.url) {
      throw new Error("決済画面のURLを取得できませんでした。");
    }
    window.location.href = data.url;
  } catch (error) {
    console.error(error);
    ui.setStatus(
      error.message || "決済画面を開けませんでした。時間をおいて再度お試しください。",
      "error"
    );
  } finally {
    button.disabled = false;
  }
}

async function handleManagePlanClick() {
  const button = ui.refs.managePlanBtn;
  button.disabled = true;
  ui.setStatus("プラン管理画面を準備しています…", "info");

  try {
    const idToken = await requireIdToken();
    const data = await createCustomerPortalSession(idToken);
    if (!data?.url) {
      throw new Error("プラン管理画面のURLを取得できませんでした。");
    }
    window.location.href = data.url;
  } catch (error) {
    console.error(error);
    ui.setStatus(
      "プラン管理画面を開けませんでした。時間をおいて再度お試しください。",
      "error"
    );
  } finally {
    button.disabled = false;
  }
}

ui.refs.plusPlanBtn.addEventListener("click", handlePlusPlanClick);
ui.refs.plusPlanPurchaseBtn.addEventListener("click", handlePlusPlanPurchaseClick);
ui.refs.managePlanBtn.addEventListener("click", handleManagePlanClick);
ui.refs.plusPlanCloseBtn.addEventListener("click", () => {
  ui.hidePlusPlanInfo();
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
      supportsLength: true,
      supportsEnglish: false,
    });
    ui.refs.submitButton.disabled = true;
    return;
  }

  try {
    const wantsTestPlus = shouldActivateTestPlus();
    const status = wantsTestPlus
      ? await activateTestPlus(token)
      : await fetchUserStatus(token);
    if (wantsTestPlus) {
      clearTestPlusIntent();
    }
    ui.setPlanStatus(status);
    ui.refs.submitButton.disabled = !canGenerate(status);
  } catch (error) {
    console.error(error);
    ui.refs.submitButton.disabled = false;
    ui.setStatus(error.message || "プラン情報の取得に失敗しました。", "error");
  }
}

async function refreshStatusAfterError(ui, error) {
  try {
    await refreshUserStatus();
    if (ui.getPlanStatus().plan === "free" && ui.getPlanStatus().remainingCount === 0) {
      ui.setStatus(
        "本日の無料生成（1回）を使い切りました。プラスプラン（月500円）をご検討ください。",
        "error"
      );
      return;
    }
  } catch (refreshError) {
    console.error(refreshError);
  }

  ui.setStatus(error.message || "エラーが発生しました。", "error");
}

initAuth({
  loginBtn: ui.refs.loginBtn,
  logoutBtn: ui.refs.logoutBtn,
  userLabel: ui.refs.userLabel,
  generateBtn: ui.refs.submitButton,
  onUserChanged: (user) => {
    ui.setAuthState(Boolean(user));
    refreshUserStatus();
  },
});

ui.refs.form.addEventListener("submit", (event) => {
  handleSubmit(event, ui);
});

ui.refs.feedbackForm.addEventListener("submit", (event) => {
  handleFeedbackSubmit(event, ui);
});

refreshUserStatus();
