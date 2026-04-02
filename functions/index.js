const { setGlobalOptions } = require("firebase-functions");
const { onRequest } = require("firebase-functions/https");
const logger = require("firebase-functions/logger");
const { defineSecret } = require("firebase-functions/params");

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { getAuth } = require("firebase-admin/auth");

// ====== Functionsのシークレット（推奨） ======
const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const ADMIN_EMAILS_SECRET = defineSecret("ADMIN_EMAILS");
const ALLOWED_EMAILS_SECRET = defineSecret("ALLOWED_EMAILS");
const DEVELOPER_EMAIL = "goyuutouya510@gmail.com";
const PLAN_CONFIG = {
  free: {
    dailyLimit: 1,
    supportsLength: false,
    supportsEnglish: false,
  },
  test_plus: {
    dailyLimit: 10,
    supportsLength: true,
    supportsEnglish: true,
  },
  plus: {
    dailyLimit: 10,
    supportsLength: true,
    supportsEnglish: true,
  },
  unlimited: {
    dailyLimit: null,
    supportsLength: true,
    supportsEnglish: true,
  },
};


// コスト暴発を抑える（必要なら調整）
setGlobalOptions({ maxInstances: 10 });

// ====== Admin SDK（Functions内はこれでOK） ======
admin.initializeApp();
const db = admin.firestore();

// ====== Firebase IDトークン検証 ======
function getBearerToken(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) {
    return "";
  }
  return header.slice(7).trim();
}

async function verifyUser(req) {
  const token = getBearerToken(req);
  if (!token) {
    const error = new Error("MISSING_TOKEN");
    error.code = "auth/missing-token";
    throw error;
  }

  const decodedToken = await getAuth().verifyIdToken(token);
  return decodedToken;
}

async function requireAuth(req, res, next) {
  try {
    const decodedToken = await verifyUser(req);
    req.user = decodedToken;
    req.uid = decodedToken.uid;
    next();
  } catch (error) {
    logger.error("verifyIdToken failed", error);
    return res.status(401).json({ error: "Unauthorized" });
  }
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function getPlanKey(value) {
  return ["free", "test_plus", "plus"].includes(value) ? value : "free";
}

function getTestModeKey(value) {
  return ["free", "plus", "unlimited"].includes(value) ? value : null;
}

function isDeveloperEmail(email) {
  return normalizeEmail(email) === DEVELOPER_EMAIL;
}

function resolvePlanContext(email, data = {}) {
  const basePlan = getPlanKey(data.plan);
  const testMode = isDeveloperEmail(email) ? getTestModeKey(data.testMode) : null;
  const effectivePlan = testMode || basePlan;

  return {
    basePlan,
    testMode,
    isTestMode: Boolean(testMode),
    effectivePlan,
  };
}

function parseEmailList(secretParam, secretName) {
  const rawValue = secretParam.value();
  if (!rawValue) {
    logger.error(`${secretName} is not configured`);
    return [];
  }

  const trimmedValue = rawValue.trim();

  try {
    if (trimmedValue.startsWith("[")) {
      const parsed = JSON.parse(trimmedValue);
      if (!Array.isArray(parsed)) {
        throw new Error("Secret value must be a JSON array");
      }
      return parsed
        .map((email) => normalizeEmail(email))
        .filter(Boolean);
    }
  } catch (error) {
    logger.error(`${secretName} is not valid JSON array`, error);
  }

  return trimmedValue
    .split(/[\n,]/)
    .map((email) => normalizeEmail(email.replace(/[[\]"]/g, "")))
    .filter(Boolean);
}

function getEmailSet(secretParam, secretName) {
  return new Set(parseEmailList(secretParam, secretName));
}

function getAccessLists() {
  return {
    allowedSet: getEmailSet(ALLOWED_EMAILS_SECRET, "ALLOWED_EMAILS"),
    adminSet: getEmailSet(ADMIN_EMAILS_SECRET, "ADMIN_EMAILS"),
  };
}

function getDefaultPlanForEmail(email, currentPlan) {
  const normalizedEmail = normalizeEmail(email);
  const plan = getPlanKey(currentPlan);
  const { allowedSet } = getAccessLists();

  if (plan === "plus" || plan === "test_plus") {
    return plan;
  }

  if (normalizedEmail && allowedSet.has(normalizedEmail)) {
    return "test_plus";
  }

  return plan;
}

function buildPlanStatus(plan, dailyCount) {
  const config = PLAN_CONFIG[plan] || PLAN_CONFIG.free;
  return {
    plan,
    dailyCount,
    dailyLimit: config.dailyLimit,
    remainingCount:
      config.dailyLimit === null ? null : Math.max(config.dailyLimit - dailyCount, 0),
    supportsLength: config.supportsLength,
    supportsEnglish: config.supportsEnglish,
    lastResetAt: getDayKeyJST(),
  };
}

function allowlist(req, res, next) {
  const email = normalizeEmail(req.user?.email);
  const { allowedSet, adminSet } = getAccessLists();

  if (!email || (!allowedSet.has(email) && !adminSet.has(email))) {
    return res.status(403).json({
      error: "このアカウントは利用できません（テスト運用中）",
    });
  }
  next();
}

// ====== プラン別の利用回数制限 ======

function getDayKeyJST() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(
    jst.getUTCDate()
  ).padStart(2, "0")}`;
}

function getDayKeyFromResetAt(value) {
  if (!value) return "";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }

  let dateValue = null;
  if (typeof value?.toDate === "function") {
    dateValue = value.toDate();
  } else if (value instanceof Date) {
    dateValue = value;
  } else {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      dateValue = parsed;
    }
  }

  if (!dateValue) return "";
  const jst = new Date(dateValue.getTime() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(
    jst.getUTCDate()
  ).padStart(2, "0")}`;
}

async function loadUserProfile(req, res, next) {
  try {
    const uid = req.user?.uid;
    const email = normalizeEmail(req.user?.email);
    if (!uid) {
      return res.status(401).json({ error: "認証情報がありません" });
    }

    const userRef = db.collection("users").doc(uid);
    const currentDay = getDayKeyJST();
    const snap = await userRef.get();

    if (!snap.exists) {
      const plan = getDefaultPlanForEmail(email, "free");
      await userRef.set({
        uid,
        email,
        plan,
        dailyCount: 0,
        lastResetAt: currentDay,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      req.userProfile = {
        ref: userRef,
        ...buildPlanStatus(plan, 0),
        basePlan: plan,
        testMode: null,
        isTestMode: false,
        lastResetAt: currentDay,
      };
      return next();
    }

    const data = snap.data() || {};
    const nextBasePlan = getDefaultPlanForEmail(email, data.plan);
    const nextPlanContext = resolvePlanContext(email, {
      ...data,
      plan: nextBasePlan,
    });
    const plan = nextPlanContext.effectivePlan;
    const lastResetDay = getDayKeyFromResetAt(data.lastResetAt);
    const shouldReset = lastResetDay !== currentDay;
    const dailyCount = shouldReset ? 0 : Math.max(Number(data.dailyCount) || 0, 0);
    const updates = {};

    if (nextBasePlan !== data.plan) {
      updates.plan = nextBasePlan;
    }
    if (email && email !== normalizeEmail(data.email)) {
      updates.email = email;
    }
    if (shouldReset) {
      updates.dailyCount = 0;
      updates.lastResetAt = currentDay;
    }

    if (Object.keys(updates).length > 0) {
      updates.updatedAt = new Date().toISOString();
      await userRef.set(updates, { merge: true });
    }

    req.userProfile = {
      ref: userRef,
      ...buildPlanStatus(plan, dailyCount),
      basePlan: nextBasePlan,
      testMode: nextPlanContext.testMode,
      isTestMode: nextPlanContext.isTestMode,
      lastResetAt: shouldReset ? currentDay : lastResetDay || currentDay,
    };
    next();
  } catch (error) {
    logger.error("loadUserProfile failed", error);
    return res.status(500).json({ error: "ユーザー情報の取得に失敗しました" });
  }
}

async function enforceDailyUsageLimit(req, res, next) {
  try {
    const uid = req.user?.uid;
    const email = normalizeEmail(req.user?.email);
    const userRef = req.userProfile?.ref || db.collection("users").doc(uid);
    const currentDay = getDayKeyJST();
    let nextStatus = null;

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      const data = snap.data() || {};
      const planContext = resolvePlanContext(email, data);
      const plan = planContext.effectivePlan;
      const config = PLAN_CONFIG[plan] || PLAN_CONFIG.free;
      const lastResetDay = getDayKeyFromResetAt(data.lastResetAt);
      const currentCount = lastResetDay === currentDay ? Math.max(Number(data.dailyCount) || 0, 0) : 0;

      if (config.dailyLimit !== null && currentCount >= config.dailyLimit) {
        throw new Error("PLAN_LIMIT");
      }

      const nextCount = currentCount + 1;
      tx.set(
        userRef,
        {
          uid,
          email,
          plan: planContext.basePlan,
          dailyCount: nextCount,
          lastResetAt: currentDay,
          updatedAt: new Date().toISOString(),
        },
        { merge: true }
      );

      nextStatus = {
        ref: userRef,
        ...buildPlanStatus(plan, nextCount),
        basePlan: planContext.basePlan,
        testMode: planContext.testMode,
        isTestMode: planContext.isTestMode,
        lastResetAt: currentDay,
      };
    });

    req.userProfile = nextStatus;
    next();
  } catch (error) {
    if (error.message === "PLAN_LIMIT") {
      const dailyLimit = req.userProfile?.dailyLimit || PLAN_CONFIG.free.dailyLimit;
      return res.status(429).json({ error: `本日の利用上限（${dailyLimit}回）に達しました` });
    }
    logger.error("enforceDailyUsageLimit failed", error);
    return res.status(500).json({ error: "利用回数チェックに失敗しました" });
  }
}

function requireEnglishFeature(req, res, next) {
  if (!req.userProfile?.supportsEnglish) {
    return res.status(403).json({ error: "plusプランで利用できます" });
  }
  next();
}

// ====== Express App ======
const app = express();
app.use(
  cors({
    origin: [
      "http://127.0.0.1:5002",
      "http://localhost:5002",
      "https://hoiku-letter-tool.web.app",
      "https://hoiku-letter-tool.firebaseapp.com",
    ],
  })
);
app.use(express.json());

// ====== API ======
app.get("/me", requireAuth, allowlist, loadUserProfile, async (req, res) => {
  return res.json({
    plan: req.userProfile.plan,
    basePlan: req.userProfile.basePlan,
    testMode: req.userProfile.testMode,
    isTestMode: req.userProfile.isTestMode,
    dailyCount: req.userProfile.dailyCount,
    lastResetAt: req.userProfile.lastResetAt,
    dailyLimit: req.userProfile.dailyLimit,
    remainingCount: req.userProfile.remainingCount,
    supportsLength: req.userProfile.supportsLength,
    supportsEnglish: req.userProfile.supportsEnglish,
  });
});

app.post("/activate-test-plus", requireAuth, allowlist, loadUserProfile, async (req, res) => {
  try {
    const userRef = req.userProfile?.ref || db.collection("users").doc(req.uid);
    const currentPlan = req.userProfile?.basePlan || "free";
    const nextPlan = currentPlan === "free" ? "test_plus" : currentPlan;
    const currentDay = getDayKeyJST();
    const currentCount = Math.max(Number(req.userProfile?.dailyCount) || 0, 0);

    await userRef.set(
      {
        uid: req.uid,
        email: normalizeEmail(req.user?.email),
        plan: nextPlan,
        updatedAt: new Date().toISOString(),
      },
      { merge: true }
    );

    const planContext = resolvePlanContext(req.user?.email, {
      plan: nextPlan,
      testMode: req.userProfile?.testMode,
    });

    return res.json({
      ...buildPlanStatus(planContext.effectivePlan, currentCount),
      basePlan: planContext.basePlan,
      testMode: planContext.testMode,
      isTestMode: planContext.isTestMode,
      lastResetAt: req.userProfile?.lastResetAt || currentDay,
    });
  } catch (error) {
    logger.error("activate-test-plus failed", error);
    return res.status(500).json({ error: "test_plus の設定に失敗しました" });
  }
});

app.post(
  "/hoiku-letter",
  requireAuth,
  allowlist,
  loadUserProfile,
  enforceDailyUsageLimit,
  async (req, res) => {
    try {
      const apiKey = OPENAI_API_KEY.value();
      if (!apiKey) {
        return res.status(500).json({ error: "OPENAI_API_KEY が未設定です" });
      }

      const payload = req.body;
      const { date, weather, group, name, event: activity, notes, length } = payload || {};

      const formatDate = (value, locale, options) => {
        if (!value) return "";
        const dateObj = new Date(value);
        if (Number.isNaN(dateObj.getTime())) return value;
        return new Intl.DateTimeFormat(locale, options).format(dateObj);
      };

      const sanitizeChildName = (rawName) => {
        if (!rawName) return { honorific: "お子さん", english: "your child" };
        const trimmed = rawName.trim();
        if (!trimmed) return { honorific: "お子さん", english: "your child" };
        const parts = trimmed.split(/\s+/);
        const given = parts[parts.length - 1].replace(/(くん|ちゃん|さん)$/u, "");
        const base = given || "お子さん";
        return { honorific: `${base}さん`, english: base };
      };

      const formattedDateJa = formatDate(date, "ja-JP", {
        year: "numeric",
        month: "long",
        day: "numeric",
        weekday: "long",
      });

      const formattedDateEn = formatDate(date, "en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
        weekday: "long",
      });

      const safeGroup = group || "保育室";
      const childNames = sanitizeChildName(name);
      const mainEvent = activity || "本日の活動";
      const observation = (notes || "").trim() || "ゆったりと友だちと関わっていました";
      const weatherText = (weather || "").trim() || "穏やかな気候";
      const lengthConfig = req.userProfile?.supportsLength
        ? {
            short: {
              charRange: "150〜200文字",
              structure: "1段落で簡潔にまとめる。",
              maxTokens: 220,
            },
            normal: {
              charRange: "230〜300文字",
              structure: "観察と遊びの様子を中心に、必要に応じて安全確認や家庭への一言を自然につなぐ。",
              maxTokens: 380,
            },
            long: {
              charRange: "380〜450文字",
              structure:
                "2段落構成にする。1段落目は観察・遊びの様子・安全確認、2段落目は家庭への一言を書く。",
              maxTokens: 520,
            },
          }[length] || {
            charRange: "230〜300文字",
            structure: "観察と遊びの様子を中心に、必要に応じて安全確認や家庭への一言を自然につなぐ。",
            maxTokens: 380,
          }
        : {
            charRange: "150〜200文字",
            structure: "1段落で簡潔にまとめる。",
            maxTokens: 220,
          };

   const messages = [
  {
    role: "system",
    content:
      "保育士が実際に観察した記録として、保護者に送る連絡帳の文章を作成してください。入力情報のみを使って自然な文章にまとめてください。",
  },
  {
    role: "user",
    content: `ルール
・入力にない出来事や会話を作らない
・会話文「」は禁止
・誇張表現を使わない
・比喩表現（〜のように、まるで〜）は禁止
・事実ベースで書く
・1〜2文は短い文にする
・園児の呼称は常に「${childNames.honorific}」とする
・文字数は${lengthConfig.charRange}を目安にし、その範囲にできるだけ近づける
・${lengthConfig.structure}
・「印象的でした」「お伝えしたいと思います」「見守っていただければと思います」「関係を深めていけると良いですね」「活動報告です」は使わない
・保育士の連絡帳として、観察、遊びの様子、安全確認を優先して書く

入力情報:
- 日付: ${formattedDateJa}
- 気候: ${weatherText}
- 所属: ${safeGroup}
- 園児の呼称: ${childNames.honorific}
- 活動: ${mainEvent}
- 観察キーワード: ${observation}

出力形式:
JSON文字列のみで回答してください (例: {"ja":"..."})。余計な装飾やマークダウンは不要です。`,
  },
];

const response = await fetch("https://api.openai.com/v1/chat/completions", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model: "gpt-4o-mini",
    messages,
    temperature: 0.3,
    max_tokens: lengthConfig.maxTokens,
  }),
});

if (!response.ok) {
  const text = await response.text();
  console.error("OpenAI API error:", text);
  return res.status(response.status).json({ error: `OpenAI API error: ${text}` });
}

const data = await response.json();
const content = data.choices?.[0]?.message?.content?.trim() || "";

let parsed;
try {
  parsed = JSON.parse(content);
} catch (e) {
  return res.status(500).json({
    error: "ChatGPTの返答をJSONとして解析できませんでした。",
    raw: content,
  });
}

return res.json({
  ja: parsed.ja || "",
  plan: req.userProfile.plan,
  basePlan: req.userProfile.basePlan,
  testMode: req.userProfile.testMode,
  isTestMode: req.userProfile.isTestMode,
  dailyCount: req.userProfile.dailyCount,
  lastResetAt: req.userProfile.lastResetAt,
  dailyLimit: req.userProfile.dailyLimit,
  remainingCount: req.userProfile.remainingCount,
  supportsLength: req.userProfile.supportsLength,
  supportsEnglish: req.userProfile.supportsEnglish,
});

    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "サーバー側でエラーが発生しました。" });
    }
  }
);

app.post(
  "/hoiku-letter-en",
  requireAuth,
  allowlist,
  loadUserProfile,
  requireEnglishFeature,
  async (req, res) => {
    try {
      const apiKey = OPENAI_API_KEY.value();
      if (!apiKey) return res.status(500).json({ error: "OPENAI_API_KEY が未設定です" });

      const { jaText } = req.body || {};
      if (!jaText || !jaText.trim()) {
        return res.status(400).json({ error: "jaText が必要です" });
      }

      const messages = [
        {
          role: "system",
          content:
            "You write friendly, natural childcare newsletter notes for parents (US/UK). Keep it warm and not too formal.",
        },
        {
          role: "user",
          content: `Rewrite the following Japanese daycare note into natural English.

Rules:
- Do not translate literally; write as if the note was originally written in natural English.
- Keep the tone friendly and informal, like a real teacher writing to parents (not a school report).
- Use simple everyday words. Keep sentences short to medium length (around ~20 words), and vary the rhythm.
- Be specific and concise. Avoid abstract praise (creativity, wonderful, amazing, impressive) or exaggerated emotional language unless clearly supported by a concrete example.
- Include one small, specific detail (gesture, expression, action, or short quote if provided) and light sensory cues (sound, movement, atmosphere) to make the moment feel real.
- Replace unnatural literal phrasing (e.g., “the earth”) with natural English equivalents.
- If cultural elements appear, explain them naturally for English readers.
- Do not invent dialogue, events, or details. Only describe what logically follows from the given information, and do not expand beyond the provided facts.
- Keep the whole note within 2–3 short paragraphs.
- Allow a touch of natural imperfection; avoid over-polishing.

Return JSON only: {"en":"..."} (no markdown).

Japanese note:
${jaText}`,
        },
      ];

      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages,
          temperature: 0.5,
          max_tokens: 350,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        console.error("OpenAI API error:", text);
        return res.status(response.status).json({ error: `OpenAI API error: ${text}` });
      }
 const data = await response.json();
 const content = data.choices?.[0]?.message?.content?.trim() || "";

 let parsed;
try {
  parsed = JSON.parse(content);
} catch (e) {
  return res.status(500).json({ error: "English JSON parse failed", raw: content });
}
 

      return res.json({
        en: parsed.en || "",
        plan: req.userProfile.plan,
        basePlan: req.userProfile.basePlan,
        testMode: req.userProfile.testMode,
        isTestMode: req.userProfile.isTestMode,
        dailyCount: req.userProfile.dailyCount,
        lastResetAt: req.userProfile.lastResetAt,
        dailyLimit: req.userProfile.dailyLimit,
        remainingCount: req.userProfile.remainingCount,
        supportsLength: req.userProfile.supportsLength,
        supportsEnglish: req.userProfile.supportsEnglish,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: "サーバー側でエラーが発生しました。" });
    }
  }
);

exports.api = onRequest(
  { secrets: [OPENAI_API_KEY, ADMIN_EMAILS_SECRET, ALLOWED_EMAILS_SECRET] },
  app
);
