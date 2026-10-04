# KhutbahTranscribe — Claude Context File

This file is auto-loaded by Claude Code at session start. It captures the full implementation state, architectural decisions, and history of fixes so any new chat can pick up exactly where the last one left off.

---

## Deployment

- **GitHub:** https://github.com/MeerHusam/khutbah-transcribe (branch: `main`)
- **Site:** https://khutbah.dev (bought 2 Oct 2026 on Cloudflare Registrar; DNS on Cloudflare: CNAME `@` and `www` → `khutbah-live.onrender.com`, DNS only). Page requests to the old `khutbah-live.onrender.com` get a 301 to the same path on khutbah.dev (`server/server.js`; on main since 2 Oct, ca26a86 + 3a9c8dc); admin pages redirect too, only `/api` (health check) and `/admin/uploads` (upload worker) answer on both. Canonical links, `/sitemap.xml` and `robots.txt` point search engines at khutbah.dev.
- **Audio:** https://media.khutbah.dev, the R2 bucket `khutbah-media`'s custom domain (r2.dev address still on, unused).
- **Render:** service `khutbah-live` (Blueprint, **Starter plan**, auto-deploys on push to `main`)
- **Persistent disk:** 1 GB mounted at `/opt/render/project/src/data` — `site.db` (the published khutbahs), `outputs/` + `audio_files/` of khutbahs published through the API, `views.json`, `visits.jsonl`, `geo_views.jsonl`, `engage.jsonl`, `feedback.jsonl`, `uploads/` persist across restarts/redeploys
- **Admin feedback:** `https://khutbah.dev/admin/feedback?key=<ADMIN_TOKEN>` (set in Render Environment tab)
- **Admin traffic:** `https://khutbah.dev/admin/traffic?key=<ADMIN_TOKEN>` — views, places, khutbahs, sources, devices, listening
- **Upload page:** `https://khutbah.dev/admin/upload?key=<ADMIN_TOKEN>` — a recording from the masjid; the Mac's worker publishes it
- **Public name:** Khutbah.dev (KhutbahTranscribe until 2 Oct 2026; the repo keeps its name, Render deploys from it)

---

## What This Project Does

Takes an Arabic Friday Khutbah (sermon) audio file and produces:
- **transcript.txt** — raw Arabic transcript (Whisper)
- **result.json** — structured JSON with translations, Quran refs, Hadith refs, timestamps
- **reader.txt** — annotated bilingual reader: Arabic prose block → English translation → Quran/Hadith citation badge
- **readable.txt** — plain text summary + full translation + ref list

---

## Key Files

Restructured 2 Oct 2026 (branch `restructure`): `pipeline.js` is only the CLI; everything it runs lives in `core/`.
Phase 2 started 2 Oct 2026 (branch `phase2-sqlite`, on top of `restructure`): the published khutbahs are in SQLite on
Render's disk and khutbahs are published through an admin API, so publishing no longer commits or deploys. Node 22.
Run every script from the repo root (each loads `.env` from the working directory). `npm test` runs all tests.

| File | Role |
|------|------|
| `pipeline.js` | The CLI: `main()` runs a khutbah end to end as named stages — `parseArgs`, `createOutputFolder`, `getTranscript` (Gemini + Groq timing by default, `--groq` alone, or `--transcript` to reuse one), `analyzeWithClaude`, `findQuranRefs`, `findHadithRefs`, then the second-khutbah split, quote swaps and the output files. Imports from `core/`; nothing imports it. |
| `core/arabic.js` | Arabic normalisation, the Quran corpus and 4-gram index, recitation zones, ayah matching (`findMatchingAyah`, `scanTranscriptForQuran`, `matchClaudeQuranRef`: Claude's surah:ayah checked against the corpus), `buildZoneRefs`, `buildProseChunks`. |
| `core/hadith.js` | Hadith corpus, matching (`matchClaudeHadithRef`) and scanning, sunnah.com links and narrators, the liturgical-formula filter and `deduplicateHadithRefs`. |
| `core/analyze.js` | The Claude analysis prompt per khutbah type (`KHUTBAH_TYPES`, `buildAnalysisPrompt`), and where the second khutbah starts (`locateSecondKhutbah`, `splitChunkAtKhutbahBoundary`). |
| `core/reader.js` | `buildReaderView` (reader.txt) and `buildReadableOutput` (readable.txt), badges, published verse English, quote swaps applied. |
| `core/transcribe.js` | Audio preprocessing, Groq Whisper and the Gemini hybrid, word timings (alignment onto Groq times, windowed Groq, gap re-timing). Owns the Groq and Gemini clients. |
| `core/reader_chunks.js` | Builds the reader chunks from reader.txt + result.json; shared by the server, `verify_reader.js` and the voice scripts so all see the same blocks and timings. |
| `core/verify_reader.js` | The publish gate: asserts on what the reader actually renders (`node core/verify_reader.js outputs/<folder>`). |
| `core/check_english.js` | English checks run by `verify_reader.js`: swapped-in quotes (no new proper noun, no doubled framing, no dropped words, verse coverage), chunk/translation pairing by length ratio, planned swaps that drop numbers/names. |
| `core/quote_swaps.js` | Plans published-translation swaps for quotes inside prose (one claude-sonnet-5-5 call per quote, answers cached in `hadith_data/.swap_answers.json`); stores `english_swap` per ref. Run by `scripts/reanalyze.js` and the pipeline. |
| `core/review_blocks.js` | Stage C: second-model review of every reader block (claude-sonnet-5-5, ~$0.07/khutbah). Writes `review.json` flags; changes nothing. |
| `core/verse_excerpts.js` | For a verse the imam recited only in part, the matching part of each published translation, so the card (and the voice) shows just that part. |
| `server/server.js` | The site's wiring only (`npm start`): Express routers, static files, the viewer WebSocket, cache warm-up. |
| `server/db.js` | The site database (2 Oct 2026, phase 2): SQLite via Node's built-in `node:sqlite` at `DATA_DIR/site.db` (Render's disk). Table `khutbahs` (folder, slug, position, featured, title … old_slugs/old_folders as JSON, note, media_url: where its audio is on R2). `publishKhutbah` upserts by folder: a new one goes on top, featured moves, a changed slug is kept as a redirect, unsent old_slugs/old_folders/note are kept; a slug owned by another folder (or its old slug) is a 409. All SQL is here, so a move to Postgres changes this file only. |
| `server/khutbahs.seed.json` | The khutbahs published before the database; seeds a fresh database once. Not the live list (that is the database): editing it changes nothing on a running site. |
| `server/khutbahs.js` | The catalog (`catalog()`, rebuilt after each publish) and each khutbah's result (reader chunks, audio URL, voice tracks, word times), cached; `publish()` clears the caches. A khutbah's files: `DATA_DIR/outputs/<folder>/` and `DATA_DIR/audio_files/` (Render's disk, put there by the publish API; the repo's `outputs/` is only a fallback, used locally). An entry with `media_url` plays its recording and voice tracks from there (R2); every listed khutbah has one. `outputs/` and `audio_files/` left git on 3 Oct 2026 (the 9 older khutbahs' text was copied to the disk first): they live on the Mac only. |
| `server/routes/pages.js` | `/`, `/<slug>`, the old `/index.html?folder=` address; link-preview tags. |
| `server/routes/api.js` | `/api/results`, `/api/results/:folder`, `/api/quran`, voice tracks and word times, `/api/feedback`, `/api/engage`. |
| `server/routes/admin.js` | `/admin/feedback`, `/admin/traffic`, `/admin/upload` and the upload job API the Mac's worker uses, and the publish API: `PUT /admin/api/files/<folder>/<name>`, `PUT /admin/api/audio/<name>` (raw body, application/octet-stream), `POST /admin/api/khutbahs` (the entry). All need `ADMIN_TOKEN`. |
| `server/viewers.js` | Live / total / unique viewer counts over the WebSocket and the per-visit log (`data/visits.jsonl`, geo by ip-api.com). |
| `server/config.js` | ROOT, PORT, ADMIN_TOKEN and the data paths (`DATA_DIR` env for tests; default `<root>/data`, Render's disk). |
| `server/admin/` | `traffic.js` builds the /admin/traffic page; `upload.html` is the upload page. |
| `worker/publish.js` | One command from recording to a published page: remux/trim (faststart checked), pipeline, verify_reader, test entry, then publish through the site's API to `--site` (default `http://localhost:3000`, to check locally first; prints the exact command for the live site; `--no-site` stops after the checks). On khutbah.dev it also writes the entry into `server/khutbahs.seed.json` (as the database stores it), so the repo keeps the live list. Never commits or deploys. |
| `worker/site.js` | The publish API's client: uploads the files the site reads (`SITE_FILES`: result.json, reader.txt, reader_ur.txt, tts_*.json/mp3, words_imam.json), the recording, then the entry. With the `R2_*` settings in `.env` (Mac only), the recording and voice tracks go to Cloudflare R2 instead (bucket `khutbah-media`, key `<folder>/<file>`; S3 API signed with SigV4 in node:crypto, `r2()`), and the entry carries `media_url`. `siteSlugs()` lists the slugs in use. R2 set up 2 Oct 2026; public address is r2.dev (rate-limited) until a custom domain is bought. |
| `worker/autopublish.js` | Recording to live page with no one in between (1 Oct 2026): remux, `pipeline.js --gemini`, title (Sonnet 5.5, low), then [Urdu translate + review ‖ imam timing, delivery, echo removal only with `--clean` (off since 2 Oct)], `core/verse_excerpts.js`, [Urdu voice (Orus) ‖ English voice (Charon), both `--direct`: a passage at a time, word times come with it → recitation], `worker/publish.js --keep-audio --page reader-ur.html --site $SITE_URL`; a step that fails on a busy API runs again after a minute (up to 3 times) (the publish API: live at once, no deploy; checked), then one commit on main with the list and the test set (`server/khutbahs.seed.json`, `tests/khutbahs.json`; pull --rebase, push; only on branch main, a git failure is logged, never fatal; Render's build filter skips the deploy), `--no-push` = everything but publishing. Our masjid: link `/<date>`, featured; another masjid (`--masjid "Name"`): `/<date>-<masjid>`. `--resume outputs/<folder>` reruns a failed run keeping finished steps; `--no-push` for tests. Logs in `logs/<name>.log`. 3-min clip: 5.7 min.  A voice that cannot be made (every key spent, a refusal) no longer stops the run (3 Oct): the page goes live with its text, the job goes into `logs/voices_pending.json`, autopublish exits 4, and `upload_worker.js` runs it again with `--resume` hourly for up to a day, which adds the voices to the live page. The title is kept in `<folder>/title.txt` so a resumed run keeps it. publish.js no longer stops when the test set fails on *other* khutbahs (it warns). |
| `worker/upload_worker.js` | Runs on the Mac (`caffeinate -is node worker/upload_worker.js`, needs `ADMIN_TOKEN` in `.env`): every 15 s takes the oldest recording sent from the upload page (`/admin/upload?key=<ADMIN_TOKEN>`, stored on the Render disk in `data/uploads/`), downloads it to `audio_files/inbox/`, runs `autopublish.js --job <id>`, which reports each stage back to the page. Only calls out; nothing on the Mac is reachable. |
| `voice/tts.js` | Voice tracks (30 Sep 2026): speaks each reader block's English (`--lang en`) or Urdu (`--lang ur`). Engine: Gemini (`tts_gemini.mjs`; ElevenLabs removed 3 Oct 2026, in git history). `--tempo 1.15` speeds up without regenerating. Writes `tts_<lang>.mp3` + `.json`; the page's player offers the voice of the language on screen. Verses: meaning only, never synthesized Arabic; a lead-in ("Allah says:" / "ارشادِ باری تعالیٰ ہے:") only where the imam didn't introduce the verse. A 4 s pause goes before the second khutbah. `--direct` (Gemini, 1 Oct 2026): a direction per sentence from `voice_directions.js` and the voice a passage at a time; 25 Sep Urdu in Orus: 13 passages, $0.39 with directions. (Kokoro, Chatterbox and OmniVoice were removed 2 Oct 2026.) |
| `voice/tts_gemini.mjs` | Gemini TTS engine for `tts.js` (passages, directions, word times from the passage split). |
| `voice/voice_directions.js` | One style note per sentence of a voice track (1 Oct 2026), so the voice rises where the imam is stirred and softens in a du'a: Claude Sonnet 5.5 (high), one call for the whole khutbah, from each block's text, the imam's Arabic and `delivery_imam.json`; kept in `tts_<lang>_directions.json` per block, so only changed blocks are re-directed (~$0.08). Used by `tts.js --direct`. |
| `voice/align_words.py` | Word times for a voice track (30 Sep 2026): Meta's MMS forced aligner (`models/mms_fa/model.onnx`, run offline in `.venv-align`, no API) aligns each block's audio in `tts_<lang>.mp3` with the text the voice read, and adds `words: [[word, start, end], ...]` to each block of `tts_<lang>.json`. `.venv-align/bin/python voice/align_words.py outputs/<folder> ur`. The page lights the spoken word and matches these words to the text it shows. Setup in its header. Measured on 25 Sep: word starts within 60 ms of the sound for 96% (Urdu) and 91% (English) of phrase starts. |
| `voice/align_imam.js` | The same for the imam's recording: aligns each reader block's Arabic (`start_time` to the next block's) with the aligner in job mode (more padding, a spare slot at both ends) and writes `words_imam.json`. `node voice/align_imam.js outputs/<folder> audio_files/<recording>`. 25 Sep: median 20 ms from the sound, where the old transcript word times were 270 ms off. |
| `voice/imam_delivery.py` | How the imam delivered each block (1 Oct 2026): loudness, pitch height and movement, pace, as z-scores against his own average, from his recording and `words_imam.json` → `delivery_imam.json`. Local, ~4 s. Read by `voice_directions.js`. |
| `voice/clean_audio.py` | Takes the hall out of a khutbah recording (30 Sep 2026), no model: the room's background and decay are measured in the longest silence (between the two khutbahs), then late reverberation is spectrally subtracted and the distinct echo (130–190 ms, the far loudspeakers) removed by long-delay linear prediction. `.venv-clean/bin/python voice/clean_audio.py <recording> outputs/<folder> <out.wav>`, same timeline as the recording, ~12 s for 16 min. 25 Sep: speech 18 dB above the gaps (was 10), echo 0.24 → 0.02, words as audible as before. The recitation clips in the voice tracks are cut from it. |
| `voice/recite.js` | The dars format for a voice track (30 Sep 2026): before each verse's translation, the imam's own recitation of it, cut from his recording (never synthesized, never sped up) at the voice's loudness; a lead-in ("Allah says:") stays before the Arabic. Rewrites `tts_<lang>.mp3/.json` in place, moving block starts and word times, and marks the manifest `recited` so it never runs twice. Order: `tts.js` → `align_words.py` → `align_imam.js` → `recite.js`. Local, no API. |
| `urdu/translate_urdu.js` | Urdu groundwork: Arabic→Urdu per chunk (claude-opus-5-5, high; everyday words a khateeb uses, not bookish ones, since 1 Oct 2026; `review_urdu.js` then corrects it), Junagarhi verses (PLACEHOLDER), fawazahmed0 urd-* hadith; writes `result.urdu` + `reader_ur.txt`. Page shows an English/اردو switch. |
| `urdu/review_urdu.js` | Stage C for the Urdu: corrects each block against the Arabic (English as a second reference), then rebuilds `reader_ur.txt` with `translate_urdu.js`. |
| `scripts/reanalyze.js` | Re-runs Claude analysis on an existing `transcript.txt` without re-transcribing. Imports from `core/`. |
| `scripts/load_test.js` | Many visitors at once against a local copy of the site (`--visitors 1000 --over 60 --hold 30`): page, text, viewer socket, engagement beacons; prints response times, errors, live count, memory. 2 Oct 2026: 1000 in 10 s, 0 errors, all under 10 ms, 89 MB. Run before a big Friday. |
| `scripts/setup_hadith.js` | Downloads the Hadith collections into `hadith_data/` (skips files already there). |
| `tests/` | `npm test`: `test_khutbahs.js` (every published khutbah's reader against `khutbahs.json`, on disk and `--rebuild`), `server.test.js` (routes, viewer socket, upload API and publishing through `worker/site.js`, on a real server with an empty DATA_DIR and a fresh database), `pipeline.test.js` (pipeline.js end to end on `tests/fixture/`'s transcript with Claude stubbed by `tests/stubs/`; must pass the gate). `tests/fixture/` = 2 Oct 2026's run (text only); the server test gives it to every listed khutbah. `test_khutbahs.js` skips folders that are not on disk, so on GitHub Actions (no `outputs/`) it checks nothing: run `npm test` on the Mac before a change to the reader. Free, offline; GitHub Actions runs it (`.github/workflows/test.yml`, Node 22). |
| `requirements/` | Pinned Python deps for `.venv-align` (align.txt: MMS aligner, imam_delivery) and `.venv-clean` (clean.txt). |
| `public/` | The pages: `home.html` (landing), `index.html` (reader), `reader-ur.html` (reader with Urdu and voices; entries name it with `page`), `recited.js` (shared with the voice scripts), `results.html` (old-link redirect). |
| `docs/` | FIXES (root causes of every fix), DEPLOY, recordings. |

---

## Data Flow

```
audio file
  → preprocessAudio() [ffmpeg: loudnorm + 16kHz + silence prepend]
  → transcribeWithGemini() (default: Gemini text + Groq timing) / transcribeWithGroq() (--groq)
  → transcript (string) + transcriptSegments [{start, end, text}]
  → prescanForQuranZones(transcriptWords)   ← n-gram index scan
  → buildProseChunks(transcriptWords, quranZones, 30)
  → Claude API [buildAnalysisPrompt(type) + numbered prose chunks]
      returns: chunk_translations[], summary, share_summary, quran_references[], hadith_references[]
  → matchClaudeQuranRef() for each Claude quran ref  [findMatchingAyah Jaccard cross-check]
  → scanTranscriptForQuran()                       [Jaccard sliding window, threshold 0.65]
  → buildZoneRefs()                                [n-gram zone fallback for partial citations]
  → findMatchingHadith() + scanTranscriptForHadith()
  → resolveSunnahLinksForRefs()  ← searches sunnah.com for each matn → canonical permalink + narrator backfill
  → result.json  →  reader.txt  →  readable.txt
```

**The default (`--gemini`) is a hybrid:** Gemini supplies the *text* (best Arabic quality, ~14% more words than Groq), Groq Whisper runs in parallel purely for accurate per-word/segment *timestamps*, which Gemini's text is then aligned onto (no drift). Because Whisper is always used for timing, the 25 MB Whisper upload limit applies even in `--gemini` mode. `--gemini` also writes `transcript_groq.txt` (the Groq side of the hybrid) alongside `transcript.txt` so the two can be compared.

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

## Key Functions (core/)

| Function | Purpose |
|----------|---------|
| `normalizeArabic(text)` | Standard normalization for matching |
| `normalizeArabicDeep(text)` | Aggressive normalization for n-gram index |
| `getQuranNgramIndex(n=4)` | Lazy-cached 4-gram index over full Quran corpus |
| `prescanForQuranZones(words)` | Returns zone ranges + ayah identities from n-gram scan |
| `buildZoneRefs(zones, words, existingRefs)` | Fallback refs for zones not covered by Claude/Jaccard |
| `buildProseChunks(words, zones, size, segments)` | Numbered prose chunks sent to Claude — breaks at Whisper segment boundaries (breath pauses) rather than fixed word count; falls back to fixed-size if no segment info |
| `findMatchingAyah(text)` | Jaccard match of extracted text against Quran corpus |
| `matchClaudeQuranRef(ref)` | One of Claude's Quran refs → matched ref: agreement with `findMatchingAyah`, tie-break by word coverage, confidence and `verification` |
| `matchClaudeHadithRef(ref, corpus)` | One of Claude's hadith refs → ref with corpus collection/number when its text matches |
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

Each is exported by its `core/` module and imported from there (`pipeline.js` no longer re-exports anything).

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

> Full root-cause analyses live in **[docs/FIXES.md](docs/FIXES.md)**. Add new fixes there with a one-line summary here.

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
| 28 | Phone-recorded audio won't stream (`moov` at end of file) | Remux on ingest: `ffmpeg -i in.m4a -c copy -movflags +faststart out.m4a` — see "Audio ingest" below |
| 29 | Reader highlight up to 30 s behind the imam (Whisper dropped ~90 s of a long file) | `--gemini` timing uses 90 s overlapping Groq windows with no prompt (the prompt caused repetition loops) + re-times any long unanchored gap; `retime.js` applies it to old runs; `reanalyze.js` refuses to write if chunk boundaries change |
| 30 | Narrator showed the successor (Tirmidhi 2910, 3585) | `parseSunnahNarrator` + `chooseNarrator` keep the Companion |
| 31 | Published swaps inserted wrong clauses (Ashura, Laylat al-Qadr) | Exact planned swaps (`quote_swaps.js`) or "our translation" label; `check_english.js` |
| 32 | Sudais English one block off from chunk 59 | Translations re-paired; length-ratio pairing check |
| 33 | Second khutbah's first word timed in the sitting pause | Pause-aware `interpolateAnchors`; `settleLoneWords` |
| 34 | Hadith carded from a collection the imam didn't name ("رواه الامام البخاري", "الشيخان") | `imamAttributionSlug` skips "الامام"/"في"; "الشيخان"/"الصحيحين" = Bukhari |
| 35 | Verse edges missed where the mushaf's spelling differs (يااولي, ذِكْرَىٰ, ذَٰلِكَ, ٱلَّيْل): the verse's words stayed in the prose and the English repeated them beside the card (2 Oct Makkah, 3 blocks) | `normalizeArabicDeep`: alefs dropped, ى/ة folded, the joined vocative split, الليل; `verify_reader` 2f fails a chunk whose words render in a card |
| 36 | Hadith linked to the first collection sunnah.com listed (Abu Dawud 4862 for a hadith in Bukhari and Muslim) | `pickSunnahResult`: with no collection named by the imam, Bukhari, then Muslim, … among results within 0.1 of the best |
| 37 | Urdu without صلی اللہ علیہ وسلم after the Prophet's name where the imam didn't say it, and امام for الأئمة (rulers) | `translate_urdu.js` / `review_urdu.js` prompts |
| 38 | English one block off: 57 translations for 58 chunks (18 Sep Madinah) | `chunk_translations` keyed by chunk number; `completeChunkTranslations` translates a missing one alone |
| 39 | English dropped Quranic words inside a chunk, translated restarts twice, kept "makhmum" | Analysis prompt and `translateChunk` rules |
| 40 | Ayah cards for the imam's own Quranic phrasing (43:85, 6:151, 19:93) | `dropBorrowedPhrases` before the chunks are cut |
| 41 | Narrator: the Successor who tells the story (Bukhari 7324, Abu Dawud 5004) | `parseSunnahNarrator`: "We were with X", "The Companions … told us" |
| 42 | 49:17 stopped short at هَدَىٰكُمْ | `normalizeArabicDeep`: ىٰ inside a word is an alef |
| 43 | 65:3's card before 65:2's; isti'adha cut to "I seek refuge" | `splitAtCitations`, `trimIstiadha` in the pre-scan |
| 44 | Urdu عنہم for two Companions | Urdu prompts: عنہما |

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

### quran-detector Augmenting Layer (idea)
`quran-detector` (PyPI, Python ≥3.12) evaluated 2026-05-22. Decision: AUGMENT (not replace). Add as a recall layer like `buildZoneRefs`: merge overlapping spans, pick one ayah per span (longest match, fewest errors), filter ritual phrases (isti'adha, basmala), map word-ranges to zones. Target `min_match≈4`. Catches du'a partials (e.g. Ibrahim 14:35) and consecutive-ayah ranges (20:43-44) that our pipeline misses. The eval scripts (`scripts/quran_detect.py`, `scripts/compare_quran.js`) were removed 3 Oct 2026; restore them from git history (`git log --all -- scripts/compare_quran.js`).

---

## Live Mode (removed 2 Oct 2026)

Two real-time attempts were removed in the restructure: the chunked Groq engine (`live.js`, `/live`,
July 2026) and the Speechmatics stream (`live/`, `/stream`). Neither worked well enough to use; real
time is to be rebuilt fresh, measured by replaying recorded khutbahs. What was learned (hold back
zones touching the transcript end, since a 4-gram zone is only detectable a chunk later; fail fast on
a slow Groq chunk rather than stall the queue; rolling AR/EN context for Claude) is in git history
(including `docs/STREAMING.md`, removed 3 Oct 2026).

## Public Listening Site Mode (2026-05-22)

The web app was converted from an upload tool into a **public, read-only listening
site**. The offline pipeline (`pipeline.js`, `reanalyze.js`, CLI) is unchanged — only
`server.js` + `public/` changed.

- **`server/`** (split by concern 2 Oct 2026, see Key Files): WebSocket for **viewer counts** (`viewers.js`): `live` = concurrent WS connections, `total` = cumulative visits,
  `unique` = distinct IPs (SHA-256 hashed, first 16 chars, persisted as set in `data/views.json`).
  All three broadcast to clients on every connection/disconnect. Geo lookup on each WS connect
  via `ip-api.com` (free, no key, 3s timeout, skips private IPs) — appends
  `{ts, city, region, country, countryCode}` to `data/geo_views.jsonl`. Admin endpoints:
  `/admin/feedback`, `/admin/traffic`, `/admin/upload` (all `?key=` = `ADMIN_TOKEN`).
  A curated allowlist, the `khutbahs` table in `server/db.js` (folder + friendly title + featured flag), replaces
  the dump-all-folders listing; `/api/results` returns `{ featured, items[] }`,
  `/api/results/:folder` is allowlist-gated (404 otherwise). `PORT` env honored.
- **`public/home.html`**: the **landing page**, served at `/` (`app.get('/')`). It has no
  audio player — linking someone to `/?folder=<name>` shows the landing page, not the reader.
- **`public/index.html`**: the **whole reader app** (single source of truth for the reader
  UI), reached at **`/index.html?folder=<name>`** via `express.static`. Loads the featured
  khutbah by default or `?folder=<name>`, has a header
  khutbah `<select>` switcher, a **live · unique · visits** badge over WS, and a full
  mobile-responsive pass. Dark "mosque-at-night" theme: deep green-black palette, Amiri/Reem
  Kufi/Lora fonts, gold accents, SVG geometric star pattern. **In Short**, **Summary**, and
  **Full Translation** all use the `.share-card` style (green gradient, pattern overlay, gold
  border). Play/pause button uses inline SVG (not Unicode `▶`/`⏸` which render as emoji on iOS).
  The old sessionStorage hand-off is gone.
- **`public/results.html`**: reduced to a redirect to `/` (preserves `?folder=`).
- **Published khutbahs**: the list is the database on Render's disk; `server/khutbahs.seed.json`
  is its copy in the repo (autopublish.js commits it after each publish).
- **Audio ingest (manual step)**: `pipeline.js` never rewrites the source file, so whatever
  lands in `audio_files/` is what the browser streams. Phone/WhatsApp recordings put the
  `moov` atom *after* `mdat`, which means the player shows 0:00 until the whole file
  downloads. Always remux before publishing:
  `ffmpeg -i in.m4a -c copy -movflags +faststart out.m4a` (lossless, no re-encode).
  Verify with `ffprobe` or by checking that `moov` precedes `mdat`.
  Note: VS Code's built-in Simple Browser has no AAC decoder — every `.m4a` silently
  fails there with no console error. Test the player in Firefox/Safari/Chrome.
- **In-memory cache** (`server/khutbahs.js`): `resultCache` (Map, keyed by folder) + `listCache` pre-warmed at
  server startup so zero file I/O on any request. Safe because files never change at runtime.
- **Deploy**: Render Starter plan (see `docs/DEPLOY.md`, `render.yaml`). No audio or pipeline runs
  in git. `render.yaml`'s `buildFilter` deploys only when the server, the pages,
  `core/reader_chunks.js` or the packages change: a deploy is ~75 s of 502 (a disk service cannot
  overlap deploys; Render offers no zero-downtime deploy with a disk). Persistent disk
  mounts `data/` at `/opt/render/project/src/data` — views + feedback survive redeploys.
  `data/` and `hadith_data/` are not committed. `npm start` runs `node server/server.js`
  (`npm run pipeline` for the CLI).

## Environment / Setup

```bash
npm install                    # Node 22.13+ (node:sqlite); deps include the quran-json corpus
cp .env.example .env           # ANTHROPIC_API_KEY, GEMINI_API_KEY, GROQ_API_KEY (+ ADMIN_TOKEN, VERTEX_API_KEY; see the file)
node scripts/setup_hadith.js   # Downloads Hadith collections to hadith_data/
npm start                      # the site at http://localhost:3000
npm test                       # reader checks, server, pipeline end to end (free, offline)

# Python environments (voice and audio steps): requirements/*.txt, each with its setup line

# CLI usage:
node pipeline.js audio.mp3                   # Gemini text + Groq timing (default; --gemini says the same)
node pipeline.js audio.mp3 --groq            # Groq alone: free, fast, rougher text
node pipeline.js --transcript outputs/<run>/transcript.txt   # reuse a transcript and its timings
node scripts/reanalyze.js outputs/<folder>   # Re-run analysis without re-transcribing
```

**Transcription modes:**
- default (`--gemini`) — Gemini 3.5 Flash for text quality (2.5 Flash until 3 Oct 2026: closed to new keys; if 3.5 Flash is closed or busy, 3.1 Pro, then 3.6 Flash, then Groq's own text — `result.json` metadata.transcription_mode names the one used) + Groq Whisper for timestamps (hybrid). Catches ~14% more words than Groq alone (observed: Sudais khutbah 1643 vs 1442). Also writes `transcript_groq.txt` for comparison. See `transcribeWithGemini()` in core/transcribe.js.
- `--groq` — Groq whisper-large-v3 alone, free, ~10s for a 20 min file.
- (OpenAI whisper-1 and `--local` faster-whisper were removed 2 Oct 2026: nothing used them.)

The **25 MB Whisper limit** is checked AFTER preprocessing (which compresses to ~48kbps mono MP3), so large raw files run fine.

**API keys (`.env`):** `ANTHROPIC_API_KEY` (required), `GEMINI_API_KEY`, `GROQ_API_KEY`; `GEMINI_API_KEY2`… and `VERTEX_API_KEY` for more voice requests (see the quota note below); `ADMIN_TOKEN` for the admin pages and the upload worker. (hadithapi.com was never used: it can't produce sunnah.com numbers, see fix #17.)

**Gemini voice quota (2–3 Oct 2026):** `gemini-3.8-flash-tts` on the Gemini API allows **100 requests per day per Google project** on Tier 1 (10 a minute, 10K tokens a minute); paying more does not raise it, and requests turned away for the per-minute limit still count toward the 100 (3 Oct: both voices at once, 21 a minute, the day gone after 31 passages). Since 3 Oct `voice/tts_gemini.mjs`: (1) voices a passage of ~4,000 characters (~5 min) per request, about 4 per voice per khutbah; (2) paces itself to 8 requests and 9,000 tokens a minute per key; (3) uses `GEMINI_API_KEY`, `GEMINI_API_KEY2`, … in turn (one per project: Default Gemini Project = gen-lang-client-0711520646, and meerhusam-mynotes), remembering a spent key in `.tts_cache/gemini/limits.json` until the reset the API gave; (4) then the **same model on Google Cloud's Agent Platform** (`VERTEX_API_KEY`, pay per use, no daily quota; with an API key each sentence's direction goes as a 5-word `[cue]`, since a full direction in brackets is read aloud); (5) a passage Gemini refuses (`content_blocked`) is voiced again without directions, then block by block. autopublish voices Urdu first, then English, never both at once. Test: `tests/voice_routes.test.js`. The Gemini SDK must keep `maxRetries: 0` (it otherwise sleeps the ~14 h `retry-after` silently).


**Output folders:** `outputs/YYYY-MM-DDTHH-MM-SS_<filename>/` — `transcript.txt`, `result.json`, `readable.txt`, `reader.txt` (+ `transcript_groq.txt` in `--gemini`).

---

## Quran Corpus

Uses `quran-json` npm package (`node_modules/quran-json/dist/quran.json`). Structure: array of 114 surah objects, each with `id`, `name`, `transliteration`, `verses: [{id, text}]`. Verse `text` includes full tashkeel (diacritics) and Uthmanic script.

## Hadith Corpus

Local files in `hadith_data/` (downloaded by `scripts/setup_hadith.js`):
- `ara-bukhari.json`, `ara-muslim.json`, `ara-abudawud.json`, `ara-nasai.json`, `ara-ibnmajah.json`

Each file has `{hadiths: [{hadithnumber, text}]}`. The `text` field includes full isnad + matn. `extractMatn()` strips the isnad before matching.
