"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  safeFetch,
  normalizeTargetUrl,
  isPrivateOrLocalIp,
  isBlockedHostname
} = require("../api/_safe-fetch");

test("blocks private IPv4 and IPv6 ranges", () => {
  assert.equal(isPrivateOrLocalIp("127.0.0.1"), true);
  assert.equal(isPrivateOrLocalIp("10.1.2.3"), true);
  assert.equal(isPrivateOrLocalIp("192.168.1.8"), true);
  assert.equal(isPrivateOrLocalIp("169.254.169.254"), true);
  assert.equal(isPrivateOrLocalIp("::1"), true);
  assert.equal(isPrivateOrLocalIp("fd00::1234"), true);
  assert.equal(isPrivateOrLocalIp("fe80::1"), true);
  assert.equal(isPrivateOrLocalIp("8.8.8.8"), false);
});

test("blocks localhost style hostnames", () => {
  assert.equal(isBlockedHostname("localhost"), true);
  assert.equal(isBlockedHostname("service.local"), true);
  assert.equal(isBlockedHostname("example.com"), false);
});

test("normalizes and strips URL credentials", () => {
  const parsed = normalizeTargetUrl("https://user:pass@example.com/path?q=1#frag");
  assert.equal(parsed.username, "");
  assert.equal(parsed.password, "");
  assert.equal(parsed.hash, "");
  assert.equal(parsed.href, "https://example.com/path?q=1");
});

test("rejects unsupported protocol", async () => {
  await assert.rejects(
    () => safeFetch("ftp://example.com/file.txt", { resolveDns: async () => [{ address: "93.184.216.34" }] }),
    /unsupported-protocol/
  );
});

test("blocks redirect to private target", async () => {
  const fetchImpl = async () => new Response("", {
    status: 302,
    headers: { Location: "https://127.0.0.1/internal" }
  });

  await assert.rejects(
    () => safeFetch("https://example.com/start", {
      fetchImpl,
      resolveDns: async () => [{ address: "93.184.216.34" }]
    }),
    /(blocked-hostname|blocked-ip|blocked-resolved-ip)/
  );
});

test("handles punycode domains without throwing", () => {
  const parsed = normalizeTargetUrl("https://xn--e1afmkfd.xn--p1ai/");
  assert.equal(parsed.protocol, "https:");
  assert.equal(parsed.hostname.includes("xn--"), true);
});

test("rejects giant responses over max bytes", async () => {
  const giantText = "a".repeat(1_200_000);
  const fetchImpl = async () => new Response(giantText, {
    status: 200,
    headers: { "Content-Type": "text/plain" }
  });

  await assert.rejects(
    () => safeFetch("https://example.com/huge", {
      fetchImpl,
      resolveDns: async () => [{ address: "93.184.216.34" }],
      maxBytes: 1_000_000
    }),
    /response-too-large/
  );
});

