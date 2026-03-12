const PROD_API_BASE = "https://us-central1-hoiku-letter-tool.cloudfunctions.net/api";
const LOCAL_API_BASE = "http://127.0.0.1:5001/hoiku-letter-tool/us-central1/api";

function getApiBase() {
  const { hostname } = window.location;
  if (hostname === "127.0.0.1" || hostname === "localhost") {
    return LOCAL_API_BASE;
  }
  return PROD_API_BASE;
}

async function postWithAuth(url, body, token) {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
}

async function getWithAuth(url, token) {
  return fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });
}

export async function fetchUserStatus(idToken) {
  const response = await getWithAuth(`${getApiBase()}/me`, idToken);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `プラン情報の取得に失敗しました (${response.status})`);
  }

  return response.json();
}

export async function generateJapaneseLetter(payload, idToken) {
  const response = await postWithAuth(`${getApiBase()}/hoiku-letter?lang=ja`, payload, idToken);
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `日本語生成エラー (${response.status})`);
  }

  return response.json();
}

export async function generateEnglishLetter(jaText, idToken) {
  const response = await postWithAuth(
    `${getApiBase()}/hoiku-letter-en?lang=en`,
    { jaText },
    idToken
  );

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `英語生成エラー (${response.status})`);
  }

  return response.json();
}
