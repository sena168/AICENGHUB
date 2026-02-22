"use strict";

const {
  createSqlClient,
  ensureStoreReady,
  csvToAbilities,
  normalizePricing
} = require("./_link-store");

function setHeaders(res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, private");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function readAdminToken(req) {
  return String((req && req.headers && req.headers["x-admin-token"]) || "").trim();
}

function isAuthorized(req) {
  const expected = String(process.env.JULEHA_ADMIN_TOKEN || "").trim();
  if (!expected) return false;
  return readAdminToken(req) === expected;
}

module.exports = async function handler(req, res) {
  setHeaders(res);

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }

  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  try {
    const sql = createSqlClient();
    await ensureStoreReady(sql);
    const rows = await sql`
      SELECT id, name, url, description, abilities_csv, pricing_tier, status, discovered_count, created_at, updated_at
      FROM ai_candidate_links
      ORDER BY created_at DESC
      LIMIT 500
    `;

    const payload = rows.map((row) => ({
      id: row.id,
      name: String(row.name || ""),
      url: String(row.url || ""),
      description: String(row.description || ""),
      abilities: csvToAbilities(row.abilities_csv),
      pricing: normalizePricing(row.pricing_tier),
      status: String(row.status || ""),
      discoveredCount: Number(row.discovered_count || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));

    return res.status(200).json(payload);
  } catch (error) {
    console.error("candidate-link-list failure", {
      error: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json({ error: "Unable to load candidate link list." });
  }
};
