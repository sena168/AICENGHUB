"use strict";

const fs = require("fs");
const path = require("path");

const ALLOWED_ABILITIES = new Set(["text", "image", "video", "audio", "code", "automation", "learning"]);
const ALLOWED_PRICING_TIERS = new Set(["free", "trial", "paid"]);
const MAX_BACKUPS = 30;

function getConnectionString() {
  const direct = String(process.env.NEON_DATABASE_URL || "").trim();
  if (direct) return direct;
  const fallback = String(process.env.DATABASE_URL || "").trim();
  if (fallback) return fallback;
  return "";
}

function createSqlClient() {
  const connectionString = getConnectionString();
  if (!connectionString) {
    throw new Error("NEON_DATABASE_URL is not configured.");
  }

  let neon;
  try {
    ({ neon } = require("@neondatabase/serverless"));
  } catch {
    throw new Error("Missing dependency: @neondatabase/serverless");
  }
  return neon(connectionString);
}

function normalizeUrl(rawUrl) {
  const candidate = String(rawUrl || "").trim();
  if (!candidate) return "";
  try {
    const parsed = new URL(candidate);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    parsed.hash = "";
    let href = parsed.href;
    if (href.endsWith("/")) href = href.slice(0, -1);
    return href;
  } catch {
    return "";
  }
}

function normalizeAbilities(rawAbilities) {
  if (!Array.isArray(rawAbilities)) return [];
  const deduped = [];
  const seen = new Set();
  for (const rawAbility of rawAbilities) {
    const ability = String(rawAbility || "").trim().toLowerCase();
    if (!ALLOWED_ABILITIES.has(ability)) continue;
    if (seen.has(ability)) continue;
    seen.add(ability);
    deduped.push(ability);
  }
  return deduped;
}

function normalizePricing(rawPricing) {
  const normalized = String(rawPricing || "").trim().toLowerCase().replace(/\s+/g, "-");
  if (["full-free", "totally-free", "gratis"].includes(normalized)) return "free";
  if (["free-trial", "freemium", "uji-coba"].includes(normalized)) return "trial";
  if (["full-paid", "berbayar", "premium"].includes(normalized)) return "paid";
  if (ALLOWED_PRICING_TIERS.has(normalized)) return normalized;
  return "trial";
}

function abilitiesToCsv(rawAbilities) {
  return normalizeAbilities(rawAbilities).join(",");
}

function csvToAbilities(rawCsv) {
  const parts = String(rawCsv || "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return normalizeAbilities(parts);
}

function rowToLink(row) {
  return {
    name: String(row.name || ""),
    url: String(row.url || ""),
    description: String(row.description || ""),
    abilities: csvToAbilities(row.abilities_csv),
    pricing: normalizePricing(row.pricing_tier)
  };
}

async function ensureSchema(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS ai_main_links (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      abilities_csv TEXT NOT NULL DEFAULT '',
      pricing_tier TEXT NOT NULL DEFAULT 'trial',
      source TEXT NOT NULL DEFAULT 'manual',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS ai_candidate_links (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      abilities_csv TEXT NOT NULL DEFAULT '',
      pricing_tier TEXT NOT NULL DEFAULT 'trial',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      discovered_count INTEGER NOT NULL DEFAULT 1,
      discovered_by TEXT NOT NULL DEFAULT 'juleha',
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      merged_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    ALTER TABLE ai_main_links
    ADD COLUMN IF NOT EXISTS pricing_tier TEXT NOT NULL DEFAULT 'trial'
  `;

  await sql`
    ALTER TABLE ai_candidate_links
    ADD COLUMN IF NOT EXISTS pricing_tier TEXT NOT NULL DEFAULT 'trial'
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS ai_link_backups (
      id BIGSERIAL PRIMARY KEY,
      backup_number INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS ai_link_backups_backup_number_idx
    ON ai_link_backups (backup_number)
  `;
}

function readInitialLinkListFromFile() {
  const filePath = path.join(process.cwd(), "public", "link-list.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.map((entry) => ({
    name: String(entry && entry.name ? entry.name : "").trim(),
    url: normalizeUrl(entry && entry.url ? entry.url : ""),
    description: String(entry && entry.description ? entry.description : "").trim(),
    abilities: normalizeAbilities(Array.isArray(entry && entry.abilities) ? entry.abilities : []),
    pricing: normalizePricing(entry && (entry.pricing || entry.pricingTier || entry.priceTier))
  }))
    .filter((entry) => entry.name && entry.url);
}

async function seedMainFromFileIfEmpty(sql) {
  const countRows = await sql`SELECT COUNT(*) AS count FROM ai_main_links`;
  const count = Number(countRows[0] && countRows[0].count ? countRows[0].count : 0);
  if (count > 0) return;

  const initialLinks = readInitialLinkListFromFile();
  for (const link of initialLinks) {
    await sql`
      INSERT INTO ai_main_links (name, url, description, abilities_csv, pricing_tier, source, updated_at)
      VALUES (${link.name}, ${link.url}, ${link.description}, ${abilitiesToCsv(link.abilities)}, ${link.pricing}, 'seed:file', NOW())
      ON CONFLICT (url) DO NOTHING
    `;
  }
}

async function refreshMainPricingTiers(sql) {
  const initialLinks = readInitialLinkListFromFile();
  const pricingByUrl = new Map(initialLinks.map((entry) => [entry.url, entry.pricing]));
  const rows = await sql`SELECT url, pricing_tier FROM ai_main_links`;

  let scannedCount = 0;
  let updatedCount = 0;
  let missingReferenceCount = 0;

  for (const row of rows) {
    const normalizedUrl = normalizeUrl(row.url);
    if (!normalizedUrl) continue;

    scannedCount += 1;
    const expectedPricing = pricingByUrl.get(normalizedUrl);
    if (!expectedPricing) {
      missingReferenceCount += 1;
      continue;
    }

    const currentPricing = normalizePricing(row.pricing_tier);
    if (currentPricing === expectedPricing) continue;

    await sql`
      UPDATE ai_main_links
      SET pricing_tier = ${expectedPricing}
      WHERE url = ${normalizedUrl}
    `;
    updatedCount += 1;
  }

  return {
    scannedCount,
    updatedCount,
    missingReferenceCount,
    sourceCount: pricingByUrl.size
  };
}

async function ensureStoreReady(sql) {
  await ensureSchema(sql);
  await seedMainFromFileIfEmpty(sql);
  await refreshMainPricingTiers(sql);
}

async function getMainLinks(sql) {
  const rows = await sql`
    SELECT name, url, description, abilities_csv, pricing_tier
    FROM ai_main_links
    ORDER BY LOWER(name) ASC
  `;
  return rows.map(rowToLink);
}

async function getMainUrlSet(sql) {
  const rows = await sql`SELECT url FROM ai_main_links`;
  return new Set(rows.map((row) => normalizeUrl(row.url)).filter(Boolean));
}

async function upsertCandidate(sql, candidate) {
  const url = normalizeUrl(candidate && candidate.url ? candidate.url : "");
  if (!url) return { inserted: false };

  const name = String(candidate && candidate.name ? candidate.name : "").trim() || url;
  const description = String(candidate && candidate.description ? candidate.description : "").trim();
  const abilitiesCsv = abilitiesToCsv(Array.isArray(candidate && candidate.abilities) ? candidate.abilities : []);
  const pricingTier = normalizePricing(candidate && (candidate.pricing || candidate.pricingTier || candidate.priceTier));
  const evidenceJson = JSON.stringify(candidate && candidate.evidence ? candidate.evidence : {});
  const discoveredBy = String(candidate && candidate.discoveredBy ? candidate.discoveredBy : "juleha").trim() || "juleha";

  await sql`
    INSERT INTO ai_candidate_links
      (name, url, description, abilities_csv, pricing_tier, evidence_json, status, discovered_count, discovered_by, last_seen_at, updated_at)
    VALUES
      (${name}, ${url}, ${description}, ${abilitiesCsv}, ${pricingTier}, ${evidenceJson}, 'pending', 1, ${discoveredBy}, NOW(), NOW())
    ON CONFLICT (url) DO UPDATE SET
      name = CASE
        WHEN ai_candidate_links.name = '' THEN EXCLUDED.name
        ELSE ai_candidate_links.name
      END,
      description = CASE
        WHEN ai_candidate_links.description = '' THEN EXCLUDED.description
        ELSE ai_candidate_links.description
      END,
      abilities_csv = CASE
        WHEN ai_candidate_links.abilities_csv = '' THEN EXCLUDED.abilities_csv
        ELSE ai_candidate_links.abilities_csv
      END,
      pricing_tier = CASE
        WHEN ai_candidate_links.pricing_tier = '' THEN EXCLUDED.pricing_tier
        ELSE ai_candidate_links.pricing_tier
      END,
      evidence_json = EXCLUDED.evidence_json,
      status = CASE
        WHEN ai_candidate_links.status = 'pending' THEN ai_candidate_links.status
        ELSE 'pending'
      END,
      discovered_count = ai_candidate_links.discovered_count + 1,
      discovered_by = EXCLUDED.discovered_by,
      last_seen_at = NOW(),
      updated_at = NOW()
  `;

  return { inserted: true };
}

async function createRollingBackup(sql, links) {
  const maxRows = await sql`SELECT COALESCE(MAX(backup_number), 0) AS max_number FROM ai_link_backups`;
  const maxNumber = Number(maxRows[0] && maxRows[0].max_number ? maxRows[0].max_number : 0);
  const backupNumber = (maxNumber % MAX_BACKUPS) + 1;
  const snapshot = JSON.stringify(links);

  await sql`DELETE FROM ai_link_backups WHERE backup_number = ${backupNumber}`;
  await sql`
    INSERT INTO ai_link_backups (backup_number, snapshot_json, created_at)
    VALUES (${backupNumber}, ${snapshot}, NOW())
  `;

  return { backupNumber, backupFileName: `backup-link-list${backupNumber}.json` };
}

async function mergePendingCandidates(sql) {
  const currentLinks = await getMainLinks(sql);
  const backup = await createRollingBackup(sql, currentLinks);
  const mainUrlSet = new Set(currentLinks.map((link) => normalizeUrl(link.url)).filter(Boolean));

  const pending = await sql`
    SELECT id, name, url, description, abilities_csv, pricing_tier
    FROM ai_candidate_links
    WHERE status = 'pending'
    ORDER BY created_at ASC
  `;

  let mergedCount = 0;
  let skippedExistingCount = 0;

  for (const row of pending) {
    const normalizedUrl = normalizeUrl(row.url);
    if (!normalizedUrl) {
      await sql`
        UPDATE ai_candidate_links
        SET status = 'rejected', updated_at = NOW()
        WHERE id = ${row.id}
      `;
      continue;
    }

    if (mainUrlSet.has(normalizedUrl)) {
      skippedExistingCount += 1;
      await sql`
        UPDATE ai_candidate_links
        SET status = 'merged', merged_at = NOW(), updated_at = NOW()
        WHERE id = ${row.id}
      `;
      continue;
    }

    await sql`
      INSERT INTO ai_main_links (name, url, description, abilities_csv, pricing_tier, source, updated_at)
      VALUES (
        ${String(row.name || "").trim() || normalizedUrl},
        ${normalizedUrl},
        ${String(row.description || "").trim()},
        ${String(row.abilities_csv || "").trim()},
        ${normalizePricing(row.pricing_tier)},
        'candidate-merge',
        NOW()
      )
      ON CONFLICT (url) DO NOTHING
    `;

    mainUrlSet.add(normalizedUrl);
    mergedCount += 1;

    await sql`
      UPDATE ai_candidate_links
      SET status = 'merged', merged_at = NOW(), updated_at = NOW()
      WHERE id = ${row.id}
    `;
  }

  const refreshedLinks = await getMainLinks(sql);
  return {
    backup,
    mergedCount,
    skippedExistingCount,
    pendingCount: pending.length,
    totalLinks: refreshedLinks.length
  };
}

module.exports = {
  createSqlClient,
  normalizeUrl,
  normalizeAbilities,
  normalizePricing,
  abilitiesToCsv,
  csvToAbilities,
  ensureStoreReady,
  refreshMainPricingTiers,
  getMainLinks,
  getMainUrlSet,
  upsertCandidate,
  mergePendingCandidates
};
