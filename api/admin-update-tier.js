"use strict";

const {
  createSqlClient,
  ensureStoreReady,
  refreshMainPricingTiers,
  getMainLinks
} = require("./_link-store");

function setHeaders(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function readAdminToken(req) {
  const headerToken = String((req && req.headers && req.headers["x-admin-token"]) || "").trim();
  if (headerToken) return headerToken;
  if (req && typeof req.body === "object" && req.body !== null) {
    const bodyToken = String(req.body.adminToken || "").trim();
    if (bodyToken) return bodyToken;
  }
  return "";
}

function isAuthorized(req) {
  const expected = String(process.env.JULEHA_ADMIN_TOKEN || "").trim();
  if (!expected) return false;
  const received = readAdminToken(req);
  return Boolean(received) && received === expected;
}

module.exports = async function handler(req, res) {
  setHeaders(res);

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  try {
    const sql = createSqlClient();
    await ensureStoreReady(sql);
    const result = await refreshMainPricingTiers(sql);
    const links = await getMainLinks(sql);

    return res.status(200).json({
      ok: true,
      scannedCount: result.scannedCount,
      updatedCount: result.updatedCount,
      insertedCount: result.insertedCount || 0,
      missingReferenceCount: result.missingReferenceCount,
      sourceCount: result.sourceCount,
      totalLinks: links.length
    });
  } catch (error) {
    console.error("admin-update-tier failure", {
      error: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json({ error: "Tier update failed." });
  }
};
