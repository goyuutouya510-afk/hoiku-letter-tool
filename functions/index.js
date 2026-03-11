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

function parseEmailList(secretParam, secretName) {
  const rawValue = secretParam.value();
  if (!rawValue) {
    logger.error(`${secretName} is not configured`);
    return [];
  }

  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) {
      throw new Error("Secret value must be a JSON array");
    }
    return parsed
      .map((email) => normalizeEmail(email))
      .filter(Boolean);
  } catch (error) {
    logger.error(`${secretName} must be a JSON array of email addresses`, error);
    return [];
  }
}

function getEmailSet(secretParam, secretName) {
  return new Set(parseEmailList(secretParam, secretName));
}

function allowlist(req, res, next) {
  const email = normalizeEmail(req.user?.email);
  const allowedSet = getEmailSet(ALLOWED_EMAILS_SECRET, "ALLOWED_EMAILS");
  const adminSet = getEmailSet(ADMIN_EMAILS_SECRET, "ADMIN_EMAILS");

  if (!email || (!allowedSet.has(email) && !adminSet.has(email))) {
    return res.status(403).json({
      error: "このアカウントは利用できません（テスト運用中）",
    });
  }
  next();
}

// ====== 利用回数制限（Firestore版） ======
const DAILY_LIMIT_PER_USER = 10;
const DAILY_LIMIT_GLOBAL = 50;

function getDayKeyJST() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, "0")}-${String(
    jst.getUTCDate()
  ).padStart(2, "0")}`;
}

async function rateLimitDailyFirestore(req, res, next) {
  try {
    const uid = req.user?.uid;
    const email = normalizeEmail(req.user?.email);
    if (!uid) return res.status(401).json({ error: "認証情報がありません" });
    // ✅ 管理者は回数制限をスキップ
    const adminSet = getEmailSet(ADMIN_EMAILS_SECRET, "ADMIN_EMAILS");
    if (adminSet.has(email)) {
      return next();
    }
    const dayKey = getDayKeyJST();
    const userRef = db.collection("usage").doc(`${uid}_${dayKey}`);
    const globalRef = db.collection("global_usage").doc(dayKey);

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      const globalSnap = await tx.get(globalRef);

      const userCount = userSnap.exists ? userSnap.data().count || 0 : 0;
      const globalCount = globalSnap.exists ? globalSnap.data().count || 0 : 0;

      if (globalCount >= DAILY_LIMIT_GLOBAL) throw new Error("GLOBAL_LIMIT");
      if (userCount >= DAILY_LIMIT_PER_USER) throw new Error("USER_LIMIT");

      tx.set(
        userRef,
        {
          uid,
          email,
          dayKey,
          count: userCount + 1,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

      tx.set(
        globalRef,
        {
          dayKey,
          count: globalCount + 1,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    });

    next();
  } catch (e) {
    if (e.message === "GLOBAL_LIMIT") {
      return res.status(429).json({ error: "本日の全体利用上限に達しました" });
    }
    if (e.message === "USER_LIMIT") {
      return res.status(429).json({ error: "本日の利用上限（10回）に達しました" });
    }
    console.error(e);
    return res.status(500).json({ error: "回数制限チェックでエラー" });
  }
}

// ====== Express App ======
const app = express();
app.use(
  cors({
    origin: [
      "https://hoiku-letter-tool.web.app",
      "https://hoiku-letter-tool.firebaseapp.com",
    ],
  })
);
app.use(express.json());

// ====== API ======
app.post(
  "/hoiku-letter",
  requireAuth,
  allowlist,
  rateLimitDailyFirestore,
  async (req, res) => {
    try {
      const apiKey = OPENAI_API_KEY.value();
      if (!apiKey) {
        return res.status(500).json({ error: "OPENAI_API_KEY が未設定です" });
      }

      const payload = req.body;
      const { date, weather, group, name, event: activity, notes } = payload || {};

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

   const messages = [
  {
    role: "system",
    content:
      "あなたは現場経験のあるベテラン保育士です。保護者にわかりやすく寄り添う自然なお便り帳を書きます。",
  },
  {
    role: "user",
    content: `以下の条件で作成してください。
1 文章は今日の気候の描写から始める。
2 園での様子から家庭への声かけへ自然につなげる。
3 園児の呼称は常に「${childNames.honorific}」とする。
4 観察キーワードは本文に自然に溶け込ませ、「様子メモ」という語は使わない。
5 短く具体的に書き、抽象的な評価語（創造力・集中力・感心しました等）は多用しない。
6 具体的な行動やしぐさを1つ以上含め、音や動きが想像できる表現を少し入れる。
7 説明調にせず、その場を一緒に見ているような描写にする。
8 文の長さを揃えすぎず、まとめすぎない。
9 入力にない事実や会話は創作しない（セリフは入力に明示されている場合のみ可）。
10 全体は2〜3段落で、長くなりすぎない。

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
    temperature: 0.6,
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
  return res.status(500).json({
    error: "ChatGPTの返答をJSONとして解析できませんでした。",
    raw: content,
  });
}

return res.json({ ja: parsed.ja || "" });

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
  rateLimitDailyFirestore,
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
 

      return res.json({ en: parsed.en || "" });
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
