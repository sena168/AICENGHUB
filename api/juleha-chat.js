"use strict";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

const DEFAULT_ROUTE_CONFIG = [
  {
    label: "GLM 4.5 Air (primary)",
    model: "z-ai/glm-4.5-air:free",
    apiKeyEnv: "OPENROUTER_API_KEY_PRIMARY",
    modelEnv: "OPENROUTER_MODEL_PRIMARY",
    labelEnv: "OPENROUTER_LABEL_PRIMARY"
  },
  {
    label: "Qwen 3 VL Thinking (backup)",
    model: "qwen/qwen3-vl-235b-a22b-thinking",
    apiKeyEnv: "OPENROUTER_API_KEY_SECONDARY",
    modelEnv: "OPENROUTER_MODEL_SECONDARY",
    labelEnv: "OPENROUTER_LABEL_SECONDARY"
  },
  {
    label: "Step 3.5 Flash (backup)",
    model: "stepfun/step-3.5-flash:free",
    apiKeyEnv: "OPENROUTER_API_KEY_TERTIARY",
    modelEnv: "OPENROUTER_MODEL_TERTIARY",
    labelEnv: "OPENROUTER_LABEL_TERTIARY"
  }
];

const ALLOWED_ROLES = new Set(["system", "user", "assistant"]);
const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 3000;
const MAX_TOTAL_CHARS = 12000;
const REQUEST_TIMEOUT_MS = 30000;
const LINK_VERIFY_MAX_LINKS = 6;
const LINK_VERIFY_TIMEOUT_MS = 6000;
const LINK_VERIFY_TITLE_CHARS = 120;

function readRouteConfigFromEnv() {
  return DEFAULT_ROUTE_CONFIG
    .map((route) => {
      const apiKey = String(process.env[route.apiKeyEnv] || "").trim();
      const model = String(process.env[route.modelEnv] || route.model).trim();
      const label = String(process.env[route.labelEnv] || route.label).trim();
      return { label, model, apiKey };
    })
    .filter((route) => route.apiKey && route.model);
}

function normalizeBody(req) {
  if (req && typeof req.body === "object" && req.body !== null) return req.body;
  if (typeof req.body === "string") {
    try {
      return JSON.parse(req.body);
    } catch {
      return {};
    }
  }
  return {};
}

function sanitizeMessages(rawMessages) {
  if (!Array.isArray(rawMessages)) return [];
  const sanitized = rawMessages
    .slice(-MAX_MESSAGES)
    .map((entry) => ({
      role: String(entry && entry.role ? entry.role : "").trim(),
      content: String(entry && entry.content ? entry.content : "").trim().slice(0, MAX_MESSAGE_CHARS)
    }))
    .filter((entry) => ALLOWED_ROLES.has(entry.role) && entry.content.length > 0);

  const systemMessages = sanitized.filter((entry) => entry.role === "system");
  const conversationMessages = sanitized.filter((entry) => entry.role !== "system");

  let totalChars = 0;
  const boundedSystems = [];
  for (const entry of systemMessages) {
    if (totalChars + entry.content.length > MAX_TOTAL_CHARS) break;
    boundedSystems.push(entry);
    totalChars += entry.content.length;
  }

  const boundedConversationReversed = [];
  for (let index = conversationMessages.length - 1; index >= 0; index -= 1) {
    const entry = conversationMessages[index];
    if (totalChars + entry.content.length > MAX_TOTAL_CHARS) break;
    boundedConversationReversed.push(entry);
    totalChars += entry.content.length;
  }

  const boundedConversation = boundedConversationReversed.reverse();
  return [...boundedSystems, ...boundedConversation];
}

function extractAssistantText(rawContent) {
  if (typeof rawContent === "string") return rawContent.trim();
  if (!Array.isArray(rawContent)) return "";
  const textParts = rawContent
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part.text === "string") return part.text;
      return "";
    })
    .filter(Boolean);
  return textParts.join("\n").trim();
}

function parseOpenRouterError(response, payload) {
  const apiMessage = payload && payload.error && payload.error.message
    ? String(payload.error.message)
    : "";
  if (apiMessage) return apiMessage;
  if (response.status === 401) return "invalid key or unauthorized model";
  if (response.status === 402) return "insufficient credits for this model/key";
  if (response.status === 429) return "rate limited";
  return `HTTP ${response.status}`;
}

function shouldVerifyLinks() {
  const raw = String(process.env.JULEHA_VERIFY_LINKS || "1").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(raw);
}

function extractUrlsFromText(text) {
  const source = String(text || "");
  const matches = source.match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
  const unique = [];
  const seen = new Set();

  for (const rawMatch of matches) {
    const match = String(rawMatch || "").replace(/[.,!?;:]+$/g, "");
    if (!match) continue;
    try {
      const parsed = new URL(match);
      if (!["http:", "https:"].includes(parsed.protocol)) continue;
      const normalized = parsed.href;
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      unique.push(normalized);
      if (unique.length >= LINK_VERIFY_MAX_LINKS) break;
    } catch {
      continue;
    }
  }

  return unique;
}

function isPrivateIpV4(hostname) {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return false;
  const octets = hostname.split(".").map((value) => Number(value));
  if (octets.some((value) => value < 0 || value > 255)) return false;

  const [a, b] = octets;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function isBlockedHostname(hostname) {
  const value = String(hostname || "").trim().toLowerCase();
  if (!value) return true;
  if (value === "localhost") return true;
  if (value === "::1") return true;
  if (value.endsWith(".local")) return true;
  if (isPrivateIpV4(value)) return true;
  return false;
}

function extractHtmlTitle(html) {
  const source = String(html || "");
  const match = source.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return "";
  return String(match[1] || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, LINK_VERIFY_TITLE_CHARS);
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal, redirect: "follow" });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function verifySingleUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { url, ok: false, status: 0, note: "invalid-url" };
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    return { url, ok: false, status: 0, note: "unsupported-protocol" };
  }

  if (isBlockedHostname(parsed.hostname)) {
    return { url, ok: false, status: 0, note: "blocked-host" };
  }

  try {
    const headResponse = await fetchWithTimeout(url, { method: "HEAD" }, LINK_VERIFY_TIMEOUT_MS);
    if (headResponse.ok) {
      return {
        url,
        ok: true,
        status: headResponse.status,
        finalUrl: headResponse.url || url
      };
    }
  } catch {}

  try {
    const getResponse = await fetchWithTimeout(
      url,
      {
        method: "GET",
        headers: {
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8"
        }
      },
      LINK_VERIFY_TIMEOUT_MS
    );

    const contentType = String(getResponse.headers.get("content-type") || "").toLowerCase();
    const canReadBody = contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
    const bodyText = canReadBody ? await getResponse.text().catch(() => "") : "";

    return {
      url,
      ok: getResponse.ok,
      status: getResponse.status,
      finalUrl: getResponse.url || url,
      title: canReadBody ? extractHtmlTitle(bodyText) : ""
    };
  } catch (error) {
    return {
      url,
      ok: false,
      status: 0,
      note: error instanceof Error ? error.message : "verify-failed"
    };
  }
}

async function verifyAssistantLinks(text) {
  if (!shouldVerifyLinks()) return [];
  const urls = extractUrlsFromText(text);
  if (!urls.length) return [];
  return Promise.all(urls.map((url) => verifySingleUrl(url)));
}

async function requestWithRoute(route, messages, req) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const referer = String(process.env.OPENROUTER_HTTP_REFERER || "https://aicenghub.vercel.app").trim();
  const title = String(process.env.OPENROUTER_APP_TITLE || "AICENGHUB").trim();

  try {
    const response = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${route.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": referer,
        "X-Title": title
      },
      body: JSON.stringify({
        model: route.model,
        messages
      }),
      signal: controller.signal
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(parseOpenRouterError(response, payload));
    }

    const assistantContent = payload
      && Array.isArray(payload.choices)
      && payload.choices[0]
      && payload.choices[0].message
      ? payload.choices[0].message.content
      : "";

    const assistantText = extractAssistantText(assistantContent);
    if (!assistantText) {
      throw new Error("OpenRouter returned an empty response.");
    }

    return { assistantText, routeLabel: route.label };
  } finally {
    clearTimeout(timeoutId);
  }
}

function setResponseSecurityHeaders(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function parseAllowedOrigins() {
  const raw = String(process.env.JULEHA_ALLOWED_ORIGINS || "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function requestOrigin(req) {
  return String((req && req.headers && req.headers.origin) || "").trim();
}

function defaultAllowedOrigin(req) {
  const host = String((req && req.headers && req.headers.host) || "").trim();
  return host ? `https://${host}` : "";
}

function isOriginAllowed(req) {
  const origin = requestOrigin(req);
  if (!origin) return true;

  const configuredOrigins = parseAllowedOrigins();
  if (configuredOrigins.length) {
    return configuredOrigins.includes(origin);
  }

  return origin === defaultAllowedOrigin(req);
}

module.exports = async function handler(req, res) {
  setResponseSecurityHeaders(res);

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  if (!isOriginAllowed(req)) {
    return res.status(403).json({ error: "Origin not allowed." });
  }

  const body = normalizeBody(req);
  const messages = sanitizeMessages(body.messages);
  if (!messages.length) {
    return res.status(400).json({ error: "Invalid or empty messages payload." });
  }
  if (!messages.some((entry) => entry.role === "user")) {
    return res.status(400).json({ error: "No user message in payload." });
  }

  const routes = readRouteConfigFromEnv();
  if (!routes.length) {
    return res.status(500).json({ error: "No OpenRouter API keys configured in environment." });
  }

  const routeErrors = [];
  for (const route of routes) {
    try {
      const result = await requestWithRoute(route, messages, req);
      const verifiedLinks = await verifyAssistantLinks(result.assistantText).catch(() => []);
      return res.status(200).json({ ...result, verifiedLinks });
    } catch (error) {
      routeErrors.push({
        route: route.label,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  console.error("Juleha route failure", {
    routeErrors,
    requestId: req && req.headers ? req.headers["x-vercel-id"] : ""
  });
  return res.status(502).json({ error: "AI service unavailable right now." });
};
