"use strict";

const { neon } = require("@neondatabase/serverless");
const { toolsEnrich } = require("../../api/_tools-client");

const ALLOWED_ABILITIES = new Set(["text", "image", "video", "audio", "code", "automation", "learning"]);

function readEnvNumber(name, fallback, min, max) {
  const raw = Number.parseInt(String(process.env[name] || ""), 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

function getSql() {
  const connectionString = String(process.env.NEON_DATABASE_URL || process.env.DATABASE_URL || "").trim();
  if (!connectionString) {
    throw new Error("Missing NEON_DATABASE_URL or DATABASE_URL");
  }
  return neon(connectionString);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  const normalized = [];
  const seen = new Set();
  for (const entry of rawAbilities) {
    const ability = String(entry || "").trim().toLowerCase();
    if (!ALLOWED_ABILITIES.has(ability)) continue;
    if (seen.has(ability)) continue;
    seen.add(ability);
    normalized.push(ability);
  }
  return normalized;
}

function abilitiesToCsv(rawAbilities) {
  return normalizeAbilities(rawAbilities).join(",");
}

function deriveToolName(url, rawTitle) {
  const title = String(rawTitle || "").trim();
  if (title) {
    const first = title.split(/[|\-:]/)[0].trim();
    if (first) return first.slice(0, 120);
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const root = host.split(".")[0] || host;
    return root.charAt(0).toUpperCase() + root.slice(1);
  } catch {
    return "Unknown AI Tool";
  }
}

function normalizePricingFlags(rawItem) {
  const pricingText = String(rawItem.pricingText || rawItem.pricing || rawItem.price || "").toLowerCase();
  const isFree = Boolean(rawItem.isFree) || /\bfree\b|\bgratis\b/.test(pricingText);
  const hasTrial = Boolean(rawItem.hasTrial) || /\btrial\b|\bfreemium\b|\buji\b/.test(pricingText);
  const isPaid = Boolean(rawItem.isPaid) || /\bpaid\b|\bpremium\b|\bpro\b|\bberbayar\b/.test(pricingText);
  return {
    pricingText: String(rawItem.pricingText || rawItem.pricing || rawItem.price || "").trim().slice(0, 500),
    isFree,
    hasTrial,
    isPaid
  };
}

function normalizeToolsResult(rawData, fallbackUrl) {
  const root = rawData && typeof rawData === "object" ? rawData : {};
  const candidates = [];
  const pools = [root.items, root.results, root.tools, root.matches];
  for (const pool of pools) {
    if (Array.isArray(pool)) {
      for (const item of pool) candidates.push(item);
    }
  }
  if (root.item && typeof root.item === "object") candidates.push(root.item);
  if (root.result && typeof root.result === "object") candidates.push(root.result);
  if (!candidates.length && root && Object.keys(root).length) candidates.push(root);

  for (const item of candidates) {
    if (!item || typeof item !== "object") continue;
    const canonicalUrl = normalizeUrl(item.canonicalUrl || item.url || item.finalUrl || fallbackUrl || "");
    if (!canonicalUrl) continue;
    const finalUrl = normalizeUrl(item.finalUrl || item.url || canonicalUrl) || canonicalUrl;
    const title = String(item.title || item.name || "").trim();
    const pricing = normalizePricingFlags(item);

    return {
      name: String(item.name || deriveToolName(canonicalUrl, title)).trim().slice(0, 160),
      canonicalUrl,
      finalUrl,
      description: String(item.description || item.summary || item.snippet || "").trim().slice(0, 800),
      abilities: normalizeAbilities(Array.isArray(item.abilities) ? item.abilities : []),
      features: item.features && typeof item.features === "object" ? item.features : {},
      pricingText: pricing.pricingText,
      isFree: pricing.isFree,
      hasTrial: pricing.hasTrial,
      isPaid: pricing.isPaid,
      faviconUrl: String(item.faviconUrl || item.favicon || "").trim(),
      thumbnailUrl: String(item.thumbnailUrl || item.thumbnail || item.image || "").trim(),
      httpStatus: Number.isFinite(Number(item.httpStatus || item.status)) ? Number(item.httpStatus || item.status) : 0,
      contentType: String(item.contentType || "").trim().slice(0, 120),
      confidence: Number.isFinite(Number(item.confidence)) ? Number(item.confidence) : null,
      sources: Array.isArray(item.sources)
        ? item.sources.map((entry) => String(entry || "").trim()).filter(Boolean).slice(0, 12)
        : item.source
          ? [String(item.source).trim()]
          : [],
      raw: item
    };
  }

  return null;
}

async function claimNextJob(sql) {
  const rows = await sql`
    WITH next_job AS (
      SELECT id
      FROM ai_scrape_queue
      WHERE status IN ('pending', 'retry')
        AND next_run_at <= NOW()
      ORDER BY next_run_at ASC, created_at ASC, id ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE ai_scrape_queue queue
    SET
      status = 'processing',
      started_at = NOW(),
      updated_at = NOW(),
      last_error = ''
    FROM next_job
    WHERE queue.id = next_job.id
    RETURNING queue.*
  `;
  return rows[0] || null;
}

async function markJobDone(sql, jobId) {
  await sql`
    UPDATE ai_scrape_queue
    SET
      status = 'done',
      finished_at = NOW(),
      updated_at = NOW()
    WHERE id = ${jobId}
  `;
}

async function markJobFailed(sql, jobId, maxAttempts, backoffBaseSec, errorMessage) {
  const safeError = String(errorMessage || "worker-failed").slice(0, 2000);
  await sql`
    UPDATE ai_scrape_queue
    SET
      attempts = attempts + 1,
      status = CASE WHEN (attempts + 1) >= ${maxAttempts} THEN 'failed' ELSE 'retry' END,
      next_run_at = CASE
        WHEN (attempts + 1) >= ${maxAttempts}
          THEN next_run_at
        ELSE NOW() + make_interval(secs => ((attempts + 1) * (attempts + 1) * ${backoffBaseSec}))
      END,
      last_error = ${safeError},
      finished_at = CASE WHEN (attempts + 1) >= ${maxAttempts} THEN NOW() ELSE NULL END,
      started_at = NULL,
      updated_at = NOW()
    WHERE id = ${jobId}
  `;
}

async function applyEnrichment(sql, job, result) {
  const checkedAt = new Date().toISOString();
  const abilitiesCsv = abilitiesToCsv(result.abilities);
  const featuresJson = JSON.stringify(result.features || {});
  const evidenceJson = JSON.stringify({
    method: "vps-worker-tools-enrich",
    sources: result.sources,
    raw: result.raw
  });
  const evidenceUrlsJson = JSON.stringify(result.sources || []);

  await sql`
    UPDATE ai_candidate_links
    SET
      name = CASE WHEN ${result.name} <> '' THEN ${result.name} ELSE name END,
      final_url = CASE WHEN ${result.finalUrl} <> '' THEN ${result.finalUrl} ELSE final_url END,
      description = CASE WHEN ${result.description} <> '' THEN ${result.description} ELSE description END,
      abilities_csv = CASE WHEN ${abilitiesCsv} <> '' THEN ${abilitiesCsv} ELSE abilities_csv END,
      features_json = CASE WHEN ${featuresJson} <> '{}' THEN ${featuresJson} ELSE features_json END,
      pricing_text = CASE WHEN ${result.pricingText} <> '' THEN ${result.pricingText} ELSE pricing_text END,
      is_free = ${Boolean(result.isFree)},
      has_trial = ${Boolean(result.hasTrial)},
      is_paid = ${Boolean(result.isPaid)},
      favicon_url = CASE WHEN ${normalizeUrl(result.faviconUrl)} <> '' THEN ${normalizeUrl(result.faviconUrl)} ELSE favicon_url END,
      thumbnail_url = CASE WHEN ${normalizeUrl(result.thumbnailUrl)} <> '' THEN ${normalizeUrl(result.thumbnailUrl)} ELSE thumbnail_url END,
      http_status = CASE WHEN ${result.httpStatus} > 0 THEN ${result.httpStatus} ELSE http_status END,
      content_type = CASE WHEN ${result.contentType} <> '' THEN ${result.contentType} ELSE content_type END,
      verified_at = COALESCE(${checkedAt}::timestamptz, NOW()),
      evidence_json = CASE WHEN ${evidenceJson} <> '{}' THEN ${evidenceJson} ELSE evidence_json END,
      evidence_urls_json = CASE WHEN ${evidenceUrlsJson} <> '[]' THEN ${evidenceUrlsJson} ELSE evidence_urls_json END,
      pending_enrichment = false,
      last_checked_at = COALESCE(${checkedAt}::timestamptz, NOW()),
      updated_at = NOW()
    WHERE canonical_url = ${job.canonical_url}
  `;

  const mainRows = await sql`
    UPDATE ai_main_links
    SET
      features_json = CASE WHEN ${featuresJson} <> '{}' THEN ${featuresJson} ELSE features_json END,
      pricing_text = CASE WHEN ${result.pricingText} <> '' THEN ${result.pricingText} ELSE pricing_text END,
      is_free = ${Boolean(result.isFree)},
      has_trial = ${Boolean(result.hasTrial)},
      is_paid = ${Boolean(result.isPaid)},
      favicon_url = CASE WHEN ${normalizeUrl(result.faviconUrl)} <> '' THEN ${normalizeUrl(result.faviconUrl)} ELSE favicon_url END,
      thumbnail_url = CASE WHEN ${normalizeUrl(result.thumbnailUrl)} <> '' THEN ${normalizeUrl(result.thumbnailUrl)} ELSE thumbnail_url END,
      pending_enrichment = false,
      last_checked_at = COALESCE(${checkedAt}::timestamptz, NOW()),
      updated_at = NOW()
    WHERE url = ${job.canonical_url}
    RETURNING id
  `;
  const toolId = mainRows[0] && mainRows[0].id ? Number(mainRows[0].id) : null;

  await sql`
    INSERT INTO tool_checks (tool_id, checked_at, result_json, confidence, sources)
    VALUES (
      ${toolId},
      COALESCE(${checkedAt}::timestamptz, NOW()),
      ${evidenceJson},
      ${result.confidence},
      ${evidenceUrlsJson}
    )
  `;
}

async function runJob(sql, job, config) {
  const enrichResult = await toolsEnrich(job.requested_url, "queue-enrichment").catch(() => ({ ok: false, error: "tools-enrich-failed" }));
  if (!enrichResult.ok) {
    throw new Error(enrichResult.error || "tools-enrich-failed");
  }

  const normalized = normalizeToolsResult(enrichResult.data, job.requested_url);
  if (!normalized) {
    throw new Error("tools-enrich-empty");
  }

  await applyEnrichment(sql, job, normalized);
  await markJobDone(sql, job.id);
}

async function main() {
  const sql = getSql();
  const pollMs = readEnvNumber("WORKER_POLL_MS", 5000, 1000, 60000);
  const maxAttempts = readEnvNumber("WORKER_MAX_ATTEMPTS", 5, 1, 20);
  const backoffBaseSec = readEnvNumber("WORKER_BACKOFF_BASE_SEC", 60, 10, 3600);

  console.log(`[worker] started poll_ms=${pollMs} max_attempts=${maxAttempts} backoff_base_sec=${backoffBaseSec}`);

  while (true) {
    const job = await claimNextJob(sql).catch((error) => {
      console.error("[worker] claim failed", error instanceof Error ? error.message : String(error));
      return null;
    });

    if (!job) {
      await sleep(pollMs);
      continue;
    }

    try {
      await runJob(sql, job, { maxAttempts, backoffBaseSec });
      console.log(`[worker] done id=${job.id} url=${job.canonical_url}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markJobFailed(sql, job.id, maxAttempts, backoffBaseSec, message).catch(() => {});
      console.error(`[worker] failed id=${job.id} error=${message}`);
    }
  }
}

main().catch((error) => {
  console.error("[worker] fatal", error instanceof Error ? error.message : String(error));
  process.exit(1);
});

