# KhutbahTranscribe — Claude Context File

This file is auto-loaded by Claude Code at session start. It captures the full implementation state, architectural decisions, and history of fixes so any new chat can pick up exactly where the last one left off.

---

## Deployment

- **GitHub:** https://github.com/MeerHusam/khutbah-live (branch: `main`)
- **Render:** https://khutbah-live.onrender.com (Blueprint, **Starter plan**, auto-deploys on push to `main`)
- **Persistent disk:** 1 GB mounted at `/opt/render/project/src/data` — `views.json`, `geo_views.jsonl`, `feedback.jsonl` persist across restarts/redeploys
- **Admin feedback:** `https://khutbah-live.onrender.com/admin/feedback?key=<ADMIN_TOKEN>` (set in Render Environment tab)
- **Admin geo:** `https://khutbah-live.onrender.com/admin/geo?key=<ADMIN_TOKEN>` — city/country breakdown of visitors
- **Public name:** KhutbahLive

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

## Issues Fixed (Session History)

### 1. Quranic Ayah Spillover into Prose Translations
**Symptom:** An-Nahl 16:125, Ash-Shu'ara 26:62/63 — Arabic ayah text appeared inside the prose block's English translation instead of being isolated as a Quran card.

**Root cause:** The old pre-scan used a Jaccard sliding window (same as the main scan) which requires near-full ayah coverage to score ≥ 0.65. Partial citations (imam recites half an ayah) scored too low → zone not created → ayah words fell into the prose chunk → Claude translated ayah text as regular prose.

**Fix:** Replaced Jaccard pre-scan with n-gram index (`prescanForQuranZones`). Any 4 consecutive transcript words matching any Quran 4-gram create a zone.

### 2. `buildReaderView` Ignoring `prose_chunk_map`
**Symptom:** Even with correct zones, reader.txt was mis-aligning translations for Arabic blocks — wrong English chunk showing under Arabic text.

**Root cause:** `proseChunkMap` variable was declared AFTER the segment-building loop, and the fallback was splitting prose into fixed 30-word chunks instead of using the zone-aware map entries.

**Fix:** Moved `proseChunkMap` declaration before the segment loop, replaced fixed-chunk fallback with `buildProseSegs()` helper that uses `prose_chunk_map` entries directly (via `proseIdx`).

### 3. Missing Prose Block Between Ayahs (filter bug)
**Symptom:** Prose text between Ta-Ha 20:43 and An-Nahl 16:125 was "wiped out" — not appearing in reader.txt.

**Root cause:** `buildProseSegs` used `filter(e => e.wordStart >= from)` — when a ref's `endWord` overshot by 1 word (cursor=307), the chunk starting at wordStart=306 was filtered out because 306 < 307.

**Fix:** Changed filter to `filter(e => e.wordEnd > from && e.wordStart < to)` — inclusive of chunks whose wordStart is slightly before the cursor.

### 4. Ash-Shu'ara 26:63 Disappearing (Claude non-determinism)
**Symptom:** On one reanalyze run 26:63 was in refs (12/12); on another it disappeared (11/11) because Claude non-deterministically missed it.

**Root cause:** Claude sometimes misses ayahs in one run. The Jaccard scan also can't catch it (partial citation, score < 0.65).

**Fix:** `buildZoneRefs()` — uses the ayah identity now stored per zone in `prescanForQuranZones`. If 26:63's zone exists but 26:63 isn't in refs from Claude/Jaccard, a fallback ref is created from the zone's transcript words.

### 5. `normalizeArabicDeep` — ئ → ي doubling ya'
**Symptom:** "سيئاتكم" in the transcript was normalizing to "سيياتكم" (double ي) which didn't match the corpus "سياتكم".

**Root cause:** Initially replaced ئ with ي, but in the transcript the ي before ئ is already a separate character — replacing ئ with ي doubled it.

**Fix:** Strip ئ entirely (→ '') since the preceding ي is already present. Corpus "سياتكم" = transcript "سيئاتكم" stripped to "سياتكم". ✓

### 6. "ووقنا" Single-Word Prose Block
**Symptom:** The word "ووقنا" appeared as a tiny standalone prose block between zones.

**Root cause:** Zone [1521-1531] ends before "ووقنا", zone [1532-1547] starts after it. The transcript has "ووقنا" (extra waw prefix) while the corpus has "وقنا" — normalization doesn't strip waw prefixes, so the n-gram can't match it, creating a 1-word gap between zones.

**Status:** Known cosmetic limitation. The imam's pronunciation variant "ووقنا" vs corpus "وقنا" can't be reconciled at normalization level.

### 8. Prose Chunks Cutting Mid-Sentence (Fixed-Size Chunking)
**Symptom:** reader.txt prose blocks cut mid-phrase because `buildProseChunks` sliced every 30 words regardless of natural speech boundaries.

**Root cause:** The fixed 30-word slice had no awareness of where the imam paused to breathe. Whisper segments already encode these pause boundaries (each segment ends where speech stops) but were ignored.

**Fix:** `buildProseChunks` now accepts `transcriptSegments` and builds a set of word-index positions where each segment ends. The `flush()` inner function accumulates consecutive segments until the chunk reaches MIN_CHUNK (15 words), then emits at the segment boundary. A MAX_CHUNK (60 words) hard cap splits unusually long single segments. Falls back to fixed 30-word slicing if no segment info is available. Call sites in `pipeline.js` and `reanalyze.js` both pass `transcriptSegments`.

### 9. Timestamp Drift in Reader Chunks (server.js)
**Symptom:** Timestamps shown next to reader chunks were accurate at the start but drifted further behind the actual audio position as the khutbah progressed — by ~2 minutes 47 seconds off at the end of a 22-minute khutbah.

**Root cause:** `server.js` built a word-time array from all transcript segments (full transcript, including Quran zone words), then tracked position with `wordCursor` counting only prose chunk words. Every Quran zone skipped in the reader (no prose translation) added its word count to the drift. With ~17 ayah zones accumulating over the khutbah, the drift reached 167 seconds.

**Fix (final — text-search approach):** Replaced the entire sequential pcm counter + skip logic with a content-based search. For each reader chunk, its first 6 Arabic words are searched in the full transcript word array starting from the previous cursor position. The matched word's segment start time is used as the chunk's timestamp. This is robust against any ordering of Quran/Hadith refs because it's content-based, not counting-based.

```javascript
// server.js — buildWordTimeMap: segment start times (no per-word interpolation)
function buildWordTimeMap(segments) {
  const wordTimes = [];
  for (const seg of segments) {
    const words = seg.text.trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) wordTimes.push(seg.start);
  }
  return wordTimes;
}

// In loadResult: text-search timestamp assignment
function findWordStart(arabic, fromWord) {
  const needle = arabic.split(/\s+/).filter(Boolean).slice(0, 6);
  if (!needle.length) return fromWord;
  for (let i = fromWord; i <= tWords.length - needle.length; i++) {
    if (needle.every((w, j) => tWords[i + j] === w)) return i;
  }
  return fromWord; // safe fallback
}
let cursor = 0;
for (const chunk of chunks) {
  const ws = findWordStart(chunk.arabic, cursor);
  chunk.start_time = Math.round(wordTimes[Math.min(ws, wordTimes.length - 1)] * 10) / 10;
  cursor = ws + chunk.arabic.split(/\s+/).filter(Boolean).length;
}
```

### 10. Gemini 2.5 Flash Transcription Mode (--gemini)
**Motivation:** Groq whisper-large-v3 misses ~18% of words in dense Arabic speech. Gemini 2.5 Flash has superior Arabic comprehension but its self-reported timestamps drift severely (up to +5:52 off by end of 20-min khutbah).

**Solution — Hybrid Gemini+Groq:** `transcribeWithGemini()` runs both in parallel:
1. Uploads audio to Gemini Files API, prompts for verbatim Arabic transcript (no timestamps)
2. Runs Groq Whisper simultaneously for accurate segment timestamps
3. Proportional mapping: `scale = geminiWords.length / groqTotalWords`. Each Groq segment gets `round(groqSegWordCount * scale)` Gemini words. This distributes Gemini's richer text across Groq's real timing boundaries.
4. Returns Gemini text with Groq-aligned `transcript_segments`

**Result:** For May 22 khutbah — Groq: 914 words, Gemini: 1005 words, Local: 914 words. Gemini catches missed connecting phrases and short words at segment boundaries.

### 11. `--local` Path Error
**Symptom:** `--local` mode failed with "No such file or directory" when mlx-whisper internally called ffmpeg.

**Root cause:** mlx-whisper resolved relative audio paths from its own working directory, not the project root.

**Fix:** `pipeline.js` now passes `path.resolve(audioPath)` (absolute path) to `transcribe_local.py`.

### 12. Timestamp Drift (server.js Sequential Counter vs. buildReaderView Position-Based)
**Root cause:** `server.js` used a sequential `proseIdx` counter to find each reader chunk's word position in `prose_chunk_map`. But `buildReaderView` uses position-based filtering (word ranges per inter-ref gap), not sequential 1:1. After 5 Hadith refs, the counter was 3-4 entries ahead — e.g., a chunk at word 1076 (t=952s) was getting pcm[62]'s timestamp (word 1129, t=991s), 39s off.

**Fix:** Replaced sequential counter with text-search: for each reader chunk, find its first 6 Arabic words in the transcript word array starting from the previous cursor. This is content-based, not counting-based, and immune to any ref ordering.

### 13. Word-Level Timestamp Alignment (Gemini hybrid) — replaces proportional mapping
**Problem:** The old `--gemini` hybrid distributed Gemini's words across Groq's segments by *proportional count* (`scale = geminiWords/groqWords`). Gemini's extra ~18% words aren't spread evenly — they cluster where Groq missed words — so the count-based slice drifted cumulatively (text landed in the wrong time slot; highlight off by minutes by end).

**Fix (Approach 1):** `transcribeWithGroq` now requests `timestamp_granularities: ['word','segment']` and returns real per-word timestamps. `alignWordTimestamps()` does a Needleman-Wunsch alignment between Gemini display words and Groq timed words: matched words get Groq's real audio time, words Groq missed are interpolated between surrounding anchors. `buildSegmentsFromWordTimes()` places Gemini text into Groq's real breath-pause segments by actual time. Result `result.json` carries `transcript_words: [{word, start}]`. No cumulative drift (re-anchors at ~950 points). Falls back to proportional mapping only if word timestamps are unavailable.

**Also fixed a constant +1s offset:** `preprocessAudio` prepends 1s of silence (`SILENCE_PREPEND_SEC`), so Whisper times were 1s late vs the original audio the player uses. `main()` subtracts it back from segments + words.

**reanalyze.js preserves `transcript_words`:** it reads `transcript_words` from the existing result.json and writes it back (alongside `transcript_segments`), so re-running analysis on a folder does NOT drop the word-level timing. Without this, reanalyze would fall the reader back to coarse segment-start timestamps.

### 14. End-Anchored Reader-Chunk Timestamps (server.js)
**Problem:** Highlight was perfect until the first Hadith, then off. Hadith words are NOT excluded from prose chunks (unlike Quran), so the Hadith text is duplicated in the reader (signal-phrase chunk + Hadith card). The server advanced its search cursor by *display word count*, so the duplicated Hadith words inflated the cursor ~14 words past their real position; the forward-only search could never recover → drift.

**Fix:** server.js now prefers `result.transcript_words` (each word's own real time) over segment starts. `findWordStart` normalizes to bare Arabic letters (handles Quran-card punctuation) and tries 6/4/3-word prefixes. The cursor advances to where each chunk actually ENDS in the transcript (found via its trailing 3 words in a bounded window), not by display word count — so duplicated text shrinks the span instead of inflating it. Verified within ~2s of ground truth across the whole khutbah, fully monotonic.

### 15. Hadith Rendered in One Chunk (buildReaderView)
**Problem:** Each Hadith appeared twice in reader.txt — once inside its prose chunk, once as a standalone card (with leaked words like a stray `)` and the next sentence's first word).

**Fix:** Quran refs still render as their own segment (Quran words are excluded from prose). Hadith refs are NOT given a separate segment; instead `buildReaderView` attaches each Hadith's badge to the prose chunk that contains it. A long Hadith can span a prose-chunk boundary (chunks break at breath pauses; Hadith zones aren't known at chunk-build time), so the attach loop MERGES every segment a Hadith overlaps into one chunk and attaches the badge once. The merge:
- collects all **prose** segments intersecting the Hadith span, plus any **Quran** segment that sits FULLY inside the span (the dhikr/dua-inside-hadith case);
- rebuilds the merged chunk's Arabic from a **contiguous `origWords.slice(spanStart, spanEnd)`**, which refills gaps left by excluded Quran zones (so the full dhikr text shows, not a gapped version);
- collects each merged prose chunk's translation into a `proseIdxList` (joined at render time), forces `type = 'prose'` so it renders with a badge even if it began as a Quran segment, and drops the absorbed segments.

Standalone Hadith segment only as a fallback when no prose chunk fits. Verified: both Hadiths in the May 22 khutbah render in one chunk each, with the complete dhikr.

**Known edge case (low probability):** because the merge refills the *entire* contiguous span, a Quran ayah that is NOT part of the Hadith but happens to fall fully inside the Hadith's located span (e.g. Claude over-captured the Hadith's `detected_text` to include an ayah the imam recited right after it) would be absorbed inline and **lose its own 📖 card**. The gate (`quran fully inside span`) keeps this rare since the span normally hugs the Hadith's own words. Tell: a 📖 card you expected near a Hadith is missing and that ayah shows as uncited Arabic inside the Hadith chunk. Tighter fix if it appears: only absorb a Quran segment overlapping the Hadith's matched matn words, not the nominal span.

### 16. Hadith Narrator from Claude Knowledge
**Problem:** Narrator showed "unknown" because the prompt only filled it "if mentioned" in the khutbah, and imams rarely name the Companion aloud.

**Fix:** ANALYSIS_PROMPT now asks Claude to identify narrator + collection from its own knowledge of the hadith (null only if truly unknown). E.g. the Arafah-fasting hadith now resolves to "Abu Qatadah al-Ansari". NOTE: the hadith *number/link* still come from the local-corpus Jaccard match and can be wrong (e.g. Muslim 2746 vs the correct 1162) — see Pending Work.

### 7. New Zone Refs: Dua Section Ayahs
**Improvement:** Zone refs now surface Quran phrases in the du'a section that Claude never detects (no signal phrases there):
- Al-Baqarah 2:201 ("ربنا آتنا في الدنيا حسنة وفي الآخرة حسنة")
- Al-Baqarah 2:127 ("ربنا تقبل منا إنك أنت السميع العليم")
- Al-Baqarah 2:128 ("وتب علينا إنك أنت التواب الرحيم")
- Al-An'am 6:151 ("ما ظهر منها وما بطن")

### 17. Authoritative sunnah.com Hadith Links (numbering-scheme fix) — DONE
**Symptom:** The hadith `link`/`hadith_number` came straight from the local-corpus Jaccard match, which uses *sequential* numbering. sunnah.com uses **Abdul-Baqi** numbering for some collections (notably Sahih Muslim), so the constructed URL pointed to the WRONG hadith — e.g. the Arafah-fasting hadith is corpus `2746` but `sunnah.com/muslim:2746` is a *repentance* hadith; the correct page is `muslim:1162a`.

**Investigation (do not repeat):**
- hadithapi.com **cannot** fix this: its hadith object has no sunnah.com reference field, and its `hadithNumber` is the same sequential scheme (Arafah = 2746 there too). Its Arabic search also requires *diacritized* query text (our matn is un-diacritized). Bukhari numbering happens to align everywhere; Muslim is the main offender.
- No free dataset carries sunnah.com's Abdul-Baqi number (AhmedBaset/hadith-json uses its own `idInBook`; the sunnah.com schema keeps `hadithNumber` vs `ourHadithNumber` but only the gated DB/API has it).

**Fix (no number translation at all):** `resolveSunnahLink()` submits the **un-diacritized matn** to sunnah.com's own search (`sunnah.com/search?q=…`) and reads the real permalink out of the results (e.g. `muslim:1162a`). Because the answer comes from sunnah.com itself, the number/link can't disagree with the page. Picks the result in the corpus/Claude-identified collection (`preferredSlug`); if that collection isn't among results, keeps the local link (safe). Disk-cached at `hadith_data/.sunnah_link_cache.json`; resilient (network/timeout → keep local link, not cached so it retries; definite no-result IS cached). `resolveSunnahLinksForRefs()` runs as a post-pass over the final deduped refs in both pipeline.js and reanalyze.js. Verified on the Sudais khutbah: 7/7 hadiths resolved (Muslim → `1162a`/`1134b`, Bukhari/Ibn Majah aligned). The `HADITH_API_KEY` in `.env` is now **unused** (kept for possible future grade/English enrichment via hadithapi.com).

### 18. Narrator Backfill from sunnah.com
**Symptom:** Scan-detected hadiths showed `narrator: undefined` — only Claude's signal-phrase path fills a narrator; `scanTranscriptForHadith` does not.

**Fix:** `fetchSunnahNarrator(slug, number)` fetches the resolved sunnah.com hadith page and parses the narrator from the `hadith_narrated` div (handles both "Narrated X:" and "It was narrated that X said:" phrasings). `resolveSunnahLinksForRefs` calls it only when `ref.narrator` is empty. Cached. Verified: all 7 Sudais hadiths now carry clean narrators (e.g. Ibn Majah 1734 → "Ibn 'Abbas").

### 19. 25 MB Whisper Guard Checked Raw File (fixed)
**Symptom:** A 40.7 MB input was rejected with "File is 40.7 MB -- Whisper API limit is 25 MB", even though `preprocessAudio` compresses to ~5 MB (48kbps mono MP3) before upload.

**Fix:** Moved the size guard to run AFTER `preprocessAudio`, checking the *processed* file size. Large recordings now run directly; the error only fires if even the compressed audio exceeds 25 MB (suggests `--local` or splitting). `--local` is exempt.

### 20. `--gemini` Saves Groq Transcript Too
**Improvement:** `transcribeWithGemini` now returns `groqText` (the Groq side of the hybrid, which already ran for timing). `main()` writes it to `transcript_groq.txt` so Gemini-vs-Groq text can be diffed without a second transcription pass. On the Sudais khutbah: Gemini 1643 words vs Groq 1442 (+14%), 96.4% coverage.

### 21. Two-Khutbah Split Detection (الخطبة الثانية divider)
**Goal:** A Friday khutbah has TWO parts (the khatib sits between them). Show a divider in the reader where Khutbah 1 ends (closing istighfar/du'a) and Khutbah 2 begins (a renewed "الحمد لله...").

**Approach — Claude marker + silence-gap cross-check** (chosen over Gemini-at-transcription, which would risk the Gemini↔Groq word alignment):
- `ANALYSIS_PROMPT` has a `second_khutbah_start` field — Claude returns the first 6-10 Arabic words of Khutbah 2, keyed off STRUCTURE (closing istighfar/du'a → renewed opening praise), not a single word (transcription mishears, e.g. البر→الغفور). Returns null if only one khutbah / no confident split.
- `locateSecondKhutbah(markerText, transcript, segments, wordTimes)` (pipeline.js, exported): fingerprint-matches the marker in the transcript (first occurrence past the first 25% so it can't hit Khutbah 1's opening hamd); computes its `time` from word-level timestamps; cross-checks against the largest silence gap between Whisper segments in the middle 20-85% (`validated` flag). Falls back to the silence-gap boundary (`via: 'silence_gap'`) if the phrase isn't found. Returns `{word_index, time, marker_text, via, validated}` or null. Stored in `result.json` as `second_khutbah`.
- **Clean mid-chunk split (`splitChunkAtKhutbahBoundary`, exported):** the boundary usually falls INSIDE a prose chunk (chunks break at breath pauses, not khutbah boundaries). Translation is chunk-granular (1 Arabic chunk → 1 holistic English string, no word alignment), so a mid-chunk English cut can't be made precisely. Instead, after analysis, if a prose chunk straddles the split word, this helper splits it in two at the boundary and makes ONE small dedicated Claude call to re-translate each half (returns `{part1, part2}`); it splices `proseChunks` + `chunk_translations` and reindexes `proseIdx`. The boundary becomes a real chunk edge, so each side gets a complete translation and the divider lands exactly between them. Graceful no-op on any failure / Quran-zone boundary / already-on-edge (falls back to whole-chunk divider). Called from both pipeline.js `main()` and reanalyze.js.
- `buildReaderView` inserts the divider before the chunk whose start is NEAREST the split word (after the split that's an exact edge; nearest-boundary still handles the no-split fallback). Rendered as an Arabic-only label block so server chunk-parsing drops it rather than mis-attaching.
- `server.js` `loadResult` flags the boundary chunk with `second_khutbah_start: true`: (1) prefer the chunk whose Arabic STARTS WITH the marker phrase (exact after a clean split — `startsWith`, not `includes`, so Khutbah 1's chunk that merely contains it isn't matched); (2) else the chunk whose `start_time` is NEAREST `second_khutbah.time` (nearest, not first-≥, so a chunk starting a hair before the boundary isn't mis-picked).
- Frontend (`public/index.html`): `.khutbah-divider` CSS + `renderTranslation` prepends the divider before the flagged chunk.
- `reanalyze.js` mirrors the locator + split + `second_khutbah` assembly.

**Verified:** Masjid (Arafah) split at word 442 → straddling chunk split into two ("...الغفور الرحيم." | "الحمد لله الذي شرع..."), each with its own translation, divider between → flagged chunk 16/40. Makkah (Sudais) at word 1435 → boundary already on a chunk edge (no split needed) → chunk 50/81 via marker-startsWith (that older folder has `time: null`).

**Cost:** the split adds one small extra Claude call, only when a chunk actually straddles the boundary.

**Known limit:** `server.js` caches parsed results indefinitely (`resultCache`, pre-warmed at startup) — after a `reanalyze`, **restart the server** or the old (un-flagged) parse is served.

---

## Known Remaining Issues / Pending Work

### Multiple Ayahs Grouped as One Ref (Ta-Ha 20:43 + 20:44)
Claude detected both 20:43 and 20:44 text under a single signal phrase, attributing it to 20:43. `buildZoneRefs` adds 20:44 to `result.json` but in `buildReaderView` the dedup drops it (20:43 ref already covers the same word range with longer text). The reader.txt shows one combined card for 20:43 instead of two separate cards.

**Potential fix:** After identifying a ref's word range, check if any zone-identified ayah's n-gram starts WITHIN that range, and if so split the ref into two at that boundary.

### 26:62 Missing from reader.txt
Ash-Shu'ara 26:62 ("كلا إن معي ربي سيهدين", 5 words) is in result.json but doesn't appear as a card in reader.txt. Likely reason: its 5-word detected_text overlaps with 26:63's range in the transcript, causing the dedup to drop it.

### Muhammad 47:7 Duplicate
ref #9 (signal_phrase) and #11 (scan) both identify Muhammad 47:7. They should be deduplicated before `buildReaderView`. Currently deduplicated at display level by the overlap check, but both entries remain in result.json.

### PAD_START and Zone Ref Detected Text
Zone refs' `detected_text` starts from `zone.start` (which includes the 2-word PAD). This means the Quran card in reader.txt starts with the imam's intro words ("ادعو إلى" etc.) rather than the ayah itself. Cosmetically fine but not ideal.

### Authoritative Hadith Number/Link — DONE (see fix #17 + #18)
Resolved via sunnah.com matn search (`resolveSunnahLink` / `resolveSunnahLinksForRefs`), not via hadithapi.com (which can't produce sunnah.com numbers). Narrator now backfilled from the sunnah.com page when missing. See Issues Fixed #17/#18 for the full investigation and rationale.

**Chains into the true-boundary fix for the fix #15 edge case (do these together):** once we have the authoritative canonical matn (from the corpus/API match), align that matn to the transcript to get the Hadith's REAL start/end word range — instead of the current `startWord + detected_text length` guess, which over-captures when an imam runs a hadith and a following ayah together. Then gate Quran absorption in `buildReaderView` on the matched-matn span, not the nominal span:
- a Quran phrase inside the matn (genuine dhikr, e.g. 64:1 in the Arafah dua) → absorb inline (correct);
- a separate ayah recited AFTER the matn end → falls outside → keeps its 📖 card.
This dissolves the fix #15 edge case (non-Hadith ayah losing its card). Caveat: it's only as good as the matn match, so the authoritative-match work above must land first. Ordering: fix the Hadith match → derive the true matn span → gate Quran absorption on it. User confirmed this approach 2026-05-22. **Prerequisite now landed (fix #17):** we have the authoritative sunnah.com hadith; the true-matn-span step can fetch the canonical matn from that page and align it to the transcript. Still TODO.

### Hadith dhikr overlapping a Quran phrase — FIXED (display layer)
The tirmidhi Arafah-dua hadith contains "له الملك وله الحمد وهو" (= Quran 64:1, At-Taghabun); the Quran pre-scan carved it out as a zone, so the middle of the dhikr vanished from reader.txt. Fixed in `buildReaderView` (fix #15): the Hadith merge now also absorbs any Quran segment that sits FULLY inside the Hadith span, and rebuilds the merged chunk from a CONTIGUOUS `origWords` slice — which refills the gap left by the excluded zone. A standalone Quran recitation (not inside a Hadith) still keeps its own card. Verified: the full dhikr now renders in the single Hadith chunk. (A deeper detection-level fix can still come with the quran-detector refactor, but the reader no longer drops the words.)

### Evaluate quran-detector library — EVALUATED 2026-05-22, decision: AUGMENT (not replace)
`Quran_Detector`/QDetect (github.com/SElBeltagy/Quran_Detector, PyPI `quran-detector`, needs Python ≥3.12 → project `.venv`) detects Quran fragments ≥3 words with typo/missing-word tolerance. Prototyped as `quran_detect.py` (shells out) + compared via `compare_quran.js`.

**Findings (Sudais ~22-min khutbah, 17 refs):**
- **Word-ranges work:** it returns `start_word`/`end_word` that align ~1:1 with our whitespace tokenization (e.g. 8:29 → its `words[117-136]` vs our zone `words[117-135]`). So it CAN drive prose-chunk exclusion / zones, not just list refs — the critical constraint is satisfiable in practice.
- **Strong agreement:** 13+ ayahs found by both.
- **Recall win:** catches du'a-section partials our pipeline misses (e.g. Ibrahim 14:35 "واجعل هذا البلد آمناً" — also missed in the May-22 masjid khutbah).
- **Range win:** natively returns consecutive-ayah ranges (20:43-44, 2:127-128) — directly addresses the "Multiple Ayahs Grouped as One Ref" pending item.
- **Complementary, not strictly better:** our pipeline uniquely caught 6:151; detector uniquely caught 14:35.
- **Precision issues to handle:** fragments one citation into multiple overlapping matches; emits multiple ayah candidates per span (21:83 vs 7:151 for "وأنت أرحم الراحمين"); false-fires on ritual phrases (isti'adha 16:98 "أعوذ بالله من الشيطان الرجيم"); some matches carry `errs≥1`.

**Decision:** keep the current zone/`prose_chunk_map` pipeline as primary; add quran-detector as an AUGMENTING recall layer (like `buildZoneRefs`) that (a) merges overlapping/consecutive spans into one ref, (b) picks one ayah per span (longest match, fewest errors), (c) filters ritual phrases (isti'adha, basmala), (d) maps its word-ranges into zones for prose exclusion. Tuning: `min_match=3` over-fires (catches 14:35 + noise); `min_match=5` is clean but loses partials → likely settle ~4 + filters. **Next session: build this augmenting layer.** No equivalent off-the-shelf Hadith detector exists (only APIs + research papers), so Hadith stays corpus-matched (+ sunnah.com link resolution, fix #17).

### Hadith Display (results.html) — RESTORED
The Hadith citation badge rendering in `public/results.html` (the `hadithMatch` branch + `chunk-hadith-cite` div) was restored 2026-05-22. It was never the cause of the timestamp drift (that was the duplicated-Hadith-text cursor inflation, see fix #14).

---

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
