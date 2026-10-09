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

### 47. A kept term where the Arabic meant something else (18 Sep 2026 Madinah)

**Symptom:** block 47: "benefit me and you by the Ayaat and the wise Dhikr (remembrance of Allah)" for الذكر الحكيم, which is the Qur'an. The analysis also kept "Rasulullah" while the review (and the official English) said "the Messenger of Allah", and the review translated away Tawhid and Ihsan, which the official keeps.

**Fix:** one list: Rasulullah dropped, Tawhid and Ihsan added to `GLOSSED_TERMS`, and `TERMS_SENSE` in both prompts: a term only where the Arabic has that word in that sense. `check_english.js` fails "Dhikr" for الذكر الحكيم and warns on "Rasulullah".

### 48. The imam's restarts translated twice across a chunk edge (18 Sep 2026)

**Root cause:** the restart rule ("translate a repeat once") works inside a chunk, but each chunk is translated and reviewed on its own, so a sentence broken off at a chunk's end and said again in the next, or a passage said twice across the edge, came out twice (Makkah 26–28 and 35, Madinah 24–25 and 38–39).

**Fix:** `findRestarts` (core/arabic.js) finds them in the Arabic: a chunk ending in "…" whose broken-off words open the next one, and a run of 5+ words said again at once (8+ within 30 words), never a du'a, the salawat, the takbir or a refrain. `restartNotes` tells the English analysis, the English review, `translate.js` and `review_translation.js` where they are. Across the 14 khutbahs on disk: 15 finds, all real. Tests: `tests/restarts.test.js`; `check_english.js` warns where the English still says one twice.

### 49. Wrong narrator on a hadith sunnah.com has no page for (18 Sep 2026 Madinah)

**Fix:** with no sunnah.com page (or no narrator line on it), the card names no narrator rather than Claude's guess (Sa'd ibn Abi Waqqas for as-Sa'ib ibn Khallad); Claude's is kept in `narrator_claude`. `verify_reader` warns on an unconfirmed narrator (4 old cards).

### 50. Hadith the imam weaves in without naming them had no card

**Root cause:** only hadith the imam introduces ("قال رسول الله ﷺ") were carded; the corpus scan (a sliding Jaccard window) found woven-in ones, but its finds were wrong in all seven test khutbahs and never shown.

**Fix:** `scanTranscriptForHadith` is now a 4-gram scan over the local collections, as the Quran pre-scan: runs of 4-grams shared with one hadith, 8+ matched words besides formula words, 4-grams in 150+ hadith skipped, outside Quran zones and the imam's own hadith, never the khutbah's liturgy (`isLiturgicalPart`). Across the 14 khutbahs on disk: 17 finds, all real (12 in Madinah 25 Sep); the pillars listed in the imam's own words (Arafah) are not a quotation. Tests: `tests/hadith_scan.test.js`.

### 51. An ayah card on the imam's du'a (4 Sep 2026 Makkah)

**Symptom:** "اللهم احفظهم من بين أيديهم ومن خلفهم وعن أيمانهم وعن شمائلهم ومن فوقهم…" (his du'a for Palestine, the Prophet's morning du'a for protection) got a 7:17 card: Iblis's words.

**Root cause:** `dropBorrowedPhrases` (fix 40) leaves only 5–6-word zones to the prose; this one is 9 words, found by the 4-gram scan alone.

**Fix:** inside a du'a ("اللهم" in the 6 words before) a zone of any length that neither starts nor ends where its ayah does is the imam's wording, unless it opens with ربنا / رب (a Quranic du'a he recites). Across the 81 transcripts on the Mac it drops that zone only. `verify_reader` fails a card on a zone the filter drops.

### 52. "imams" for the rulers in English (4 Sep 2026 Makkah; Sudais, Makkah 25 Sep)

**Symptom:** "set right our imams and those in authority" (أصلح أئمتنا وولاة أمورنا), "grant success to our imam and guardian, the Custodian of the Two Holy Mosques" (إمامنا وولي أمرنا): a reader hears prayer leaders.

**Fix:** `TERMS_SENSE` (analysis and English review) has the rule the Urdu prompt got in fix 37. `check_english.js` fails "imam(s)" in a block whose Arabic has أئمتنا / إمامنا beside ولاة / ولي أمر. Sudais's and Makkah 25 Sep's published pages have it; they need reprocessing.

### 53. A published hadith text turned the imam's "us" into "me" (4 Sep 2026 Makkah)

**Symptom:** his du'a "وأن تغفر لنا وترحمنا" showed Tirmidhi 3235's published English, "and that You forgive me".

**Fix:** `personShift` (check_english.js): a swap whose excerpt says I/me/my where our rendering says we/us is refused (`quote_swaps.js`) and fails the publish check.

### 54. Hadith cards against the imam's own attribution (4 Sep 2026 Makkah)

**Symptoms:** the birds hadith ("أخرجه الترمذي" after it) carded as Ibn Majah 4164; "اللهم بارك لأمتي في بكورها" ("الحديث الذي أخرجه الترمذي … عن صخر الغامدي … أنه قال") as Abu Dawud 2606; "الدعاء هو العبادة. أخرجه أبو داود والترمذي وابن ماجه" with no card.

**Root causes:** `imamAttribution` read a collection only after the hadith; when sunnah.com's search did not return the hadith in the named collection (Tirmidhi's wording differs), the code fell back to Claude's collection; `deduplicateHadithRefs` drops a matn under 4 words; and `extractMatn` had no pattern for "عن النبي ﷺ قال", so 918 corpus matns were cut at a later قال (Abu Dawud 1479's was the ayah it quotes).

**Fix:** the name is read before the hadith too, when the chain ("عن …") follows it with no sentence end between; once the imam named a collection, a missed search takes the number from our copy of that collection (`imam_collection`), never another; a short hadith he attributes is kept; `findAttributedHadith` cards a quote between "قال رسول الله ﷺ" and "رواه / أخرجه <collection>" when that collection has those words; `extractMatn` reads "عن النبي ﷺ قال". `verify_reader` fails a card naming another collection than his, and an attributed quote with no card. With the matn fix the scan also finds Tirmidhi 3246 and 2538 on Madinah 25 Sep.

### 55. "في مسند الإمام أحمد" not read as an attribution (11 Sep 2026 Makkah)

**Symptoms:** the hadith of the lines ("خط لنا رسول الله ﷺ خطاً…"), introduced "وفي مسند الإمام أحمد قال ابن عباس قال ابن مسعود", carded as Tirmidhi 2454, a different hadith (the square the Prophet drew). The publish check passed.

**Root causes:** the name before a hadith was read only after "رواه / أخرجه" or "في صحيح / الصحيحين", and only with a chain opening "عن"; this one said "في مسند" and "قال ابن مسعود". With no attribution found, the search took the closest match in any collection. Separately, a card whose search missed the imam's collection kept the number, link and published English of the hadith it had before.

**Fix:** "في" before صحيح / مسند / سنن / جامع / موطأ introduces the next hadith, and after it the chain may open with "قال" as well as "عن" (after "رواه" a "قال" still opens the next hadith and is not taken). A card that names the imam's collection but has no number there drops the other collection's number, link and English (`imam_collection_unlinked`): "Musnad Ahmad" with no link, as for At-Tabarani. Across the 328 hadith refs on the Mac only this one changes.

### 56. Narrator: the asker, under his father's name; a misspelled header shown whole (11 Sep 2026 Makkah)

**Symptoms:** Muslim 770 (how the Prophet ﷺ opened his night prayer, as 'A'isha told it) carded "Narrator: 'Abd al-Rahman b. 'Auf"; Muslim 395b carded "Narrator: It is naratted on the authority of Abu Huraira".

**Root causes:** sunnah.com's header for 770 names the Successor who asked, and cuts him from Abu Salama b. 'Abd al-Rahman b. 'Auf to his father's name; `parseSunnahNarrator` had no rule for "I asked X … she said". 395b's header is misspelled "naratted", which the framing strip did not match.

**Fix:** "I asked X" / "I said to X" at the start of the hadith names X as the Companion (unless X is the Prophet ﷺ); the strip accepts "naratted". Across the 87 linked hadiths on the Mac only these two change (and Muslim 7500's Suhaib gains his full name).

### 57. A hadith card from another Companion than the one the imam named (11 Sep 2026 Madinah)

**Symptoms:** "وقد صح عن جرير بن عبد الله رضي الله عنه … بايعنا رسول الله ﷺ على النصح لأهل الإسلام" carded as Bukhari 7202, Ibn 'Umar's pledge to hear and obey.

**Root causes:** the imam named no collection, so the search took the closest wording in any collection; nothing compared the card with the Companion he named.

**Fix:** `imamCompanion` reads the name before "رضي الله عنه/ا/ما/م" within the 60 words before the hadith (no other hadith or verse between); the corpus keeps each hadith's whole text with its chain (`full`), and a card whose chain lacks him is replaced by his hadith with those words (`imam_companion`; here Nasa'i 4156, "عن جرير قال بايعت رسول الله ﷺ على النصح لكل مسلم"), else loses its number and link. `verify_reader` fails such a card. Of 225 hadith refs on the Mac, 12 have a Companion named before them; only this one changes.

### 58. The English said an ayah and a hadith twice (11 Sep 2026 Madinah)

**Symptoms:** chunk 12's English carried chunk 13's "Woe to those who give less than due" and the hadith after it, and chunk 13 said them again.

**Root causes:** the analysis folded chunk 13's words into chunk 12 and left 13 empty; `completeChunkTranslations` translated 13 alone, leaving 12 as it was. The English review found it (high) and wrote the fix, but the loop refused it: 35% of the old length, outside the 0.5–1.8 guard against wild rewrites.

**Fix:** a neighbour whose English is far too long for its Arabic beside an empty chunk is translated again on its own too; the review applies a correction however much shorter when the words it takes out are, all but a fifth, the next or previous chunk's (`removesNeighbourText`); the analysis prompt says each chunk's English is its own words only.

### 59. A lone "في" from a restart inside an ayah, "translated" with the translator's note (11 Sep 2026 Madinah)

**Symptoms:** "ويشهد الله على ما في نفسه ويشهد الله على ما في ويشهد الله على ما في قلبه" (2:204, the imam restarting) left "في" between two zones of the ayah as a chunk of its own; translated alone, its English was "The chunk is the verse portion: … the translation of this chunk is: in". The publish check failed it on length.

**Root causes:** zones merged only when they touched; the single-chunk translator had no instruction for a stray word, and nothing checked for a note in place of a translation.

**Fix:** two zones of the very same ayah at most two words apart are one zone (one card, the restart inside it; across 52 transcripts only this one and a test file's doubled 26:62 change; 2:201 then 2:128, and Arafah's "نعم نعم" between 22:27 and 22:28, stay apart); `translateChunk` replies empty for a stray word and never with a note; `check_english` fails an English that is a note about the text.

### 60. "يا أيها" before 35:15 stayed in the prose (4 Sep 2026 Makkah)

**Symptoms:** block 6 ended "as He, glory be to Him, said: “O mankind,”" and the 35:15 card below began "O mankind!" again (Urdu and Bengali ended on a dangling "اے…" / "হে…"). The publish check failed it.

**Root cause:** 35:15 opens with the quarter-hizb mark against its first word, "۞يَـٰٓأَيُّهَا"; `splitVocative` (fix 35) looks for the vocative only at a word's start, so for ayaat carrying the mark it stayed one joined word and the scan could not reach back over "يا أيها".

**Fix:** the mark is removed before the vocative is split. Across 52 transcripts only this zone changes (it now starts at "يا").

### 61. Narrator: the Successor who tells the story, in a form no rule knew (28 Aug 2026 Makkah)

**Symptoms:** "من سلك طريقاً يلتمس فيه علماً…" (Abu Dawud 3641) carded with narrator Kathir ibn Qays. He tells how he sat with Abu al-Darda' in the mosque of Damascus; the hadith is Abu al-Darda's, as Claude had it.

**Root causes:** the card took sunnah.com's narrator line, and the Successor was recognised only by the English's wording ("I heard X", "We were with X", "I asked X": fixes 30, 41, 56), each rule written for the phrasing last seen. Here the English opens "Kathir ibn Qays said: I was sitting with AbudDarda'…", which none of them reads.

**Fix:** the chain decides, whatever the English says. The hadith is the Companion's who heard the Prophet ﷺ, the one nearest him on its chain (the corpus `full` text, read only up to where the Prophet ﷺ is first named); when Claude's narrator stands there nearer than every name the page gives, Claude's is shown (`nearerOnChain`). Names are compared across the two scripts by their consonants (Darda / الدرداء both d-r-d; transmission words such as حدثنا and سمعت are no one's name). Claude naming an earlier link, someone named only after the Prophet ﷺ, or someone off the chain changes nothing; the English rules stay for hadith whose chain we do not have. `verify_reader` fails a card whose narrator stands before Claude's on the chain. Of 160 cards on the Mac with a cached page, only this one changes.

### 62. An ayah card inside a du'a whose "اللهم" was 7 words back (28 Aug 2026 Makkah)

**Symptoms:** "ونسألك اللهم يا حي يا قيوم، يا من لا تأخذه سنة ولا نوم، أن تعطي السائل…" got a 2:255 card in the middle of the du'a, and the English, Urdu and Bengali before it ended on a dangling "O You who…".

**Root cause:** fix 51 counted a zone as du'a when "اللهم" was in the 6 words before it; a du'a of several calls puts it further back.

**Fix:** "اللهم" anywhere in the zone's sentence (back to a full stop, question mark or colon, at most 30 words) counts too, unless the imam cites a verse after it; the 6-word rule stays, so nothing it caught comes back. Across 86 transcripts on the Mac this zone changes, and Sudais's Ramadan du'a "وجنبهم الفواحش والفتن ما ظهر منها وما بطن، اللهم ادفع عنا…" (a 22-word 6:151 zone, fix 40's error; the live page already shows no card there) in that page and its ten May test runs; nothing else.

### 63. Look-alike ayaat: 20:43 carded as 20:24 once alefs stopped counting (the Sudais test khutbah, rerun 8 Oct 2026)

**Symptoms:** "اذهبا إلى فرعون إنه طغى فقولا له قولاً ليناً…" (20:43–44, Musa and Harun sent together) got a 20:24 card, the ayah where Musa is sent alone, and 20:44 a card of its own. The May runs had it right; the publish check failed it ("ref labelled 20:24 but only 40% of its text is in that verse").

**Root cause:** since fix 35, `normalizeArabicDeep` drops every alef so the mushaf's spelling meets ordinary spelling (ذَٰلِكَ / ذلك, السَّمَٰوَٰت / السماوات). That also made the dual "اذهبا" the singular "اذهب": 20:24, 20:43 and 79:17 matched the same words equally, and `prescanForQuranZones` kept the first in the mushaf's order. 20:24 is not followed by 20:44, so 20:44 became a zone of its own.

**Fix:** the alef-free form still finds the candidates; between candidates that match equally, `preferredAyah` takes the one whose written alefs agree with what the imam said (`withRealAlefs`: only the mushaf's small alef is dropped), then the one whose next ayah he goes on to recite. Across 86 saved transcripts (1,493 card and narrator decisions) only this zone changes, in the three runs of that khutbah; the rerun's check passes. Test: `tests/verse_zones.test.js` (20:43, 20:24 and 79:17 told apart).

### 64. Two ayaat recited together labelled with the second (2 Oct 2026 Makkah, rebuilt 9 Oct)

**Symptoms:** "إنا لما طغى الماء حملناكم في الجارية لنجعلها لكم تذكرة وتعيها أذن واعية" (69:11–12) got a card labelled 69:12 only; the publish check failed it ("ref labelled 69:12 but only 46% of its text is in that verse") and stopped the rebuild before the voices. The page made on 3 Oct had it right, 69:11–12.

**Root cause:** the label must name the ayah the recitation starts in. `matchClaudeQuranRef` sees to that when Claude and the matcher disagree (Quraysh 106:3–4), and on 3 Oct they did. On the rebuild Claude named 69:12 and the matcher agreed, so nothing checked the start, and `annotateRefAyahRange` only walks forward from the label.

**Fix:** `annotateRefAyahRange` steps the label back while the ayah before it is recited whole at the start of the text and the labelled ayah follows straight on (whole, or at the end of the text its opening part, as the forward walk accepts); the quran.com link moves with it. An ayah of one or two words must match exactly. Across the 884 Quran refs of 80 saved runs only the label changes, on 4 refs, each a passage that starts one ayah earlier: 69:11–12, Arafah's 22:1–2 (two runs) and 33:70–71 (May); no text changes. Test: `tests/verse_zones.test.js`.

### 65. The imam's recitation cut short in the voice tracks: "معنا", "الكافرون", "العالمين" (9 Oct 2026)

**Symptoms:** in the translated audio, the imam's own recitation of 9:40 stopped before "معنا", of 12:87 before "الكافرون", of 37:182 before "العالمين". On the page, the first word of some blocks lit while the imam was still saying the last word of the block before.

**Root cause:** `align_imam.js` aligns each block alone, padded 0.8 s each side, so a word at a boundary could be placed in the other block's sound. 12 of today's 50 boundaries overlapped (against Groq's times, the next block's first word early in 9, the last word late in 3; the 2 Oct fixture has 14). `recite.js` ends a recitation just before the next block's first word, so an early one cut the ayah's last word.

**Fix:** `align_imam.js` aligns overlapping blocks again as one stretch, so the aligner sets the boundary with both texts (today: 0 overlaps left, agreement with Groq unchanged, median 0.12 s); `recite.js` never ends a recitation before its own last word; `check_highlight.js` fails word times where a block starts before the one before it ends. Test: `tests/highlight.test.js`.

### 66. A hadith not marked in the Arabic when the imam reorders its closing words (9 Oct 2026)

**Symptoms:** "لا يمتن أحدكم إلا وهو يحسن الظن، إلا وهو يحسن بالله الظن" (Muslim 2877c) was not marked green; only "رواه مسلم" was.

**Root cause:** the page finds a hadith by the first and last three words of its detected text, in order. Claude's text ends "يحسن الظن بالله"; the imam said "يحسن بالله الظن".

**Fix:** `locateSpan` (public/reader.html) accepts the same three closing words in another order. Of the 43 hadith on the published pages, this one is now marked and none other changes (18 Sep Makkah's Bukhari 3281 stays unmarked).

### 67. An ayah card's recited part began a word late ("لا", "اليوم", "ما", "إن") (9 Oct 2026)

**Symptoms:** the 9:40 card showed "…تَحْزَنْ إِنَّ ٱللَّهَ مَعَنَا…" for "لا تحزن إن الله معنا".

**Root cause:** `recitedSpans` (public/recited.js) paired the imam's "لا" with the verse's opening "إلا" (the alef set aside), 18 words before the rest, then dropped it as a stray, so the part began at the next word. The Arafah test had the same miss built in (5:3 from "أكملت", not "اليوم").

**Fix:** the kept part grows at both ends while the verse's next word is the imam's next word. Across 752 ayah cards of the saved runs, 20 change, each by one recited word at the start. Test: `tests/recited.test.js`.
