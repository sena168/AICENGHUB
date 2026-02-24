"use strict";

const dns = require("node:dns").promises;
const net = require("node:net");

const DEFAULT_ALLOWED_PORTS = new Set([80, 443, 8080]);
const DEFAULT_ALLOWED_CONTENT_TYPES = new Set(["text/html", "text/plain", "application/json"]);
const BLOCKED_METADATA_IPS = new Set(["169.254.169.254", "169.254.170.2", "100.100.100.200"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function normalizeTargetUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || "").trim());
  } catch {
    throw new Error("invalid-url");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("unsupported-protocol");
  }

  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";

  if (!parsed.hostname) {
    throw new Error("missing-hostname");
  }

  return parsed;
}

function parseIpv4(input) {
  const value = String(input || "").trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) return null;
  const octets = value.split(".").map((part) => Number(part));
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return octets;
}

function isPrivateOrLocalIpv4(address) {
  const octets = parseIpv4(address);
  if (!octets) return false;
  const [a, b] = octets;
  if (a === 127) return true;
  if (a === 10) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  return false;
}

function ipv4ToIpv6Hextets(address) {
  const octets = parseIpv4(address);
  if (!octets) return null;
  const high = (octets[0] << 8) + octets[1];
  const low = (octets[2] << 8) + octets[3];
  return [high.toString(16), low.toString(16)];
}

function expandIpv6(address) {
  let source = String(address || "").trim().toLowerCase();
  if (!source) return null;
  if (source.startsWith("[") && source.endsWith("]")) {
    source = source.slice(1, -1);
  }
  const zoneIndex = source.indexOf("%");
  if (zoneIndex >= 0) source = source.slice(0, zoneIndex);

  if (source.includes(".")) {
    const lastColon = source.lastIndexOf(":");
    if (lastColon < 0) return null;
    const v4Part = source.slice(lastColon + 1);
    const mapped = ipv4ToIpv6Hextets(v4Part);
    if (!mapped) return null;
    source = `${source.slice(0, lastColon)}:${mapped[0]}:${mapped[1]}`;
  }

  const split = source.split("::");
  if (split.length > 2) return null;
  const left = split[0] ? split[0].split(":").filter(Boolean) : [];
  const right = split.length === 2 && split[1] ? split[1].split(":").filter(Boolean) : [];
  const missing = 8 - (left.length + right.length);

  if (split.length === 1 && missing !== 0) return null;
  if (missing < 0) return null;

  const parts = [...left, ...new Array(missing).fill("0"), ...right];
  if (parts.length !== 8) return null;

  const normalized = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    normalized.push(part.padStart(4, "0"));
  }

  return normalized;
}

function isPrivateOrLocalIpv6(address) {
  const parts = expandIpv6(address);
  if (!parts) return false;
  const first = parseInt(parts[0], 16);
  const second = parseInt(parts[1], 16);
  const allZero = parts.every((part) => part === "0000");

  if (allZero) return true; // ::
  if (parts.slice(0, 7).every((part) => part === "0000") && parts[7] === "0001") return true; // ::1
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10
  if (first === 0 && second === 0xffff) {
    const ipv4 = `${parseInt(parts[6], 16) >> 8}.${parseInt(parts[6], 16) & 255}.${parseInt(parts[7], 16) >> 8}.${parseInt(parts[7], 16) & 255}`;
    return isPrivateOrLocalIpv4(ipv4);
  }
  return false;
}

function isPrivateOrLocalIp(address) {
  const value = String(address || "").trim();
  if (!value) return true;
  if (BLOCKED_METADATA_IPS.has(value)) return true;
  if (isPrivateOrLocalIpv4(value)) return true;
  if (isPrivateOrLocalIpv6(value)) return true;
  return false;
}

function isBlockedHostname(hostname) {
  const value = String(hostname || "").trim().toLowerCase();
  if (!value) return true;
  if (value === "localhost") return true;
  if (value.endsWith(".local")) return true;
  if (value === "::1") return true;
  if (isPrivateOrLocalIp(value)) return true;
  return false;
}

function effectivePort(parsedUrl) {
  if (parsedUrl.port) return Number(parsedUrl.port);
  if (parsedUrl.protocol === "http:") return 80;
  if (parsedUrl.protocol === "https:") return 443;
  return 0;
}

function assertAllowedPort(parsedUrl, allowedPorts) {
  const port = effectivePort(parsedUrl);
  if (!allowedPorts.has(port)) {
    throw new Error("blocked-port");
  }
}

async function defaultResolveDns(hostname) {
  return dns.lookup(hostname, { all: true, verbatim: true });
}

async function assertResolvablePublicHost(parsedUrl, resolveDns) {
  const hostname = String(parsedUrl.hostname || "").trim();
  if (isBlockedHostname(hostname)) {
    throw new Error("blocked-hostname");
  }

  if (net.isIP(hostname)) {
    if (isPrivateOrLocalIp(hostname)) {
      throw new Error("blocked-ip");
    }
    return;
  }

  const records = await resolveDns(hostname);
  if (!Array.isArray(records) || !records.length) {
    throw new Error("dns-no-records");
  }

  for (const record of records) {
    const address = String(record && record.address ? record.address : "").trim();
    if (!address) continue;
    if (isPrivateOrLocalIp(address)) {
      throw new Error("blocked-resolved-ip");
    }
  }
}

function sanitizeOutboundHeaders(rawHeaders) {
  const cleaned = {};
  if (!rawHeaders || typeof rawHeaders !== "object") return cleaned;

  for (const [key, value] of Object.entries(rawHeaders)) {
    const lower = String(key || "").toLowerCase();
    if (["cookie", "set-cookie", "authorization", "proxy-authorization"].includes(lower)) continue;
    cleaned[key] = value;
  }

  return cleaned;
}

function parseContentType(value) {
  return String(value || "").split(";")[0].trim().toLowerCase();
}

async function readBodyWithLimit(response, maxBytes) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text().catch(() => "");
    const size = Buffer.byteLength(text, "utf8");
    if (size > maxBytes) {
      throw new Error("response-too-large");
    }
    return Buffer.from(text, "utf8");
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const next = await reader.read();
    if (next.done) break;
    const chunk = Buffer.from(next.value);
    total += chunk.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error("response-too-large");
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks, total);
}

async function fetchWithTimeout(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function safeFetch(rawUrl, options) {
  const config = options && typeof options === "object" ? options : {};
  const fetchImpl = typeof config.fetchImpl === "function" ? config.fetchImpl : fetch;
  const method = String(config.method || "GET").toUpperCase();
  const resolveDns = typeof config.resolveDns === "function" ? config.resolveDns : defaultResolveDns;
  const maxRedirects = Math.max(0, Math.min(6, Number(config.maxRedirects || 4)));
  const maxBytes = Math.max(1024, Number(config.maxBytes || 1_000_000));
  const totalTimeoutMs = Math.max(1000, Number(config.totalTimeoutMs || 7000));
  const hopTimeoutMs = Math.max(500, Number(config.hopTimeoutMs || 4000));
  const allowedPorts = config.allowedPorts instanceof Set ? config.allowedPorts : DEFAULT_ALLOWED_PORTS;
  const allowedContentTypes = config.allowedContentTypes instanceof Set
    ? config.allowedContentTypes
    : DEFAULT_ALLOWED_CONTENT_TYPES;
  const headers = sanitizeOutboundHeaders(config.headers);

  const startedAt = Date.now();
  const redirects = [];
  let current = normalizeTargetUrl(rawUrl);
  let currentMethod = method;
  let redirectCount = 0;

  while (true) {
    assertAllowedPort(current, allowedPorts);
    await assertResolvablePublicHost(current, resolveDns);

    const elapsed = Date.now() - startedAt;
    const remaining = totalTimeoutMs - elapsed;
    if (remaining <= 0) {
      throw new Error("timeout-total");
    }

    const response = await fetchWithTimeout(
      fetchImpl,
      current.href,
      {
        method: currentMethod,
        redirect: "manual",
        headers,
        cache: "no-store"
      },
      Math.min(hopTimeoutMs, remaining)
    );

    const status = Number(response.status || 0);
    const contentType = parseContentType(response.headers.get("content-type"));
    const isRedirect = REDIRECT_STATUSES.has(status);

    if (isRedirect) {
      const location = String(response.headers.get("location") || "").trim();
      if (!location) {
        throw new Error("redirect-missing-location");
      }
      if (redirectCount >= maxRedirects) {
        throw new Error("redirect-limit-exceeded");
      }

      const next = normalizeTargetUrl(new URL(location, current.href).href);
      if (next.protocol !== current.protocol) {
        throw new Error("redirect-cross-protocol-blocked");
      }

      redirects.push(next.href);
      current = next;
      redirectCount += 1;

      if (status === 303 && currentMethod !== "HEAD") {
        currentMethod = "GET";
      }
      continue;
    }

    let bodyText = "";
    if (currentMethod !== "HEAD") {
      if (!allowedContentTypes.has(contentType)) {
        throw new Error("disallowed-content-type");
      }
      const bodyBuffer = await readBodyWithLimit(response, maxBytes);
      bodyText = bodyBuffer.toString("utf8");
    }

    return {
      ok: response.ok,
      status,
      finalUrl: current.href,
      contentType,
      bodyText,
      redirects
    };
  }
}

module.exports = {
  safeFetch,
  normalizeTargetUrl,
  isPrivateOrLocalIp,
  isBlockedHostname
};

