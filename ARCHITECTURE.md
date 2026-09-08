# KhutbahTranscribe — Architecture & Production Reference

> **Status:** proposal under review. Nothing in the "Proposed" sections is built
> yet. The SQLite schema (§5) and the open decisions (§13) are awaiting sign-off
> before any code changes. Existing `outputs/` folders and `audio_files/` are
> **never deleted** — the migration is strictly additive.

Two upcoming goals drive every decision here:

- **Multi-language** — English first, then Urdu, then Bengali, etc.
- **Remote upload** — publish a khutbah without running the pipeline on a laptop
  and editing/redeploying the server.

---

## Table of Contents

1. [Goals & Non-Goals](#1-goals--non-goals)
2. [Current Architecture (v0)](#2-current-architecture-v0)
3. [Core Problem Analysis](#3-core-problem-analysis)
4. [Proposed Architecture](#4-proposed-architecture)
5. [SQLite Schema (FOR REVIEW)](#5-sqlite-schema-for-review)
6. [Multi-Language Strategy](#6-multi-language-strategy)
7. [Remote Upload & Worker](#7-remote-upload--worker)
8. [Storage, Backups & Disaster Recovery](#8-storage-backups--disaster-recovery)
9. [Security](#9-security)
10. [Reliability, Performance & Observability](#10-reliability-performance--observability)
11. [Scalability & the SQLite Ceiling](#11-scalability--the-sqlite-ceiling)
12. [Cost Model](#12-cost-model)
13. [Content Integrity (Religious Accuracy)](#13-content-integrity-religious-accuracy)
14. [Legal, Licensing & Privacy](#14-legal-licensing--privacy)
15. [SEO, Accessibility & Frontend](#15-seo-accessibility--frontend)
16. [Testing & CI/CD](#16-testing--cicd)
17. [Phased Migration Plan](#17-phased-migration-plan)
18. [Open Decisions](#18-open-decisions)
19. [Appendix: Env Vars & API Surface](#19-appendix-env-vars--api-surface)

---

## 1. Goals & Non-Goals

**Goals**
- Decouple content/config from code (publish without a redeploy).
- Make the data model multi-language from the ground up.
- Enable authenticated remote upload with a review-before-publish gate.
- Keep the offline CLI pipeline (`pipeline.js`, `reanalyze.js`) working unchanged.
- Stay cheap and low-ops (solo maintainer, Render Starter).

**Non-Goals (for now)**
- Multi-region / multi-instance horizontal scaling.
- Public user accounts / comments / social features.
- Live (real-time) transcription during the khutbah.
- Replacing the Quran/Hadith detection algorithms (that work is tracked in
  `CLAUDE.md`, not here).

---

## 2. Current Architecture (v0)

```
┌─ OFFLINE (laptop) ────────────────────────────────────────┐
│  audio file                                                │
│    → pipeline.js  (ffmpeg → Whisper/Groq → Claude → refs)  │
│    → outputs/<timestamp>_<name>/                           │
│         result.json   ← all data (source + English mixed)  │
│         reader.txt, readable.txt, transcript.txt           │
└────────────────────────────────────────────────────────────┘
        │  manual: git add audio + outputs, edit server.js, push
        ▼
┌─ ONLINE (Render Starter, read-only) ──────────────────────┐
│  server.js                                                 │
│   • PUBLIC_KHUTBAHS[]   ← metadata HARDCODED in the .js     │
│   • startup: outputs/*/result.json → resultCache (Map)     │
│   • serves audio_files/* off the web dyno disk             │
│   • data/ (views, geo, feedback) on a 1 GB persistent disk │
│  public/home.html   ← landing page (khutbah grid, About, How it Works, Contact)
  public/index.html  ← reader SPA, fetches /api/results/:folder            │
└────────────────────────────────────────────────────────────┘
```

### Where the data lives today

| Thing | Location | Notes |
|---|---|---|
| Khutbah content | `outputs/<folder>/result.json` | Source + English translation mixed |
| Audio | `audio_files/<name>.<ext>` | Bundled in git (one file is 42 MB) |
| Published list + metadata | `PUBLIC_KHUTBAHS[]` in `server.js` | Title, masjid, date, maps_url, featured |
| Analytics | `data/views.json` (+ `geo_views.jsonl`, `feedback.jsonl` once created) | On persistent disk |
| Runtime cache | `resultCache` (in-memory Map) | Assumes files never change at runtime |

### Current request flow

```
GET /                       → public/home.html (landing page — khutbah grid, About, How it Works, Contact)
GET /index.html?folder=X    → public/index.html (reader SPA for a specific khutbah)
GET /api/results            → { featured, items[] }   (allowlist-gated)
GET /api/results/:folder    → result.json + merged metadata  (404 if not allowlisted)
GET /api/quran/:surah/:ayah → ayah text with harakat (live lookup from corpus)
GET /audio/<file>           → static audio from audio_files/ (Express static)
POST /api/feedback          → append to data/feedback.jsonl
WS  /                       → live/unique/total viewer counts + geo logging
GET /admin/feedback?key=    → ADMIN_TOKEN-gated feedback dump
GET /admin/geo?key=         → ADMIN_TOKEN-gated geo dump
```

---

## 3. Core Problem Analysis

| # | Problem | Consequence | Fixed by |
|---|---|---|---|
| 1 | Filesystem is the database | No querying, no status, ~56 dead folders | SQLite (§5) |
| 2 | Metadata hardcoded in `server.js` | Publishing = edit code + redeploy | `khutbahs` table |
| 3 | Audio on web dyno + in git | Repo bloat, no CDN, doesn't scale | Object storage (§8) |
| 4 | Cache assumes immutability | Breaks under uploads/re-translation | DB + cache invalidation |
| 5 | **Monolingual data model** | Can't add Urdu without overwriting/duplicating | Source/translation split |
| 6 | No auth on writes | Can't safely accept uploads | Auth layer (§9) |
| 7 | Pipeline is local-only | Manual, laptop-bound publishing | Worker + job queue (§7) |

### The core problem: `result.json` mixes two lifecycles

```
result.json
├─ SOURCE / ANALYSIS  (language-independent — computed ONCE per khutbah)
│    transcript_words, transcript_segments, prose_chunk_map,
│    second_khutbah, quran_references (surah:ayah IDs),
│    hadith_references (collection:number IDs), metadata
│
└─ TRANSLATION  (English-only — should exist N times, once per language)
     chunk_translations[], summary, share_summary
```

Adding Urdu today means overwriting English or duplicating the whole file
(including all the Arabic source). That is the signal to split the layers.

---

## 4. Proposed Architecture

**Principles**

1. **Split source from translation.** Transcribe + detect refs *once*; translate
   *N times*, one document per language.
2. **Content and config live in data, not code.** SQLite replaces
   `PUBLIC_KHUTBAHS` and folder-scanning.
3. **Additive migration.** Existing folders/audio stay; the DB references them via
   a `legacy_folder` column.
4. **Soft delete, never hard delete.** `status = 'archived'`, not `DROP`.

### Data model & lifecycle

```
Khutbah (1)
  ├── SourceAnalysis (1)   ← Arabic, timings, ref IDs, prose_chunk_map   [compute ONCE]
  └── Translation (N)      ← en, ur, bn …  (prose chunks + summaries)     [compute per language]

Quran/Hadith DISPLAY text per language ← resolved by ref ID from published sources (not stored per khutbah)
```

### Component diagram (target)

```
┌──────────────┐  auth   ┌───────────┐ enqueue ┌──────────┐
│ Uploader UI  │────────▶│  Web API  │────────▶│  Job     │
│ (admins)     │         │ (server)  │         │  Queue   │
└──────────────┘         └─────┬─────┘         └────┬─────┘
                               │                    │
                          ┌────▼────┐          ┌────▼─────┐
                          │ SQLite  │◀────────▶│  Worker  │
                          │ +WAL    │          │ (pipeline│
                          │ Litestream→R2       │  funcs)  │
                          └────┬────┘          └────┬─────┘
                               │                    │
                          ┌────▼─────────┐          │
                          │ Object store │◀─────────┘
                          │ (R2/S3): audio + big blobs + backups
                          └────┬─────────┘
                               │
┌──────────────┐         ┌─────▼─────┐
│ Public Site  │◀────────│  Web API  │  (reads DB + in-mem cache)
└──────────────┘         └───────────┘
```

---

## 5. SQLite Schema (FOR REVIEW)

```sql
-- ── Core content ────────────────────────────────────────────

CREATE TABLE khutbahs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT UNIQUE NOT NULL,           -- clean URL id (new links)
  legacy_folder TEXT,                           -- outputs/<folder> for back-compat
  title         TEXT NOT NULL,
  speaker       TEXT,
  masjid        TEXT,
  masjid_ar     TEXT,
  maps_url      TEXT,
  khutbah_date  TEXT,                            -- ISO 'YYYY-MM-DD'
  audio_url     TEXT,                            -- object-store URL or /audio/<file>
  audio_sha256  TEXT,                            -- dedupe / idempotency key
  duration_sec  REAL,
  featured      INTEGER NOT NULL DEFAULT 0,      -- 0/1
  status        TEXT NOT NULL DEFAULT 'draft',   -- draft | published | archived
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Language-independent analysis (1:1 with khutbah) ────────

CREATE TABLE source_analyses (
  khutbah_id          INTEGER PRIMARY KEY REFERENCES khutbahs(id) ON DELETE CASCADE,
  transcript_words    TEXT,    -- JSON [{word,start}]
  transcript_segments TEXT,    -- JSON [{start,end,text}]
  prose_chunk_map     TEXT,    -- JSON [{wordStart,wordEnd,proseIdx}]
  second_khutbah      TEXT,    -- JSON or NULL
  transcription_mode  TEXT,
  word_count          INTEGER,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Per-language translation (N per khutbah) ────────────────

CREATE TABLE translations (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  khutbah_id         INTEGER NOT NULL REFERENCES khutbahs(id) ON DELETE CASCADE,
  lang               TEXT NOT NULL,             -- 'en','ur','bn',...
  chunk_translations TEXT NOT NULL,             -- JSON [] (prose only)
  summary            TEXT,
  share_summary      TEXT,
  translator         TEXT,                       -- 'claude-sonnet-4-6' | 'human:Name'
  reviewed_by        TEXT,                        -- who approved (null = unreviewed)
  status             TEXT NOT NULL DEFAULT 'ready', -- pending|ready|failed
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(khutbah_id, lang)
);

-- ── Detected references (queryable; identity is language-independent) ──

CREATE TABLE quran_refs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  khutbah_id       INTEGER NOT NULL REFERENCES khutbahs(id) ON DELETE CASCADE,
  ord              INTEGER,                       -- order within khutbah
  surah_number     INTEGER NOT NULL,
  ayah_number      INTEGER NOT NULL,
  surah_name       TEXT,
  detected_text    TEXT,                          -- Arabic as transcribed
  confidence       REAL,
  verification     TEXT,
  detection_method TEXT
);

CREATE TABLE hadith_refs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  khutbah_id       INTEGER NOT NULL REFERENCES khutbahs(id) ON DELETE CASCADE,
  ord              INTEGER,
  collection       TEXT,
  hadith_number    TEXT,
  narrator         TEXT,
  detected_text    TEXT,                          -- Arabic matn
  link             TEXT,
  confidence       REAL,
  verification     TEXT,
  detection_method TEXT
);

-- ── Job tracking (upload / transcribe / analyze / translate) ──

CREATE TABLE jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  khutbah_id  INTEGER REFERENCES khutbahs(id) ON DELETE SET NULL,
  type        TEXT NOT NULL,                      -- upload|transcribe|analyze|translate
  lang        TEXT,                                -- for translate jobs
  status      TEXT NOT NULL DEFAULT 'pending',     -- pending|running|done|failed
  progress    REAL DEFAULT 0,
  attempts    INTEGER NOT NULL DEFAULT 0,          -- retry counter
  error       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Auth (admins / uploaders) ───────────────────────────────

CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT UNIQUE NOT NULL,
  role          TEXT NOT NULL DEFAULT 'uploader',  -- admin | uploader
  password_hash TEXT,                               -- argon2/bcrypt (if password auth)
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE sessions (
  token       TEXT PRIMARY KEY,                     -- random 256-bit
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Analytics (consolidates data/*.json[l]) ─────────────────

CREATE TABLE views (
  id     INTEGER PRIMARY KEY CHECK (id = 1),       -- singleton row
  total  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE unique_ips (
  ip_hash    TEXT PRIMARY KEY,                      -- sha256[:16]
  first_seen TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE geo_views (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL DEFAULT (datetime('now')),
  khutbah_id   INTEGER REFERENCES khutbahs(id) ON DELETE SET NULL,
  city         TEXT,
  region       TEXT,
  country      TEXT,
  country_code TEXT
);

CREATE TABLE feedback (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         TEXT NOT NULL DEFAULT (datetime('now')),
  khutbah_id INTEGER REFERENCES khutbahs(id) ON DELETE SET NULL,
  message    TEXT NOT NULL,
  contact    TEXT
);

-- ── Schema migrations ───────────────────────────────────────

CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Indexes ──────────────────────────────────────────────────
CREATE INDEX idx_khutbahs_status      ON khutbahs(status);
CREATE INDEX idx_translations_khutbah ON translations(khutbah_id);
CREATE INDEX idx_quran_refs_khutbah   ON quran_refs(khutbah_id);
CREATE INDEX idx_quran_refs_ayah      ON quran_refs(surah_number, ayah_number);
CREATE INDEX idx_hadith_refs_khutbah  ON hadith_refs(khutbah_id);
CREATE INDEX idx_jobs_status          ON jobs(status);
CREATE INDEX idx_sessions_user        ON sessions(user_id);
```

### Operational settings (apply on every connection open)

```sql
PRAGMA journal_mode = WAL;     -- concurrent readers + 1 writer; survives crashes
PRAGMA synchronous = NORMAL;   -- safe with WAL, much faster than FULL
PRAGMA foreign_keys = ON;      -- enforce FK cascades (off by default in SQLite!)
PRAGMA busy_timeout = 5000;    -- wait 5s on a locked DB instead of erroring
```

### Driver & migrations

- **Driver:** `better-sqlite3` (synchronous, fastest Node SQLite binding; matches
  the existing synchronous `resultCache` access pattern). No async/await churn.
- **Migrations:** numbered `.sql` files in `migrations/` (`001_init.sql`,
  `002_*.sql`). A tiny runner applies any `version` not in `schema_migrations`
  inside a transaction, on server startup. Forward-only; no down-migrations
  (restore from backup instead).

### Schema decisions to confirm (see §18)

1. `legacy_folder` keeps existing folders usable without moving/deleting them.
2. Big blobs as JSON `TEXT` in `source_analyses` (vs. external files) — fine at
   this scale; externalize later with no schema change.
3. `quran_refs`/`hadith_refs` as rows (not JSON) for queryability.
4. `slug` for new URLs, `legacy_folder` for old `?folder=` links.
5. Analytics + auth tables in the same DB (vs. separate). Recommended: one DB.

---

## 6. Multi-Language Strategy

### Minimal-LLM principle

A Quran ref is just an identity (`2:286`). Published, scholar-reviewed
translations of every ayah **already exist** in many languages (Quran.com API
serves them keyed by translator ID). So:

| Content | English | Urdu / Bengali / … |
|---|---|---|
| Imam's prose (`chunk_translations`, `summary`, `share_summary`) | Claude | Claude `translate` pass |
| Quran ayah text | by ref ID from published translation | by ref ID, different translator |
| Hadith matn | sunnah.com (English) | **gap — see below** |

Adding Urdu = `translate(sourceAnalysis, 'ur')` over existing analysis. No
re-transcription, no re-detection.

### Per-language sourcing

- **Quran:** Quran.com API (`/verses/by_key/{s}:{a}?translations={id}`) or a
  local mirror of the chosen translations. Pick one trusted translator per
  language and store its ID + attribution (see §14). Cache the verse text.
- **Hadith English:** sunnah.com (already resolved per ref, fix #17/#18 in
  `CLAUDE.md`). **Hadith Urdu/Bengali:** no clean free API. Options: (a) ship
  English hadith text in all languages initially with a note; (b) source a
  licensed Urdu hadith dataset later; (c) Claude-translate the matn (lower trust
  — flag as machine-translated). **Decision needed.**

### RTL / LTR rendering

| Language | Direction | Font |
|---|---|---|
| Arabic (source) | RTL | Amiri / Uthmani |
| English | LTR | Lora |
| Urdu | **RTL** | Noto Nastaliq Urdu |
| Bengali | LTR | Noto Serif Bengali |

The reader UI must set `dir` and font **per translation block**, not globally —
an Urdu translation under an Arabic ayah is RTL-under-RTL, but the English build
is LTR-under-RTL. Store `dir` derivable from `lang` (a small lookup table in the
frontend). Numerals, punctuation mirroring, and the play/seek controls need an
RTL pass.

### Language selection UX

- URL: `?folder=<slug>&lang=ur` (or path `/{slug}/{lang}`).
- A language switcher in the header; remember choice in `localStorage`.
- **Fallback chain:** requested lang → English → "translation pending" placeholder
  (when a `translations` row is `pending`/missing). Never blank.
- `GET /api/results/:slug?lang=ur` returns `{ ...source, translation }` for the
  requested language; `available_langs[]` lists what exists so the switcher only
  shows ready ones.

---

## 7. Remote Upload & Worker

### Flow

```
1. Admin logs in (session cookie).
2. POST /api/upload (multipart audio + metadata) → validate → store audio →
   create khutbah(status=draft) + job(type=transcribe).
3. Worker picks job → preprocessAudio → transcribe → analyze → write
   source_analyses + quran_refs + hadith_refs + translations('en', pending→ready).
   Progress streamed over WS (reuse the existing channel).
4. Admin reviews draft at /admin/review/:slug (transcript + refs + translation).
5. Admin edits if needed, sets status=published.
6. (Optional) Admin queues translate jobs for ur/bn.
```

### Worker design

- The pipeline is heavy (ffmpeg + Groq + Claude, tens of seconds to minutes) — it
  **must not** run in a web request. Run as a job.
- **Phase-3a (simple):** in-process worker — `setInterval` polls `jobs` for
  `pending`, runs one at a time, updates status. Fine for low volume (one
  uploader, a few khutbahs/week). Risk: a crash mid-job leaves `running` jobs;
  reconcile on startup (`running` older than N min → `failed`, retry if
  `attempts < 3`).
- **Phase-3b (robust):** a separate Render Background Worker service consuming the
  same SQLite (single instance) or a real queue. Only needed if volume grows.
- **Idempotency:** `audio_sha256` dedupes re-uploads of the same file.
- **Retries:** `attempts` counter; exponential backoff; dead-letter after 3.

### Upload validation (security-critical — see §9)

- Auth required (admin/uploader role).
- MIME + magic-byte check (not just extension); allowlist audio types.
- Size cap (matches the 25 MB post-preprocess Whisper limit, or `--local`).
- Filename sanitization → never use client filename as a path; generate `slug`.
- Virus/abuse: rate-limit uploads per user; cap concurrent jobs.

---

## 8. Storage, Backups & Disaster Recovery

### Layout

| Data | Store | Why |
|---|---|---|
| Metadata, translations, refs, jobs, analytics | **SQLite** on persistent disk | Transactional, queryable |
| Audio files | **Object storage (Cloudflare R2 / S3)** | Cheap, CDN-frontable, range requests; off the dyno & out of git |
| Large transcript blobs (optional) | Object storage | Keep the DB small if needed |
| Static frontend | Web dyno / CDN | — |

> Until Phase 3, audio stays in `audio_files/` on disk. R2 is the migration
> target, not a day-one requirement.

### Backups — **this is the highest-risk gap today**

A single SQLite file on one persistent disk = one disk failure from total loss.

- **Litestream** (recommended): streams the SQLite WAL continuously to R2/S3.
  Point-in-time restore, ~zero ops, designed exactly for single-instance SQLite.
- **Plus** a nightly `VACUUM INTO backup.db` snapshot copied to object storage
  (belt and suspenders).
- **Audio** in R2 has provider-side durability; keep the originals archived too.
- **Restore drill:** document and *test* the restore procedure (a backup you've
  never restored is a hope, not a backup).

### Disaster recovery checklist

- [ ] Litestream replicating to R2.
- [ ] Nightly snapshot to a second bucket/prefix.
- [ ] Restore procedure documented + tested.
- [ ] Secrets backed up in a password manager (not just Render env).
- [ ] `outputs/` + `audio_files/` originals archived (the source of truth for re-derivation).

---

## 9. Security

| Surface | Risk | Mitigation |
|---|---|---|
| Upload endpoint | Arbitrary file write / RCE | Auth + MIME/magic-byte allowlist + size cap + generated filenames (no client paths) |
| Admin endpoints | Token in URL/query (`?key=`) leaks in logs/referrers | Move to session cookie or `Authorization` header; rotate `ADMIN_TOKEN` |
| Auth | Credential stuffing | argon2/bcrypt hashes, rate-limit login, lock after N fails |
| Sessions | Token theft | HttpOnly + Secure + SameSite cookies; expiry; rotate on privilege change |
| XSS | Untrusted content in DOM | Keep `escHtml`/`escAttr` everywhere; CSP header; never `innerHTML` raw user/LLM text |
| SQL injection | String-built queries | `better-sqlite3` **prepared statements** only — never string-concat SQL |
| Path traversal | `:folder`/`:slug` → filesystem | Look up by DB id/slug, never join user input into a path |
| CSRF | State-changing GET/POST | SameSite cookies + CSRF token on mutating routes |
| Rate limiting | Abuse / cost blowup | Per-IP limits on public API; per-user on upload/translate |
| Secrets | Keys in repo/logs | `.env` only; never log keys; `.gitignore` verified; rotate if leaked |
| CORS | Cross-origin abuse | Lock `Access-Control-Allow-Origin` to the site origin |
| Dependencies | Supply chain | `npm audit` in CI; pin versions; Dependabot |
| Privacy | IP storage | Already SHA-256 truncated — keep; document retention |

Add standard hardening: `helmet` (security headers incl. CSP, HSTS),
`express-rate-limit`, request body size limits, and disable `x-powered-by`.

---

## 10. Reliability, Performance & Observability

### Reliability
- **Graceful degradation:** if Quran.com translation fetch fails, fall back to
  cached/stored text or English; never 500 the page.
- **Job recovery:** reconcile orphaned `running` jobs on startup.
- **Health check:** `GET /healthz` (DB ping + disk writable) for Render.
- **Graceful shutdown:** drain WS, finish in-flight DB writes on SIGTERM.

### Performance
- **Cache:** keep an in-memory cache of published khutbahs keyed by `slug+lang`;
  invalidate on publish/edit (not "never changes" — event-driven).
- **Audio:** serve via CDN with HTTP range requests (seeking). R2 + Cloudflare
  gives this free.
- **Frontend:** lazy-load the reader chunks; defer fonts; preconnect to CDN;
  cache-bust static assets by hash.
- **DB:** indexes per §5; prepared statements; `EXPLAIN QUERY PLAN` on hot paths.
- **N+1:** fetch refs for a khutbah in one query, not per-ref.

### Observability
- **Structured logging** (JSON) with request IDs; log levels via env.
- **Error tracking:** Sentry (or similar) for server + frontend exceptions.
- **Uptime:** an external pinger (UptimeRobot) on `/healthz`.
- **Metrics:** request latency, job duration, job failure rate, API spend per
  khutbah. A tiny `/admin/stats` over the DB covers most of it.
- **Audit log:** who published/edited/archived what (lightweight `audit` table or
  log line) — matters for a high-trust content domain.

---

## 11. Scalability & the SQLite Ceiling

SQLite + WAL comfortably handles this workload: reads dominate, writes are rare
(a publish, a view counter bump, a feedback row). Realistic ceiling is
**thousands of concurrent readers on one instance** — far beyond near-term need.

**The hard limit:** SQLite is single-machine. The moment you run **2+ web
instances**, they can't share one SQLite file safely (network-FS locking is
unreliable). Triggers to migrate to **Postgres**:

- You need horizontal scaling (multiple web dynos) for traffic or HA.
- Write concurrency becomes contended (many simultaneous uploads/translations).
- You want managed backups/replication without Litestream.

Because the data layer is isolated behind a thin DB module, the SQLite→Postgres
move is a driver swap + SQL dialect tweaks, not an app rewrite. Design the DB
access as a small module (`db.js`) with named query functions so the rest of the
app never touches SQL directly — this keeps the escape hatch cheap.

---

## 12. Cost Model

| Item | Cost | Notes |
|---|---|---|
| Groq Whisper | Free | Primary transcription |
| Claude analysis | Paid (per khutbah) | One analysis pass per khutbah |
| Claude translation | Paid (per khutbah **per language**) | Only prose; Quran/Hadith reuse published text |
| Gemini (optional) | Paid | `--gemini` hybrid for text quality |
| Render Starter | ~$7/mo | Web + persistent disk |
| Render Background Worker (if Phase 3b) | extra | Avoid until needed (use in-process worker) |
| Object storage (R2) | ~free egress | Audio + backups |
| **Cost-control levers** | | Cache translations (never re-run); Quran/Hadith via published text (no LLM); batch translation; prompt caching on the analysis/translate prompts |

The translation-cost multiplier is the thing to watch: N languages × M khutbahs ×
prose size. Caching + minimal-LLM sourcing (§6) keeps it linear and cheap.

---

## 13. Content Integrity (Religious Accuracy)

This is a high-trust domain — a wrong ayah/hadith attribution is a serious harm,
not a cosmetic bug. The architecture must make accuracy a first-class concern.

- **Review-before-publish gate** (`status: draft → published`) — no auto-publish
  of machine output.
- **Provenance on every claim:** keep `verification`, `confidence`,
  `detection_method` (already in the data) and surface them to reviewers.
- **Translator provenance:** `translations.translator` + `reviewed_by`. Mark
  machine translations clearly until human-reviewed.
- **Published Quran/Hadith text** (not LLM-generated) for citations wherever
  possible — higher trust than asking an LLM to render an ayah.
- **Immutable corrections trail:** prefer new versions / audit entries over silent
  edits, so a correction is traceable.
- **"Report an error" path** for the community (extend the existing feedback box,
  tie feedback to `khutbah_id`).

---

## 14. Legal, Licensing & Privacy

- **Quran translations are copyrighted.** Sahih International, Pickthall, etc.
  each have licenses/attribution terms. Store the translator ID + required
  attribution string and **display attribution** in the UI. Verify each chosen
  translation's terms before shipping it.
- **Hadith translations** similarly — attribute sunnah.com / the translation
  source.
- **Audio rights:** khutbahs from named imams/masajid — confirm permission to
  host/redistribute, especially for non-original (e.g. Makkah) recordings.
- **Privacy:** IPs already SHA-256-truncated (good). Add a short privacy note
  (what's collected: hashed IP, coarse geo, view counts; retention period).
  No PII beyond admin accounts.
- **Cookie/consent:** if you add analytics cookies, a basic consent notice may be
  needed depending on audience geography.

---

## 15. SEO, Accessibility & Frontend

### SEO
- Server-render (or pre-render) `<title>`, meta description, and **Open Graph /
  Twitter cards** per khutbah (title, masjid, date, summary, share image) so
  WhatsApp/social shares look right — the "Copy for WhatsApp" flow implies sharing
  is core.
- `sitemap.xml` of published khutbahs; `robots.txt`.
- **Structured data** (schema.org) for articles/audio.
- Canonical URLs; per-language `hreflang` tags once multi-lang ships.

### Accessibility
- Semantic landmarks, focus management, ARIA on the player controls (the SVG
  play/pause already replaced emoji — keep aria-labels).
- Color contrast on the dark theme (verify gold-on-green meets WCAG AA).
- Keyboard navigation for the player and language switcher.
- `lang` and `dir` attributes correct per content block (ties into §6 RTL).

### Frontend structure
- `public/index.html` is currently one large file (SPA + styles + logic). As it
  grows, consider splitting CSS/JS out for caching and maintainability — but not
  urgent; don't over-engineer a working page.

---

## 16. Testing & CI/CD

### Testing
- **Unit:** the pure pipeline functions (normalization, n-gram index, Jaccard,
  `buildReaderView`, timestamp search) — high-value, deterministic.
- **Golden-file tests:** run the pipeline on a fixed transcript and assert
  `result.json` ref identities + reader chunk alignment don't regress (the
  `CLAUDE.md` fix history shows how easily these break).
- **DB layer:** migration apply test; query functions against an in-memory SQLite.
- **API:** smoke tests for each route (200/404/auth).
- **Frontend:** at minimum a load-without-JS-errors check; ideally a Playwright
  pass on the reader (play, seek, switch khutbah, switch language).

### CI/CD
- GitHub Actions: `npm ci` → lint → `npm audit` → unit/golden tests on PR.
- **Migrations run on deploy**, inside a transaction, before the server accepts
  traffic. Fail the deploy if a migration fails.
- **Rollback:** Render keeps previous deploys; forward-only migrations mean a code
  rollback is safe as long as the new migration is additive (add columns/tables,
  don't drop). Destructive migrations need a backup-first policy.
- **Staging:** a second Render service on a branch for testing migrations against
  a copy of the DB before prod.

---

## 17. Phased Migration Plan

Additive only — no deletions. Each phase ships independently.

| Phase | Scope | Unblocks | Rollback |
|---|---|---|---|
| **0** | Add `better-sqlite3` + `migrations/001_init.sql`. Backfill the 2 published khutbahs (metadata from `PUBLIC_KHUTBAHS`, source + English from their `result.json`). Server reads DB; `PUBLIC_KHUTBAHS` kept as a seed only. | Publish without redeploy | DB is additive; revert server to read `PUBLIC_KHUTBAHS` |
| **1** | Formalize source↔translation split in API + frontend (`{source, translation[lang]}`, `available_langs`). Backfill English into `translations`. | Multi-lang seam | Frontend reads merged shape as before |
| **2** | `translate(source, lang)` worker pass + Urdu (RTL, fonts, switcher). Quran via published translations by ref ID. Hadith-in-Urdu decision (§6). | Multi-language ships | Hide non-en langs |
| **3a** | Auth (users/sessions) + upload endpoint + in-process worker + review/publish gate. | Remote publishing | Disable upload routes |
| **3b** | Object storage (R2) for audio + Litestream backups. Optional separate worker service. | Scale + durability | Keep disk audio fallback |

### Phase 0 concrete steps (when schema is signed off)
1. `npm i better-sqlite3`.
2. `db.js` — open DB, set PRAGMAs, run pending migrations, expose query functions.
3. `migrations/001_init.sql` — the schema in §5.
4. `scripts/backfill.js` — read each `PUBLIC_KHUTBAHS` entry + its `result.json`,
   insert `khutbahs` + `source_analyses` + `translations('en')` + refs. Idempotent
   (skip if `slug`/`legacy_folder` exists).
5. Switch `server.js` `/api/results*` to read from `db.js`; keep `resultCache` as
   an event-invalidated cache over DB reads.
6. Verify both khutbahs render identically (golden compare against current output).

---

## 18. Open Decisions

| # | Decision | Options | Leaning |
|---|---|---|---|
| 1 | Schema sign-off (§5) | as-is / changes | — needs you |
| 2 | Big blobs: in-DB TEXT vs. external files | in-DB / external | in-DB now, external later |
| 3 | Refs as rows vs. JSON | rows / JSON | rows (queryable) |
| 4 | Analytics + auth in same DB | one DB / split | one DB |
| 5 | SQLite driver | `better-sqlite3` | `better-sqlite3` |
| 6 | Hadith in Urdu/Bengali | English fallback / licensed dataset / machine-translate | English fallback first, flagged |
| 7 | Quran translation source | Quran.com API / local mirror | local mirror (no runtime dep) |
| 8 | Worker | in-process / separate service | in-process until volume |
| 9 | Auth method | password / magic-link / OAuth | magic-link or single admin password |
| 10 | URL scheme | `?folder=&lang=` / `/{slug}/{lang}` | path-based, keep `?folder=` redirect |

---

## 19. Appendix: Env Vars & API Surface

### Env vars (current + proposed)
```
# Current
ANTHROPIC_API_KEY   (required)
GROQ_API_KEY
OPENAI_API_KEY
GEMINI_API_KEY
HADITH_API_KEY      (unused — see CLAUDE.md fix #17)
ADMIN_TOKEN         (admin endpoints)
PORT

# Proposed (new)
DATABASE_PATH       (default data/khutbah.db)
SESSION_SECRET
R2_ACCOUNT_ID / R2_ACCESS_KEY / R2_SECRET / R2_BUCKET   (object storage)
LITESTREAM_*        (backup replication)
SENTRY_DSN          (error tracking)
QURAN_TRANSLATION_IDS  (per-language translator IDs)
```

### Proposed API surface (target)
```
Public
  GET  /                              SPA shell
  GET  /api/results                   { featured, items[] } (published only)
  GET  /api/results/:slug?lang=xx     { source, translation, available_langs }
  GET  /api/quran/:surah/:ayah?lang=  ayah text (+ translation by lang)
  GET  /audio/:slug                   audio stream (range) — later via R2/CDN
  POST /api/feedback                  { khutbah_id, message, contact }
  WS   /                              live/unique/total counts

Auth
  POST /api/auth/login                → session cookie
  POST /api/auth/logout

Admin / uploader (auth required)
  POST /api/upload                    multipart audio + metadata → job
  GET  /api/jobs/:id                  job status (or via WS)
  GET  /admin/review/:slug            draft review view
  POST /api/khutbahs/:slug            edit metadata / refs / translation
  POST /api/khutbahs/:slug/publish    status → published
  POST /api/khutbahs/:slug/archive    status → archived (soft delete)
  POST /api/khutbahs/:slug/translate  { lang } → enqueue translate job
  GET  /admin/feedback                (move off ?key= to session)
  GET  /admin/geo
  GET  /admin/stats                   spend / job health / counts
  GET  /healthz                       DB + disk health
```
