"use strict";

const DEFAULT_TOOLS_TIMEOUT_MS = 6000;

function readToolsConfig() {
  const baseUrl = String(process.env.TOOLS_BASE_URL || "").trim().replace(/\/+$/, "");
  const apiKey = String(process.env.TOOLS_API_KEY || "").trim();
  const parsedTimeout = Number.parseInt(String(process.env.TOOLS_TIMEOUT_MS || ""), 10);
  const timeoutMs = Number.isFinite(parsedTimeout) && parsedTimeout > 0
    ? parsedTimeout
    : DEFAULT_TOOLS_TIMEOUT_MS;

  return {
    baseUrl,
    apiKey,
    timeoutMs: Math.min(20_000, Math.max(1_000, timeoutMs))
  };
}

async function toolsRequest(path, init) {
  const { baseUrl, apiKey, timeoutMs } = readToolsConfig();
  if (!baseUrl || !apiKey) {
    return { ok: false, error: "tools-not-configured" };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    ...(init && init.body ? { "Content-Type": "application/json" } : {})
  };

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: init && init.method ? init.method : "GET",
      headers,
      body: init && init.body ? JSON.stringify(init.body) : undefined,
      signal: controller.signal
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const errorMessage = payload && payload.error
        ? String(payload.error)
        : `tools-http-${response.status}`;
      return { ok: false, error: errorMessage };
    }

    return { ok: true, data: payload };
  } catch (error) {
    if (error && typeof error === "object" && error.name === "AbortError") {
      return { ok: false, error: "tools-timeout" };
    }
    return { ok: false, error: error instanceof Error ? error.message : "tools-request-failed" };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function toolsHealth() {
  return toolsRequest("/health", { method: "GET" });
}

async function toolsEnrich(url, mode) {
  return toolsRequest("/enrich", {
    method: "POST",
    body: {
      url: String(url || "").trim(),
      mode: String(mode || "enrich").trim() || "enrich"
    }
  });
}

async function toolsSearch(query) {
  return toolsRequest("/search", {
    method: "POST",
    body: {
      query: String(query || "").trim()
    }
  });
}

module.exports = {
  toolsHealth,
  toolsEnrich,
  toolsSearch,
  _internals: {
    readToolsConfig
  }
};

