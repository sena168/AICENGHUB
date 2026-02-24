"use strict";

const {
  createSqlClient,
  ensureStoreReady,
  csvToAbilities,
  csvToTags,
  normalizePricing
} = require("./_link-store");
const { setNoStoreHeaders, authorizeAdminRequest } = require("./_admin-auth");

function parsePaging(req) {
  let limit = 40;
  let offset = 0;

  try {
    const requestUrl = new URL(String(req && req.url ? req.url : "/"), "http://localhost");
    const limitRaw = Number.parseInt(String(requestUrl.searchParams.get("limit") || "40"), 10);
    const offsetRaw = Number.parseInt(String(requestUrl.searchParams.get("offset") || "0"), 10);
    if (Number.isFinite(limitRaw)) limit = Math.min(100, Math.max(1, limitRaw));
    if (Number.isFinite(offsetRaw)) offset = Math.max(0, offsetRaw);
  } catch {}

  return { limit, offset };
}

module.exports = async function handler(req, res) {
  setNoStoreHeaders(res);

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed." });
  }

  if (!authorizeAdminRequest(req).ok) {
    return res.status(401).json({ error: "Unauthorized." });
  }

  try {
    const sql = createSqlClient();
    await ensureStoreReady(sql);
    const { limit, offset } = parsePaging(req);
    const countRows = await sql`SELECT COUNT(*)::INT AS count FROM ai_candidate_links`;
    const total = Number(countRows[0] && countRows[0].count ? countRows[0].count : 0);
    const rows = await sql`
      SELECT id, name, url, description, abilities_csv, pricing_tier, tags_csv, status, discovered_count, created_at, updated_at
      FROM ai_candidate_links
      ORDER BY created_at DESC, id DESC
      LIMIT ${limit}
      OFFSET ${offset}
    `;

    const payload = rows.map((row) => ({
      id: row.id,
      name: String(row.name || ""),
      url: String(row.url || ""),
      description: String(row.description || ""),
      abilities: csvToAbilities(row.abilities_csv),
      pricing: normalizePricing(row.pricing_tier),
      tags: csvToTags(row.tags_csv),
      status: String(row.status || ""),
      discoveredCount: Number(row.discovered_count || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));

    const nextOffset = offset + payload.length;
    const hasMore = nextOffset < total;
    return res.status(200).json({
      items: payload,
      paging: {
        limit,
        offset,
        nextOffset,
        total,
        hasMore
      }
    });
  } catch (error) {
    console.error("candidate-link-list failure", {
      error: error instanceof Error ? error.message : String(error)
    });
    return res.status(500).json({ error: "Unable to load candidate link list." });
  }
};
