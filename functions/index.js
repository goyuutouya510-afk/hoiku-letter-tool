const { setGlobalOptions } = require("firebase-functions");
const { onRequest } = require("firebase-functions/https");
const logger = require("firebase-functions/logger");
const { defineSecret } = require("firebase-functions/params");

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { getAuth } = require("firebase-admin/auth");
const Stripe = require("stripe");


// ====== Functionsのシークレット（推奨） ======
const OPENAI_API_KEY = defineSecret("OPENAI_API_KEY");
const ADMIN_EMAILS_SECRET = defineSecret("ADMIN_EMAILS");
const ALLOWED_EMAILS_SECRET = defineSecret("ALLOWED_EMAILS");
const STRIPE_SECRET_KEY = defineSecret("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = defineSecret("STRIPE_WEBHOOK_SECRET");
const STRIPE_PRICE_ID = defineSecret("STRIPE_PRICE_ID");
const DEVELOPER_EMAIL = "goyuutouya510@gmail.com";
const PLAN_CONFIG = {
  free: {
    dailyLimit: 1,
    supportsLength: true,
    supportsEnglish: false,
  },
  test_plus: {
    dailyLimit: 30,
    supportsLength: true,
    supportsEnglish: true,
  },
  plus: {
    dailyLimit: 30,
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

function getStripeClient() {
  return new Stripe(STRIPE_SECRET_KEY.value());
}

function summarizeSecretValue(value, expectedPrefix) {
  const raw = String(value || "");
  const trimmed = raw.trim();

  return {
    present: Boolean(raw),
    startsWithExpectedPrefix: trimmed.startsWith(expectedPrefix),
    hasLeadingOrTrailingWhitespace: raw !== trimmed,
    hasControlChars: /[\u0000-\u001F\u007F]/.test(raw),
    hasNonAscii: /[^\u0000-\u007F]/.test(raw),
  };
}

function getAppBaseUrl(req) {
  const origin = String(req.get("origin") || "").trim();
  const allowedOrigins = new Set([
    "http://127.0.0.1:5002",
    "http://localhost:5002",
    "https://hoiku-letter-tool.web.app",
    "https://hoiku-letter-tool.firebaseapp.com",
  ]);

  if (allowedOrigins.has(origin)) {
    return origin;
  }

  return "https://hoiku-letter-tool.web.app";
}

async function findUserByStripeIds(subscriptionId, customerId) {
  const normalizedSubscriptionId = String(subscriptionId || "").trim();
  const normalizedCustomerId = String(customerId || "").trim();

  if (normalizedSubscriptionId) {
    const bySubscription = await db
      .collection("users")
      .where("stripeSubscriptionId", "==", normalizedSubscriptionId)
      .limit(1)
      .get();
    if (!bySubscription.empty) {
      return bySubscription.docs[0];
    }
  }

  if (normalizedCustomerId) {
    const byCustomer = await db
      .collection("users")
      .where("stripeCustomerId", "==", normalizedCustomerId)
      .limit(1)
      .get();
    if (!byCustomer.empty) {
      return byCustomer.docs[0];
    }
  }

  return null;
}

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
  return ["free", "test_plus", "plus", "unlimited"].includes(value) ? value : null;
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
  const plan = getPlanKey(currentPlan);

  if (plan === "plus" || plan === "test_plus") {
    return plan;
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
        lastResetAt: admin.firestore.FieldValue.serverTimestamp(),
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
    return res.status(403).json({ error: "plus / test_plus で利用できます" });
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

app.post(
  "/stripe-webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    const signature = req.headers["stripe-signature"];
    if (!signature) {
      return res.status(400).send("Missing stripe-signature header");
    }

    let event;
    try {
      event = getStripeClient().webhooks.constructEvent(
        req.rawBody,
        signature,
        STRIPE_WEBHOOK_SECRET.value()
      );
    } catch (error) {
      logger.error("stripe webhook signature verification failed", error);
      return res.status(400).send(`Webhook Error: ${error.message}`);
    }

    try {
      if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const uid = String(session.client_reference_id || "").trim();

        if (!uid) {
          logger.error("checkout.session.completed missing client_reference_id", {
            sessionId: session.id,
          });
          return res.status(400).send("Missing client_reference_id");
        }

        await db.collection("users").doc(uid).set(
          {
            plan: "plus",
            stripeCustomerId: session.customer || "",
            stripeSubscriptionId: session.subscription || "",
            subscriptionStatus: "active",
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }

      if (event.type === "customer.subscription.deleted") {
        const subscription = event.data.object;
        const subscriptionId = subscription.id || "";
        const customerId = subscription.customer || "";
        const userDoc = await findUserByStripeIds(subscriptionId, customerId);

        if (!userDoc) {
          logger.warn("customer.subscription.deleted user not found", {
            subscriptionId,
            customerId,
          });
          return res.json({ received: true });
        }

        await userDoc.ref.set(
          {
            plan: "free",
            subscriptionStatus: "canceled",
            canceledAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );
      }

      return res.json({ received: true });
    } catch (error) {
      logger.error("stripe webhook handling failed", error);
      return res.status(500).send("Webhook handler failed");
    }
  }
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

app.post("/create-checkout-session", requireAuth, allowlist, async (req, res) => {
  try {
    if (!req.uid) {
      return res.status(401).json({ error: "認証情報がありません" });
    }

    const priceId = STRIPE_PRICE_ID.value();
    const stripe = getStripeClient();
    const baseUrl = getAppBaseUrl(req);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      client_reference_id: req.uid,
      customer_email: req.user?.email || undefined,
      success_url: `${baseUrl}/?checkout=success`,
      cancel_url: `${baseUrl}/?checkout=cancel`,
    });

    if (!session.url) {
      return res.status(500).json({ error: "Checkout URL の作成に失敗しました" });
    }

    return res.json({ url: session.url });
  } catch (error) {
    logger.error("create-checkout-session failed", {
      type: error?.type || "",
      code: error?.code || "",
      message: error?.message || "",
      param: error?.param || "",
      rawMessage: error?.raw?.message || "",
      requestId: error?.requestId || error?.raw?.requestId || "",
      statusCode: error?.statusCode || null,
      hasUid: Boolean(req.uid),
      hasEmail: Boolean(req.user?.email),
      origin: String(req.get("origin") || ""),
      resolvedBaseUrl: getAppBaseUrl(req),
      secretKeySummary: summarizeSecretValue(STRIPE_SECRET_KEY.value(), "sk_live_"),
      priceIdSummary: summarizeSecretValue(STRIPE_PRICE_ID.value(), "price_"),
    });
    return res.status(500).json({ error: "決済画面の作成に失敗しました" });
  }
});

app.post(
  "/create-customer-portal-session",
  requireAuth,
  allowlist,
  loadUserProfile,
  async (req, res) => {
    try {
      const isPlusUser = req.userProfile?.plan === "plus" || req.userProfile?.basePlan === "plus";
      if (!isPlusUser) {
        return res.status(403).json({ error: "plusプランのユーザーのみ利用できます" });
      }

      const userRef = req.userProfile?.ref || db.collection("users").doc(req.uid);
      const snap = await userRef.get();
      const userData = snap.data() || {};
      const stripeCustomerId = String(userData.stripeCustomerId || "").trim();

      if (!stripeCustomerId) {
        return res.status(404).json({ error: "Stripe customer 情報が見つかりません" });
      }

      const stripe = getStripeClient();
      const portalSession = await stripe.billingPortal.sessions.create({
        customer: stripeCustomerId,
        return_url: "https://hoiku-letter-tool.web.app",
      });

      if (!portalSession.url) {
        return res.status(500).json({ error: "プラン管理画面の作成に失敗しました" });
      }

      return res.json({ url: portalSession.url });
    } catch (error) {
      logger.error("create-customer-portal-session failed", error);
      return res.status(500).json({ error: "プラン管理画面の作成に失敗しました" });
    }
  }
);

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

      const payload = req.body || {};
      const {
        date,
        name,
        ageGroup,
        selectedTags,
        activity,
        lengthMode,
        length,
        tone,
        className,
        group,
      } = payload;

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

      const sanitizeTagText = (rawTag) =>
        String(rawTag || "")
          .replace(/^[^\p{L}\p{N}]+/u, "")
          .trim();

      const toneLabelMap = {
        formal: "丁寧",
        gentle: "やさしい",
        friendly: "フレンドリー",
      };

      const toneGuideMap = {
        formal: "少しかしこまった、きちんとした文章にする。",
        gentle: "保護者が安心しやすい、自然であたたかい文章にする。",
        friendly: "親しみやすさを出しつつ、保護者向けとして丁寧さは残し、軽すぎる表現にはしない。",
      };

      const normalizedTags = Array.isArray(selectedTags)
        ? selectedTags.map((tag) => sanitizeTagText(tag)).filter(Boolean)
        : [];

      const healthRelatedTags = ["すり傷", "鼻水", "咳", "体調注意"];
      const hasHealthTag = normalizedTags.some((tag) => healthRelatedTags.includes(tag));

      const formattedDateJa = formatDate(date, "ja-JP", {
        year: "numeric",
        month: "long",
        day: "numeric",
        weekday: "long",
      });

      const safeGroup = className || group || "保育室";
      const childNames = sanitizeChildName(name);
      const mainEvent = activity || "本日の活動";
      const observation = normalizedTags.join("／") || "ゆったりと友だちと関わっていました";
      const lengthConfig = {
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
      }[lengthMode || length] || {
        charRange: "150〜200文字",
        structure: "1段落で簡潔にまとめる。",
        maxTokens: 220,
      };
      const safeAgeGroup = String(ageGroup || "").trim() || "未設定";
      const toneLabel = toneLabelMap[tone] || "やさしい";
      const toneGuide = toneGuideMap[tone] || toneGuideMap.gentle;

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
・具体的な行動や様子を書く
・抽象表現だけで終わらない
・ネガティブな出来事だけで終わらない
・その後どうなったかを書く
・保護者が安心できる文章にする
・保護者が様子をイメージできる文章にする
・保育現場らしい自然な文章にする
・硬すぎない書き出しにする
・温かみのある表現を使う
・前向きで安心感のある締めにする
・本文に絵文字は使わない
・年齢に合った表現にする
・${hasHealthTag ? "けがや体調に関する内容は、必要な事実を伝えつつ、保護者が不安になりすぎないよう落ち着いた表現にする" : "けがや体調に関するタグがない場合でも、安心感を損なわない書き方にする"}
・free/plusで文章品質に差をつけず、差は文字数と利用機能だけにする
・AIっぽい不自然な表現を避ける
・4月など関係づくりの時期は、初めての環境への配慮や安心感が伝わる表現を優先する
・園児の呼称は常に「${childNames.honorific}」とする
・文字数は${lengthConfig.charRange}を目安にし、その範囲にできるだけ近づける
・${lengthConfig.structure}
・「印象的でした」「お伝えしたいと思います」「見守っていただければと思います」「関係を深めていけると良いですね」「活動報告です」は使わない
・保育士の連絡帳として、観察、遊びの様子、安全確認を優先して書く

言い換えの参考パターン
・「元気に過ごしました」より「笑顔で過ごす姿が見られました」
・「楽しんでいました」より「夢中になって遊ぶ姿が見られました」
・「頑張っていました」より「最後まで取り組もうとする姿が見られました」
・「落ち着いて過ごしました」より「安心した様子で過ごしていました」
・「できました」より「自分でやろうとする姿が見られました」
・「泣いていました」より「涙が見られる場面もありましたが、その後は落ち着いて過ごしていました」
・「トラブルがありました」より「思いがぶつかる場面もありましたが、やりとりを経験しています」
・「言うことを聞きませんでした」より「自分の思いを強く表す姿が見られました」
・「落ち着きがありませんでした」より「気持ちが動きやすい様子が見られました」
・「甘えていました」より「保育者に関わりを求める姿が見られました」
・「ご飯を食べました」より「意欲的に食事に取り組む姿が見られました」
・「あまり食べませんでした」より「食事量は少なめでしたが、自分のペースで食べ進めていました」
・「遊びました」より「好きな遊びを見つけて楽しんでいました」
・「外で遊びました」より「戸外で体を動かしながら遊ぶ姿が見られました」
・「寝ました」より「落ち着いて午睡に入ることができました」
・「すごいですね」より「成長を感じる姿が見られました」
・「上手でした」より「工夫しながら取り組む姿が見られました」
・「えらいですね」より「自分でやってみようとする姿が見られました」
・「成長しました」より「少しずつできることが増えてきています」
・「いい感じでした」より「安定して過ごす姿が見られました」

補足
・上の言い換えは固定テンプレではなく参考パターンとして使う
・入力内容に合うときだけ自然に取り入れる
・4月らしい場面では「少しずつ慣れてきています」「安心した様子が見られました」「関わりの中で落ち着いています」「新しい環境に戸惑う様子もありますが安心して過ごしています」「好きな遊びを見つけながら過ごしています」などを参考にしてよい
・トーン指定は「${toneLabel}」。${toneGuide}

入力情報:
- 日付: ${formattedDateJa}
- 所属: ${safeGroup}
- 園児の呼称: ${childNames.honorific}
- 年齢区分: ${safeAgeGroup}
- 選択タグ: ${normalizedTags.join("、") || "なし"}
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
  "/feedback",
  requireAuth,
  allowlist,
  loadUserProfile,
  async (req, res) => {
    try {
      const { rating = "", feedbackText = "", improvementRequest = "" } = req.body || {};
      await db.collection("feedback").add({
        uid: req.user?.uid || "",
        email: normalizeEmail(req.user?.email),
        rating: String(rating || "").trim(),
        feedbackText: String(feedbackText || "").trim(),
        improvementRequest: String(improvementRequest || "").trim(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        plan: req.userProfile?.plan || "free",
        userAgent: String(req.headers["user-agent"] || ""),
      });

      return res.json({ ok: true });
    } catch (error) {
      logger.error("feedback save failed", error);
      return res.status(500).json({ error: "感想の保存に失敗しました" });
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
  { secrets: [OPENAI_API_KEY, ADMIN_EMAILS_SECRET, ALLOWED_EMAILS_SECRET,STRIPE_SECRET_KEY,STRIPE_WEBHOOK_SECRET,STRIPE_PRICE_ID] },
  app
);
