// Arabic text and the Quran (split out of pipeline.js): normalisation, the Quran corpus and its
// n-gram index, recitation zones, ayah matching, and the prose chunks sent to Claude.

import { createRequire } from 'module';

const require = createRequire(import.meta.url);

// ---- Quran corpus -----------------------------------------------------------

let quranData = null;
try {
  // quran-json/dist/quran.json has all 114 surahs with Arabic verses embedded
  const raw = require('quran-json/dist/quran.json');
  quranData = Array.isArray(raw) ? raw : null;
  if (!quranData) throw new Error('unexpected shape -- not an array');
} catch (e) {
  console.warn(`Warning: quran-json failed to load (${e.message}). Quran matching will be skipped.`);
}

// ---- Text normalisation -----------------------------------------------------

// Normalise Arabic text for matching.
//
// The quran-json corpus encodes text with characters Whisper output won't contain:
//   U+0671  alif wasla (vs plain alif U+0627)
//   U+06E1  small high dotless head of khah (used as sukun separator)
//   U+06D6-U+06ED  Quranic annotation/pause marks
//   U+064B-U+065F  standard tashkeel diacritics
//   U+0610-U+061A  Arabic sign combining block
//   U+0670  superscript alef
//
// We strip all of these and unify alif variants so both sides compare on bare consonants.
// All ranges use explicit \uXXXX escapes -- literal Arabic characters in regex ranges
// can silently expand to include consonants when saved in certain editors.
// Gemini decorates recited ayahs with quotation markup, and which markup it picks varies
// between runs of the same audio: ornate parentheses ﴿…﴾, curly braces {…}, and a "*"
// separating consecutive ayahs of a single run. None of it is spoken.
//
// Left in the transcript it breaks the pipeline in two ways. A bracket attached to a word
// ("﴿لئن") makes a fingerprint match land mid-token and shifts every located reference by
// one word. A standalone "*" between ayahs sits in the middle of a recited run, so
// consecutive-ayah chaining fails and reference spans straddle two verses.
//
// Strip it once, here, where the transcript is produced, so every downstream stage sees
// plain spoken words. Doing it in normalizeArabic instead cannot work: a token that is
// ONLY markup would normalise to empty and be dropped, desynchronising the normalised word
// list from the original one that reference spans are sliced against.
function stripAyahMarkup(text) {
  if (!text) return text;
  return text
    .replace(/[﴿﴾{}]/g, '')
    .split('\n')
    .map(line => line.split(/\s+/).filter(w => w && !/^[*۞]+$/.test(w)).join(' '))
    .join('\n')
    .trim();
}

function normalizeArabic(text) {
  return text
    .replace(/[ؐ-ؚ]/g, '')  // Arabic sign combining marks
    .replace(/ٰ/g, 'ا')     // superscript alef → plain alif (Uthmanic long-vowel marker)
    .replace(/[ً-ٟ]/g, '')  // tashkeel diacritics
    .replace(/ـ/g, '')           // tatweel/kashida
    .replace(/[ۖ-ۭ]/g, '')  // Quranic annotation/pause signs
    .replace(/ٱ/g, 'ا')     // alif wasla → plain alif
    .replace(/[آأإ]/g, 'ا') // hamzated alifs → plain alif
    // Strip punctuation (Gemini adds sentence punctuation like . and ؟ that attaches to a
    // word — e.g. "ينفعه؟" — and breaks Quran n-gram matching, spilling ayah tails into prose).
    // Only punctuation is removed, never spaces or letters, so word-token counts stay aligned.
    //
    // The ornate parentheses ﴿﴾ (U+FD3E/U+FD3F) that Gemini wraps ayahs in MUST be in this
    // set. They attach to the ayah's first and last word ("﴿لئن"), so a fingerprint lookup
    // in buildReaderView matches *inside* the token; the slice before the match then ends
    // with a bare "﴿" that counts as a word, shifting every located ref one word to the
    // right. The ayah's first word is stranded in the preceding prose block and the span
    // runs one word into the next — the whole class of "ayah head/tail leaking into prose".
    .replace(/[.,!?;:؟،؛"'`(){}\[\]«»﴿﴾…—–-]/g, '')
    .trim();
}

// ---- Similarity scoring -----------------------------------------------------

// Jaccard-style overlap: |shared words| / |union of words|
function wordOverlapScore(a, b) {
  const setA = new Set(a.split(/\s+/).filter(Boolean));
  const setB = new Set(b.split(/\s+/).filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  const shared = [...setA].filter(w => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return shared / union;
}

// ---- Quran search -----------------------------------------------------------

function findMatchingAyah(detectedText) {
  if (!quranData || !detectedText) return null;

  const normDetected = normalizeArabic(detectedText);
  const detectedWords = normDetected.split(/\s+/).filter(Boolean);
  const detectedWordSet = new Set(detectedWords);

  let best = null;
  let bestScore = 0;

  for (const surah of quranData) {
    const verses = surah.verses ?? surah.ayahs ?? [];

    for (const verse of verses) {
      const ayahText = verse.text ?? verse.arabic ?? '';
      if (!ayahText) continue;

      const normAyah = normalizeArabic(ayahText);
      const ayahWordSet = new Set(normAyah.split(/\s+/).filter(Boolean));

      // Word-level containment — character-level includes() would cause short ayahs like "يس"
      // to spuriously match inside longer words (e.g. "اليسر" contains the chars "يس").
      const ayahWordsArr = normAyah.split(/\s+/).filter(Boolean);
      const stringContained = ayahWordsArr.every(w => detectedWordSet.has(w)) ||
                              detectedWords.every(w => ayahWordSet.has(w));

      // Word-set majority: ≥75% of detected words appear in the ayah.
      // Handles Whisper transcription errors and Uthmanic vs standard orthography differences.
      const matchedWordCount = detectedWords.length >= 3
        ? detectedWords.filter(w => ayahWordSet.has(w)).length
        : 0;
      const wordMajority = matchedWordCount / Math.max(detectedWords.length, 1) >= 0.75;

      const overlap = wordOverlapScore(normDetected, normAyah);
      const score = stringContained
        ? Math.max(overlap, 0.8)
        : wordMajority
          ? Math.max(overlap, 0.7)
          : overlap;

      if (score > bestScore) {
        bestScore = score;
        best = {
          surah_number: surah.id,
          surah_name: surah.transliteration ?? surah.name,
          ayah_number: verse.id,
          arabic_text: ayahText,
          quran_link: `https://quran.com/${surah.id}/${verse.id}`,
          confidence: Math.round(score * 100) / 100,
        };
      }
    }
  }

  return bestScore >= 0.4 ? best : null;
}

// ---- Transcript scan --------------------------------------------------------

// Slides a window across the full transcript and scores every chunk against
// every ayah in the corpus. Catches Quranic quotes with no signal phrase.
// O(ayahs × transcriptWords) with O(1) per window slide via a frequency map.
function scanTranscriptForQuran(transcript, alreadyFound, keepPositions = false) {
  if (!quranData) return [];

  const tWords = normalizeArabic(transcript).split(/\s+/).filter(Boolean);
  const tLen = tWords.length;

  // Normalized texts already caught by Claude -- used for dedup
  const claudeNorm = new Set(
    alreadyFound.map(r => normalizeArabic(r.detected_text ?? ''))
  );

  const candidates = [];

  for (const surah of quranData) {
    for (const verse of (surah.verses ?? [])) {
      const ayahText = verse.text ?? '';
      if (!ayahText) continue;

      const aWords = normalizeArabic(ayahText).split(/\s+/).filter(Boolean);
      const aLen = aWords.length;

      if (aLen < 5 || aLen > tLen) continue;

      const aWordSet = new Set(aWords);

      // Sliding window — maintain intersection count incrementally
      let freq = {};
      let uniqueCount = 0;
      let intersect = 0;

      const addWord = w => {
        if (!freq[w]) { freq[w] = 0; uniqueCount++; if (aWordSet.has(w)) intersect++; }
        freq[w]++;
      };
      const removeWord = w => {
        freq[w]--;
        if (freq[w] === 0) { delete freq[w]; uniqueCount--; if (aWordSet.has(w)) intersect--; }
      };
      const score = () => intersect / (uniqueCount + aWordSet.size - intersect);

      for (let j = 0; j < aLen; j++) addWord(tWords[j]);

      let bestScore = score();
      let bestStart = 0;

      for (let i = 1; i <= tLen - aLen; i++) {
        removeWord(tWords[i - 1]);
        addWord(tWords[i + aLen - 1]);
        const s = score();
        if (s > bestScore) { bestScore = s; bestStart = i; }
      }

      if (bestScore < 0.65) continue;

      const detectedText = tWords.slice(bestStart, bestStart + aLen).join(' ');

      // Skip if Claude already found this region. Compare only the words the window shares
      // with the ayah: a window is fixed at the ayah's length, so it can pull in a word of the
      // imam's lead-in ("جل وعلا ألم تر كيف فعل ربك"), and that stray word defeated the
      // containment test — the opening of Al-Fil 105:1, already cited, came back as Al-Fajr
      // 89:6, which starts with the same four words.
      let lo = bestStart, hi = bestStart + aLen;
      while (lo < hi && !aWordSet.has(tWords[lo])) lo++;
      while (hi > lo && !aWordSet.has(tWords[hi - 1])) hi--;
      const core = tWords.slice(lo, hi).join(' ');
      if ([...claudeNorm].some(cn => cn.includes(core) || detectedText.includes(cn))) continue;

      candidates.push({
        detected_text: detectedText,
        matched: true,
        surah_name: surah.transliteration ?? surah.name,
        surah_number: surah.id,
        ayah_number: verse.id,
        quran_link: `https://quran.com/${surah.id}/${verse.id}`,
        confidence: Math.round(bestScore * 100) / 100,
        detection_method: 'scan',
        _start: bestStart,
        _end: bestStart + aLen,
      });
    }
  }

  // Sort by transcript position, deduplicate overlapping regions (keep best score)
  candidates.sort((a, b) => a._start - b._start);
  const deduped = [];
  for (const c of candidates) {
    const prev = deduped[deduped.length - 1];
    if (prev && c._start < prev._end) {
      if (c.confidence > prev.confidence) deduped[deduped.length - 1] = c;
    } else {
      deduped.push(c);
    }
  }

  // keepPositions=true is used internally for pre-chunking; callers get clean objects by default
  return deduped.map(({ _start, _end, ...rest }) =>
    keepPositions ? { _start, _end, ...rest } : rest
  );
}

// Extended normalisation used for matching the imam's words against the Quran corpus (the
// n-gram index, the pre-scan, the reader's verse checks). Both sides go through it, so it
// erases the differences between the mushaf's spelling and ordinary spelling:
//  - hamza seats ("ءامنوا" / "آمنوا", "سيئاتكم" / "سياتكم", "رءوف" / "رؤوف");
//  - every alef. The mushaf has a small alef where ordinary spelling has none (ذَٰلِكَ, ذِكْرَىٰ,
//    أُو۟لَٰٓئِكَ) and none where it has one (ٱلْكِتَٰب is fine, but so is the plural "جاءو"),
//    so a key without alefs matches both; recited.js aligns the cards the same way;
//  - ى/ي and ة/ه, and the mushaf's single lam in ٱلَّيْل for "الليل";
//  - the vocative, written joined in the mushaf (يَٰٓأَيُّهَا, يَٰٓأُو۟لِى, يَٰقَوْمِ) and as two words by
//    the imam's transcript (يا أيها, يا أولي, يا قوم);
//  - ى with a small alef inside a word, an alef in ordinary spelling (هَدَىٰكُمْ / هداكم).
// Until 4 Oct 2026 only the hamza seats were handled: on 2 Oct (Makkah) the matches of 59:2,
// 11:120 and 50:37 stopped short of يا أولي / وذكرى / ذلك, those words stayed in the prose sent to
// Claude, and three blocks repeated them beside the cards; 25:62's card began a word late.
const splitVocative = text => text.replace(/(^|\s)ي\u064E?\u0640?\u0670\u0653?(?=\S)/g, '$1يا ');
const midWordAlefMaqsura = text => text.replace(/ى\u0670(?=[\u0653\u0654]?[\u0621-\u064A])/g, 'ا');
function normalizeArabicDeep(text) {
  return normalizeArabic(midWordAlefMaqsura(splitVocative(text)))
    .replace(/ء/g, '')   // strip bare hamza ("ءامنوا" → "امنوا")
    .replace(/ئ/g, '')   // strip hamza-on-ya': in the corpus the ya' is already present
                         // separately, so replacing with ي would double it ("سيئاتكم" → "سياتكم")
    .replace(/ؤ/g, 'و') // hamza-on-waw → waw
    .replace(/وو/g, 'و') // "رؤوف" → "رووف", the corpus "رءوف" → "روف"
    .replace(/(^|\s)الل(?!ه)/g, '$1ال') // "الليل" → "اليل"; "الله", "اللهم" kept
    .replace(/ا/g, '')
    .replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim();
}

// Lazy-cached 4-gram index over the full Quran corpus.
// Key: deep-normalized 4-gram string. Value: [{pos_in_ayah, ayah_words}]
let _quranNgramIndex = null;
function getQuranNgramIndex(n = 4) {
  if (_quranNgramIndex) return _quranNgramIndex;
  if (!quranData) return new Map();
  const index = new Map();
  for (const surah of quranData) {
    for (const verse of (surah.verses ?? [])) {
      const text = verse.text ?? '';
      if (!text) continue;
      const words = normalizeArabicDeep(text).split(/\s+/).filter(Boolean);
      if (words.length < n) continue;
      for (let i = 0; i <= words.length - n; i++) {
        const key = words.slice(i, i + n).join(' ');
        if (!index.has(key)) index.set(key, []);
        index.get(key).push({
          pos: i, ayah_words: words,
          surah_id: surah.id,
          ayah_id: verse.id,
          surah_name: surah.transliteration ?? surah.name,
          ayah_text: text,
        });
      }
    }
  }
  _quranNgramIndex = index;
  return index;
}

// Scan transcript for Quran zones using n-gram index lookup.
// Catches partial citations and pronunciation variants at boundaries (e.g. ادعو vs ادع)
// that the Jaccard sliding-window scanner misses because it requires the full ayah length.
// Returns [{start, end}] word-index ranges to exclude from prose chunking.
// Local (Smith-Waterman) alignment of a canonical ayah against the transcript, tolerating
// gaps — fillers, repetitions, transcription variance. Claims the FULL recited span of the
// ayah (anchored to its first/last matched word), not merely the longest contiguous run, so
// an ayah head/tail never leaks into a prose chunk. ayahWords/tNorm are deep-normalized.
// anchorI = transcript index of the matched n-gram; anchorPos = its position within the ayah.
function alignFullAyah(ayahWords, tNorm, anchorI, anchorPos) {
  const A = ayahWords;
  const winStart = Math.max(0, anchorI - anchorPos - 4);
  const winEnd = Math.min(tNorm.length, anchorI - anchorPos + A.length + 8);
  const B = tNorm.slice(winStart, winEnd);
  const n = A.length, m = B.length;
  if (!n || !m) return null;
  const MATCH = 2, MISMATCH = -2, GAP = -1;
  const W = m + 1;
  const H = new Int32Array((n + 1) * W);
  const tb = new Int8Array((n + 1) * W); // 0=stop, 1=diag, 2=up(gap in B), 3=left(gap in A)
  let maxScore = 0, maxA = 0, maxB = 0;
  for (let a = 1; a <= n; a++) {
    for (let b = 1; b <= m; b++) {
      const diag = H[(a - 1) * W + (b - 1)] + (A[a - 1] === B[b - 1] ? MATCH : MISMATCH);
      const up = H[(a - 1) * W + b] + GAP;
      const left = H[a * W + (b - 1)] + GAP;
      let best = 0, dir = 0;
      if (diag > best) { best = diag; dir = 1; }
      if (up > best) { best = up; dir = 2; }
      if (left > best) { best = left; dir = 3; }
      H[a * W + b] = best; tb[a * W + b] = dir;
      if (best > maxScore) { maxScore = best; maxA = a; maxB = b; }
    }
  }
  if (maxScore <= 0) return null;
  // Traceback (from the max cell to the first zero) recording matched B positions.
  let a = maxA, b = maxB, firstB = -1, lastB = -1, matched = 0;
  while (a > 0 && b > 0 && tb[a * W + b] !== 0) {
    const dir = tb[a * W + b];
    if (dir === 1) {
      if (A[a - 1] === B[b - 1]) { matched++; if (lastB < 0) lastB = b - 1; firstB = b - 1; }
      a--; b--;
    } else if (dir === 2) { a--; } else { b--; }
  }
  if (firstB < 0) return null;
  return { start: winStart + firstB, end: winStart + lastB + 1, matched };
}

// Lazy surah_id -> [{ayah_id, surah_name, words}] map, used to walk from an identified
// ayah into the ones that follow it.
let _quranAyahWords = null;
function getQuranAyahWords() {
  if (_quranAyahWords) return _quranAyahWords;
  const m = new Map();
  for (const surah of (quranData ?? [])) {
    m.set(surah.id, (surah.verses ?? []).map(v => ({
      ayah_id: v.id,
      surah_name: surah.transliteration ?? surah.name,
      words: normalizeArabicDeep(v.text ?? '').split(/\s+/).filter(Boolean),
    })));
  }
  _quranAyahWords = m;
  return m;
}

// Levenshtein distance, capped: we only care whether two words are within a small edit
// distance, so bail out as soon as the best possible result exceeds `max`.
function editDistanceWithin(a, b, max) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1]
        : 1 + Math.min(prev[j - 1], prev[j], cur[j - 1]);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// Does `ayahWords` appear in the transcript starting at `at`?
//
// Exact matching is too strict for ASR output: a single mis-heard word ("وقطبا" for the
// Quran's "وقضبا") would break the chain mid-recitation, stranding the remaining verses in
// prose while the card above still quotes them — the passage then renders twice. So allow a
// small number of positions to differ, and only when the differing word is a near-miss of
// the expected one rather than a genuinely different word. This mirrors the transcription
// tolerance alignFullAyah already applies elsewhere.
function ayahFollowsAt(ayahWords, tNorm, at) {
  const len = ayahWords.length;
  if (!len || at + len > tNorm.length) return false;
  const allowed = Math.max(1, Math.floor(len * 0.25));
  let wrong = 0;
  for (let k = 0; k < len; k++) {
    const got = tNorm[at + k], want = ayahWords[k];
    if (got === want) continue;
    const d = editDistanceWithin(got, want, 2);
    // A single-letter difference in a word of four letters or more is orthography, not a
    // different word: the corpus writes the long vowel of عَلَىٰ / ذَٰلِكَ / ٱلْمَوْتَىٰ as a
    // superscript alef, which normalisation turns into a full alif ("علىا", "ذالك"), while
    // transcribed speech spells them the modern way. Those words are among the commonest in
    // the Quran, so charging each one against the budget exhausted it on ordinary verses and
    // broke consecutive-ayah chaining mid-passage (Al-Hajj 22:6 stopped short of 22:7).
    // Short words stay strict — at three letters a single edit is usually a different word.
    if (d === 1 && Math.max(got.length, want.length) >= 4) continue;
    // A near-miss counts as transcription noise; anything further apart is a real mismatch.
    if (d <= 2) { wrong++; if (wrong > allowed) return false; continue; }
    return false;
  }
  // Require most of the ayah to be genuinely present, so a short ayah cannot chain on noise.
  return len - wrong >= Math.ceil(len / 2);
}

// How many consecutive ayahs does a reference's detected_text actually cover?
//
// A khutbah often recites a passage, not a single verse, and whichever layer detected it
// (Claude's signal phrase, the Jaccard scan, or an n-gram zone) labels the reference with
// the FIRST ayah only. The reader then renders the card by fetching that one ayah, so a
// recitation of 'Abasa 80:25-32 displays as just 80:25 and the rest of the passage is lost
// from the card. Walk forward from the labelled ayah, consuming as many following ayahs as
// the detected text continues into, and record the last one as ayah_number_end.
// A multi-verse reference whose later verses are ALSO cited by their own reference gives
// those verses up. The two layers see different spans: Claude cited Quraysh 106:3-4 as one
// passage, while the n-gram pre-scan carved out only 106:4 (the corpus spells هذا "هاذا",
// so 106:3's 4-grams never matched) and cited it separately. 106:3 stayed in prose with a
// badge claiming both verses, and 106:4's words left that block for their own card — the
// badge's text was no longer contiguous in its block, so the reader could not mark it.
// Trimming the earlier reference to end where the later one begins lets each verse render
// once, where it was recited. Mutates in place.
function yieldTailToLaterRefs(refs) {
  const tokensOf = t => (t ?? '').split(/\s+/).filter(Boolean);
  const norm = t => normalizeArabicDeep(t.replace(/[.,،؛؟!:]/g, ''));
  for (const r of refs) {
    if (!r.ayah_number_end || r.ayah_number_end <= r.ayah_number) continue;
    const rTok = tokensOf(r.detected_text), rNorm = rTok.map(norm);
    for (const z of refs) {
      if (z === r || z.surah_number !== r.surah_number) continue;
      if (!(z.ayah_number > r.ayah_number && z.ayah_number <= r.ayah_number_end)) continue;
      const zLead = tokensOf(z.detected_text).map(norm).filter(Boolean).slice(0, 4);
      if (zLead.length < 3) continue;
      let at = -1;
      for (let p = 1; p + zLead.length <= rNorm.length && at < 0; p++) {
        if (zLead.every((w, k) => rNorm[p + k] === w)) at = p;
      }
      if (at < 0) continue;
      r.detected_text = rTok.slice(0, at).join(' ');
      if (z.ayah_number - 1 > r.ayah_number) r.ayah_number_end = z.ayah_number - 1;
      else delete r.ayah_number_end;
      break;
    }
  }
  return refs;
}

function annotateRefAyahRange(ref) {
  if (!ref?.matched || !ref.surah_number || !ref.ayah_number) return ref;
  const verses = getQuranAyahWords().get(ref.surah_number);
  if (!verses) return ref;

  // Normalise token by token so each normalised word keeps a pointer back to the original
  // token — the reference's text is trimmed against these positions at the end.
  const origTokens = (ref.detected_text ?? '').split(/\s+/).filter(Boolean);
  const words = [], srcIdx = [];
  origTokens.forEach((t, i) => {
    const n = normalizeArabicDeep(t);
    if (n) { words.push(n); srcIdx.push(i); }
  });
  if (!words.length) return ref;

  let idx = verses.findIndex(v => v.ayah_id === ref.ayah_number);
  if (idx < 0) return ref;

  // The reference may open with an intro phrase, so find where the labelled ayah starts.
  let pos = -1;
  for (let s = 0; s <= Math.min(words.length - 1, 6); s++) {
    if (ayahFollowsAt(verses[idx].words, words, s)) { pos = s + verses[idx].words.length; break; }
  }
  // An imam often picks a passage up MID-verse, and the detection layer still labels the
  // reference with the verse the recitation starts inside. The whole verse then never
  // matches, the walk never starts, and a two-verse passage is left labelled as one — which
  // is how Al-Hajj 22:34 came to carry the text of 22:34's tail plus all of 22:35. Try the
  // tails of the labelled verse, longest first, so the walk can still reach 22:35.
  if (pos < 0) {
    const av = verses[idx].words;
    for (let cut = 1; cut <= av.length - 3 && pos < 0; cut++) {
      const tail = av.slice(cut);
      for (let s = 0; s <= Math.min(words.length - 1, 6); s++) {
        if (ayahFollowsAt(tail, words, s)) { pos = s + tail.length; break; }
      }
    }
  }
  if (pos < 0) return ref;

  let last = ref.ayah_number;
  while (idx + 1 < verses.length) {
    const next = verses[idx + 1];
    if (!next.words.length || !ayahFollowsAt(next.words, words, pos)) break;
    pos += next.words.length;
    last = next.ayah_id;
    idx++;
  }
  if (last !== ref.ayah_number) ref.ayah_number_end = last;

  // Whatever follows the last consumed verse does not belong to this reference. The imam
  // skips verses — at Arafah he recited Al-Hajj 22:45 and then jumped to 22:48 — and the
  // detection layer hands back both as one block of text under the first verse's label. A
  // range cannot express a gap, so the card would display two verses that were never
  // recited. Trim instead: the skipped-to verse is picked up on its own by the zone scan,
  // so nothing is lost and the reference now says only what it cites.
  // A recitation often stops PART-WAY through its closing verse, which the full-verse walk
  // above cannot consume. That leftover text is still part of this reference, so check for a
  // partial continuation before trimming anything — otherwise Al-Hajj 22:27's run into the
  // first half of 22:28 would be cut off as if it belonged elsewhere.
  const leftover = words.length - pos;
  if (leftover >= 4 && idx + 1 < verses.length) {
    const next = verses[idx + 1];
    if (next.words.length > leftover && ayahFollowsAt(next.words.slice(0, leftover), words, pos)) {
      ref.ayah_number_end = next.ayah_id;
      return ref;
    }
  }
  if (leftover >= 3 && pos > 0) {
    ref.detected_text = origTokens.slice(0, srcIdx[pos - 1] + 1).join(' ');
  }
  return ref;
}

// Walk a zone forward through the ayahs that follow the one it was identified as.
//
// The n-gram index is built per ayah and skips any ayah shorter than n words, so a run of
// short ayahs is invisible to the scan no matter how clearly it is recited. 'Abasa 80:27-32
// ("فأنبتنا فيها حبا" / "وعنبا وقضبا" / ...) are all 2-3 words, so every one of them fell
// through into prose and was translated as if the imam were speaking rather than reciting.
//
// Recitation is sequential, so once a zone's ayah is known we can simply check whether the
// transcript continues into ayah+1, ayah+2, ... Matching is exact on the deep-normalised
// words: a khutbah recites verbatim, and a strict test avoids swallowing prose that merely
// resembles the next ayah.
function extendZonesByConsecutiveAyahs(zones, tNorm) {
  const byS = getQuranAyahWords();
  if (!byS.size) return zones;

  for (const zone of zones) {
    // A merged zone can hold several ayah identities; any of them might be the one sitting
    // at the zone's end, so try each as the anchor to continue from.
    const candidates = [
      { surah_id: zone.surah_id, ayah_id: zone.ayah_id },
      ...(zone.extra_ayahs ?? []).map(e => ({ surah_id: e.surah_id, ayah_id: e.ayah_id })),
    ];

    let advanced = true;
    while (advanced) {
      advanced = false;
      for (const c of candidates) {
        const verses = byS.get(c.surah_id);
        if (!verses) continue;
        const nextIdx = verses.findIndex(v => v.ayah_id === c.ayah_id) + 1;
        if (nextIdx <= 0 || nextIdx >= verses.length) continue;
        const next = verses[nextIdx];
        if (!next.words.length) continue;
        if (zone.end + next.words.length > tNorm.length) continue;

        if (!ayahFollowsAt(next.words, tNorm, zone.end)) continue;

        if (!zone.ayah_spans) zone.ayah_spans = [];
        zone.ayah_spans.push({
          surah_id: c.surah_id, ayah_id: next.ayah_id, surah_name: next.surah_name,
          start: zone.end, end: zone.end + next.words.length,
        });
        zone.end += next.words.length;
        if (!zone.extra_ayahs) zone.extra_ayahs = [];
        const dup = (zone.surah_id === c.surah_id && zone.ayah_id === next.ayah_id) ||
          zone.extra_ayahs.some(e => e.surah_id === c.surah_id && e.ayah_id === next.ayah_id);
        if (!dup) zone.extra_ayahs.push({ surah_id: c.surah_id, ayah_id: next.ayah_id, surah_name: next.surah_name });
        c.ayah_id = next.ayah_id; // continue the walk from the ayah we just consumed
        advanced = true;
        break;
      }
    }
  }
  return zones;
}

// A verse's first word or two that the match missed because the imam's form differs from the
// corpus only by a leading و ("ويكفر" for the Quran's "يكفر", "من" for "ومن"). Left out, they
// became one-word prose blocks beside a full sentence of translation ("ويكفر"; 2 Oct 2026
// Madinah; the joined يا أيها that also did is now split by normalizeArabicDeep). A word joins
// the verse only if it is the verse's own preceding word, so "قال تعالى" stays in the prose.
const noWaw = w => w.replace(/^و(?=..)/, '');
function extendZoneStarts(zones, tNorm) {
  for (const z of zones) {
    const verse = quranData[z.surah_id - 1]?.verses?.[z.ayah_id - 1]?.text;
    if (!verse) continue;
    const words = normalizeArabicDeep(verse).split(/\s+/).filter(Boolean);
    let k = words.indexOf(tNorm[z.start]);
    let start = z.start;
    for (let taken = 0; taken < 2 && k > 0 && start > 0; taken++) {
      const want = words[k - 1], have = tNorm[start - 1];
      if (noWaw(want) === noWaw(have)) { start--; k--; }
      else break;
    }
    if (start === z.start) continue;
    z.start = start;
    for (const s of z.ayah_spans ?? []) s.start = Math.min(s.start, start);
  }
}

function prescanForQuranZones(transcriptWords, n = 4) {
  if (!quranData) return [];
  const index = getQuranNgramIndex(n);
  const tNorm = transcriptWords.map(w => normalizeArabicDeep(w));
  const zones = [];
  let i = 0;

  while (i <= tNorm.length - n) {
    const key = tNorm.slice(i, i + n).join(' ');
    const hits = index.get(key);

    if (!hits) { i++; continue; }

    // Try all matching ayahs, keep the longest claimed span.
    let bestStart = i, bestEnd = i + n, bestHit = hits[0];
    for (const hit of hits) {
      const { pos, ayah_words } = hit;
      // Fuzzy full-ayah alignment (handles gaps/repeats/variance).
      const span = alignFullAyah(ayah_words, tNorm, i, pos);
      let zStart, zEnd;
      if (span && span.matched >= n) {
        zStart = span.start; zEnd = span.end;
      } else {
        // Fallback: strict contiguous extension forward/backward from the n-gram.
        let back = 0;
        while (back < pos && i - back - 1 >= 0 &&
               tNorm[i - back - 1] === ayah_words[pos - back - 1]) back++;
        let fwd = n;
        while (i + fwd < tNorm.length && pos + fwd < ayah_words.length &&
               tNorm[i + fwd] === ayah_words[pos + fwd]) fwd++;
        zStart = i - back; zEnd = i + fwd;
      }
      if (zEnd - zStart > bestEnd - bestStart) { bestStart = zStart; bestEnd = zEnd; bestHit = hit; }
    }

    // The claimed span must at least cover the matched n-gram [i, i+n]; the fuzzy
    // alignment can otherwise anchor on a repeated phrase elsewhere in the window.
    if (bestStart > i) bestStart = i;
    if (bestEnd < i + n) bestEnd = i + n;
    zones.push({
      start: bestStart, end: bestEnd,
      surah_id: bestHit.surah_id, ayah_id: bestHit.ayah_id, surah_name: bestHit.surah_name,
      // Exact word range of each ayah inside the zone. Ayahs shorter than n have no entry
      // in the n-gram index, so buildZoneRefs cannot re-derive their position by anchoring
      // and would fall back to claiming the whole zone — which mislabels the card. Record
      // the spans here, where they are known.
      ayah_spans: [{ surah_id: bestHit.surah_id, ayah_id: bestHit.ayah_id, surah_name: bestHit.surah_name, start: bestStart, end: bestEnd }],
    });
    // Always advance i past the zone (guard against a span that doesn't move us forward).
    i = Math.max(bestEnd, i + 1);
  }

  extendZoneStarts(zones, tNorm);

  // PAD_START=0: do NOT pad the zone backward. Padding pulled the intro phrase's last
  // word(s) ("قال الله [تعالى]", "قال عز [وجل]") into the zone, where they were excluded
  // from the prose chunk but NOT shown in the ayah card (cards render only verse text) —
  // so those words vanished. Keeping the intro in the prose chunk shows it as a natural
  // lead-in and renders the ayah cards with clean verse text.
  const PAD_START = 0;
  const padded = zones.map(z => ({ ...z, start: Math.max(0, z.start - PAD_START) }));

  // Merge overlapping/adjacent zones (padding can cause overlaps).
  // When zones merge, track extra ayahs so buildZoneRefs can surface all of them.
  const merged = [];
  for (const z of padded) {
    const prev = merged[merged.length - 1];
    if (prev && z.start <= prev.end) {
      prev.end = Math.max(prev.end, z.end);
      if (!prev.extra_ayahs) prev.extra_ayahs = [];
      const isDup = (prev.surah_id === z.surah_id && prev.ayah_id === z.ayah_id) ||
        prev.extra_ayahs.some(e => e.surah_id === z.surah_id && e.ayah_id === z.ayah_id);
      if (!isDup) prev.extra_ayahs.push({ surah_id: z.surah_id, ayah_id: z.ayah_id, surah_name: z.surah_name });
      prev.ayah_spans = [...(prev.ayah_spans ?? []), ...(z.ayah_spans ?? [])];
    } else {
      merged.push({ ...z });
    }
  }

  // Pick up runs of ayahs too short for the n-gram index to see (see the function's note).
  extendZonesByConsecutiveAyahs(merged, tNorm);

  // Extension can push one zone into the next; merge again so spans stay disjoint.
  const settled = [];
  for (const z of merged) {
    const prev = settled[settled.length - 1];
    if (prev && z.start <= prev.end) {
      prev.end = Math.max(prev.end, z.end);
      if (!prev.extra_ayahs) prev.extra_ayahs = [];
      for (const e of [{ surah_id: z.surah_id, ayah_id: z.ayah_id, surah_name: z.surah_name }, ...(z.extra_ayahs ?? [])]) {
        const isDup = (prev.surah_id === e.surah_id && prev.ayah_id === e.ayah_id) ||
          prev.extra_ayahs.some(x => x.surah_id === e.surah_id && x.ayah_id === e.ayah_id);
        if (!isDup) prev.extra_ayahs.push(e);
      }
      prev.ayah_spans = [...(prev.ayah_spans ?? []), ...(z.ayah_spans ?? [])];
    } else {
      settled.push(z);
    }
  }
  return splitAtCitations(trimIstiadha(settled), transcriptWords);
}

// The ayah words of a zone, deep-normalized.
const zoneAyahWords = z => new Set((z.ayah_spans ?? []).flatMap(s =>
  normalizeArabicDeep(quranData[s.surah_id - 1]?.verses.find(v => v.id === s.ayah_id)?.text ?? '').split(' ')));

// "أعوذ بالله من الشيطان الرجيم" before a recitation matches 16:98 and joined the verse's zone,
// leaving "أعوذ" alone in the prose ("I seek refuge", 18 Sep 2026 Madinah, before 17:21). The
// isti'adha is the imam's, not the verse: it starts the zone no more, and stays in the prose whole.
function trimIstiadha(zones) {
  for (const z of zones) {
    const spans = (z.ayah_spans ?? []).slice().sort((a, b) => a.start - b.start);
    const [first, next] = spans;
    if (!next || first.surah_id !== 16 || first.ayah_id !== 98 || first.end - first.start > 5 || first.start !== z.start) continue;
    z.start = next.start;
    z.ayah_spans = spans.slice(1);
    ({ surah_id: z.surah_id, ayah_id: z.ayah_id, surah_name: z.surah_name } = next);
    z.extra_ayahs = (z.extra_ayahs ?? []).filter(e => !(e.surah_id === 16 && e.ayah_id === 98) && !(e.surah_id === next.surah_id && e.ayah_id === next.ayah_id));
  }
  return zones;
}

// A zone that runs across the imam's citing phrase joined his own words to the verse he then
// cites: "ورزق الآخرة من حيث لا يحتسب، قال تعالى: ومن يتق الله يجعل له مخرجاً ويرزقه من حيث لا
// يحتسب" was one 65:3 zone from the first "من حيث", so 65:3's card came before 65:2's (18 Sep 2026,
// Madinah). Split at the citing word (one the verse does not have) and scan each side again.
function splitAtCitations(zones, transcriptWords) {
  const letters = w => normalizeArabic(w).replace(/[^\u0621-\u064A]/g, '');
  const out = [];
  for (const z of zones) {
    const ayah = zoneAyahWords(z);
    const words = transcriptWords.slice(z.start, z.end);
    const isCiting = w => CITES_VERSE.test(letters(w)) && !ayah.has(normalizeArabicDeep(w));
    const p = words.findIndex(isCiting);
    if (p < 0 || words.slice(0, p).filter(w => !isCiting(w)).length < 2) { out.push(z); continue; }
    for (const [a, b] of [[z.start, z.start + p], [z.start + p + 1, z.end]]) {
      for (const y of prescanForQuranZones(transcriptWords.slice(a, b))) {
        out.push({ ...y, start: y.start + a, end: y.end + a, ayah_spans: (y.ayah_spans ?? []).map(s => ({ ...s, start: s.start + a, end: s.end + a })) });
      }
    }
  }
  return out;
}

// Surface Quranic ayahs that the n-gram zones identified but Claude + Jaccard scan both missed.
// For each zone whose ayah is absent from existingRefs, creates a fallback ref using the
// transcript words from that zone as detected_text.
// Minimum matched words before an n-gram zone is worth citing. Shared by buildZoneRefs
// (which decides whether a zone becomes a card) and buildProseChunks (which decides
// whether a zone is carved out of prose). These two MUST use the same value: a zone that
// is carved out but not cited leaves its words in no chunk and no ref, and they vanish
// from the reader entirely.
const MIN_ZONE_WORDS = 5;

// The imam introducing a verse ("كما قال جل وعلا:"), in the few words before it.
const CITES_VERSE = /(^| )(قال|وقال|فقال|يقول|ويقول|تعالى|وتعالى|وعلا|سبحانه|وجل|قوله|وقوله|لقوله)( |$)/;

// Zones that are the imam's own sentence or du'a in Quranic words, not a recitation.
// 18 Sep 2026: "إلى العزيز الغفار من له ملك السماوات والأرض وما بينهما العظيم الجبار" got a
// 43:85 card mid-sentence, "اللهم جنبنا الفتن ما ظهر منها وما بطن" a 6:151 card in the du'a,
// and "وما من ذرة في السماوات والأرض إلا وهي شاهدة" a 19:93 card that cut the sentence in two.
// Such a zone is short (5–6 words), nothing cites it, no recitation runs just before it, it is
// neither the start nor the end of its ayah, and its words are a common Quranic phrase (every
// 4 words of it are in other ayahs too) or include a word the ayah does not have. Dropped
// here, before the chunks are cut, so its words stay in the prose and are translated with it.
// A short quotation found in one ayah only ("إن أكرمكم عند الله أتقاكم", 49:13) stays a card,
// as does a Quranic du'a run to the ayah's end ("ربنا آتنا في الدنيا حسنة …", 2:201).
// ponytail: a heuristic; across 36 transcripts it drops these four and the same 6:151 du'a in
// two May test runs, and no zone of a published page.
// Inside a du'a ("اللهم" just before) the same holds at any length: "اللهم احفظهم من بين أيديهم ومن
// خلفهم وعن أيمانهم وعن شمائلهم" (4 Sep 2026 Makkah, for Palestine) got a 7:17 card, Iblis's
// words. A Quranic du'a he recites (opening ربنا / رب) stays a card.
const BORROWED_MAX_WORDS = 6;
const DUA_LEAD = /(^| )اللهم( |$)/;
function dropBorrowedPhrases(zones, transcriptWords) {
  const index = getQuranNgramIndex();
  const deep = w => normalizeArabicDeep(w).split(' ').filter(Boolean);
  return zones.filter((z, k) => {
    const n = z.end - z.start;
    if (n < MIN_ZONE_WORDS || z.extra_ayahs?.length) return true;
    const lead = transcriptWords.slice(Math.max(0, z.start - 6), z.start).map(w => normalizeArabic(w)).join(' ');
    if (CITES_VERSE.test(lead)) return true;
    if (k > 0 && z.start - zones[k - 1].end <= 3) return true; // the recitation goes on
    const ayah = deep(quranData[z.surah_id - 1]?.verses.find(v => v.id === z.ayah_id)?.text ?? '');
    const said = transcriptWords.slice(z.start, z.end).flatMap(deep);
    if (!ayah.length || n >= ayah.length) return true;
    const bare = w => w?.replace(/^و/, '');
    if (bare(said[0]) === bare(ayah[0]) || said.at(-1) === ayah.at(-1)) return true;
    if (DUA_LEAD.test(lead) && !/^و?(?:رب|ربنا)$/.test(normalizeArabic(transcriptWords[z.start]).replace(/[^\u0621-\u064A]/g, ''))) return false;
    if (n > BORROWED_MAX_WORDS) return true;
    const stray = said.some(w => !ayah.includes(w));
    const grams = said.slice(0, -3).map((_, j) => new Set((index.get(said.slice(j, j + 4).join(' ')) ?? []).map(h => `${h.surah_id}:${h.ayah_id}`)));
    const common = grams.some(g => g.size) && grams.every(g => !g.size || g.size >= 2);
    return !(stray || common);
  });
}

function buildZoneRefs(zones, transcriptWords, existingRefs) {
  const index = getQuranNgramIndex();
  const tNorm = transcriptWords.map(w => normalizeArabicDeep(w));
  const newRefs = [];

  for (const zone of zones) {
    // When prescan recorded exact per-ayah spans, prefer them. A consecutive recitation
    // (e.g. 'Abasa 80:25-32) becomes ONE card covering the run rather than one card per
    // ayah: several of those ayahs are 2-3 words and would fall under MIN_ZONE_WORDS
    // individually, and eight stacked cards for a single passage reads worse than one.
    const spans = (zone.ayah_spans ?? []).slice().sort((a, b) => a.start - b.start);
    if (spans.length) {
      const runs = [];
      for (const s of spans) {
        const prev = runs[runs.length - 1];
        const consecutive = prev && prev.surah_id === s.surah_id &&
          s.ayah_id === prev.ayah_end + 1 && s.start <= prev.end;
        if (consecutive) { prev.ayah_end = s.ayah_id; prev.end = Math.max(prev.end, s.end); }
        else runs.push({ surah_id: s.surah_id, surah_name: s.surah_name, ayah_start: s.ayah_id, ayah_end: s.ayah_id, start: s.start, end: s.end });
      }

      for (const run of runs) {
        const refWords = transcriptWords.slice(run.start, run.end);
        // An earlier layer may already name one ayah of this run — typically the first,
        // with detected_text covering only that verse. Skipping the run then leaves the
        // rest of the recitation inside the zone (so out of prose) but outside any
        // reference, and it renders nowhere: that is how the khutbah's closing
        // "وسلام على المرسلين والحمد لله رب العالمين" (37:181-182) disappeared. Widen the
        // existing reference to the whole run instead of dropping it.
        const existing = existingRefs.find(r =>
          r.matched && r.surah_number === run.surah_id &&
          r.ayah_number >= run.ayah_start && r.ayah_number <= run.ayah_end
        );
        if (existing) {
          const existingLen = (existing.detected_text ?? '').split(/\s+/).filter(Boolean).length;
          if (refWords.length > existingLen) {
            existing.detected_text = refWords.join(' ');
            existing.ayah_number = run.ayah_start;
            existing.quran_link = `https://quran.com/${run.surah_id}/${run.ayah_start}`;
            if (run.ayah_end !== run.ayah_start) existing.ayah_number_end = run.ayah_end;
          }
          continue;
        }
        if (refWords.length < MIN_ZONE_WORDS) continue;
        newRefs.push({
          detected_text: refWords.join(' '),
          matched: true,
          surah_name: run.surah_name,
          surah_number: run.surah_id,
          ayah_number: run.ayah_start,
          ...(run.ayah_end !== run.ayah_start ? { ayah_number_end: run.ayah_end } : {}),
          quran_link: `https://quran.com/${run.surah_id}/${run.ayah_start}`,
          confidence: 0.8,
          verification: 'ngram_zone',
          detection_method: 'ngram_zone',
        });
      }
      continue;
    }

    const ayahs = [
      { surah_id: zone.surah_id, ayah_id: zone.ayah_id, surah_name: zone.surah_name },
      ...(zone.extra_ayahs ?? []),
    ];

    for (const { surah_id, ayah_id, surah_name } of ayahs) {
      if (!surah_id || !ayah_id) continue;
      const already = existingRefs.some(r =>
        r.matched && r.surah_number === surah_id && r.ayah_number === ayah_id
      );
      if (already) continue;

      // Find this ayah's span within the zone. Anchor on any of its 4-grams, then use the
      // SAME fuzzy alignment as prescan (alignFullAyah) so transcription variance (e.g.
      // "زلزله" vs corpus "زلزلة") doesn't truncate the span below the 5-word threshold and
      // drop the ayah. Default to the whole zone if no anchor is found.
      let wordStart = zone.start, wordEnd = zone.end;
      for (let j = zone.start; j <= zone.end - 4; j++) {
        const key = tNorm.slice(j, j + 4).join(' ');
        const hits = index.get(key);
        if (!hits) continue;
        const hit = hits.find(h => h.surah_id === surah_id && h.ayah_id === ayah_id);
        if (!hit) continue;
        const span = alignFullAyah(hit.ayah_words, tNorm, j, hit.pos);
        if (span) { wordStart = span.start; wordEnd = span.end; }
        break;
      }

      const refWords = transcriptWords.slice(wordStart, wordEnd);
      // Require MIN_ZONE_WORDS matched words to avoid surfacing short common phrases
      // (ta'awwudh "بالله من الشيطان الرجيم", common endings like "إنه كان حليما غفورا")
      // that happen to appear in an ayah but aren't genuine citations. buildProseChunks
      // uses the same constant to decide which zones to carve out of prose — the two must
      // agree, or a zone gets removed from prose without ever being rendered as a card.
      if (refWords.length < MIN_ZONE_WORDS) continue;
      const detected_text = refWords.join(' ');
      newRefs.push({
        detected_text,
        matched: true,
        surah_name,
        surah_number: surah_id,
        ayah_number: ayah_id,
        quran_link: `https://quran.com/${surah_id}/${ayah_id}`,
        confidence: 0.8,
        verification: 'ngram_zone',
        detection_method: 'ngram_zone',
      });
    }
  }
  return newRefs;
}

// Splits transcript words into numbered prose chunks, skipping detected Quran zones.
// Returns [{text, wordStart, wordEnd, proseIdx}] for prose chunks only.
// proseIdx is the 0-based index matching the chunk_translations array.
// Phrases a block never splits: on 2 Oct 2026 (Madinah) a 30-second timing segment ended inside
// "يقول النبي صلى | الله عليه وسلم: ليس الغنى…", the long sentence was cut there, and the English
// block began "وسلم said:". A cut that would fall inside one moves past it.
const FIXED_PHRASES = ['صلى الله عليه وسلم', 'صلى الله عليه وآله وسلم', 'رضي الله عنه', 'رضي الله عنها',
  'رضي الله عنهما', 'رضي الله عنهم', 'عز وجل', 'جل جلاله', 'سبحانه وتعالى', 'تبارك وتعالى', 'عليه السلام',
  'عليه الصلاة والسلام', 'رحمه الله'].map(p => p.split(' ').map(w => normalizeArabic(w)));
const bare = w => normalizeArabic(w ?? '').replace(/[^\u0621-\u064A]/g, '');
function splitsPhrase(words, b) {
  return FIXED_PHRASES.some(p => {
    for (let k = 1; k < p.length; k++) if (p.every((w, j) => bare(words[b - k + j]) === bare(w))) return true;
    return false;
  });
}

function buildProseChunks(transcriptWords, quranZones, CHUNK_SIZE, transcriptSegments) {
  // Build set of word-index positions where each Whisper segment ends.
  // These are the natural breath/pause boundaries in the imam's speech.
  const segBreaks = new Set();
  if (transcriptSegments && transcriptSegments.length) {
    let pos = 0;
    for (const seg of transcriptSegments) {
      pos += seg.text.trim().split(/\s+/).filter(Boolean).length;
      segBreaks.add(pos);
    }
  }

  // Prefer breaking at SENTENCE ends (Gemini adds . ؟ ! punctuation) so a chunk never
  // cuts mid-sentence. Fall back to Whisper segment (breath-pause) boundaries when the
  // transcript has no sentence punctuation (e.g. raw Groq output).
  const sentenceBreaks = new Set();
  for (let i = 0; i < transcriptWords.length; i++) {
    if (/[.؟!…]$/.test(transcriptWords[i])) sentenceBreaks.add(i + 1);
  }
  const breakSet = sentenceBreaks.size ? sentenceBreaks : segBreaks;
  // A hadith's attribution ("متفق عليه.", "رواه البخاري.") closes the hadith, so no block starts
  // with it: on 2 Oct "متفق عليه" opened the next block three times. Only a short attribution
  // sentence (a sentence end within six words) moves; a long one is the imam's own sentence.
  for (const b of [...breakSet]) {
    if (!/^(?:متفق عليه|(?:رواه|اخرجه|خرجه) )/.test(normalizeArabic(transcriptWords.slice(b, b + 3).join(' ')))) continue;
    if (transcriptWords.slice(b, b + 6).some(w => /[.؟!…]$/.test(w))) breakSet.delete(b);
  }
  for (const b of [...breakSet]) if (splitsPhrase(transcriptWords, b)) breakSet.delete(b);

  const proseChunks = [];
  let cursor = 0;

  const flush = (from, to) => {
    if (from >= to) return;

    // Fallback: no break info — use fixed-size chunks
    if (breakSet.size === 0) {
      for (let i = from; i < to; i += CHUNK_SIZE) {
        const end = Math.min(i + CHUNK_SIZE, to);
        const slice = transcriptWords.slice(i, end);
        if (slice.length > 0)
          proseChunks.push({ text: slice.join(' '), wordStart: i, wordEnd: end, proseIdx: proseChunks.length });
      }
      return;
    }

    // Break-aware chunking: accumulate until we have at least MIN_CHUNK words, then break
    // at the next sentence end (or segment boundary). Keeps semantically coherent units
    // and avoids cutting mid-sentence.
    // MIN_CHUNK drives the typical block size: a block accumulates until it reaches
    // MIN_CHUNK words and then ends at the NEXT sentence boundary, so blocks always break
    // on a full sentence. Lowering it shortens blocks without ever cutting mid-sentence.
    // MAX_CHUNK is only a wall for a single runaway sentence, and it DOES cut mid-sentence,
    // so it stays well above MIN_CHUNK and is deliberately rare.
    const MIN_CHUNK = 10;
    const MAX_CHUNK = Math.round(CHUNK_SIZE * 1.5); // hard cap for unusually long sentences

    // Collect break points within (from, to), plus 'to' as the final boundary
    const breaks = [];
    for (let b = from + 1; b < to; b++) {
      if (breakSet.has(b)) breaks.push(b);
    }
    breaks.push(to);

    const ranges = [];
    let chunkStart = from;
    for (const brk of breaks) {
      const len = brk - chunkStart;
      if (len >= MIN_CHUNK || brk === to) { ranges.push([chunkStart, brk]); chunkStart = brk; }
      // else: accumulated words still below MIN_CHUNK — keep going
    }
    // Merge any too-short range into a neighbour (contiguous prose between two zones can
    // leave a tiny trailing fragment like "وكيف يدعو" right before an ayah; on its own it
    // gets a misleading expanded translation that paraphrases the upcoming verse).
    for (let k = ranges.length - 1; k > 0; k--) {
      if (ranges[k][1] - ranges[k][0] < MIN_CHUNK) { ranges[k - 1][1] = ranges[k][1]; ranges.splice(k, 1); }
    }
    if (ranges.length > 1 && ranges[0][1] - ranges[0][0] < MIN_CHUNK) {
      ranges[1][0] = ranges[0][0]; ranges.shift();
    }
    for (const [s, e] of ranges) {
      // Split a range that exceeds MAX_CHUNK. Cutting at exactly MAX_CHUNK slices
      // mid-phrase ("...ولأنعامكم عباد" / "...as provision for you. O servants of"), so
      // prefer the last breath pause or comma inside the window and only cut at the hard
      // limit when the span has no internal boundary at all.
      let i = s;
      while (i < e) {
        let end = Math.min(i + MAX_CHUNK, e);
        if (end < e) {
          let cut = -1;
          for (let b = end; b > i + MIN_CHUNK; b--) {
            if ((segBreaks.has(b) || /[،,؛;]$/.test(transcriptWords[b - 1] ?? '')) && !splitsPhrase(transcriptWords, b)) { cut = b; break; }
          }
          if (cut > i) end = cut;
          while (end < e && splitsPhrase(transcriptWords, end)) end++;
        }
        const slice = transcriptWords.slice(i, end);
        if (slice.length > 0)
          proseChunks.push({ text: slice.join(' '), wordStart: i, wordEnd: end, proseIdx: proseChunks.length });
        i = end;
      }
    }
  };

  // Only carve out zones that will actually be rendered as a reference card. buildZoneRefs
  // requires MIN_ZONE_WORDS before it will surface a zone, so a shorter zone produces no
  // card — and if it were still excluded here its words would belong to no chunk and no
  // ref, and would silently disappear from the reader. That is how "إنه هو الغفور الرحيم"
  // (a 4-word match on 12:98) and the closing "والحمد لله رب العالمين" (6:45) were lost.
  // Leaving them in prose means they are translated as prose, which is the right outcome
  // for a fragment too short to cite.
  for (const zone of quranZones) {
    if (zone.end - zone.start < MIN_ZONE_WORDS) continue;
    if (zone.start > cursor) flush(cursor, zone.start);
    cursor = zone.end;
  }
  if (cursor < transcriptWords.length) flush(cursor, transcriptWords.length);
  return proseChunks;
}

// Step 7: Match each Quranic reference.
// Claude identifies the surah/ayah from its Quran knowledge (primary).
// The local algorithm independently scores the extracted text (cross-check).
// If both agree  → high confidence.
// If they disagree → flag for manual review (one may have erred).
// If only algorithm matched → use it, note Claude was uncertain.
function matchClaudeQuranRef(ref) {
  const algoMatch = findMatchingAyah(ref.arabic_text ?? '');

  const claudeSurahNum = ref.surah_number ?? null;
  const claudeAyahNum  = ref.ayah_number  ?? null;
  const claudeIdentified = claudeSurahNum !== null && claudeAyahNum !== null;

  // Determine agreement
  const bothAgree = claudeIdentified && algoMatch &&
    algoMatch.surah_number === claudeSurahNum &&
    algoMatch.ayah_number  === claudeAyahNum;
  const disagree = claudeIdentified && algoMatch &&
    (algoMatch.surah_number !== claudeSurahNum || algoMatch.ayah_number !== claudeAyahNum);

  // On a disagreement, let the detected words themselves break the tie. Claude reads
  // meaning and is usually right about which passage is being cited, but it mislabels an
  // adjacent verse when two share a phrase: Al-Hajj 22:36 and 22:37 both contain
  // "كذلك سخر…ها لكم", and Claude labelled 22:36's closing words as 22:37. Deferring to
  // Claude unconditionally put the wrong verse on the card. Prefer the algorithm only when
  // its verse contains clearly more of the detected text, so an ordinary near-tie still
  // goes to Claude.
  const ayahCoverage = (sNum, aNum) => {
    const verse = getQuranAyahWords().get(sNum)?.find(v => v.ayah_id === aNum);
    if (!verse) return 0;
    const inVerse = new Set(verse.words);
    const det = normalizeArabicDeep(ref.arabic_text ?? '').split(/\s+/).filter(Boolean);
    if (!det.length) return 0;
    return det.filter(w => inVerse.has(w)).length / det.length;
  };
  // Neighbouring verses of the same surah are a different case: a recitation that runs
  // across both contains words of both, and whole-text coverage then favours whichever
  // verse is longer — Quraysh 106:3-4 was labelled 106:4 because 106:4 has twice the
  // words, and the range walk (which only extends forward) could never recover 106:3.
  // The label must name the verse the recitation STARTS in, so decide on the leading words.
  const leadCoverage = (sNum, aNum) => {
    const verse = getQuranAyahWords().get(sNum)?.find(v => v.ayah_id === aNum);
    if (!verse) return 0;
    const inVerse = new Set(verse.words);
    const lead = normalizeArabicDeep(ref.arabic_text ?? '').split(/\s+/).filter(Boolean).slice(0, 3);
    return lead.filter(w => inVerse.has(w)).length;
  };
  const adjacent = disagree && algoMatch.surah_number === claudeSurahNum &&
    Math.abs(algoMatch.ayah_number - claudeAyahNum) === 1;
  const preferAlgo = disagree && (adjacent
    ? leadCoverage(algoMatch.surah_number, algoMatch.ayah_number)
        > leadCoverage(claudeSurahNum, claudeAyahNum)
    : ayahCoverage(algoMatch.surah_number, algoMatch.ayah_number)
        > ayahCoverage(claudeSurahNum, claudeAyahNum) + 0.15);

  // Choose which identification to use:
  //  - Agreed: either (they match)
  //  - Claude only: trust Claude, algorithm couldn't confirm
  //  - Algorithm only: use algorithm, Claude was uncertain
  //  - Disagreement: whichever verse the words belong to (above), defaulting to Claude
  const useClaude = claudeIdentified && !preferAlgo;
  const surahNum  = useClaude ? claudeSurahNum  : (algoMatch?.surah_number ?? null);
  const ayahNum   = useClaude ? claudeAyahNum   : (algoMatch?.ayah_number  ?? null);
  const surahName = useClaude ? (ref.surah_name ?? algoMatch?.surah_name ?? null)
                              : (algoMatch?.surah_name ?? null);

  if (!surahNum || !ayahNum) {
    return {
      detected_text: ref.arabic_text,
      matched: false,
      surah_name: null, surah_number: null, ayah_number: null,
      quran_link: null, confidence: 0,
      verification: 'no_match',
    };
  }

  const quranLink = `https://quran.com/${surahNum}/${ayahNum}`;
  const confidence = bothAgree
    ? Math.max(algoMatch.confidence, 0.95)   // both agree → high confidence
    : claudeIdentified && !algoMatch
      ? 0.85                                  // Claude only
      : disagree
        ? 0.75                                // disagreement — flagged
        : (algoMatch?.confidence ?? 0.7);     // algorithm only

  return {
    detected_text: ref.arabic_text,
    matched: true,
    surah_name: surahName,
    surah_number: surahNum,
    ayah_number: ayahNum,
    quran_link: quranLink,
    confidence: Math.round(confidence * 100) / 100,
    verification: bothAgree    ? 'claude+algorithm'
                : disagree     ? `DISAGREEMENT:claude=${claudeSurahNum}:${claudeAyahNum},algo=${algoMatch.surah_number}:${algoMatch.ayah_number}${preferAlgo ? ',used=algo' : ',used=claude'}`
                : claudeIdentified ? 'claude_only'
                : 'algorithm_only',
  };
}

// The imam's restarts (18 Sep 2026). Each chunk is translated, and reviewed, apart from the
// next, so a sentence he broke off and said again in the next chunk was translated twice
// although every prompt says to translate a restart once. Two kinds:
//  - broken: a chunk ends where he broke off ("…", as the transcript marks it) and the next one
//    starts that sentence again ("فهو سيد الأغنياء الشاكر..." | "فهو سيد الأغنياء الشاكرين");
//  - repeat: a run of 5+ words he says again within 30 words ("فلا تندم عبد الله على حسن ظن
//    بذلته…", 25 words, said twice across a chunk edge).
// chunks: each chunk's Arabic, in order. Returns [{ kind, chunk, from, words }]: chunk `chunk`
// says again `words` that chunk `from` already has (from === chunk inside one chunk).
const RESTART_FORMULA = new Set(['صلى', 'الله', 'عليه', 'وسلم', 'رسول', 'النبي', 'سبحانه', 'وتعالى', 'تعالى', 'عز', 'وجل',
  'رضي', 'عنه', 'عنها', 'عنهم', 'قال']);
// Repeated on purpose: a du'a ("اللهم احفظ …" twice), the salawat's "على محمد وعلى آل محمد كما …
// على إبراهيم", the Eid takbir, a refrain ("فعلو الهمة يا عباد الله").
const RESTART_DELIBERATE = /(?:^| )(?:و?اللهم|يا|ربنا|اكبر|محمد|ابراهيم|احفظ|واحفظ|وانصر)(?= |$)/;
function findRestarts(chunks, { min = 5, within = 30 } = {}) {
  const seq = [];
  chunks.forEach((c, ci) => (c ?? '').split(/\s+/).filter(Boolean)
    .forEach(raw => seq.push({ ci, raw, w: normalizeArabic(raw).replace(/[^\u0621-\u064A]/g, '') })));
  const same = (i, j, n) => { for (let k = 0; k < n; k++) if (!seq[i + k].w || seq[i + k].w !== seq[j + k].w) return false; return true; };
  const out = [];
  for (let i = 0; i + min <= seq.length; i++) {
    for (let j = i + min; j <= i + min + within && j + min <= seq.length; j++) {
      if (!same(i, j, min)) continue;
      let n = min;
      while (j + n < seq.length && i + n < j && seq[i + n].w === seq[j + n].w) n++;
      const run = seq.slice(j, j + n), gap = j - i - n;
      // A short run counts only when said again at once, a word between at most ("في دار أسامة بن زيد، في دار أسامة بن
      // زيد"); with words between, a short run is the imam's parallelism ("ويظهر الوفاء كذلك في
      // نبذ …، ويظهر الوفاء كذلك في نبذ …").
      if ((n >= 8 || gap <= 1) && run.filter(x => !RESTART_FORMULA.has(x.w)).length >= 3
        && !RESTART_DELIBERATE.test(run.map(x => x.w).join(' '))) {
        out.push({ kind: 'repeat', chunk: seq[j].ci, from: seq[i].ci, words: run.map(x => x.raw).join(' '), gap });
      }
      i += n - 1;
      break;
    }
  }
  for (let c = 0; c + 1 < chunks.length; c++) {
    const text = (chunks[c] ?? '').trim();
    if (!/(\.\.\.|…)$/.test(text) || out.some(r => r.from === c && r.chunk === c + 1)) continue;
    const tail = text.split(/[.،؟!:؛]\s/).pop().replace(/(\.\.\.|…)$/, '').split(/\s+/).filter(Boolean);
    const next = new Set((chunks[c + 1] ?? '').split(/\s+/).slice(0, tail.length + 3).map(w => normalizeArabic(w)));
    // The last word is the one he cut ("الشاكر" for "الشاكرين"): the others must come again.
    const whole = tail.slice(0, -1);
    if (whole.length >= 2 && whole.filter(w => next.has(normalizeArabic(w))).length >= Math.max(2, whole.length * 0.6)) {
      out.push({ kind: 'broken', chunk: c + 1, from: c, words: tail.join(' ') });
    }
  }
  return out;
}

// findRestarts' finds as lines for a translator's prompt; label(i): chunk i as that prompt numbers it.
function restartNotes(restarts, label = i => String(i)) {
  if (!restarts.length) return '';
  return 'Where the imam restarted (found in his Arabic; translate each of these once):\n' + restarts.map(r =>
    r.kind === 'broken'
      ? `- Chunk ${label(r.from)} ends where he broke off («${r.words}…») and chunk ${label(r.chunk)} says that sentence again in full: leave the broken-off words out of chunk ${label(r.from)}.`
      : r.chunk === r.from
        ? `- Chunk ${label(r.chunk)} says «${r.words}» twice: translate it once.`
        : `- Chunk ${label(r.chunk)} says again «${r.words}», which chunk ${label(r.from)} already has: translate it in chunk ${label(r.from)} only.`).join('\n');
}

export {
  findRestarts,
  restartNotes,
  splitsPhrase,
  matchClaudeQuranRef,
  normalizeArabic,
  wordOverlapScore,
  quranData,
  normalizeArabicDeep,
  prescanForQuranZones,
  MIN_ZONE_WORDS,
  stripAyahMarkup,
  buildProseChunks,
  findMatchingAyah,
  getQuranAyahWords,
  scanTranscriptForQuran,
  buildZoneRefs,
  dropBorrowedPhrases,
  CITES_VERSE,
  annotateRefAyahRange,
  yieldTailToLaterRefs,
  getQuranNgramIndex,
};
