# KhutbahTranscribe — Claude Context File

This file is auto-loaded by Claude Code at session start. It captures the full implementation state, architectural decisions, and history of fixes so any new chat can pick up exactly where the last one left off.

---

## Deployment

- **GitHub:** https://github.com/MeerHusam/khutbah-transcribe (branch: `main`)
- **Render:** https://khutbah-live.onrender.com (Blueprint, **Starter plan**, auto-deploys on push to `main`)
- **Persistent disk:** 1 GB mounted at `/opt/render/project/src/data` — `views.json`, `geo_views.jsonl`, `feedback.jsonl` persist across restarts/redeploys
- **Admin feedback:** `https://khutbah-live.onrender.com/admin/feedback?key=<ADMIN_TOKEN>` (set in Render Environment tab)
- **Admin geo:** `https://khutbah-live.onrender.com/admin/geo?key=<ADMIN_TOKEN>` — city/country breakdown of visitors
- **Public name:** KhutbahTranscribe

---

## What This Project Does

Takes an Arabic Friday Khutbah (sermon) audio file and produces:
- **transcript.txt** — raw Arabic transcript (Whisper)
- **result.json** — structured JSON with translations, Quran refs, Hadith refs, timestamps
- **reader.txt** — annotated bilingual reader: Arabic prose block → English translation → Quran/Hadith citation badge
- **readable.txt** — plain text summary + full translation + ref list

---

## Key Files

| File | Role |
|------|------|
| `pipeline.js` | Main pipeline — transcription, Claude analysis, ref matching, output generation. Also exports all shared functions. |
| `reanalyze.js` | Re-runs Claude analysis on an existing `transcript.txt` without re-transcribing. Imports from `pipeline.js`. |
| `server.js` | Express + WebSocket server. Accepts audio uploads, spawns `pipeline.js` as child process, streams progress, serves `public/`. |
| `transcribe_local.py` | Python script for local transcription via faster-whisper or mlx-whisper. Called by `pipeline.js --local`. |
| `quran_detect.py` | **Prototype** Quran-detection helper using the `quran-detector` PyPI library (shells out like `transcribe_local.py`). Reads a transcript, prints detected verse fragments as JSON. NOT yet wired into the production pipeline — used for evaluation only. Needs the project `.venv` (Python ≥3.12). |
| `compare_quran.js` | **Eval harness.** Runs the current Quran pipeline (`prescanForQuranZones` + `scanTranscriptForQuran` + `buildZoneRefs`) and `quran_detect.py` on a transcript and prints a side-by-side + surah:ayah delta. Read-only. |
| `compare_transcripts.py` | Compares two transcripts (word coverage + sequence similarity). Used to compare Gemini vs Groq text in `--gemini` mode. |
| `live.js` | **Live khutbah engine** (first iteration, 2026-07-15). WebSocket-driven: receives ~12s mic chunks, Groq-transcribes each (rolling transcript tail as Whisper prompt for boundary context), re-runs `prescanForQuranZones` on the full rolling transcript, emits ordered feed events (prose / quran / hadith), translates prose live with Claude (`claude-opus-4-8`, structured JSON output that also flags quoted hadiths), verifies hadiths against local corpus + `resolveSunnahLinksForRefs`, saves session to `outputs/live_<ts>/` on stop. See "Live Mode" section below. |
| `public/live.html` | Live test page at `/live` — Start Listening (mic) button + live feed (Arabic instantly, English patched in, gold Quran cards, teal Hadith cards, raw-ASR ticker). Doubles as passive listener page. |
| `public/` | Frontend SPA. |

---

## Data Flow

```
audio file
  → preprocessAudio() [ffmpeg: loudnorm + 16kHz + silence prepend]
  → transcribeWithGroq() / transcribeWithAPI() / transcribeLocal() / transcribeWithGemini()
  → transcript (string) + transcriptSegments [{start, end, text}]
  → prescanForQuranZones(transcriptWords)   ← n-gram index scan
  → buildProseChunks(transcriptWords, quranZones, 30)
  → Claude API [ANALYSIS_PROMPT + numbered prose chunks]
      returns: chunk_translations[], summary, share_summary, quran_references[], hadith_references[]
  → findMatchingAyah() for each Claude quran ref  [Jaccard cross-check]
  → scanTranscriptForQuran()                       [Jaccard sliding window, threshold 0.65]
  → buildZoneRefs()                                [n-gram zone fallback for partial citations]
  → findMatchingHadith() + scanTranscriptForHadith()
  → resolveSunnahLinksForRefs()  ← searches sunnah.com for each matn → canonical permalink + narrator backfill
  → result.json  →  reader.txt  →  readable.txt
```

**`--gemini` is a hybrid:** Gemini supplies the *text* (best Arabic quality, ~14% more words than Groq), Groq Whisper runs in parallel purely for accurate per-word/segment *timestamps*, which Gemini's text is then aligned onto (no drift). Because Whisper is always used for timing, the 25 MB Whisper upload limit applies even in `--gemini` mode. `--gemini` also writes `transcript_groq.txt` (the Groq side of the hybrid) alongside `transcript.txt` so the two can be diffed with `compare_transcripts.py`.

---

## Core Architecture

### Quran Zone Pre-Scanning (most important piece)

**Problem it solves:** If an imam recites only half an ayah, the Jaccard sliding window (which needs the full ayah length) scores below 0.65 and misses it. Those ayah words then fall into a prose chunk → Claude translates the Arabic ayah text as if it were prose → wrong translation and no citation badge.

**Solution: n-gram index (`getQuranNgramIndex`)** — builds a 4-gram → [{pos_in_ayah, ayah_words, surah_id, ayah_id, surah_name, ayah_text}] map over the full Quran corpus. Any 4 consecutive transcript words matching a Quran 4-gram triggers a zone, regardless of total ayah length.

**Flow:**
1. `prescanForQuranZones(transcriptWords)` → `[{start, end, surah_id, ayah_id, surah_name, extra_ayahs?}]`
   - Scans transcript with 4-gram index, extends each hit forward/backward to maximize match length
   - Pads zone start by 2 words (PAD_START=2) to include imam's intro phrase ("قال تعالى" etc.)
   - Merges overlapping/adjacent zones; tracks all ayah identities (primary + `extra_ayahs[]`) when zones merge
2. `buildProseChunks(transcriptWords, quranZones, 30)` — breaks the non-zone words into 30-word numbered chunks sent to Claude for translation
3. Zone word ranges are saved to `result.json` as `prose_chunk_map: [{wordStart, wordEnd, proseIdx}]`
4. `buildReaderView` uses `prose_chunk_map` directly (not fixed 30-word slicing) to align chunks → translations

### Normalization

Two normalization functions:

**`normalizeArabic(text)`** — standard normalization used for Jaccard matching, fingerprinting, Hadith matching:
- Strips diacritics (tashkeel), tatweel, Quranic annotation marks
- Strips combining marks, superscript alef
- Normalizes alif wasla (ٱ→ا), hamzated alifs (آأإ→ا)

**`normalizeArabicDeep(text)`** — more aggressive, used ONLY for n-gram index building and pre-scan matching:
- Calls `normalizeArabic` first
- Then strips bare hamza (ء→'') — e.g. "ءامنوا" → "امنوا"
- Strips hamza-on-ya' (ئ→'') — NOT replacing with ي to avoid doubling ("سيئاتكم" → "سياتكم" not "سيياتكم"; corpus has it as "سياتكم")
- Maps hamza-on-waw (ؤ→و)

**Known limitation:** The quran-json corpus encodes يَـٰٓأَيُّهَا as a single token "ياايها" after normalization, while Whisper transcribes it as two tokens "يا" + "أيها". This prevents backward extension at that boundary — only causes 2 words at zone boundary to be missed. Accepted.

### Ref Detection Pipeline

Three layers, in order:
1. **Claude signal-phrase detection** — finds explicit citation markers ("قال الله تعالى" etc.), extracts Arabic text + identifies surah/ayah from knowledge
2. **Jaccard sliding window scan** (`scanTranscriptForQuran`) — slides window of each ayah's length across transcript, scores overlap. Threshold: 0.65. Catches ayahs cited without signal phrases.
3. **N-gram zone fallback** (`buildZoneRefs`) — for each zone whose identified ayah is absent from refs 1+2, creates a fallback ref. Minimum 5 words. Catches partial citations and du'a-section Quran phrases (2:201, 2:127, 2:128 etc.).

Each Claude ref is also cross-checked by `findMatchingAyah()` (Jaccard). Confidence and `verification` field reflect agreement:
- `claude+algorithm` — both agree (conf ≥ 0.95)
- `claude_only` — Claude identified, algo uncertain (conf 0.85)
- `algorithm_only` — algo found it, Claude was uncertain (conf = algo score)
- `DISAGREEMENT:claude=X:Y,algo=A:B` — they differ (conf 0.75, use Claude's ID)
- `ngram_zone` — found via zone fallback only (conf 0.8)

### `buildReaderView` — How the Reader Works

Locates every ref in the transcript by fingerprinting its first N words (increments N until unique match). Builds ordered segment list: prose chunks interleaved with refs. For prose segments, pulls translation from `chunk_translations[proseIdx]` using `proseIdx` from `prose_chunk_map`.

**Critical filter in `buildProseSegs`:** `filter(e => e.wordEnd > from && e.wordStart < to)` — uses `wordEnd > from` (not `wordStart >= from`) so chunks whose wordStart falls slightly inside a ref's span aren't silently dropped.

---

## Key Functions (pipeline.js)

| Function | Purpose |
|----------|---------|
| `normalizeArabic(text)` | Standard normalization for matching |
| `normalizeArabicDeep(text)` | Aggressive normalization for n-gram index |
| `getQuranNgramIndex(n=4)` | Lazy-cached 4-gram index over full Quran corpus |
| `prescanForQuranZones(words)` | Returns zone ranges + ayah identities from n-gram scan |
| `buildZoneRefs(zones, words, existingRefs)` | Fallback refs for zones not covered by Claude/Jaccard |
| `buildProseChunks(words, zones, size, segments)` | Numbered prose chunks sent to Claude — breaks at Whisper segment boundaries (breath pauses) rather than fixed word count; falls back to fixed-size if no segment info |
| `findMatchingAyah(text)` | Jaccard match of extracted text against Quran corpus |
| `scanTranscriptForQuran(transcript, found)` | Sliding-window scan, threshold 0.65 |
| `buildReaderView(transcript, result)` | Annotated bilingual reader output |
| `buildReadableOutput(result)` | Plain text summary + ref list |
| `findMatchingHadith(text, corpus)` | Jaccard match against local Hadith corpus |
| `scanTranscriptForHadith(transcript, found, corpus)` | Sliding-window Hadith scan, threshold 0.6 |
| `deduplicateHadithRefs(refs)` | Removes duplicate Hadith refs (subset text) |
| `loadHadithCorpus()` | Loads and pre-processes hadith_data/*.json files |
| `extractMatn(text)` | Strips isnad from hadith text, returns matn only |
| `resolveSunnahLink(detectedText, preferredSlug)` | Searches sunnah.com for the matn, returns the canonical `{collection_slug, hadith_number, link}` permalink. Disk-cached, resilient (null on failure). |
| `resolveSunnahLinksForRefs(refs)` | Post-pass over final hadith refs: replaces corpus number/link with the sunnah.com permalink + backfills narrator. Mutates in place; called by both pipeline.js and reanalyze.js. |
| `fetchSunnahNarrator(slug, number)` | Fetches a resolved sunnah.com hadith page and parses the narrator ("Narrated X:"). Cached. Only called for refs lacking a narrator. |
| `collectionToSlug(name)` / `slugToDisplay(slug)` | Map collection display name ↔ sunnah.com slug (bukhari, muslim, abudawud, nasai, ibnmajah, tirmidhi, …). |

All functions except `main()` are exported for use by `reanalyze.js`.

---

## result.json Structure

```json
{
  "share_summary": "2-3 sentence community WhatsApp summary",
  "summary": "3-5 sentence detailed summary",
  "chunk_translations": ["translation of chunk 1", "..."],
  "prose_chunk_map": [{"wordStart": 0, "wordEnd": 30, "proseIdx": 0}, ...],
  "quran_references": [{
    "detected_text": "Arabic text as it appeared in transcript",
    "matched": true,
    "surah_name": "Al-Baqarah",
    "surah_number": 2,
    "ayah_number": 185,
    "quran_link": "https://quran.com/2/185",
    "confidence": 0.95,
    "verification": "claude+algorithm",
    "detection_method": "signal_phrase | scan | ngram_zone"
  }],
  "hadith_references": [{
    "detected_text": "Arabic matn text",
    "narrator": "Abu Qatadah",
    "collection": "Sahih Muslim",
    "hadith_number": "1162a",
    "link": "https://sunnah.com/muslim:1162a",
    "confidence": 0.82,
    "detection_method": "signal_phrase | scan",
    "verification": "sunnah_search",
    "note": "Link verified via sunnah.com search | Matched against local corpus | Manual verification recommended"
  }],
  "transcript_segments": [{"start": 0.0, "end": 3.5, "text": "..."}],
  "transcript_words": [{"word": "الحمد", "start": 0.0}, {"word": "لله", "start": 4.08}],
  "metadata": {
    "processed_at": "ISO timestamp",
    "transcription_mode": "groq:whisper-large-v3 | openai:whisper-1 | local:...",
    "transcript_word_count": 1578,
    "quran_references_found": 17,
    "quran_references_matched": 17,
    "quran_references_by_scan": 2,
    "hadith_references_found": 8,
    "hadith_references_by_scan": 4
  }
}
```

---

## Issues Fixed

> Full root-cause analyses live in **[FIXES.md](FIXES.md)**. Add new fixes there with a one-line summary here.

| # | Fix | Key change |
|---|-----|-----------|
| 1 | Quranic ayah spillover into prose translations | Replaced Jaccard pre-scan with 4-gram index (`prescanForQuranZones`) |
| 2 | `buildReaderView` ignoring `prose_chunk_map` | Moved `proseChunkMap` declaration before segment loop |
| 3 | Missing prose block between ayahs (filter bug) | `filter(e => e.wordEnd > from && e.wordStart < to)` |
| 4 | Ash-Shu'ara 26:63 disappearing (Claude non-determinism) | `buildZoneRefs()` fallback creates ref from zone identity |
| 5 | `normalizeArabicDeep` ئ → ي doubling ya' | Strip ئ entirely instead of replacing with ي |
| 6 | "ووقنا" single-word prose block | Known cosmetic limit — waw-prefix variant unresolvable |
| 7 | Dua section ayahs missing | Zone refs now surface 2:201, 2:127, 2:128, 6:151 |
| 8 | Prose chunks cutting mid-sentence | Segment-boundary chunking (MIN=15, MAX=60 words) |
| 9 | Timestamp drift in reader chunks | Content-based text-search replaces sequential word counter |
| 10 | `--gemini` transcription mode | Hybrid: Gemini text + Groq Whisper timestamps (Needleman-Wunsch alignment) |
| 11 | `--local` path error | Pass `path.resolve(audioPath)` to `transcribe_local.py` |
| 12 | Timestamp drift (sequential proseIdx counter) | Same text-search fix as #9 |
| 13 | Word-level timestamp alignment (Gemini hybrid) | Needleman-Wunsch alignment; +1s silence offset fix |
| 14 | End-anchored reader-chunk timestamps | Prefer `transcript_words`; end-anchor cursor by trailing 3 words |
| 15 | Hadith rendered twice / leaking words | Merge overlapping segments in `buildReaderView`; attach badge once |
| 16 | Hadith narrator showing "unknown" | `ANALYSIS_PROMPT` asks Claude to identify narrator from knowledge |
| 17 | Wrong sunnah.com hadith links (numbering mismatch) | `resolveSunnahLink()` matn-searches sunnah.com directly |
| 18 | Narrator missing on scan-detected hadiths | `fetchSunnahNarrator()` parses narrator from sunnah.com page |
| 19 | 25 MB Whisper guard rejecting large raw files | Guard moved to after `preprocessAudio()` |
| 20 | `--gemini` not saving Groq transcript | `transcript_groq.txt` written alongside `transcript.txt` |
| 21 | Two-khutbah split detection | Claude marker + silence-gap; `splitChunkAtKhutbahBoundary`; divider in reader + frontend |
| 22 | Share-card design inconsistency (height-dependent shade) | Flat `#112519` base; In Short / Summary / Full Translation all use `.share-card` |
| 23 | Play/pause button shows as emoji on iOS | Replaced Unicode `▶`/`⏸` with inline SVG |
| 24 | Geo location tracking | `lookupGeo()` via ip-api.com; appends to `data/geo_views.jsonl` |
| 25 | Unique visitor count | SHA-256 hashed IPs persisted in `data/views.json`; broadcast as `unique` |
| 26 | Consecutive ayahs deduped (20:43 + 20:44) | Dedup trims earlier ref to next ref's start when surah:ayah differ; keeps both cards |
| 27 | Single-khutbah mode | `--single`/`--no-split` flag skips `locateSecondKhutbah` (Arafah, Eid, lectures) |

---

## Known Remaining Issues / Pending Work

### 26:62 Missing from reader.txt (nested-overlap case)
Ash-Shu'ara 26:62 (5 words) is in result.json but deduped out of reader.txt — its short detected_text is *nested* inside 26:63's range (not consecutive/in-order). Fix #26 deliberately left the nested case on the old longer-text behavior because trimming there can drop a tail of the enclosing ref. The general consecutive-ayah case (e.g. 20:43 + 20:44) is now handled — see fix #26.

### Muhammad 47:7 Duplicate
Signal-phrase ref and scan ref both identify 47:7. Both entries remain in result.json (deduplicated at display level only).

### PAD_START and Zone Ref Detected Text
Zone refs' `detected_text` starts from `zone.start` (includes the 2-word PAD), so the Quran card shows the imam's intro words. Cosmetically acceptable.

### True Matn Span for Hadith (fix #15 edge case)
Fetch canonical matn from the resolved sunnah.com page (fix #17), align it to the transcript to get the Hadith's real start/end word range, then gate Quran absorption in `buildReaderView` on the matched-matn span (not the nominal span). This prevents a non-Hadith ayah recited right after a Hadith from losing its 📖 card. Prereq (fix #17) already landed.

### quran-detector Augmenting Layer (TODO — next session)
`quran-detector` (PyPI, Python ≥3.12, `.venv`) evaluated 2026-05-22. Decision: AUGMENT (not replace). Add as a recall layer like `buildZoneRefs`: merge overlapping spans, pick one ayah per span (longest match, fewest errors), filter ritual phrases (isti'adha, basmala), map word-ranges to zones. Target `min_match≈4`. Catches du'a partials (e.g. Ibrahim 14:35) and consecutive-ayah ranges (20:43-44) that our pipeline misses. See `quran_detect.py` + `compare_quran.js`.

---

## Live Mode (2026-07-15, first iteration)

Real-time khutbah transcription + translation with live Quran/Hadith reference cards —
the differentiator over generic live translate. Test page: `http://localhost:3000/live`.

**Architecture (`live.js`):**
- Single WS endpoint `/ws/live` (host + listeners on same socket protocol). Control JSON:
  `{type:'start', title, mime, key}` / `{type:'stop'}`; binary frames = audio chunks.
  When `ADMIN_TOKEN` env is set, `start` requires `key` to match (open in local dev).
- Browser records mic via MediaRecorder restart-loop (12s standalone webm/opus blobs;
  mp4/aac on iOS Safari — both accepted by Groq directly, **no ffmpeg needed**).
- Per chunk (serialized promise queue → feed stays ordered): Groq whisper-large-v3
  (prompt = last 25 transcript words for cross-chunk decoder context, `timeout 25s,
  maxRetries 1` — fail fast, drop chunk rather than stall the queue) → append words →
  `prescanForQuranZones(allWords)` → emit pass.
- **Emit pass stability rule:** hold back last `HOLDBACK=3` words + any zone touching
  the transcript end (a zone starting in the last <4 words is only detectable next
  chunk; n-gram = 4). Zones `< 5` words → left in prose (basmala/isti'adha filter,
  mirrors `buildZoneRefs` threshold). `stop` runs a final pass with no hold-back.
- **Quran cards:** canonical Arabic from quran.json + English from `quran_en.json`
  (quran-json ships translations) + quran.com link. `extra_ayahs` from merged zones all
  emitted. Dedupe only against last 4 events (imams repeat refrains legitimately).
- **Prose:** event emitted immediately with Arabic (`pending:true`), Claude Opus 4.8
  translates with rolling AR/EN context (structured output `output_config.format`
  json_schema → `{translation, hadith|null}`), then `{type:'update'}` patches English in.
- **Hadith:** Claude flags quoted hadith in the segment → teal card immediately
  (narrator/collection from Claude knowledge) → `findMatchingHadith` against local
  corpus (loaded lazily at first session start, 29k entries) → async
  `resolveSunnahLinksForRefs` patches the authoritative sunnah.com permalink.
- On stop: session saved to `outputs/live_<ts>/` (`transcript.txt` +
  `live_session.json` with words+times+events) so the offline pipeline can re-analyze.
- `server.js` additions are minimal/additive: `/ws/live` routed before viewer-count
  logic, `GET /live`, `GET /api/live/status`.

**Tested** (2026-07-15, simulated feed of Arafah audio in 12s chunks): opening →
Al-Hajj 22:1+22:2 gold cards with correct canonical text/translation; hadith section
(~720s) → Tirmidhi + Abu Dawud cards with narrator "Abdullah ibn Amr ibn al-As" and
resolved sunnah.com links; dua ayahs 40:60, 2:201 caught. Feeder harness:
scratchpad `feeder.js` + ffmpeg-sliced chunks.

**Known v1 limitations:** Quranic phrases *inside* hadith text still get a Quran card
(same true-matn-span issue as offline fix #15 edge case); zone straddling an emitted
boundary shows truncated `detected_text` (card's canonical text correct); one lost
chunk on Groq timeout is dropped, not retried; QR-code join + separate host/listener
pages + production auth polish deferred (`qrcode` npm dep already installed).

## Public Listening Site Mode (2026-05-22)

The web app was converted from an upload tool into a **public, read-only listening
site**. The offline pipeline (`pipeline.js`, `reanalyze.js`, CLI) is unchanged — only
`server.js` + `public/` changed.

- **`server.js`**: upload route / multer / pipeline-spawn **removed**. WebSocket repurposed
  for **viewer counts**: `live` = concurrent WS connections, `total` = cumulative visits,
  `unique` = distinct IPs (SHA-256 hashed, first 16 chars, persisted as set in `data/views.json`).
  All three broadcast to clients on every connection/disconnect. Geo lookup on each WS connect
  via `ip-api.com` (free, no key, 3s timeout, skips private IPs) — appends
  `{ts, city, region, country, countryCode}` to `data/geo_views.jsonl`. Admin endpoints:
  `/admin/feedback?key=` and `/admin/geo?key=` (both require `ADMIN_TOKEN` env var).
  A curated `PUBLIC_KHUTBAHS` allowlist (folder + friendly title + featured flag) replaces
  the dump-all-folders listing; `/api/results` returns `{ featured, items[] }`,
  `/api/results/:folder` is allowlist-gated (404 otherwise). `PORT` env honored.
- **`public/index.html`**: now the **whole reader app** (single source of truth for the
  reader UI). Loads the featured khutbah by default or `?folder=<name>`, has a header
  khutbah `<select>` switcher, a **live · unique · visits** badge over WS, and a full
  mobile-responsive pass. Dark "mosque-at-night" theme: deep green-black palette, Amiri/Reem
  Kufi/Lora fonts, gold accents, SVG geometric star pattern. **In Short**, **Summary**, and
  **Full Translation** all use the `.share-card` style (green gradient, pattern overlay, gold
  border). Play/pause button uses inline SVG (not Unicode `▶`/`⏸` which render as emoji on iOS).
  The old sessionStorage hand-off is gone.
- **`public/results.html`**: reduced to a redirect to `/` (preserves `?folder=`).
- **Featured khutbah**: `outputs/2026-05-22T11-30-04_khutbah-2026-05-22-masjid` (audio
  `audio_files/khutbah-2026-05-22-masjid.m4a`). Second published: Sudais —
  `outputs/2026-05-22T21-05-05_makkah_sudais_ramadan_ummah` (audio
  `audio_files/makkah_sudais_ramadan_ummah.mp3`, 5.9 MB, now shipped).
- **In-memory cache**: `resultCache` (Map, keyed by folder) + `listCache` pre-warmed at
  server startup so zero file I/O on any request. Safe because files never change at runtime.
- **Deploy**: Render Starter plan (see `DEPLOY.md`, `render.yaml`). `.gitignore` bundles both
  audio files + the two published `outputs/` text folders (~12 MB total). Persistent disk
  mounts `data/` at `/opt/render/project/src/data` — views + feedback survive redeploys.
  `data/` and `hadith_data/` are not committed. `npm start` runs `node server.js`
  (`npm run pipeline` for the CLI).

## Environment / Setup

```bash
npm install              # Node deps (includes quran-json corpus)
cp .env.example .env     # Add ANTHROPIC_API_KEY, GROQ_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY (HADITH_API_KEY optional/unused)
node setup_hadith.js     # Downloads Hadith collections to hadith_data/
node server.js           # Web UI at http://localhost:3000

# Quran-detector prototype (eval only — Python >=3.12):
python3.12 -m venv .venv && ./.venv/bin/pip install quran-detector

# CLI usage:
node pipeline.js audio.mp3 --groq          # recommended (fast, free)
node pipeline.js audio.mp3 --gemini        # best Arabic quality (hybrid Gemini text + Groq timing)
node pipeline.js audio.mp3 --local         # Apple Silicon, offline
node reanalyze.js outputs/<folder>         # Re-run analysis without re-transcribing
node compare_quran.js outputs/<folder>     # Eval: current Quran pipeline vs quran-detector
```

**Transcription modes:**
- `--groq` — Groq whisper-large-v3, free, ~10s for 20min file (recommended for speed)
- `--gemini` — Gemini 2.5 Flash for text quality + Groq Whisper for timestamps (hybrid). Catches ~14% more words than Groq alone (observed: Sudais khutbah 1643 vs 1442). Also writes `transcript_groq.txt` for comparison. Uses `GEMINI_API_KEY`. See `transcribeWithGemini()` in pipeline.js.
- `--local` — mlx-whisper (Apple Silicon) or faster-whisper fallback. Must pass absolute path internally (fixed).
- default — OpenAI whisper-1 API (paid)

The **25 MB Whisper limit** is checked AFTER preprocessing (which compresses to ~48kbps mono MP3), so large raw files run fine; `--local` has no cap.

**API keys (`.env`):** `ANTHROPIC_API_KEY` (required), `GROQ_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `HADITH_API_KEY` (present but **unused** — hadithapi.com can't produce sunnah.com numbers, see fix #17; kept for possible future grade/English enrichment).

**Output folders:** `outputs/YYYY-MM-DDTHH-MM-SS_<filename>/` — `transcript.txt`, `result.json`, `readable.txt`, `reader.txt` (+ `transcript_groq.txt` in `--gemini`).

---

## Quran Corpus

Uses `quran-json` npm package (`node_modules/quran-json/dist/quran.json`). Structure: array of 114 surah objects, each with `id`, `name`, `transliteration`, `verses: [{id, text}]`. Verse `text` includes full tashkeel (diacritics) and Uthmanic script.

## Hadith Corpus

Local files in `hadith_data/` (downloaded by `setup_hadith.js`):
- `ara-bukhari.json`, `ara-muslim.json`, `ara-abudawud.json`, `ara-nasai.json`, `ara-ibnmajah.json`

Each file has `{hadiths: [{hadithnumber, text}]}`. The `text` field includes full isnad + matn. `extractMatn()` strips the isnad before matching.
