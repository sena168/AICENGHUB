# AICENGHUB

AICENGHUB is a static-first AI tools directory with a Juleha chat assistant, deployed on Vercel.

## Tech Stack

- Frontend: `public/index.html` (vanilla HTML, CSS, JavaScript)
- Backend APIs: Vercel Serverless Functions (`api/*.js`, Node.js runtime)
- AI Provider: OpenRouter Chat Completions API
- Database: Neon Postgres via `@neondatabase/serverless`
- Persistence:
  - Cookies (`document.cookie`) for agreement/bunny visibility
  - Local storage for language + sound preferences + chat memory

## Project Structure

- `public/index.html`: main app page
- `public/admin.html`: admin update UI
- `public/link-list.json`: static fallback link list
- `api/juleha-chat.js`: Juleha chat API + policy guardrails + link verification + candidate capture
- `api/link-list.js`: reads main list from Neon (with fallback seeding from static file)
- `api/admin-update-list.js`: admin-triggered backup + merge candidates into main list
- `api/admin-update-tier.js`: admin-triggered pricing tier sync (free/trial/paid) from curated seed
- `api/candidate-link-list.js`: admin read endpoint for candidate queue
- `api/_link-store.js`: shared Neon schema + list operations
- `vercel.json`: headers + rewrites

## Environment Variables

Define these in Vercel Project Settings and local `.env` (never commit real values):

- `OPENROUTER_API_KEY_PRIMARY`
- `OPENROUTER_MODEL_PRIMARY`
- `OPENROUTER_LABEL_PRIMARY`
- `OPENROUTER_API_KEY_SECONDARY`
- `OPENROUTER_MODEL_SECONDARY`
- `OPENROUTER_LABEL_SECONDARY`
- `OPENROUTER_API_KEY_TERTIARY`
- `OPENROUTER_MODEL_TERTIARY`
- `OPENROUTER_LABEL_TERTIARY`
- `OPENROUTER_HTTP_REFERER`
- `OPENROUTER_APP_TITLE`
- `NEON_DATABASE_URL`
- `JULEHA_ADMIN_TOKEN`
- `JULEHA_ALLOWED_ORIGINS` (optional)
- `JULEHA_VERIFY_LINKS` (optional, `1`/`0`)
- `JULEHA_CAPTURE_CANDIDATES` (optional, `1`/`0`)

Reference template: `.env.example`.

## Security Notes

- API keys and DB credentials are server-side only.
- `.env` is ignored by git.
- Juleha backend has guardrails for:
  - prompt/secret exfiltration refusal
  - harmful request refusal baseline
  - secret-like token redaction in model output
- Admin merge endpoint requires `JULEHA_ADMIN_TOKEN`.

## Deployment

1. Push repo to GitHub.
2. Connect project to Vercel.
3. Set environment variables in Vercel.
4. Deploy.
5. Visit `/admin.html` and run:
   - **Update List** to merge pending candidates into main list.
   - **Update Tier** to refresh pricing tiers from curated `public/link-list.json`.
