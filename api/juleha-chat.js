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

  let totalChars = 0;
  const bounded = [];
  for (const entry of sanitized) {
    if (totalChars + entry.content.length > MAX_TOTAL_CHARS) break;
    bounded.push(entry);
    totalChars += entry.content.length;
  }
  return bounded;
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

  const routes = readRouteConfigFromEnv();
  if (!routes.length) {
    return res.status(500).json({ error: "No OpenRouter API keys configured in environment." });
  }

  const routeErrors = [];
  for (const route of routes) {
    try {
      const result = await requestWithRoute(route, messages, req);
      return res.status(200).json(result);
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
