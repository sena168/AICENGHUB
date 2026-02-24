"use strict";

const ALLOWED_ABILITIES = new Set(["text", "image", "video", "audio", "code", "automation", "learning"]);
const ALLOWED_PRICING_TIERS = new Set(["free", "trial", "paid"]);
const ALLOWED_TOOL_TAGS = new Set(["watermarked"]);
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

function normalizeTags(rawTags) {
  if (!Array.isArray(rawTags)) return [];
  const deduped = [];
  const seen = new Set();
  for (const rawTag of rawTags) {
    const tag = String(rawTag || "").trim().toLowerCase().replace(/\s+/g, "-");
    if (!ALLOWED_TOOL_TAGS.has(tag)) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    deduped.push(tag);
  }
  return deduped;
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

function tagsToCsv(rawTags) {
  return normalizeTags(rawTags).join(",");
}

function csvToTags(rawCsv) {
  const parts = String(rawCsv || "")
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  return normalizeTags(parts);
}

function rowToLink(row) {
  return {
    name: String(row.name || ""),
    url: String(row.url || ""),
    description: String(row.description || ""),
    abilities: csvToAbilities(row.abilities_csv),
    pricing: normalizePricing(row.pricing_tier),
    tags: csvToTags(row.tags_csv)
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
      tags_csv TEXT NOT NULL DEFAULT '',
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
      canonical_url TEXT NOT NULL DEFAULT '',
      final_url TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      abilities_csv TEXT NOT NULL DEFAULT '',
      pricing_tier TEXT NOT NULL DEFAULT 'trial',
      tags_csv TEXT NOT NULL DEFAULT '',
      http_status INTEGER NOT NULL DEFAULT 0,
      content_type TEXT NOT NULL DEFAULT '',
      verified_at TIMESTAMPTZ,
      evidence_urls_json TEXT NOT NULL DEFAULT '[]',
      evidence_json TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'pending',
      discovered_count INTEGER NOT NULL DEFAULT 1,
      discovered_by TEXT NOT NULL DEFAULT 'juleha',
      submitted_ip_hash TEXT NOT NULL DEFAULT '',
      submitted_session_hash TEXT NOT NULL DEFAULT '',
      capture_reason TEXT NOT NULL DEFAULT 'verified-link',
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
    ALTER TABLE ai_main_links
    ADD COLUMN IF NOT EXISTS tags_csv TEXT NOT NULL DEFAULT ''
  `;

  await sql`
    ALTER TABLE ai_candidate_links
    ADD COLUMN IF NOT EXISTS pricing_tier TEXT NOT NULL DEFAULT 'trial'
  `;

  await sql`
    ALTER TABLE ai_candidate_links
    ADD COLUMN IF NOT EXISTS tags_csv TEXT NOT NULL DEFAULT ''
  `;

  await sql`
    ALTER TABLE ai_candidate_links
    ADD COLUMN IF NOT EXISTS canonical_url TEXT NOT NULL DEFAULT ''
  `;

  await sql`
    ALTER TABLE ai_candidate_links
    ADD COLUMN IF NOT EXISTS final_url TEXT NOT NULL DEFAULT ''
  `;

  await sql`
    ALTER TABLE ai_candidate_links
    ADD COLUMN IF NOT EXISTS http_status INTEGER NOT NULL DEFAULT 0
  `;

  await sql`
    ALTER TABLE ai_candidate_links
    ADD COLUMN IF NOT EXISTS content_type TEXT NOT NULL DEFAULT ''
  `;

  await sql`
    ALTER TABLE ai_candidate_links
    ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ
  `;

  await sql`
    ALTER TABLE ai_candidate_links
    ADD COLUMN IF NOT EXISTS evidence_urls_json TEXT NOT NULL DEFAULT '[]'
  `;

  await sql`
    ALTER TABLE ai_candidate_links
    ADD COLUMN IF NOT EXISTS submitted_ip_hash TEXT NOT NULL DEFAULT ''
  `;

  await sql`
    ALTER TABLE ai_candidate_links
    ADD COLUMN IF NOT EXISTS submitted_session_hash TEXT NOT NULL DEFAULT ''
  `;

  await sql`
    ALTER TABLE ai_candidate_links
    ADD COLUMN IF NOT EXISTS capture_reason TEXT NOT NULL DEFAULT 'verified-link'
  `;

  await sql`
    UPDATE ai_candidate_links
    SET canonical_url = url
    WHERE canonical_url = '' OR canonical_url IS NULL
  `;

  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS ai_candidate_links_canonical_url_idx
    ON ai_candidate_links (canonical_url)
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

  await sql`
    CREATE TABLE IF NOT EXISTS ai_scrape_queue (
      id BIGSERIAL PRIMARY KEY,
      canonical_url TEXT NOT NULL,
      requested_url TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT 'candidate-enrichment',
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      last_error TEXT NOT NULL DEFAULT ''
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS ai_scrape_queue_status_created_idx
    ON ai_scrape_queue (status, created_at)
  `;
}

async function refreshMainPricingTiers(sql) {
  const rows = await sql`
    SELECT id, pricing_tier, tags_csv
    FROM ai_main_links
  `;

  let updatedCount = 0;
  for (const row of rows) {
    const normalizedPricing = normalizePricing(row.pricing_tier);
    const normalizedTagsCsv = tagsToCsv(csvToTags(row.tags_csv));
    const currentPricing = String(row.pricing_tier || "").trim().toLowerCase();
    const currentTagsCsv = String(row.tags_csv || "").trim().toLowerCase();
    if (currentPricing === normalizedPricing && currentTagsCsv === normalizedTagsCsv) continue;

    await sql`
      UPDATE ai_main_links
      SET pricing_tier = ${normalizedPricing},
          tags_csv = ${normalizedTagsCsv},
          updated_at = NOW()
      WHERE id = ${row.id}
    `;
    updatedCount += 1;
  }

  return {
    scannedCount: rows.length,
    updatedCount,
    missingReferenceCount: 0,
    sourceCount: rows.length,
    insertedCount: 0
  };
}

async function ensureStoreReady(sql) {
  await ensureSchema(sql);
}

async function getMainLinks(sql) {
  const rows = await sql`
    SELECT name, url, description, abilities_csv, pricing_tier, tags_csv
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
  const canonicalUrl = normalizeUrl(candidate && (candidate.canonicalUrl || candidate.url) ? (candidate.canonicalUrl || candidate.url) : "");
  if (!canonicalUrl) return { inserted: false };

  const finalUrl = normalizeUrl(candidate && candidate.finalUrl ? candidate.finalUrl : canonicalUrl) || canonicalUrl;
  const url = normalizeUrl(candidate && candidate.url ? candidate.url : canonicalUrl) || canonicalUrl;
  const name = String(candidate && candidate.name ? candidate.name : "").trim() || canonicalUrl;
  const description = String(candidate && candidate.description ? candidate.description : "").trim();
  const abilitiesCsv = abilitiesToCsv(Array.isArray(candidate && candidate.abilities) ? candidate.abilities : []);
  const pricingTier = normalizePricing(candidate && (candidate.pricing || candidate.pricingTier || candidate.priceTier));
  const tagsCsv = tagsToCsv(Array.isArray(candidate && candidate.tags) ? candidate.tags : []);
  const evidenceJson = JSON.stringify(candidate && candidate.evidence ? candidate.evidence : {});
  const evidenceUrlsJson = JSON.stringify(Array.isArray(candidate && candidate.evidenceUrls) ? candidate.evidenceUrls : []);
  const discoveredBy = String(candidate && candidate.discoveredBy ? candidate.discoveredBy : "juleha").trim() || "juleha";
  const submittedIpHash = String(candidate && candidate.submittedIpHash ? candidate.submittedIpHash : "").trim();
  const submittedSessionHash = String(candidate && candidate.submittedSessionHash ? candidate.submittedSessionHash : "").trim();
  const captureReason = String(candidate && candidate.captureReason ? candidate.captureReason : "verified-link").trim() || "verified-link";
  const contentType = String(candidate && candidate.contentType ? candidate.contentType : "").trim().slice(0, 120);
  const httpStatus = Number.isFinite(Number(candidate && candidate.httpStatus)) ? Number(candidate.httpStatus) : 0;
  const verifiedAt = candidate && candidate.verifiedAt ? String(candidate.verifiedAt) : null;

  await sql`
    INSERT INTO ai_candidate_links
      (
        name,
        url,
        canonical_url,
        final_url,
        description,
        abilities_csv,
        pricing_tier,
        tags_csv,
        http_status,
        content_type,
        verified_at,
        evidence_urls_json,
        evidence_json,
        status,
        discovered_count,
        discovered_by,
        submitted_ip_hash,
        submitted_session_hash,
        capture_reason,
        last_seen_at,
        updated_at
      )
    VALUES
      (
        ${name},
        ${url},
        ${canonicalUrl},
        ${finalUrl},
        ${description},
        ${abilitiesCsv},
        ${pricingTier},
        ${tagsCsv},
        ${httpStatus},
        ${contentType},
        COALESCE(${verifiedAt}::timestamptz, NOW()),
        ${evidenceUrlsJson},
        ${evidenceJson},
        'pending',
        1,
        ${discoveredBy},
        ${submittedIpHash},
        ${submittedSessionHash},
        ${captureReason},
        NOW(),
        NOW()
      )
    ON CONFLICT (canonical_url) DO UPDATE SET
      name = CASE
        WHEN ai_candidate_links.name = '' THEN EXCLUDED.name
        ELSE ai_candidate_links.name
      END,
      url = EXCLUDED.url,
      final_url = CASE
        WHEN EXCLUDED.final_url <> '' THEN EXCLUDED.final_url
        ELSE ai_candidate_links.final_url
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
      tags_csv = CASE
        WHEN ai_candidate_links.tags_csv = '' THEN EXCLUDED.tags_csv
        ELSE ai_candidate_links.tags_csv
      END,
      http_status = CASE
        WHEN EXCLUDED.http_status > 0 THEN EXCLUDED.http_status
        ELSE ai_candidate_links.http_status
      END,
      content_type = CASE
        WHEN EXCLUDED.content_type <> '' THEN EXCLUDED.content_type
        ELSE ai_candidate_links.content_type
      END,
      verified_at = COALESCE(EXCLUDED.verified_at, ai_candidate_links.verified_at),
      evidence_urls_json = EXCLUDED.evidence_urls_json,
      evidence_json = EXCLUDED.evidence_json,
      status = CASE
        WHEN ai_candidate_links.status = 'pending' THEN ai_candidate_links.status
        ELSE 'pending'
      END,
      discovered_count = ai_candidate_links.discovered_count + 1,
      discovered_by = EXCLUDED.discovered_by,
      submitted_ip_hash = CASE
        WHEN EXCLUDED.submitted_ip_hash <> '' THEN EXCLUDED.submitted_ip_hash
        ELSE ai_candidate_links.submitted_ip_hash
      END,
      submitted_session_hash = CASE
        WHEN EXCLUDED.submitted_session_hash <> '' THEN EXCLUDED.submitted_session_hash
        ELSE ai_candidate_links.submitted_session_hash
      END,
      capture_reason = CASE
        WHEN EXCLUDED.capture_reason <> '' THEN EXCLUDED.capture_reason
        ELSE ai_candidate_links.capture_reason
      END,
      last_seen_at = NOW(),
      updated_at = NOW()
  `;

  return { inserted: true };
}

async function enqueueScrapeJob(sql, input) {
  const canonicalUrl = normalizeUrl(input && input.canonicalUrl ? input.canonicalUrl : "");
  const requestedUrl = normalizeUrl(input && input.requestedUrl ? input.requestedUrl : canonicalUrl) || canonicalUrl;
  if (!canonicalUrl || !requestedUrl) return { queued: false };

  const reason = String(input && input.reason ? input.reason : "candidate-enrichment").trim() || "candidate-enrichment";
  const payloadJson = JSON.stringify(input && input.payload ? input.payload : {});

  await sql`
    INSERT INTO ai_scrape_queue (canonical_url, requested_url, reason, status, attempts, payload_json, updated_at)
    VALUES (${canonicalUrl}, ${requestedUrl}, ${reason}, 'pending', 0, ${payloadJson}, NOW())
  `;

  return { queued: true };
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
    SELECT id, name, url, description, abilities_csv, pricing_tier, tags_csv
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
      INSERT INTO ai_main_links (name, url, description, abilities_csv, pricing_tier, tags_csv, source, updated_at)
      VALUES (
        ${String(row.name || "").trim() || normalizedUrl},
        ${normalizedUrl},
        ${String(row.description || "").trim()},
        ${String(row.abilities_csv || "").trim()},
        ${normalizePricing(row.pricing_tier)},
        ${tagsToCsv(csvToTags(row.tags_csv))},
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
  normalizeTags,
  abilitiesToCsv,
  csvToAbilities,
  tagsToCsv,
  csvToTags,
  ensureStoreReady,
  refreshMainPricingTiers,
  getMainLinks,
  getMainUrlSet,
  upsertCandidate,
  enqueueScrapeJob,
  mergePendingCandidates
};
