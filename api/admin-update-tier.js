"use strict";

const {
  createSqlClient,
  ensureStoreReady,
  refreshMainPricingTiers,
  getMainLinks
} = require("./_link-store");
const { setNoStoreHeaders, authorizeAdminRequest } = require("./_admin-auth");

module.exports = async function handler(req, res) {
  setNoStoreHeaders(res);

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Method not allowed." });
  }

  if (!authorizeAdminRequest(req).ok) {
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
