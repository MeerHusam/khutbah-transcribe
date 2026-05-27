# KhutbahTranscribe — Fix History

Full root-cause analyses and implementation notes for every fix. New fixes go here, with a one-line summary added to the Issues Fixed table in `CLAUDE.md`.

---

### 1. Quranic Ayah Spillover into Prose Translations
**Symptom:** An-Nahl 16:125, Ash-Shu'ara 26:62/63 — Arabic ayah text appeared inside the prose block's English translation instead of being isolated as a Quran card.

**Root cause:** The old pre-scan used a Jaccard sliding window (same as the main scan) which requires near-full ayah coverage to score ≥ 0.65. Partial citations (imam recites half an ayah) scored too low → zone not created → ayah words fell into the prose chunk → Claude translated ayah text as regular prose.

**Fix:** Replaced Jaccard pre-scan with n-gram index (`prescanForQuranZones`). Any 4 consecutive transcript words matching any Quran 4-gram create a zone.

---

### 2. `buildReaderView` Ignoring `prose_chunk_map`
**Symptom:** Even with correct zones, reader.txt was mis-aligning translations for Arabic blocks — wrong English chunk showing under Arabic text.

**Root cause:** `proseChunkMap` variable was declared AFTER the segment-building loop, and the fallback was splitting prose into fixed 30-word chunks instead of using the zone-aware map entries.

**Fix:** Moved `proseChunkMap` declaration before the segment loop, replaced fixed-chunk fallback with `buildProseSegs()` helper that uses `prose_chunk_map` entries directly (via `proseIdx`).

---

### 3. Missing Prose Block Between Ayahs (filter bug)
**Symptom:** Prose text between Ta-Ha 20:43 and An-Nahl 16:125 was "wiped out" — not appearing in reader.txt.

**Root cause:** `buildProseSegs` used `filter(e => e.wordStart >= from)` — when a ref's `endWord` overshot by 1 word (cursor=307), the chunk starting at wordStart=306 was filtered out because 306 < 307.

**Fix:** Changed filter to `filter(e => e.wordEnd > from && e.wordStart < to)`.

---

### 4. Ash-Shu'ara 26:63 Disappearing (Claude non-determinism)
**Symptom:** On one reanalyze run 26:63 was in refs (12/12); on another it disappeared (11/11) because Claude non-deterministically missed it.

**Root cause:** Claude sometimes misses ayahs in one run. The Jaccard scan also can't catch it (partial citation, score < 0.65).

**Fix:** `buildZoneRefs()` — if 26:63's zone exists but 26:63 isn't in refs from Claude/Jaccard, a fallback ref is created from the zone's transcript words.

---

### 5. `normalizeArabicDeep` — ئ → ي Doubling Ya'
**Symptom:** "سيئاتكم" normalizing to "سيياتكم" (double ي) which didn't match corpus "سياتكم".

**Root cause:** Initially replaced ئ with ي, but the ي before ئ is already a separate character.

**Fix:** Strip ئ entirely (→ ''). Corpus "سياتكم" = transcript "سيئاتكم" stripped to "سياتكم". ✓

---

### 6. "ووقنا" Single-Word Prose Block
**Symptom:** The word "ووقنا" appeared as a tiny standalone prose block between zones.

**Root cause:** Zone ends before "ووقنا", next zone starts after it. Transcript has "ووقنا" (extra waw prefix) while corpus has "وقنا" — n-gram can't match it, creating a 1-word gap.

**Status:** Known cosmetic limitation. Waw-prefix pronunciation variant can't be reconciled at normalization level.

---

### 7. New Zone Refs: Dua Section Ayahs
**Improvement:** Zone refs now surface Quran phrases in the du'a section that Claude never detects (no signal phrases there): Al-Baqarah 2:201, 2:127, 2:128; Al-An'am 6:151.

---

### 8. Prose Chunks Cutting Mid-Sentence (Fixed-Size Chunking)
**Symptom:** reader.txt prose blocks cut mid-phrase because `buildProseChunks` sliced every 30 words regardless of natural speech boundaries.

**Root cause:** Fixed 30-word slice ignored Whisper segment boundaries (pause points).

**Fix:** `buildProseChunks` now accepts `transcriptSegments` and emits chunks at segment boundaries. MIN_CHUNK=15 words, MAX_CHUNK=60. Falls back to fixed-30 if no segment info.

---

### 9. Timestamp Drift in Reader Chunks (server.js)
**Symptom:** Timestamps drifted ~2m47s behind by end of a 22-min khutbah.

**Root cause:** Sequential `wordCursor` counted only prose words. Every Quran zone skipped in the reader added its word count to the drift. 17 ayah zones → 167s drift.

**Fix:** Content-based search: for each reader chunk, search its first 6 Arabic words in the full transcript word array from the previous cursor. Immune to Quran/Hadith ref ordering.

---

### 10. Gemini 2.5 Flash Transcription Mode (--gemini)
**Motivation:** Groq whisper-large-v3 misses ~18% of words in dense Arabic speech. Gemini 2.5 Flash has superior Arabic comprehension but timestamps drift severely (+5:52 off by end of 20-min khutbah).

**Solution — Hybrid Gemini+Groq:** Upload audio to Gemini Files API (text only), run Groq Whisper in parallel (timestamps only). Proportional mapping distributes Gemini's words across Groq's real timing boundaries. Result: Gemini 1643 words vs Groq 1442 (+14%), 96.4% coverage on Sudais khutbah.

---

### 11. `--local` Path Error
**Symptom:** `--local` mode failed with "No such file or directory" when mlx-whisper called ffmpeg.

**Root cause:** mlx-whisper resolved relative audio paths from its own working directory.

**Fix:** `pipeline.js` passes `path.resolve(audioPath)` (absolute path) to `transcribe_local.py`.

---

### 12. Timestamp Drift (server.js Sequential Counter vs. buildReaderView Position-Based)
**Root cause:** `server.js` used a sequential `proseIdx` counter. After 5 Hadith refs the counter was 3-4 entries ahead, e.g. a chunk at word 1076 (t=952s) was getting timestamp for word 1129 (t=991s), 39s off.

**Fix:** Same text-search as fix #9 — content-based, not counting-based.

---

### 13. Word-Level Timestamp Alignment (Gemini hybrid)
**Problem:** Proportional-count distribution of Gemini words across Groq segments drifted cumulatively — Gemini's extra words cluster where Groq missed them, not evenly.

**Fix:** `transcribeWithGroq` requests `timestamp_granularities: ['word','segment']`. `alignWordTimestamps()` does Needleman-Wunsch alignment between Gemini display words and Groq timed words — matched words get Groq's real time, missed words interpolated. No cumulative drift (re-anchors at ~950 points).

**Also fixed:** `preprocessAudio` prepends 1s silence (`SILENCE_PREPEND_SEC`), so Whisper times were 1s late. `main()` subtracts it back from segments + words.

**reanalyze.js:** preserves `transcript_words` from existing result.json so re-running analysis doesn't drop word-level timing.

---

### 14. End-Anchored Reader-Chunk Timestamps (server.js)
**Problem:** Highlight perfect until first Hadith, then off. Hadith text is duplicated in the reader (signal-phrase chunk + Hadith card), inflating the cursor ~14 words past real position → forward-only search couldn't recover.

**Fix:** server.js prefers `result.transcript_words` over segment starts. `findWordStart` normalizes to bare Arabic letters, tries 6/4/3-word prefixes. Cursor advances to where each chunk ENDS in the transcript (trailing 3 words in bounded window), not by display word count.

---

### 15. Hadith Rendered in One Chunk (buildReaderView)
**Problem:** Each Hadith appeared twice — inside its prose chunk AND as a standalone card with leaked words.

**Fix:** Hadith refs are NOT given a separate segment. `buildReaderView` attaches each Hadith's badge to the prose chunk that contains it. Long Hadiths that span a chunk boundary: the attach loop MERGES all intersecting prose segments + any Quran segment FULLY inside the span. Merged chunk's Arabic is rebuilt from contiguous `origWords.slice(spanStart, spanEnd)` — refills gaps from excluded Quran zones. `proseIdxList` joins translations.

**Known edge case:** A Quran ayah NOT part of the Hadith but fully inside its located span could be absorbed inline and lose its 📖 card. Gate keeps this rare. Deeper fix: align against canonical matn span (see pending work).

---

### 16. Hadith Narrator from Claude Knowledge
**Problem:** Narrator showed "unknown" — prompt only filled it "if mentioned" in the khutbah; imams rarely name the Companion aloud.

**Fix:** ANALYSIS_PROMPT now asks Claude to identify narrator + collection from its own knowledge (null only if truly unknown). E.g. Arafah-fasting hadith → "Abu Qatadah al-Ansari".

---

### 17. Authoritative sunnah.com Hadith Links (numbering-scheme fix)
**Symptom:** Hadith links pointed to wrong hadith — local corpus uses sequential numbering, sunnah.com uses Abdul-Baqi for Muslim. e.g. Arafah-fasting is corpus `2746` but `sunnah.com/muslim:2746` is a repentance hadith; correct is `muslim:1162a`.

**Investigation (do not repeat):**
- hadithapi.com can't fix this: same sequential scheme (Arafah = 2746 there too). Arabic search requires diacritized text. No free dataset carries Abdul-Baqi numbers.

**Fix:** `resolveSunnahLink()` submits the un-diacritized matn to `sunnah.com/search?q=…` and reads the real permalink. Picks result matching `preferredSlug` (Claude/corpus-identified collection). Disk-cached at `hadith_data/.sunnah_link_cache.json`. `HADITH_API_KEY` now unused (kept for future enrichment).

---

### 18. Narrator Backfill from sunnah.com
**Symptom:** Scan-detected hadiths showed `narrator: undefined`.

**Fix:** `fetchSunnahNarrator(slug, number)` fetches the resolved sunnah.com page and parses the narrator from `hadith_narrated` div (handles "Narrated X:" and "It was narrated that X said:" patterns). Called from `resolveSunnahLinksForRefs` only when `ref.narrator` is empty. Cached.

---

### 19. 25 MB Whisper Guard Checked Raw File
**Symptom:** 40.7 MB input rejected even though `preprocessAudio` compresses to ~5 MB.

**Fix:** Moved size guard to run AFTER `preprocessAudio`, checking compressed file size. `--local` exempt.

---

### 20. `--gemini` Saves Groq Transcript Too
**Improvement:** `transcribeWithGemini` returns `groqText`. `main()` writes it to `transcript_groq.txt` for diffing without a second transcription pass.

---

### 21. Two-Khutbah Split Detection (الخطبة الثانية divider)
**Goal:** Show a divider where Khutbah 1 ends and Khutbah 2 begins.

**Approach — Claude marker + silence-gap cross-check:**
- `ANALYSIS_PROMPT` returns `second_khutbah_start`: first 6-10 Arabic words of Khutbah 2, keyed off structure (closing istighfar/du'a → renewed opening praise). Null if no confident split.
- `locateSecondKhutbah()`: fingerprint-matches marker past first 25% of transcript; cross-checks against largest silence gap in middle 20-85% (`validated` flag). Returns `{word_index, time, marker_text, via, validated}` or null.
- `splitChunkAtKhutbahBoundary()`: if a prose chunk straddles the boundary, makes one small Claude call to re-translate each half (`{part1, part2}`), splices proseChunks + chunk_translations, reindexes proseIdx.
- `buildReaderView`: inserts divider before the chunk whose start is NEAREST the split word.
- `server.js loadResult`: flags boundary chunk with `second_khutbah_start: true` — prefers `startsWith` marker match, falls back to nearest-time.
- Frontend: `.khutbah-divider` CSS renders `۞ الخطبة الثانية · Second Khutbah ۞`.

**Known limit:** `resultCache` caches indefinitely — restart server after `reanalyze`.

---

### 22. Share-Card Design for All Sections (UI)
**Change:** In Short, Summary, and Full Translation sections all converted from `.section` to `.share-card` (green gradient, geometric pattern overlay, gold border). Share-card gradient changed from diagonal `135deg` (height-dependent shade) to flat `#112519` base with subtle top tint — consistent shade regardless of card height.

---

### 23. SVG Play/Pause Icons (iOS Emoji Fix)
**Symptom:** Play/pause button showed as emoji on iOS (Unicode `▶`/`⏸` rendered by iOS emoji engine).

**Fix:** Replaced with inline SVG — `<polygon points="6,4 20,12 6,20"/>` for play, two `<rect>` elements for pause. `setPlayIcon(paused)` toggles `display` on the two SVGs.

---

### 24. Geo Location Tracking
**Added:** On each WebSocket connection, `lookupGeo(ip)` calls `ip-api.com` (free, no key, 3s timeout, skips private IPs). Appends `{ts, city, region, country, countryCode}` to `data/geo_views.jsonl`. Admin view at `/admin/geo?key=<ADMIN_TOKEN>` shows country/city breakdown table.

---

### 25. Unique Visitor Count
**Added:** IP hashes (SHA-256, first 16 chars) stored as a Set in `data/views.json`. Broadcast as `unique` alongside `live` and `total`. Header shows **X live · Y unique · Z visits**. Persistent on paid Render plan (disk mounted at `/opt/render/project/src/data`).

---

### 26. Consecutive Ayahs Deduped (Ta-Ha 20:43 + 20:44)
**Symptom:** When two ayahs are recited back-to-back, only the first got a Quran card in `reader.txt`; the second silently vanished.

**Root cause:** In `buildReaderView`, each located ref's `endWord = startWord + detected_text.length`. A merged Quran zone gives the FIRST ref a `detected_text` spanning BOTH ayahs, so the second ayah's `startWord` falls inside the first's span. The overlap-dedup then kept only the longer detected_text and dropped the second — it could not tell a true duplicate (same ayah found by multiple layers) from two distinct consecutive ayahs.

**Fix:** Dedup now compares `surah_number`/`ayah_number`. For two distinct (different surah:ayah) Quran refs that overlap with `loc.startWord > prev.startWord && loc.endWord >= prev.endWord` (i.e. consecutive, in recitation order), it **trims the earlier ref's `endWord` to the later ref's `startWord`** and keeps both — each renders its own words and citation card. True duplicates (same ayah) and ambiguous *nested* refs (e.g. 26:62 inside 26:63's span) keep the old longer-detected_text behavior. Verified with a synthetic two-ayah transcript: 20:43 and 20:44 each render once, no duplication; a same-ayah duplicate still collapses to one.

---

### 27. Single-Khutbah Mode (`--single`)
**Goal:** Process a one-part khutbah (Arafah, Eid, lectures) without the false "الخطبة الثانية" divider.

**Root cause of the false divider:** `locateSecondKhutbah` ran unconditionally. When Claude correctly returned `second_khutbah_start: null`, the function fell through to its silence-gap fallback (`maxGap >= 1.2s` in the middle 20–85%), which fires on ordinary recitation pauses — splitting a continuous khutbah.

**Fix:** `--single` (alias `--no-split`) CLI flag sets `secondKhutbah = null` and skips `locateSecondKhutbah` entirely. Usage: `node pipeline.js audio.mp3 --gemini --single`.
