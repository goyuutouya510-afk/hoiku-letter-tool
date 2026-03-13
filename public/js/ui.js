export function createUI() {
  const refs = {
    form: document.getElementById("noteForm"),
    output: document.getElementById("output"),
    languageToggle: document.getElementById("languageToggle"),
    englishOption: document.getElementById("englishOption"),
    copyBtn: document.getElementById("copyBtn"),
    copyMessage: document.getElementById("copyMessage"),
    statusMessage: document.getElementById("statusMessage"),
    submitButton: document.getElementById("generateBtn"),
    loginBtn: document.getElementById("loginBtn"),
    logoutBtn: document.getElementById("logoutBtn"),
    userLabel: document.getElementById("userLabel"),
    planLabel: document.getElementById("planLabel"),
    usageLabel: document.getElementById("usageLabel"),
    plusPlanBtn: document.getElementById("plusPlanBtn"),
    lengthField: document.getElementById("lengthField"),
    lengthSelect: document.getElementById("length"),
    featureHint: document.getElementById("featureHint"),
  };

  let lastGenerated = null;
  let planStatus = {
    plan: "free",
    basePlan: "free",
    testMode: null,
    isTestMode: false,
    dailyCount: 0,
    dailyLimit: 1,
    remainingCount: 1,
    supportsLength: false,
    supportsEnglish: false,
  };

  const setStatus = (text, type = "info") => {
    refs.statusMessage.textContent = text || "";
    refs.statusMessage.className = `hint status${type ? ` ${type}` : ""}`;
  };

  const updatePreview = () => {
    if (!lastGenerated) {
      refs.copyBtn.disabled = true;
      refs.copyMessage.textContent = "";
      return;
    }
    const language = refs.languageToggle.value;
    const text = lastGenerated[language] || "選択した言語の文章がありません。";
    refs.output.classList.remove("empty-state");
    refs.output.textContent = text;
    refs.copyBtn.disabled = !text || text === "選択した言語の文章がありません。";
    refs.copyMessage.textContent = "";
  };

  const getPayload = () => {
    const formData = new FormData(refs.form);
    return {
      date: formData.get("date"),
      weather: formData.get("weather"),
      group: formData.get("group"),
      name: formData.get("name"),
      event: formData.get("event"),
      notes: formData.get("notes") || "",
      length: formData.get("length") || "normal",
    };
  };

  const setGenerated = (data) => {
    lastGenerated = data;
    updatePreview();
  };

  const getGenerated = () => lastGenerated;

  const getCurrentOutputText = () => {
    if (!lastGenerated) return "";
    const language = refs.languageToggle.value;
    return lastGenerated[language] || "";
  };

  const setCopyMessage = (text = "", type = "") => {
    refs.copyMessage.textContent = text;
    refs.copyMessage.className = `hint copy-message${type ? ` ${type}` : ""}`;
  };

  const setPlanStatus = (nextStatus = {}) => {
    planStatus = {
      ...planStatus,
      ...nextStatus,
    };

    refs.planLabel.textContent =
      `現在のプラン: ${planStatus.plan}${planStatus.isTestMode ? " (test mode)" : ""}`;
    refs.usageLabel.textContent = planStatus.dailyLimit === null
      ? `本日の残り回数: 無制限`
      : `本日の残り回数: ${planStatus.remainingCount}/${planStatus.dailyLimit}`;

    refs.lengthField.classList.toggle("hidden", !planStatus.supportsLength);
    refs.englishOption.hidden = !planStatus.supportsEnglish;
    refs.englishOption.disabled = !planStatus.supportsEnglish;
    if (!planStatus.supportsEnglish && refs.languageToggle.value === "en") {
      refs.languageToggle.value = "ja";
      updatePreview();
    }

    refs.featureHint.textContent = planStatus.supportsEnglish
      ? "plusプランでは英語翻訳と文章量選択を利用できます。"
      : "freeプランでは日本語生成のみ利用できます。";
  };

  const getPlanStatus = () => planStatus;

  refs.languageToggle.addEventListener("change", updatePreview);

  return {
    refs,
    setStatus,
    updatePreview,
    getPayload,
    setGenerated,
    getGenerated,
    getCurrentOutputText,
    setCopyMessage,
    setPlanStatus,
    getPlanStatus,
  };
}
