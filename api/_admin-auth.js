"use strict";

const { createHmac, timingSafeEqual } = require("node:crypto");

const SESSION_COOKIE_NAME = "aicenghub_admin_session";
const SESSION_TTL_SECONDS_DEFAULT = 60 * 60 * 12;
const GOOGLE_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo";

const DEFAULT_ALLOWED_ADMIN_EMAILS = [
  "senaprasena@gmail.com",
  "ashmeeishwar@gmail.com",
  "julehaautomata@gmail.com",
  "suhuaiceng@gmail.com"
];

function setNoStoreHeaders(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => normalizeEmail(item))
    .filter(Boolean);
}

function getAllowedAdminEmails() {
  const configured = splitCsv(process.env.ADMIN_ALLOWED_EMAILS || "");
  if (configured.length) return configured;
  return [...DEFAULT_ALLOWED_ADMIN_EMAILS];
}

function getAllowedAdminSet() {
  return new Set(getAllowedAdminEmails());
}

function isAllowedAdminEmail(value) {
  return getAllowedAdminSet().has(normalizeEmail(value));
}

function toBase64Url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64Url(input) {
  const base64 = String(input || "")
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const padding = base64.length % 4;
  const fixed = padding ? base64 + "=".repeat(4 - padding) : base64;
  return Buffer.from(fixed, "base64");
}

function getSessionSecret() {
  return String(process.env.ADMIN_SESSION_SECRET || "").trim();
}

function getSessionTtlSeconds() {
  const parsed = Number.parseInt(String(process.env.ADMIN_SESSION_TTL_SECONDS || ""), 10);
  if (Number.isFinite(parsed) && parsed > 0) return Math.min(parsed, 60 * 60 * 24 * 7);
  return SESSION_TTL_SECONDS_DEFAULT;
}

function shouldUseSecureCookies(req) {
  const nodeEnv = String(process.env.NODE_ENV || "").trim().toLowerCase();
  if (nodeEnv === "production") return true;
  const forwardedProto = String(
    (req && req.headers && req.headers["x-forwarded-proto"]) || ""
  ).toLowerCase();
  return forwardedProto.includes("https");
}

function buildSessionToken(payload, secret) {
  const headerPart = toBase64Url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payloadPart = toBase64Url(JSON.stringify(payload));
  const signingInput = `${headerPart}.${payloadPart}`;
  const signature = toBase64Url(createHmac("sha256", secret).update(signingInput).digest());
  return `${signingInput}.${signature}`;
}

function safeCompare(left, right) {
  const leftBuffer = Buffer.from(String(left || ""));
  const rightBuffer = Buffer.from(String(right || ""));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function verifySessionToken(token, secret) {
  if (!token || !secret) return null;
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;

  const [headerPart, payloadPart, signaturePart] = parts;
  const signingInput = `${headerPart}.${payloadPart}`;
  const expectedSignature = toBase64Url(createHmac("sha256", secret).update(signingInput).digest());
  if (!safeCompare(signaturePart, expectedSignature)) return null;

  try {
    const payload = JSON.parse(fromBase64Url(payloadPart).toString("utf8"));
    const exp = Number(payload && payload.exp ? payload.exp : 0);
    if (!Number.isFinite(exp) || exp <= 0) return null;
    if (exp * 1000 <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const cookieHeader = String((req && req.headers && req.headers.cookie) || "");
  if (!cookieHeader) return {};
  return cookieHeader.split(";").reduce((acc, pair) => {
    const [rawName, ...rest] = pair.split("=");
    const name = String(rawName || "").trim();
    if (!name) return acc;
    acc[name] = decodeURIComponent(rest.join("=").trim());
    return acc;
  }, {});
}

function authorizeWithSession(req) {
  const secret = getSessionSecret();
  if (!secret) return null;

  const cookies = parseCookies(req);
  const token = String(cookies[SESSION_COOKIE_NAME] || "").trim();
  const payload = verifySessionToken(token, secret);
  if (!payload) return null;

  const email = normalizeEmail(payload.email);
  if (!email || !isAllowedAdminEmail(email)) return null;

  return {
    email,
    role: "admin",
    authMethod: "session"
  };
}

function authorizeAdminRequest(req) {
  const sessionUser = authorizeWithSession(req);
  if (sessionUser) return { ok: true, user: sessionUser };
  return { ok: false, user: null };
}

function setSessionCookie(res, req, user) {
  const secret = getSessionSecret();
  if (!secret) return false;

  const nowSeconds = Math.floor(Date.now() / 1000);
  const ttlSeconds = getSessionTtlSeconds();
  const payload = {
    sub: String(user && user.sub ? user.sub : ""),
    email: normalizeEmail(user && user.email),
    role: "admin",
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds
  };

  const token = buildSessionToken(payload, secret);
  const secure = shouldUseSecureCookies(req);
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    `Max-Age=${ttlSeconds}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict"
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
  return true;
}

function clearSessionCookie(res, req) {
  const secure = shouldUseSecureCookies(req);
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    "Max-Age=0",
    "Path=/",
    "HttpOnly",
    "SameSite=Strict"
  ];
  if (secure) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

function getGoogleClientId() {
  return String(process.env.GOOGLE_OAUTH_CLIENT_ID || "").trim();
}

async function verifyGoogleIdToken(idToken) {
  const token = String(idToken || "").trim();
  if (!token) {
    return { ok: false, reason: "missing_token" };
  }

  const googleClientId = getGoogleClientId();
  if (!googleClientId) {
    return { ok: false, reason: "missing_client_id" };
  }

  const requestUrl = `${GOOGLE_TOKENINFO_URL}?id_token=${encodeURIComponent(token)}`;
  let response;
  try {
    response = await fetch(requestUrl, {
      method: "GET",
      headers: { Accept: "application/json" }
    });
  } catch {
    return { ok: false, reason: "google_request_failed" };
  }

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, reason: "invalid_google_token", detail: payload };
  }

  const aud = String(payload.aud || "").trim();
  if (aud !== googleClientId) {
    return { ok: false, reason: "aud_mismatch" };
  }

  const issuer = String(payload.iss || "").trim();
  const validIssuer = issuer === "accounts.google.com" || issuer === "https://accounts.google.com";
  if (!validIssuer) {
    return { ok: false, reason: "issuer_invalid" };
  }

  const email = normalizeEmail(payload.email);
  const emailVerified = String(payload.email_verified || "").toLowerCase() === "true";
  if (!email || !emailVerified) {
    return { ok: false, reason: "email_not_verified" };
  }

  const exp = Number.parseInt(String(payload.exp || "0"), 10);
  if (!Number.isFinite(exp) || exp * 1000 <= Date.now()) {
    return { ok: false, reason: "token_expired" };
  }

  return {
    ok: true,
    user: {
      sub: String(payload.sub || ""),
      email,
      name: String(payload.name || ""),
      picture: String(payload.picture || "")
    }
  };
}

module.exports = {
  setNoStoreHeaders,
  getGoogleClientId,
  getAllowedAdminEmails,
  isAllowedAdminEmail,
  verifyGoogleIdToken,
  setSessionCookie,
  clearSessionCookie,
  authorizeAdminRequest
};
