const STORAGE_KEYS = {
  nameHistory: "hoiku_letter_name_history",
  classHistory: "hoiku_letter_class_history",
  tone: "hoiku_letter_tone",
  length: "hoiku_letter_length",
};

function loadStoredValue(key, fallback = "") {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch (error) {
    console.error(error);
    return fallback;
  }
}

function saveStoredValue(key, value) {
  try {
    if (!value) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, value);
  } catch (error) {
    console.error(error);
  }
}

function loadStoredList(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch (error) {
    console.error(error);
    return [];
  }
}

function saveStoredList(key, values) {
  try {
    const nextValues = Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean))).slice(0, 20);
    if (nextValues.length === 0) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify(nextValues));
  } catch (error) {
    console.error(error);
  }
}

function upsertStoredListItem(key, value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) return;
  const current = loadStoredList(key).filter((item) => item !== trimmed);
  saveStoredList(key, [trimmed, ...current]);
}

function todayString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function setSingleSelection(buttons, activeValue, dataKey) {
  buttons.forEach((button) => {
    const isSelected = button.dataset[dataKey] === activeValue;
    button.classList.toggle("is-selected", isSelected);
    button.setAttribute("aria-pressed", String(isSelected));
  });
}

function renderDatalist(target, values) {
  target.replaceChildren(
    ...values.map((value) => {
      const option = document.createElement("option");
      option.value = value;
      return option;
    })
  );
}

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
    managePlanSection: document.getElementById("managePlanSection"),
    managePlanBtn: document.getElementById("managePlanBtn"),
    plusPlanSection: document.getElementById("plusPlanSection"),
    limitNotice: document.getElementById("limitNotice"),
    plusPlanBtn: document.getElementById("plusPlanBtn"),
    plusPlanInfoPanel: document.getElementById("plusPlanInfoPanel"),
    plusPlanPurchaseBtn: document.getElementById("plusPlanPurchaseBtn"),
    plusPlanCloseBtn: document.getElementById("plusPlanCloseBtn"),
    featureHint: document.getElementById("featureHint"),
    dateInput: document.getElementById("date"),
    nameInput: document.getElementById("name"),
    nameHistory: document.getElementById("nameHistory"),
    classInput: document.getElementById("className"),
    classHistory: document.getElementById("classHistory"),
    ageGroupInput: document.getElementById("ageGroup"),
    ageButtons: Array.from(document.querySelectorAll("[data-age-group]")),
    tagButtons: Array.from(document.querySelectorAll("[data-tag]")),
    selectedTagsInput: document.getElementById("selectedTags"),
    activityInput: document.getElementById("activity"),
    lengthInput: document.getElementById("length"),
    lengthButtons: Array.from(document.querySelectorAll("[data-length-mode]")),
    toneInput: document.getElementById("tone"),
    toneButtons: Array.from(document.querySelectorAll("[data-tone]")),
    feedbackForm: document.getElementById("feedbackForm"),
    feedbackSubmitBtn: document.getElementById("feedbackSubmitBtn"),
    feedbackStatusMessage: document.getElementById("feedbackStatusMessage"),
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
    supportsLength: true,
    supportsEnglish: false,
  };
  const selectedTags = new Set();

  const setStatus = (text, type = "info") => {
    refs.statusMessage.textContent = text || "";
    refs.statusMessage.className = `hint status${type ? ` ${type}` : ""}`;
  };

  const setFeedbackStatus = (text, type = "info") => {
    refs.feedbackStatusMessage.textContent = text || "";
    refs.feedbackStatusMessage.className = `hint status${type ? ` ${type}` : ""}`;
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

  const syncSelectedTags = () => {
    refs.selectedTagsInput.value = JSON.stringify(Array.from(selectedTags));
  };

  const selectAgeGroup = (value) => {
    refs.ageGroupInput.value = value;
    setSingleSelection(refs.ageButtons, value, "ageGroup");
  };

  const selectLengthMode = (value) => {
    refs.lengthInput.value = value;
    saveStoredValue(STORAGE_KEYS.length, value);
    setSingleSelection(refs.lengthButtons, value, "lengthMode");
  };

  const selectTone = (value) => {
    refs.toneInput.value = value;
    saveStoredValue(STORAGE_KEYS.tone, value);
    setSingleSelection(refs.toneButtons, value, "tone");
  };

  const toggleTag = (value) => {
    if (selectedTags.has(value)) {
      selectedTags.delete(value);
    } else {
      selectedTags.add(value);
    }

    refs.tagButtons.forEach((button) => {
      const isSelected = selectedTags.has(button.dataset.tag);
      button.classList.toggle("is-selected", isSelected);
      button.setAttribute("aria-pressed", String(isSelected));
    });
    syncSelectedTags();
  };

  const getPayload = () => {
    const name = refs.nameInput.value.trim();
    const className = refs.classInput.value.trim();
    return {
      name,
      ageGroup: refs.ageGroupInput.value,
      selectedTags: Array.from(selectedTags),
      activity: refs.activityInput.value.trim(),
      lengthMode: refs.lengthInput.value || "short",
      date: refs.dateInput.value,
      tone: refs.toneInput.value || "gentle",
      className,
      length: refs.lengthInput.value || "short",
      group: className,
    };
  };

  const getFeedbackPayload = () => {
    const formData = new FormData(refs.feedbackForm);
    return {
      rating: formData.get("rating") || "",
      feedbackText: String(formData.get("feedbackText") || "").trim(),
      improvementRequest: String(formData.get("improvementRequest") || "").trim(),
    };
  };

  const rememberFormHistory = () => {
    upsertStoredListItem(STORAGE_KEYS.nameHistory, refs.nameInput.value);
    upsertStoredListItem(STORAGE_KEYS.classHistory, refs.classInput.value);
    renderDatalist(refs.nameHistory, loadStoredList(STORAGE_KEYS.nameHistory));
    renderDatalist(refs.classHistory, loadStoredList(STORAGE_KEYS.classHistory));
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
      ? "本日の残り回数: 無制限"
      : `本日の残り回数: ${planStatus.remainingCount}/${planStatus.dailyLimit}`;
    const showManagePlan =
      planStatus.plan === "plus" || planStatus.basePlan === "plus";
    refs.managePlanSection.classList.toggle("hidden", !showManagePlan);
    refs.plusPlanSection.style.display = planStatus.plan === "free" ? "block" : "none";
    if (planStatus.plan !== "free") {
      refs.plusPlanInfoPanel.classList.add("hidden");
    }
    refs.limitNotice.classList.toggle(
      "hidden",
      !(planStatus.plan === "free" && planStatus.remainingCount === 0)
    );

    refs.englishOption.hidden = !planStatus.supportsEnglish;
    refs.englishOption.disabled = !planStatus.supportsEnglish;
    if (!planStatus.supportsEnglish && refs.languageToggle.value === "en") {
      refs.languageToggle.value = "ja";
      updatePreview();
    }

    refs.featureHint.textContent = planStatus.supportsEnglish
      ? "英語翻訳を利用できます。感想送信はどのプランでも利用できます。"
      : "日本語生成と各入力機能は利用できます。英語翻訳は plus / test_plus で利用できます。";
  };

  const getPlanStatus = () => planStatus;

  const showPlusPlanInfo = () => {
    refs.plusPlanInfoPanel.classList.remove("hidden");
  };

  const hidePlusPlanInfo = () => {
    refs.plusPlanInfoPanel.classList.add("hidden");
  };

  const setAuthState = (nextLoggedIn) => {
    const loggedIn = Boolean(nextLoggedIn);
    refs.feedbackSubmitBtn.disabled = !loggedIn;
    if (!loggedIn) {
      setFeedbackStatus("感想送信にはログインが必要です。", "info");
      return;
    }
    setFeedbackStatus("");
  };

  const resetFeedbackForm = () => {
    refs.feedbackForm.reset();
  };

  refs.languageToggle.addEventListener("change", updatePreview);

  refs.ageButtons.forEach((button) => {
    button.addEventListener("click", () => {
      selectAgeGroup(button.dataset.ageGroup || "");
    });
  });

  refs.lengthButtons.forEach((button) => {
    button.addEventListener("click", () => {
      selectLengthMode(button.dataset.lengthMode || "short");
    });
  });

  refs.toneButtons.forEach((button) => {
    button.addEventListener("click", () => {
      selectTone(button.dataset.tone || "gentle");
    });
  });

  refs.tagButtons.forEach((button) => {
    button.addEventListener("click", () => {
      toggleTag(button.dataset.tag || "");
    });
  });

  refs.dateInput.value = todayString();
  renderDatalist(refs.nameHistory, loadStoredList(STORAGE_KEYS.nameHistory));
  renderDatalist(refs.classHistory, loadStoredList(STORAGE_KEYS.classHistory));
  selectLengthMode(loadStoredValue(STORAGE_KEYS.length, "short") || "short");
  selectTone(loadStoredValue(STORAGE_KEYS.tone, "gentle") || "gentle");
  selectAgeGroup("0");
  syncSelectedTags();
  setAuthState(false);

  return {
    refs,
    setStatus,
    setFeedbackStatus,
    updatePreview,
    getPayload,
    getFeedbackPayload,
    rememberFormHistory,
    setGenerated,
    getGenerated,
    getCurrentOutputText,
    setCopyMessage,
    setPlanStatus,
    getPlanStatus,
    showPlusPlanInfo,
    hidePlusPlanInfo,
    setAuthState,
    resetFeedbackForm,
  };
}
