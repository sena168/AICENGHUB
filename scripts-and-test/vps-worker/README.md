# Juleha VPS Worker

This folder contains the queue worker and scheduler for `ai_scrape_queue`.

## Files
- `worker.js`: claims jobs with `FOR UPDATE SKIP LOCKED`, enriches with tools server, updates Neon, retries with quadratic backoff.
- `scheduler.js`: enqueues stale tool refresh jobs from `ai_main_links` every run.
- `juleha-worker.service`: systemd unit for long-running worker.
- `juleha-scheduler.service`: oneshot systemd unit for scheduler.
- `juleha-scheduler.timer`: timer (24h + randomized 48h delay => 24-72h cadence).

## Required environment variables
- `NEON_DATABASE_URL` (or `DATABASE_URL`)
- `TOOLS_BASE_URL`
- `TOOLS_API_KEY`
- `TOOLS_TIMEOUT_MS` (optional, default handled by tools client)
- `WORKER_POLL_MS` (optional, default `5000`)
- `WORKER_MAX_ATTEMPTS` (optional, default `5`)
- `WORKER_BACKOFF_BASE_SEC` (optional, default `60`)
- `STALE_HOURS` (optional scheduler override, bounded `24..72`)
- `SCHEDULER_BATCH_SIZE` (optional, default `200`)

## systemd install example
```bash
sudo cp scripts-and-test/vps-worker/juleha-worker.service /etc/systemd/system/
sudo cp scripts-and-test/vps-worker/juleha-scheduler.service /etc/systemd/system/
sudo cp scripts-and-test/vps-worker/juleha-scheduler.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now juleha-worker.service
sudo systemctl enable --now juleha-scheduler.timer
```

