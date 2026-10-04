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

---

### 30. Hadith narrator named the successor, not the Companion
**Symptom:** Regenerating showed Tirmidhi 2910 as "Muhammad bin Ka'b Al-Qurazi" (a Tabi'i; the imam said Ibn Mas'ud) and Tirmidhi 3585 as "Shu`aib".

**Root cause:** `fetchSunnahNarrator` took the first name on the sunnah.com page. Some pages open with a later narrator: "Narrated Muhammad bin Ka'b: I heard 'Abdullah bin Mas'ud saying…", "`Amr bin Shu`aib narrated from his father, from his grandfather".

**Fix:** `parseSunnahNarrator` reads the narrator line and the start of the English and flags these chains; `chooseNarrator` then keeps Claude's narrator (saved as `narrator_claude`) when it names someone on the chain, else the parsed Companion. Links confirmed on an earlier run are kept when today's search finds nothing, and their page still supplies narrator and English.

---

### 31. Published-translation swaps put the wrong words in the imam's mouth
**Symptom:** Muslim 1162a's Ashura clause replaced the Arafah clause the imam quoted; Nasa'i 2202 added the Laylat al-Qadr clause; Muslim 1141a lost "and remembrance of Allah"; a Sa'd hadith read "The Prophet ﷺ, “The Messenger of Allah passed by Sa'd … and he said”:".

**Root cause:** `swapInPublished` matched Claude's English to the published English by word overlap (F1), which cannot tell a clause about Ashura from one about Arafah.

**Fix:** `quote_swaps.js` plans each swap with one model call (claude-sonnet-5): the exact text of Claude's rendering, the exact published excerpt, and any meaning the excerpt adds or lacks against the imam's Arabic. Used only when both are verbatim substrings, nothing is added or lacking, the excerpt keeps every number and name, and it passes `check_english.js` (no new proper noun, no doubled framing, published hadith Arabic contains the imam's words, verse coverage matches what was recited). Otherwise Claude's wording stays and the page labels it "our translation". Stored per ref as `english_swap`; answers cached by request hash.

---

### 32. Sudais: every block from chunk 59 on showed its neighbour's English
**Root cause:** Claude returned 88 translations for 90 chunks (skipped the 3-word verse tail "على ما هداكم", merged chunks 72 and 73); translations pair with chunks by position.

**Fix:** Data repair in result.json (`metadata.realigned`). `check_english.js` now fails a khutbah when chunk English/Arabic length ratios show a slipped pairing; `translate_urdu.js` requires one translation per chunk index.

---

### 33. Second khutbah's first word timed ~15 s into the sitting pause
**Root cause:** Unanchored words were spread evenly between anchors, including across the pause.

**Fix:** `interpolateAnchors` packs a run at speaking pace against the anchor it belongs to (split at the last sentence end) when its gap is too long for speech; `settleLoneWords` repairs saved runs (via `reanalyze.js`).

---

### 34. Hadith carded from a collection the imam didn't name
**Symptom:** 11 Sep and Sudais both carded "كلكم راع وكلكم مسؤول عن رعيته" as Abu Dawud 2928, though the imams said "رواه الامام البخاري ومسلم" and "أخرجه في الصحيحين"; Sudais's "من صامه وقامه… خرجه الشيخان" was Nasa'i 2202.

**Root cause:** `imamAttributionSlug` expected the collection name straight after رواه/أخرجه. A title or "in" before it ("الامام", "في") hid the name, and "الشيخان"/"الصحيحين" (Bukhari and Muslim) had no mapping, so the lookup fell back to Claude's guess.

**Fix:** Skip a leading "الامام"/"في"; map "الشيخان" and "الصحيحين" to Bukhari. 11 Sep and Sudais now link Bukhari 7138 and Bukhari 1901.

### 35. Verse words repeated in the prose next to their card (2 Oct 2026 Makkah)

**Symptom:** three English and Urdu blocks opened or closed with words of the verse card beside them ("O people of insight.", "And a reminder for the believers.", "Indeed in that is a reminder for whoever has a heart"), and 25:62's card began a word late.

**Root cause:** the Quran corpus is in the mushaf's spelling. The verse match compared words after `normalizeArabicDeep`, which still told apart يااولي (joined vocative) from يا أولي, وذكرىا (small alef made a full alef) from وذكرى, ذالك from ذلك, and اليل from الليل. The match stopped short at those words; they stayed in the prose chunk sent to Claude, and the reader then gave them to the card while the chunk's English kept them.

**Fix:** `normalizeArabicDeep` drops every alef, folds ى/ي and ة/ه, splits the joined vocative (338 verses have one) and maps الليل to the mushaf's اليل. Across the 12 test-set transcripts the change moves 20 zone edges, all onto the right word, and identifies 28:60 and 106:3 correctly; the shahada's 4-word matches with 21:87 and 37:35 stay under the 5-word minimum, so they never leave the prose. `verify_reader` 2f fails a prose chunk with two or more words rendered in a verse card; it also found the same defect in Arafah, Eid, Sudais and 21 Aug (reprocess them). Test: `tests/verse_zones.test.js`.

### 36. Hadith linked to the first collection listed

**Symptom:** "لا يلدغ المؤمن من جحر واحد مرتين" (Bukhari 6133, Muslim 2998) was carded as Abu Dawud 4862.

**Root cause:** with no collection named by the imam, the link was the best-scoring sunnah.com result, and all three scored the same; the first listed won.

**Fix:** `pickSunnahResult` takes Bukhari, then Muslim, then the Sunan, among results within 0.1 of the best score, and the search without a named collection runs before Claude's guess of one. The sunnah.com cache key for that search moved to v3. Test in `tests/narrator.test.js`.

### 37. Urdu honorific and du'a conventions

**Symptom:** the shahada read "محمد اس کے بندے…" with no صلی اللہ علیہ وسلم (the official Urdu has it), and "أصلح الأئمة" became اماموں, heard as prayer leaders.

**Fix:** the Urdu prompt writes صلی اللہ علیہ وسلم and رضی اللہ عنہ/عنہم by Urdu convention even where the imam doesn't say them, and حکمران for الأئمة in a du'a for those in authority; the Urdu review keeps them rather than marking them as additions.


### 38. English one block off from a skipped chunk (18 Sep 2026 Madinah)

**Symptom:** from block 55 on, every block showed the next block's English and the last had none. The publish gate failed the page.

**Root cause:** the analysis returned `chunk_translations` as an array, and Sonnet 5.5 merged two chunks into one translation: 57 strings for 58 chunks. Paired by position, everything after the merge slid one place.

**Fix:** the prompt asks for the English keyed by chunk number (`{"1": …, "2": …}`), so a skipped chunk leaves a gap at its own number. `completeChunkTranslations` (core/analyze.js) translates each gap on its own with `translateChunk` (the function `reanalyze.js` already used, now shared); an array of the wrong length cannot be paired, so then every chunk is. Test in `tests/pipeline.test.js`.

### 39. English left out Quranic words inside a chunk, repeated restarts, kept "makhmum"

**Symptom:** "as Allah said:" with nothing after it (ليحزن الذين آمنوا, too short for a card); 21:35's quote and the imam's explanation missing; the imam's restarts translated twice; مخموم القلب left as "makhmum".

**Root cause:** the prompt said verses are shown separately, true only for verses that get a card; it had no restart rule (the Urdu prompt did) and no rule against transliteration.

**Fix:** three rules in the analysis prompt and in `translateChunk`: Quranic words inside a chunk are translated with it, a restart once, every Arabic word outside the kept terms translated.

### 40. Ayah cards for the imam's own Quranic phrasing

**Symptom:** a 43:85 card in the middle of "…العزيز الغفار من له ملك السماوات والأرض وما بينهما العظيم الجبار", 6:151 twice for the du'a's "ما ظهر منها وما بطن", and 19:93 cutting "وما من ذرة في السماوات والأرض إلا وهي شاهدة" in two.

**Root cause:** the pre-scan makes a zone of any 5 words that match an ayah; the reader's citing-phrase and du'a rules applied only to its own gap check.

**Fix:** `dropBorrowedPhrases` (core/arabic.js) drops, before the chunks are cut, a zone of 5–6 words that nothing cites, that does not run on from another recitation, that is neither the start nor the end of its ayah, and whose words are a common Quranic phrase (every 4 words of it in other ayahs too) or include a word the ayah lacks. Its words stay in the prose. The literal rule (no card without a citing phrase) would have dropped 4:131, 43:32, 59:18, 25:62 and other real quotations. Across 36 transcripts it drops the four above and the same 6:151 du'a in two May test runs, and no zone of a published page. Tests in `tests/verse_zones.test.js`.

### 41. Narrator: the Successor who tells the story

**Symptom:** Bukhari 7324 (Abu Hurairah's own account) showed "Muhammad" (Ibn Sirin); Abu Dawud 5004 showed "AbdurRahman ibn AbuLayla", who reports it from the Companions.

**Fix:** `parseSunnahNarrator` reads "We were with X …" and "The Companions of the Prophet (ﷺ) told us …" as a Successor reporting from X / the Companions, and `chooseNarrator` no longer keeps Claude's name when it is the Successor's and the page names the Companion. Of the 48 cached sunnah.com pages only these two change. Tests in `tests/narrator.test.js`.

### 42. 49:17's card stopped short at هَدَىٰكُمْ

**Fix:** `normalizeArabicDeep` reads ى with a small alef inside a word as an alef (هَدَىٰكُمْ / هداكم, يَتَوَفَّىٰكُمْ / يتوفاكم). Also Sudais's "على ما هداكم" (2:185). Test in `tests/verse_zones.test.js`.

### 43. 65:3's card before 65:2's; the isti'adha cut to "I seek refuge"

**Root cause:** the fuzzy ayah alignment ran 65:3's zone back over the imam's own "من حيث لا يحتسب، قال تعالى:"; "بالله من الشيطان الرجيم" matched 16:98 and joined the next verse's zone, leaving "أعوذ" alone in the prose.

**Fix:** the pre-scan splits a zone at a citing word the verse does not have and scans each side again (`splitAtCitations`), and an isti'adha no longer starts a zone (`trimIstiadha`). Across 36 transcripts: 65:2–3 on 18 Sep, and the isti'adha before 17:21, 22:37 (Eid), 2:185 (Sudais) and 47:7. Tests in `tests/verse_zones.test.js`. Not fixed: a lone "كلا" (89:17's first word) after 89:15–16 stays in the prose as "No!": a card for one word would need the recitation check to trust single-word matches.

### 44. Urdu: عنہم for two Companions

**Fix:** the Urdu prompts ask for the dual, رضی اللہ عنہما, for two (ابوبکر و عمر).

### 45. English errors stayed on the page (2 Oct 2026 Makkah)

**Symptom:** block 29 read "do not take admonition from what befell others, nor from what happened to those around them" for بما حل بهم ولا بما جرى لغيرهم (what befell them, nor what befell others). The Urdu had it right; the same happened on 25 Sep Makkah.

**Root cause:** the Urdu review corrects against the Arabic; the English review (`review_blocks.js`) only reported.

**Fix:** `core/review_english.js` corrects every chunk's English against the Arabic (the Urdu as a second reference when there), with the loop the Urdu review uses, now shared in `core/review_chunks.js` (the Urdu review's requests and results are byte-for-byte unchanged, checked with a recording stand-in for Claude). It writes `review_en.json` and rebuilds reader.txt with `reanalyze.js --keep-chunks`. autopublish runs it before the Urdu, which then works from the corrected English. About $0.30 and a minute or two a khutbah (claude-opus-5-5, high). Test: `tests/review.test.js`.

### 46. Islamic terms in English

**Symptom:** the English said "faith", "Satan", "disbelief", "fear Allah" where the Haramain's official English keeps iman, Shaytan, kufr, taqwa.

**Fix:** the analysis prompt keeps `GLOSSED_TERMS` (Iman, Taqwa, Kufr, Shirk, Shaytan, Jannah, Jahannam, Dhikr, Awliya, Ummah), each with a short gloss the first time it appears ("Iman (faith)") and alone after; the English review holds the English to the same list.
