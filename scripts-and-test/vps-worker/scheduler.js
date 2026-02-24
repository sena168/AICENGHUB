"use strict";

const { neon } = require("@neondatabase/serverless");

function getSql() {
  const connectionString = String(process.env.NEON_DATABASE_URL || process.env.DATABASE_URL || "").trim();
  if (!connectionString) {
    throw new Error("Missing NEON_DATABASE_URL or DATABASE_URL");
  }
  return neon(connectionString);
}

function readEnvNumber(name, fallback, min, max) {
  const raw = Number.parseInt(String(process.env[name] || ""), 10);
  if (!Number.isFinite(raw)) return fallback;
  return Math.min(max, Math.max(min, raw));
}

function randomIntInclusive(min, max) {
  const lower = Math.ceil(min);
  const upper = Math.floor(max);
  return Math.floor(Math.random() * (upper - lower + 1)) + lower;
}

async function enqueueStaleToolRefreshes(sql, staleHours, maxBatch) {
  const rows = await sql`
    WITH stale_tools AS (
      SELECT url
      FROM ai_main_links
      WHERE url <> ''
        AND (
          last_checked_at IS NULL
          OR last_checked_at < NOW() - make_interval(hours => ${staleHours})
        )
      ORDER BY COALESCE(last_checked_at, TIMESTAMPTZ '1970-01-01') ASC, id ASC
      LIMIT ${maxBatch}
    )
    INSERT INTO ai_scrape_queue (
      canonical_url,
      requested_url,
      reason,
      status,
      attempts,
      next_run_at,
      payload_json,
      updated_at
    )
    SELECT
      stale_tools.url,
      stale_tools.url,
      'scheduled-refresh',
      'pending',
      0,
      NOW(),
      ${JSON.stringify({ source: "stale-refresh-scheduler" })},
      NOW()
    FROM stale_tools
    WHERE NOT EXISTS (
      SELECT 1
      FROM ai_scrape_queue queue
      WHERE queue.canonical_url = stale_tools.url
        AND queue.status IN ('pending', 'retry', 'processing')
    )
    RETURNING id, canonical_url
  `;

  return rows;
}

async function main() {
  const sql = getSql();
  const configuredStaleHours = Number.parseInt(String(process.env.STALE_HOURS || ""), 10);
  const staleHours = Number.isFinite(configuredStaleHours)
    ? Math.min(72, Math.max(24, configuredStaleHours))
    : randomIntInclusive(24, 72);
  const maxBatch = readEnvNumber("SCHEDULER_BATCH_SIZE", 200, 1, 5000);

  const inserted = await enqueueStaleToolRefreshes(sql, staleHours, maxBatch);
  console.log(`[scheduler] stale_hours=${staleHours} batch=${maxBatch} queued=${inserted.length}`);
}

main().catch((error) => {
  console.error("[scheduler] fatal", error instanceof Error ? error.message : String(error));
  process.exit(1);
});

