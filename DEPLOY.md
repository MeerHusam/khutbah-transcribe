# Deploying the public listening site

This is the **public, read-only** mode of KhutbahTranscribe: an always-on
Express + WebSocket server that streams pre-processed khutbahs (audio +
`result.json` + `reader.txt`) from disk. There is **no upload / pipeline** in this
mode — it only plays back khutbahs already in `outputs/`.

## Why not Vercel

Vercel (and other serverless platforms) run functions that spin up per-request and
can't hold a long-lived connection or local disk. This app needs both:

- a **persistent WebSocket** for the live viewer count, and
- **local file reads** for audio + result JSON.

So it needs a real always-on host. **Render** is recommended (simplest setup, native
WebSocket support, a usable free tier). Railway, Fly.io, or a small VPS also work —
a `Dockerfile` is included for those.

| Host | Setup effort | WebSocket | Notes |
|------|-------------|-----------|-------|
| **Render** (recommended) | Lowest — connect repo, done | ✅ native | Free tier spins down after ~15 min idle (~50 s cold start); `starter` ($7/mo) is always-on. Uses `render.yaml`. |
| Railway | Low | ✅ | No idle spin-down on hobby (~$5/mo credit). Build from `Dockerfile`. |
| Fly.io | Medium | ✅ | Global container + volumes; needs `fly.toml`. Build from `Dockerfile`. |
| VPS (DO/Hetzner) | Highest | ✅ (via Caddy/nginx) | ~$4–6/mo, full control; you manage TLS + a process manager. |

## Deploy to Render (recommended)

1. **Push to GitHub** (this repo is already a git repo with the right `.gitignore`):
   ```bash
   git remote add origin git@github.com:<you>/khutbah-transcribe.git
   git push -u origin main
   ```
2. In the [Render dashboard](https://dashboard.render.com): **New + → Blueprint**,
   pick the repo. Render reads `render.yaml` and provisions the web service.
   (Or **New + → Web Service** manually: Build `npm install`, Start `node server.js`.)
3. Wait for the build, then open the `*.onrender.com` URL. The featured masjid
   khutbah loads by default; the dropdown switches khutbahs.

No environment variables are required for the listening site. (`ANTHROPIC_API_KEY`
etc. are only for the offline pipeline, which doesn't run here.)

## What ships with the deploy

`.gitignore` bundles only what the site needs (~6 MB total):

- `audio_files/khutbah-2026-05-22-masjid.m4a` — the featured khutbah's audio
- `outputs/2026-05-22T11-30-04_khutbah-2026-05-22-masjid/` — featured text outputs
- `outputs/2026-05-15T17-45-24_makkah_sudais_ramadan_ummah/` — Sudais text outputs

Everything else (other audio, 50+ dev/test runs, `node_modules`, `hadith_data`,
`.env`) stays local.

### Audio note (Sudais)

Per the "bundle masjid only" choice, the **Sudais audio is not shipped**. Its folder
is still published, so on the deploy it shows as a **readable transcript with no
audio player** (the player auto-hides when audio is absent — no broken UI). The
Sudais file is only ~5.9 MB, so if you want it fully playable, add one line to
`.gitignore`:
```
!audio_files/makkah_sudais_ramadan_ummah.mp3
```
then `git add audio_files/makkah_sudais_ramadan_ummah.mp3 && git commit`.

To publish a different/new khutbah, add its entry to `PUBLIC_KHUTBAHS` in
`server.js` and make sure its audio + outputs folder are un-ignored in `.gitignore`.

## Viewer counts

- **Live ("N now")** — concurrent open WebSocket connections. Always accurate.
- **Total ("N total")** — cumulative page loads, written to `data/views.json`.

On Render's **free** plan the disk is ephemeral, so the *total* resets on each
deploy/restart (the live count is unaffected). To persist the total, use the
`starter` plan and uncomment the `disk:` block in `render.yaml`.

## Run locally

```bash
npm install
node server.js          # → http://localhost:3000
```
