"use strict";

const {
  createSqlClient,
  ensureStoreReady,
  mergePendingCandidates
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
    const result = await mergePendingCandidates(sql);

    return res.status(200).json({
      ok: true,
      backupFileName: result.backup.backupFileName,
      backupNumber: result.backup.backupNumber,
      pendingCount: result.pendingCount,
      mergedCount: result.mergedCount,
      skippedExistingCount: result.skippedExistingCount,
      totalLinks: result.totalLinks
    });
  } catch (error) {
    console.error("admin-update-list failure", {
      error: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json({ error: "List update failed." });
  }
};
