"use strict";

const buckets = new Map();

function nowMs() {
  return Date.now();
}

function cleanupExpired(maxEntries) {
  if (buckets.size <= maxEntries) return;
  const now = nowMs();
  for (const [key, value] of buckets.entries()) {
    if (!value || value.resetAt <= now) {
      buckets.delete(key);
    }
  }
}

function consumeRateLimit(options) {
  const key = String(options && options.key ? options.key : "").trim();
  const limit = Number(options && options.limit ? options.limit : 0);
  const windowMs = Number(options && options.windowMs ? options.windowMs : 0);
  const weight = Math.max(1, Number(options && options.weight ? options.weight : 1));

  if (!key || !Number.isFinite(limit) || !Number.isFinite(windowMs) || limit <= 0 || windowMs <= 0) {
    return {
      allowed: true,
      remaining: limit,
      retryAfterSec: 0,
      resetAt: nowMs()
    };
  }

  cleanupExpired(8000);

  const now = nowMs();
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }

  if (bucket.count + weight > limit) {
    return {
      allowed: false,
      remaining: Math.max(0, limit - bucket.count),
      retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      resetAt: bucket.resetAt
    };
  }

  bucket.count += weight;
  return {
    allowed: true,
    remaining: Math.max(0, limit - bucket.count),
    retryAfterSec: 0,
    resetAt: bucket.resetAt
  };
}

function resetRateLimits() {
  buckets.clear();
}

module.exports = {
  consumeRateLimit,
  resetRateLimits
};

