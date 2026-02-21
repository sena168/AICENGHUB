"use strict";

const {
  createSqlClient,
  ensureStoreReady,
  getMainLinks
} = require("./_link-store");

function setHeaders(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

module.exports = async function handler(req, res) {
  setHeaders(res);

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }

  try {
    const sql = createSqlClient();
    await ensureStoreReady(sql);
    const links = await getMainLinks(sql);
    return res.status(200).json(links);
  } catch (error) {
    console.error("link-list api failure", {
      error: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json({ error: "Unable to load link list from database." });
  }
};
