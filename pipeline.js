// Khutbah Processing Pipeline
// Transcribes Arabic audio -> translates -> extracts Quranic/Hadith references -> matches Ayahs

import 'dotenv/config';
import { writeFileSync, mkdirSync, readFileSync, existsSync, statSync, createReadStream, readdirSync, unlinkSync } from 'fs';
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import Groq from 'groq-sdk';
import { GoogleGenAI } from '@google/genai';

const require = createRequire(import.meta.url);

// Fallback placeholder keys so importing this module (e.g. server.js live mode)
// never throws when an optional provider key is absent — the API call itself
// will fail with a clear auth error if that provider is actually used.
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || 'not-set' });
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || 'not-set',
  timeout: 120_000,  // 2-minute timeout (large transcripts take a while)
  maxRetries: 3,
});
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || 'not-set' });
const gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || 'not-set' });

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

// Hadith corpus loaded lazily in main() after normalizeArabic is defined.
let hadithCorpus = null;

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

// Search the hadith corpus for the best match to a detected hadith text.
// Used to fill in collection + number for Claude's signal-phrase finds.
function findMatchingHadith(detectedText, hadithCorpus) {
  if (!hadithCorpus?.length || !detectedText) return null;

  // Strip khatib commentary patterns inserted into the hadith text:
  //   أي ...     (i.e. / meaning ...)
  //   يعني ...   (meaning ...)
  //   parenthetical clauses wrapped in brackets
  const cleaned = detectedText
    .replace(/\s+أي\s+\S+(?:\s+\S+){0,3}/g, ' ')   // strip "أي X Y Z" (max 4 words)
    .replace(/\s+يعني\s+\S+(?:\s+\S+){0,3}/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const normDetected = normalizeArabic(cleaned);
  const detectedWords = normDetected.split(/\s+/).filter(Boolean);
  const detectedWordSet = new Set(detectedWords);
  const isShort = detectedWords.length < 6;

  let best = null;
  let bestScore = 0;

  for (const h of hadithCorpus) {
    const aWordSet = new Set(h.matnWords);
    const matchedCount = detectedWords.filter(w => aWordSet.has(w)).length;

    let score;
    if (isShort) {
      // For short phrases: require ALL words to appear in the matn (containment).
      // Score = fraction of matn words that are detected words (avoids Jaccard dilution).
      if (matchedCount < detectedWords.length) continue;
      score = matchedCount / h.matnWords.length;
    } else {
      const stringContained = normDetected.includes(h.matn) || h.matn.includes(normDetected);
      const wordMajority = matchedCount / Math.max(detectedWords.length, 1) >= 0.75;
      const overlap = wordOverlapScore(normDetected, h.matn);
      score = stringContained ? Math.max(overlap, 0.8) : wordMajority ? Math.max(overlap, 0.65) : overlap;
    }

    if (score > bestScore) { bestScore = score; best = h; }
  }

  const minScore = isShort ? 0.08 : 0.5;
  if (bestScore < minScore) return null;
  return { ...best, confidence: Math.round(bestScore * 100) / 100 };
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

// Extended normalisation used only for n-gram index building and pre-scan matching.
// More aggressive than normalizeArabic: also collapses hamza seats and strips
// bare hamza so corpus encoding differences (ئ vs dropped, ء vs آ, ياايها vs يا+أيها)
// don't prevent 4-gram matches.
function normalizeArabicDeep(text) {
  return normalizeArabic(text)
    .replace(/ء/g, '')   // strip bare hamza ("ءامنوا" → "امنوا")
    .replace(/ئ/g, '')   // strip hamza-on-ya': in the corpus the ya' is already present
                         // separately, so replacing with ي would double it ("سيئاتكم" → "سياتكم")
    .replace(/ؤ/g, 'و') // hamza-on-waw → waw
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
  return settled;
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
            if (segBreaks.has(b) || /[،,؛;]$/.test(transcriptWords[b - 1] ?? '')) { cut = b; break; }
          }
          if (cut > i) end = cut;
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

// ---- Hadith corpus ----------------------------------------------------------

const HADITH_DIR = path.join(__dirname, 'hadith_data');
const COLLECTION_NAMES = {
  'ara-bukhari':  'Sahih al-Bukhari',
  'ara-muslim':   'Sahih Muslim',
  'ara-abudawud': 'Sunan Abu Dawud',
  'ara-nasai':    "Sunan an-Nasa'i",
  'ara-ibnmajah': 'Sunan Ibn Majah',
};

// Load and pre-process all downloaded hadith collections.
// Extracts just the matn (main text) from each hadith, stripping the isnad.
function loadHadithCorpus() {
  if (!existsSync(HADITH_DIR)) return [];

  const corpus = [];
  for (const file of readdirSync(HADITH_DIR).filter(f => f.endsWith('.json'))) {
    const id = file.replace('.json', '');
    const collectionName = COLLECTION_NAMES[id] ?? id;
    let data;
    try {
      data = JSON.parse(readFileSync(path.join(HADITH_DIR, file), 'utf8'));
    } catch { continue; }

    for (const h of (data.hadiths ?? [])) {
      const matn = extractMatn(h.text ?? '');
      const matnWords = matn.split(/\s+/).filter(Boolean);
      if (matnWords.length < 5) continue;
      corpus.push({
        collection: collectionName,
        collectionId: id,
        number: h.hadithnumber ?? h.arabicnumber,
        matn,
        matnWords,
        link: `https://sunnah.com/${id.replace('ara-', '')}:${h.hadithnumber}`,
      });
    }
  }
  return corpus;
}

// ---- Authoritative sunnah.com link resolution ------------------------------
//
// The local corpus matches the hadith *text* correctly but stores a sequential
// hadith number, while sunnah.com URLs use a different numbering for some
// collections (notably Sahih Muslim uses Abdul-Baqi numbering — the Arafah-fasting
// hadith is sequential 2746 in the corpus but muslim:1162a on sunnah.com). There is
// no free Abdul-Baqi<->sequential mapping, so instead of *constructing* a URL from a
// number we ask sunnah.com directly: search its site for the matn text and read back
// the real permalink it returns. The number/link then come from sunnah.com itself and
// cannot disagree with the page they point to.

// sunnah.com collection slugs we recognise (local corpus ids minus the "ara-" prefix
// already match these; extras cover collections Claude may name without a corpus match).
const SUNNAH_SLUGS = new Set([
  'bukhari', 'muslim', 'abudawud', 'nasai', 'ibnmajah', 'tirmidhi',
  'malik', 'ahmad', 'darimi', 'nawawi40', 'riyadussalihin', 'adab', 'mishkat',
]);

const SLUG_DISPLAY = {
  bukhari: 'Sahih al-Bukhari', muslim: 'Sahih Muslim', abudawud: 'Sunan Abu Dawud',
  nasai: "Sunan an-Nasa'i", ibnmajah: 'Sunan Ibn Majah', tirmidhi: 'Jami` at-Tirmidhi',
  malik: 'Muwatta Malik', ahmad: 'Musnad Ahmad',
};
const slugToDisplay = slug => SLUG_DISPLAY[slug] ?? slug;

// Map a collection display name (from Claude or the corpus) to a sunnah.com slug.
function collectionToSlug(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  if (n.includes('bukhari')) return 'bukhari';
  if (n.includes('muslim')) return 'muslim';
  if (n.includes('tirmidhi') || n.includes('tirmizi') || n.includes('tirmidzi')) return 'tirmidhi';
  if (n.includes('abu dawud') || n.includes('abu dawood') || n.includes('abudawud') || n.includes('abi dawud')) return 'abudawud';
  if (n.includes('nasa')) return 'nasai';
  if (n.includes('ibn majah') || n.includes('ibn-e-majah') || n.includes('ibnmajah') || n.includes('ibn maja')) return 'ibnmajah';
  if (n.includes('muwatta') || n.includes('malik')) return 'malik';
  if (n.includes('ahmad')) return 'ahmad';
  return null;
}

// On-disk cache so repeat hadiths / re-runs cost no network requests.
const SUNNAH_CACHE_FILE = path.join(HADITH_DIR, '.sunnah_link_cache.json');
let _sunnahCache = null;
function loadSunnahCache() {
  if (_sunnahCache) return _sunnahCache;
  try { _sunnahCache = JSON.parse(readFileSync(SUNNAH_CACHE_FILE, 'utf8')); }
  catch { _sunnahCache = {}; }
  return _sunnahCache;
}

// Resolve the canonical sunnah.com permalink for a hadith by searching sunnah.com for
// its (un-diacritized) matn text. Returns {collection_slug, hadith_number, link} or null.
// Resilient: any network/timeout error returns null and is NOT cached (so it retries);
// a definitive "no result" IS cached. Callers fall back to the local-corpus link on null.
async function resolveSunnahLink(detectedText, preferredSlug = null) {
  const norm = normalizeArabic(detectedText ?? '').trim();
  const words = norm.split(/\s+/).filter(Boolean);
  if (words.length < 4) return null; // too short to search reliably

  const cache = loadSunnahCache();
  const cacheKey = 'v2::' + (preferredSlug ?? '*') + '::' + norm; // v2: results text-verified
  if (Object.prototype.hasOwnProperty.call(cache, cacheKey)) return cache[cacheKey];

  let resolved = null;
  let gotResponse = false;
  try {
    // A focused query (first ~12 content words) keeps sunnah.com's search specific.
    const q = words.slice(0, 12).join(' ');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    const res = await fetch('https://sunnah.com/search?q=' + encodeURIComponent(q), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 'Accept': 'text/html' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      gotResponse = true;
      const html = await res.text();
      // sunnah.com search matches words loosely, so a result is only a candidate if its
      // Arabic actually carries the quoted matn. Taking the first hit in the expected
      // collection linked "من صلى علي صلاة واحدة…" to Abu Dawud 5085 — Aisha describing the
      // night prayer — which merely shares common words. Score each result by the share of
      // the query's word PAIRS found in its Arabic: word order separates the real hadith
      // from one that happens to use the same vocabulary.
      const pairs = ws => ws.slice(1).map((w, i) => ws[i] + ' ' + w);
      const qPairs = pairs(q.split(' '));
      const results = [];
      for (const part of html.split('actualHadithContainer').slice(1)) {
        const m = part.match(/href="\/([a-z]+):(\d+[a-z]?)"/); // permalink, e.g. /muslim:1162a
        if (!m || !SUNNAH_SLUGS.has(m[1])) continue;
        const ar = part.match(/arabic_text_details[^>]*>([\s\S]*?)<\/span>\s*<\/div>/)?.[1] ?? '';
        const have = new Set(pairs(normalizeArabic(ar.replace(/<[^>]+>/g, ' ')).split(/\s+/).filter(Boolean)));
        const score = qPairs.filter(p => have.has(p)).length / Math.max(qPairs.length, 1);
        if (score >= 0.5) results.push({ slug: m[1], number: m[2], score });
      }
      // Prefer the collection the imam or Claude named, best-scoring within it; with no
      // expectation, the best-scoring result. If the expected collection has no verified
      // hit, return null and keep the local link rather than risk a different hadith.
      const inPreferred = preferredSlug ? results.filter(r => r.slug === preferredSlug) : results;
      const pick = inPreferred.reduce((best, r) => (!best || r.score > best.score ? r : best), null);
      if (pick) {
        resolved = {
          collection_slug: pick.slug,
          hadith_number: pick.number,
          link: `https://sunnah.com/${pick.slug}:${pick.number}`,
        };
      }
    }
  } catch { /* network/timeout — leave resolved null, do not cache */ }

  if (gotResponse) { cache[cacheKey] = resolved; try { writeFileSync(SUNNAH_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8'); } catch {} }
  return resolved;
}

// Fetch the narrator from a resolved sunnah.com hadith page (cached). Scan-detected
// hadiths have no narrator (only Claude's signal-phrase path fills one); sunnah.com
// states it on the page ("Narrated Abu Bakr:"), so we can backfill it from the lookup.
// Fetch the canonical English translation of a resolved hadith from sunnah.com.
// Without this the English shown under a Hadith card is whatever Claude produced while
// translating the surrounding prose — a paraphrase of the imam's recitation rather than
// the published translation of the hadith itself.
//
// Page shape (see fetchSunnahNarrator for the sibling parse):
//   <div class="english_hadith_full">
//     <div class=hadith_narrated><p>Anas said:</div>
//     <div class=text_details>The Apostle of Allah (ﷺ) performed ablution ...</div>
// The `english_hadith_full` block is isolated first because `arabic_text_details` would
// otherwise match the same `text_details` suffix and return the Arabic.
async function fetchSunnahTranslation(slug, number) {
  if (!slug || !number) return null;
  const cache = loadSunnahCache();
  const key = `translation::${slug}:${number}`;
  if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];

  let translation = null, gotResponse = false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    const res = await fetch(`https://sunnah.com/${slug}:${number}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 'Accept': 'text/html' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      gotResponse = true;
      const html = await res.text();
      const block = html.match(/class=["']?english_hadith_full["']?[^>]*>([\s\S]*?)<div class=["']?clear/i);
      const scope = block ? block[1] : '';
      const m = scope.match(/class=["']?text_details["']?[^>]*>([\s\S]*?)<\/div>/i);
      if (m) {
        const txt = m[1]
          .replace(/<[^>]+>/g, '')        // drop stray inline tags (<b>, <a>, unclosed </b>)
          .replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'")
          .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
          .replace(/&nbsp;/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        translation = txt || null;
      }
    }
  } catch { /* network/timeout — leave null, do not cache */ }

  if (gotResponse) { cache[key] = translation; try { writeFileSync(SUNNAH_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8'); } catch {} }
  return translation;
}

async function fetchSunnahNarrator(slug, number) {
  if (!slug || !number) return null;
  const cache = loadSunnahCache();
  const key = `narrator2::${slug}:${number}`; // 2: reporting clause trimmed
  if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];

  let narrator = null, gotResponse = false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    const res = await fetch(`https://sunnah.com/${slug}:${number}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 'Accept': 'text/html' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      gotResponse = true;
      const html = await res.text();
      const m = html.match(/class=["']?hadith_narrated[^>]*>\s*(?:<p>)?\s*([^<]+)/i);
      if (m) {
        let txt = m[1].replace(/\s+/g, ' ').trim();
        // Strip leading narration framing: "Narrated X:", "It was narrated that X said:",
        // "It has been narrated on the authority of X who …", "On the authority of X ...".
        txt = txt.replace(/^it (?:is|was|has been) narrated(?: on the authority of| from)?(?: that)?\s*/i, '');
        txt = txt.replace(/^(?:it was )?narrated\s*/i, '');
        txt = txt.replace(/^on the authority of\s*/i, '');
        // "Salamah bin 'Ubaidullah … narrated from his father" — the Companion is the father.
        const fromFather = txt.match(/^\S+ (?:bin|ibn|b\.) (.+?) (?:narrated|reported) from his father/i);
        if (fromFather) txt = fromFather[1];
        // Cut at the reporting clause: "Sa'd b. Abu Waqqas reported Allah's Messenger (ﷺ) as
        // saying" and "Salman who" were shown whole as the narrator's name.
        txt = txt.split(/\s+(?:who|reported|narrated|said|says|relates|relating|that|as saying)\b|\s*[:(]/i)[0];
        txt = txt.replace(/[\s,:]+$/, '').trim();
        narrator = txt || null;
      }
    }
  } catch { /* network/timeout — leave null, do not cache */ }

  if (gotResponse) { cache[key] = narrator; try { writeFileSync(SUNNAH_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8'); } catch {} }
  return narrator;
}

// Replace each hadith ref's collection/number/link with the canonical sunnah.com
// permalink resolved from the matn. Mutates refs in place; leaves the existing
// local-corpus number/link untouched when sunnah.com returns no matching result.
// Also backfills a narrator from the resolved page when the ref lacks one.
// The collection the imam names right after quoting a hadith ("… رواه مسلم"). Imams almost
// always say where a hadith is from, and that is more reliable than Claude's recollection:
// a matn found in several collections was carded as Ibn Majah while the imam said Muslim.
const IMAM_ATTRIBUTION = [
  [/^البخاري|^متفق عليه/, 'bukhari'], [/^مسلم/, 'muslim'], [/^الترمذي/, 'tirmidhi'],
  [/^ابو داود/, 'abudawud'], [/^النسائي/, 'nasai'], [/^ابن ماج/, 'ibnmajah'],
  [/^الامام احمد|^احمد/, 'ahmad'], [/^مالك/, 'malik'],
];
function imamAttributionSlug(transcript, detectedText) {
  const tNorm = normalizeArabic(transcript);
  const dWords = normalizeArabic(detectedText ?? '').split(/\s+/).filter(Boolean);
  for (const n of [5, 4, 3]) {
    if (dWords.length < n) continue;
    const tail = dWords.slice(-n).join(' ');
    const at = tNorm.indexOf(tail);
    if (at < 0 || tNorm.indexOf(tail, at + 1) >= 0) continue; // absent or ambiguous
    const after = tNorm.slice(at + tail.length).trim().split(/\s+/).slice(0, 6).join(' ');
    const m = after.match(/^(?:\S+\s+){0,2}?(?:رواه|اخرجه|خرجه)\s+(.*)$|^(متفق عليه)/);
    if (!m) return null;
    const name = (m[1] ?? m[2]).trim();
    for (const [re, slug] of IMAM_ATTRIBUTION) if (re.test(name)) return slug;
    return null;
  }
  return null;
}

async function resolveSunnahLinksForRefs(refs, transcript = null) {
  for (const ref of refs) {
    const claudeSlug = collectionToSlug(ref.collection);
    const imamSlug = transcript ? imamAttributionSlug(transcript, ref.detected_text) : null;
    let sunnah = null;
    if (imamSlug) sunnah = await resolveSunnahLink(ref.detected_text, imamSlug);
    if (!sunnah) sunnah = await resolveSunnahLink(ref.detected_text, claudeSlug);
    if (sunnah) {
      ref.collection = slugToDisplay(sunnah.collection_slug);
      ref.hadith_number = sunnah.hadith_number;
      ref.link = sunnah.link;
      ref.verification = 'sunnah_search';
      ref.note = 'Link verified via sunnah.com search';
      // The resolved page states the narrator of THAT hadith; Claude's narrator is from
      // memory and was wrong for Bukhari's ribat hadith (Sahl ibn Sa'd, not Salman). Keep
      // Claude's only when the page cannot be read.
      const narr = await fetchSunnahNarrator(sunnah.collection_slug, sunnah.hadith_number);
      if (narr) ref.narrator = narr;
      // Always prefer the published translation over Claude's paraphrase of the prose.
      const trans = await fetchSunnahTranslation(sunnah.collection_slug, sunnah.hadith_number);
      if (trans) ref.translation = trans;
    }
  }
  return refs;
}

// Extract just the matn from a full hadith text (strips the isnad).
// Returns text AFTER the prophet attribution, not including it — so the corpus
// matn contains only the actual speech, not "قال رسول الله صلى الله عليه وسلم".
// This prevents attribution phrases in the transcript from scoring against corpus hadiths.
function extractMatn(text) {
  const norm = normalizeArabic(text);

  // Each pattern matches the attribution chain. We return text from AFTER the match.
  // The trailing `(?:قال\s+|يقول\s+)?` skips the reporting verb before the actual words.
  const patterns = [
    /(?:قال|يقول)\s+(?:رسول\s+الله|النبي|المصطفى)\s+(?:صلى\s+الله\s+عليه\s+وسلم\s+)?(?:قال\s+|يقول\s+)?/,
    /(?:ان|إن)\s+(?:رسول\s+الله|النبي)\s+(?:صلى\s+الله\s+عليه\s+وسلم\s+)?(?:قال\s+|يقول\s+)?/,
    /سمعت\s+(?:رسول\s+الله|النبي)\s+(?:صلى\s+الله\s+عليه\s+وسلم\s+)?(?:يقول\s+|قال\s+)?/,
    /عن\s+(?:النبي|رسول\s+الله)\s+(?:صلى\s+الله\s+عليه\s+وسلم\s+)?(?:انه|أنه)\s+(?:قال\s+)?/,
    /(?:ان|إن)\s+الله\s+(?:قال|يقول)\s+/,    // Hadith Qudsi
  ];

  for (const pat of patterns) {
    const m = norm.match(pat);
    if (m) {
      const after = norm.slice(m.index + m[0].length).trim();
      if (after.split(/\s+/).filter(Boolean).length >= 3) return after;
    }
  }

  // Fallback: take text after the last قال if it's deep enough in the text
  const lastQala = norm.lastIndexOf('قال');
  if (lastQala > norm.length * 0.4) return norm.slice(lastQala + 4).trim();
  return norm;
}

// Slide a window across the transcript and score every chunk against every
// hadith matn. Same O(1)-per-slide algorithm as the Quran scan.
function scanTranscriptForHadith(transcript, claudeHadithRefs, hadithCorpus) {
  if (!hadithCorpus.length) return [];

  const tWords = normalizeArabic(transcript).split(/\s+/).filter(Boolean);
  const tLen = tWords.length;

  const claudeNorm = new Set(
    claudeHadithRefs.map(r => normalizeArabic(r.detected_text ?? ''))
  );

  const candidates = [];

  for (const h of hadithCorpus) {
    const aWords = h.matnWords;
    const aLen = aWords.length;
    // Very short matn entries are too prone to matching common Islamic phrases
    // (e.g. the shahada). Short hadiths are reliably caught by Claude's signal-phrase
    // detection, so skip them in the scan.
    if (aLen < 8 || aLen > tLen) continue;

    const aWordSet = new Set(aWords);
    let freq = {}, uniqueCount = 0, intersect = 0;

    const addW = w => {
      if (!freq[w]) { freq[w] = 0; uniqueCount++; if (aWordSet.has(w)) intersect++; }
      freq[w]++;
    };
    const remW = w => {
      freq[w]--;
      if (freq[w] === 0) { delete freq[w]; uniqueCount--; if (aWordSet.has(w)) intersect--; }
    };
    const score = () => intersect / (uniqueCount + aWordSet.size - intersect);

    for (let j = 0; j < aLen; j++) addW(tWords[j]);

    let bestScore = score(), bestStart = 0;
    for (let i = 1; i <= tLen - aLen; i++) {
      remW(tWords[i - 1]);
      addW(tWords[i + aLen - 1]);
      const s = score();
      if (s > bestScore) { bestScore = s; bestStart = i; }
    }

    if (bestScore < 0.6) continue;

    const detectedText = tWords.slice(bestStart, bestStart + aLen).join(' ');
    if ([...claudeNorm].some(cn => cn.includes(detectedText) || detectedText.includes(cn))) continue;

    // Reject windows that are mostly attribution chain with little actual hadith content.
    // extractMatn strips the isnad; if fewer than 5 words remain, the window landed on
    // an attribution phrase, not a real hadith quote.
    const contentAfterIsnad = extractMatn(detectedText).split(/\s+/).filter(Boolean).length;
    if (contentAfterIsnad < 5) continue;

    candidates.push({
      detected_text: detectedText,
      collection: h.collection,
      hadith_number: h.number,
      link: h.link,
      confidence: Math.round(bestScore * 100) / 100,
      detection_method: 'scan',
      _start: bestStart,
      _end: bestStart + aLen,
    });
  }

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

  return deduped.map(({ _start, _end, ...rest }) => rest);
}

// ---- Claude prompt ----------------------------------------------------------

// Khutbah types — drive how the analysis prompt frames the sermon and whether the
// two-part (sitting + second khutbah) structure applies. Add new types here.
const KHUTBAH_TYPES = {
  friday: {
    desc: 'a Friday Jummah Khutbah (sermon) transcript',
    ref: "this Friday khutbah",
    twoPart: true,
  },
  arafah: {
    desc: 'the Khutbah of Arafah (the Hajj sermon delivered at Masjid Namirah on the Day of Arafah) transcript',
    ref: "this Khutbah of Arafah",
    twoPart: false,
  },
  eid: {
    desc: 'an Eid Khutbah (the sermon delivered after the Eid prayer) transcript',
    ref: "this Eid khutbah",
    twoPart: false,
  },
};

const ANALYSIS_PROMPT_TEMPLATE = `You are an Islamic scholar assistant processing {{KHUTBAH_DESC}}.

Given this Arabic Khutbah transcript, do the following:

IMPORTANT STYLE RULE (applies to ALL English text you produce — chunk_translations, share_summary, summary): Do NOT use em dashes (—) or en dashes (–) anywhere. Use a comma, period, colon, parentheses, or the word "and" instead. Write natural prose without dash-joined clauses.

PROSE-CHUNK RULE: A prose chunk may END with a lead-in to a Quranic verse (e.g. "قال الله تعالى", "وقال سبحانه", or the first words of a verse the khatib is about to recite). Translate ONLY the literal Arabic words present in that chunk. Do NOT complete the sentence with, or paraphrase, the content of the Quranic verse that follows — those verses are displayed separately with their own translation. For example, if a chunk ends with "وكيف يدعو", translate just "And how can he invoke", not the full meaning of the verse.

1. Translate the full text into natural, readable English. Preserve Islamic terms untranslated: Allah, Rasulullah, Salah, Zakat, Ummah, Sunnah, Hadith, Quran, Surah, Ayah, Jummah, Khatib, and any Arabic honorifics like صلى الله عليه وسلم or رضي الله عنه

2. Write two summaries:
   a. "share_summary": A ONE-SENTENCE TL;DR — ABSOLUTE MAXIMUM 30 WORDS. State the khutbah's topic and its single biggest takeaway, nothing more. Simple, friendly English; no academic language; do NOT list multiple points or describe both khutbah parts. This is a one-line hook, not a summary. (The detailed "summary" field below carries the full content.)
   b. "summary": A fuller 3-5 sentence summary covering all main points and themes in detail.
   In BOTH summaries, refer to the sermon as {{KHUTBAH_REF}} — do NOT call it a "Friday khutbah" or "Jummah khutbah" unless that is in fact what it is.

3. Identify every Quranic reference by detecting these signal phrases in the Arabic text:
- قال الله تعالى
- يقول الله تعالى
- قال الله سبحانه وتعالى
- كما قال الله تعالى
- في قوله تعالى
- لقوله تعالى
- قال عز وجل
- وقوله تعالى
For each one found:
- Extract the Arabic text that immediately follows (up to 50 words or until the next sentence break)
- Identify which Surah and Ayah it is using your Quran knowledge. Provide surah_name (transliterated, e.g. "Al-Baqarah"), surah_number (integer), and ayah_number (integer). If you are not certain, set these to null.

4. Identify every Hadith reference by detecting these signal phrases:
- قال رسول الله صلى الله عليه وسلم
- عن النبي صلى الله عليه وسلم
- عن أبي هريرة
- عن ابن عمر
- عن عائشة
- عن أنس بن مالك
- رواه البخاري
- رواه مسلم
- أخرجه البخاري
- أخرجه الشيخان
- خرجه الشيخان
- متفق عليه
- رواه أبو داود
- رواه الترمذي
- أخرجه الترمذي
- ثبت عن النبي
- صح عن النبي
- في الصحيح أن رسول الله
- في الصحيح عن
- ثبت في الصحيح
- في الحديث أن رسول الله
- ففي الحديث
For each one found, extract ONLY the hadith text (the Prophet's actual words or the reported content). Do NOT include the signal phrase itself or the narrator chain (isnad) in the arabic_text field — only the matn (the body of the hadith). Identify the narrator (the Companion who reported it) and the collection from your own knowledge of the hadith, even when they are not spoken aloud in the khutbah. Only use null if you genuinely cannot identify it.

{{SPLIT_INSTRUCTION}}

Return ONLY a valid JSON object with no markdown formatting, no backticks, no preamble. Exactly this structure:
{
  "chunk_translations": ["natural English translation of chunk [1]", "translation of chunk [2]", "...one string per numbered chunk, in order"],
  "share_summary": "2-3 sentence simple community-friendly summary",
  "summary": "3-5 sentence detailed summary",
  "quran_references": [
    {
      "signal_phrase": "the signal phrase found",
      "arabic_text": "extracted arabic text after signal phrase",
      "surah_name": "transliterated surah name or null if uncertain",
      "surah_number": 2,
      "ayah_number": 185,
      "position": "early/middle/late in khutbah"
    }
  ],
  "hadith_references": [
    {
      "signal_phrase": "the signal phrase found",
      "arabic_text": "extracted arabic text after signal phrase",
      "narrator": "the Companion (sahabi) who narrated it, from your knowledge — null only if truly unknown",
      "collection": "bukhari/muslim/tirmidhi etc, from your knowledge — null only if truly unknown"
    }
  ],
  "second_khutbah_start": "first 6-10 Arabic words of the second khutbah exactly as in the transcript, or null if there is only one khutbah / no confident split"
}`;

const SPLIT_INSTRUCTION_TWO_PART = `5. A Friday khutbah is delivered in TWO parts: the first khutbah ends with the khatib's closing du'a/istighfar (e.g. "أقول قولي هذا وأستغفر الله لي ولكم" / "...فاستغفروه وتوبوا إليه إنه هو البر الرحيم"), the khatib sits briefly, then stands and begins the SECOND khutbah with a fresh opening praise (a new "الحمد لله..." or "إن الحمد لله نحمده ونستعينه..."). Identify where the SECOND khutbah begins and return its first 6-10 Arabic words EXACTLY as they appear in the transcript (so they can be located by text search). Key off this STRUCTURE — closing istighfar/du'a followed by a renewed opening praise — NOT any single word, since transcription can mishear words. If the transcript contains only one khutbah or you cannot confidently find the split, return null.`;

const SPLIT_INSTRUCTION_SINGLE = `5. This sermon is delivered as ONE continuous khutbah (no sitting, no second khutbah). Always return null for "second_khutbah_start".`;

// Builds the analysis prompt for a given khutbah type (friday | arafah | eid).
// Unknown types fall back to friday.
function buildAnalysisPrompt(khutbahType = 'friday') {
  const t = KHUTBAH_TYPES[khutbahType] || KHUTBAH_TYPES.friday;
  return ANALYSIS_PROMPT_TEMPLATE
    .replace('{{KHUTBAH_DESC}}', t.desc)
    .replace('{{KHUTBAH_REF}}', t.ref)
    .replace('{{SPLIT_INSTRUCTION}}', t.twoPart ? SPLIT_INSTRUCTION_TWO_PART : SPLIT_INSTRUCTION_SINGLE);
}

// Back-compat: the default (Friday) prompt as a ready-to-use string.
const ANALYSIS_PROMPT = buildAnalysisPrompt('friday');

// ---- Hadith deduplication ---------------------------------------------------

// Removes duplicate or near-duplicate hadith refs that arise when Claude detects
// the same hadith through multiple overlapping signal phrases. Keeps the entry with
// the most complete matn; drops any whose text is a subset of one already kept.
// Also drops entries with fewer than 8 words — those are pure signal phrases with
// no actual hadith content, not real references.
// Liturgy the khatib *performs* rather than *cites*. Every one of these is a genuine
// narrated hadith, so the corpus matches them correctly — but in a khutbah they are the
// closing ritual, not a quotation, and tagging them as cited hadiths puts a citation card
// on the imam's own du'a. This is the hadith-side counterpart to the minimum-word gate
// that keeps the basmala and isti'adha out of Quran zone refs.
//
// Deliberately a small curated set, not a general rule: the closing formulas of a khutbah
// are a genuinely closed class, and every entry here has to be a phrase that is always
// liturgy and never evidence. Matching is Jaccard, not substring, so wording and
// transcription variants still land. Add to it only with that test in mind.
const LITURGICAL_FORMULAS = [
  // Salawat Ibrahimiyyah — both halves, which the khatib recites as one unit
  'اللهم صل على محمد وعلى آل محمد كما صليت على إبراهيم وعلى آل إبراهيم إنك حميد مجيد',
  'وبارك على محمد وعلى آل محمد كما باركت على إبراهيم وعلى آل إبراهيم إنك حميد مجيد',
  // Closing du'a of essentially every khutbah (itself Quran 2:201, which the Quran
  // layer surfaces separately — suppressing the hadith card is what lets that card show)
  'ربنا آتنا في الدنيا حسنة وفي الآخرة حسنة وقنا عذاب النار',
  // Standard closing supplications
  'اللهم اغفر للمسلمين والمسلمات والمؤمنين والمؤمنات الأحياء منهم والأموات',
  'سبحان ربك رب العزة عما يصفون وسلام على المرسلين والحمد لله رب العالمين',
].map(f => new Set(normalizeArabic(f).split(/\s+/).filter(Boolean)));

const LITURGICAL_MATCH_THRESHOLD = 0.55;

function isLiturgicalFormula(text) {
  const words = new Set(normalizeArabic(text ?? '').split(/\s+/).filter(Boolean));
  if (!words.size) return false;
  return LITURGICAL_FORMULAS.some(formula => {
    let intersect = 0;
    for (const w of words) if (formula.has(w)) intersect++;
    return intersect / (words.size + formula.size - intersect) >= LITURGICAL_MATCH_THRESHOLD;
  });
}

function deduplicateHadithRefs(refs) {
  const kept = [];
  for (const ref of refs) {
    // Ritual closing formulas are matched correctly by the corpus but are not citations.
    if (isLiturgicalFormula(ref.detected_text)) continue;

    // Content check: strip the prophet attribution and measure what remains.
    // Pure attribution phrases ("الصحيح ان رسول الله صلى الله عليه وسلم") leave
    // < 4 content words; real hadiths (even short ones like "كلكم راع...") leave ≥ 4.
    const contentWords = extractMatn(ref.detected_text ?? '').split(/\s+/).filter(Boolean).length;
    if (contentWords < 4) continue;

    const normText = normalizeArabic(ref.detected_text ?? '');
    const isDuplicate = kept.some(k => {
      const kNorm = normalizeArabic(k.detected_text ?? '');
      return kNorm.includes(normText) || normText.includes(kNorm);
    });
    if (!isDuplicate) kept.push(ref);
  }
  return kept;
}

// ---- Two-khutbah split ------------------------------------------------------

// Locate the boundary between the first and second khutbah. Primary signal is Claude's
// `second_khutbah_start` marker phrase (located in the transcript by fingerprint); this is
// cross-checked against — or, when the phrase can't be found, replaced by — the largest
// silence gap between Whisper segments (the khatib sitting between the two khutbahs).
// Returns { word_index, time, marker_text, via, validated } or null.
function locateSecondKhutbah(markerText, transcript, segments = [], wordTimes = []) {
  const origWords = transcript.split(/\s+/).filter(Boolean);
  const normWords = normalizeArabic(transcript).split(/\s+/).filter(Boolean);
  const total = origWords.length;
  if (total < 40) return null;
  const timeAt = i => (wordTimes[i] && typeof wordTimes[i].start === 'number') ? wordTimes[i].start : null;

  // Largest silence gap whose boundary falls in the middle 20%–85% of the khutbah.
  let gapWordIndex = -1, gapTime = null, maxGap = 0;
  if (segments.length > 1) {
    const cumAt = []; let cum = 0;
    for (const s of segments) { cumAt.push(cum); cum += (s.text ?? '').trim().split(/\s+/).filter(Boolean).length; }
    for (let i = 0; i < segments.length - 1; i++) {
      const gap = (segments[i + 1].start ?? 0) - (segments[i].end ?? 0);
      const frac = cumAt[i + 1] / Math.max(total, 1);
      if (frac > 0.2 && frac < 0.85 && gap > maxGap) {
        maxGap = gap; gapWordIndex = cumAt[i + 1]; gapTime = segments[i + 1].start ?? null;
      }
    }
  }

  // Locate Claude's marker phrase — take the first occurrence past the first quarter
  // (so it can't match the opening hamd of the FIRST khutbah).
  let markerWordIndex = -1;
  if (markerText) {
    const m = normalizeArabic(markerText).split(/\s+/).filter(Boolean);
    if (m.length >= 3) {
      const normStr = normWords.join(' ');
      for (let fp = Math.min(6, m.length); fp >= 3 && markerWordIndex < 0; fp--) {
        const needle = m.slice(0, fp).join(' ');
        let from = 0;
        while (true) {
          const p = normStr.indexOf(needle, from);
          if (p === -1) break;
          const wi = p === 0 ? 0 : normStr.slice(0, p).split(/\s+/).filter(Boolean).length;
          if (wi / total > 0.25) { markerWordIndex = wi; break; }
          from = p + 1;
        }
      }
    }
  }

  if (markerWordIndex >= 0) {
    const time = timeAt(markerWordIndex) ?? gapTime;
    const validated = gapTime != null && time != null && Math.abs(time - gapTime) <= 30;
    return {
      word_index: markerWordIndex,
      time: time != null ? Math.round(time * 10) / 10 : null,
      marker_text: origWords.slice(markerWordIndex, markerWordIndex + 8).join(' '),
      via: 'claude', validated,
    };
  }
  // Fallback: a clear silence gap (khatib sitting) when the phrase wasn't found.
  if (gapWordIndex >= 0 && maxGap >= 1.2) {
    return {
      word_index: gapWordIndex,
      time: gapTime != null ? Math.round(gapTime * 10) / 10 : null,
      marker_text: origWords.slice(gapWordIndex, gapWordIndex + 8).join(' '),
      via: 'silence_gap', validated: true,
    };
  }
  return null;
}

// If the khutbah-2 boundary falls INSIDE a prose chunk, split that chunk in two at the
// boundary and translate each half with a small dedicated Claude call — so the boundary
// becomes a real chunk edge (clean divider, no mid-chunk bleed) and each side gets a complete
// translation. Mutates proseChunks + chunkTranslations in place and reindexes proseIdx.
// Returns true if it split; no-op (false) when the boundary is already on a chunk edge, lands
// in a Quran zone, the chunk counts are inconsistent, or the Claude call fails (graceful
// fallback to the whole-chunk divider).
async function splitChunkAtKhutbahBoundary(proseChunks, chunkTranslations, splitWordIndex, transcriptWords, anthropic, model) {
  if (splitWordIndex == null || splitWordIndex < 0) return false;
  if (!Array.isArray(chunkTranslations) || chunkTranslations.length !== proseChunks.length) return false;
  const si = proseChunks.findIndex(c => c.wordStart < splitWordIndex && splitWordIndex < c.wordEnd);
  if (si < 0) return false; // boundary already on a chunk edge, or inside a Quran zone

  const chunk = proseChunks[si];
  const arabicA = transcriptWords.slice(chunk.wordStart, splitWordIndex).join(' ');
  const arabicB = transcriptWords.slice(splitWordIndex, chunk.wordEnd).join(' ');
  if (!arabicA || !arabicB) return false;
  const origEnglish = chunkTranslations[si] ?? '';

  const prompt = `The Arabic below is one prose chunk from a Friday khutbah. It spans the boundary between the FIRST and the SECOND khutbah, so it must be split into two parts. Translate each part into natural English in the same style, preserving Islamic terms (Allah, Sunnah, Tawhid, Eid al-Adha, etc.).

PART 1 (end of the first khutbah): ${arabicA}

PART 2 (start of the second khutbah): ${arabicB}

(For reference, the whole chunk was previously translated as: "${origEnglish}")

Return ONLY valid JSON, no markdown: {"part1":"English of PART 1","part2":"English of PART 2"}`;

  try {
    const msg = await anthropic.messages.create({ model, max_tokens: 1200, messages: [{ role: 'user', content: prompt }] });
    const raw = (msg.content?.[0]?.text ?? '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const j = JSON.parse(raw);
    if (!j.part1 || !j.part2) return false;
    proseChunks.splice(si, 1,
      { text: arabicA, wordStart: chunk.wordStart, wordEnd: splitWordIndex, proseIdx: si },
      { text: arabicB, wordStart: splitWordIndex, wordEnd: chunk.wordEnd, proseIdx: si + 1 });
    chunkTranslations.splice(si, 1, j.part1, j.part2);
    proseChunks.forEach((c, k) => { c.proseIdx = k; });
    return true;
  } catch {
    return false; // any failure → keep the original single chunk + whole-chunk divider
  }
}

// ---- Reader view formatter --------------------------------------------------

// Emit a Hadith citation badge, followed by the published sunnah.com translation when we
// have one. The translation is its own paragraph prefixed with ❝ so the web reader can
// style it apart from the prose translation above it (server.js splits reader.txt blocks
// on blank lines, and renderEnglishParts keys off the prefix).
// Emit a Quran citation badge. A recited passage carries ayah_number_end, so the label
// reads as a range ("'Abasa 80:25-32") and the web reader fetches every verse in it.
// `inline` marks a citation sitting inside a prose block (a short ayah quoted mid-sentence)
// rather than a block that IS the recitation. The web reader replaces a block's Arabic with
// the canonical verse text, which is right for a recitation but destroys the imam's own
// words around a short inline quote — so the two cases need different markers. 📖 means
// "this block is the verse"; 📑 means "this block cites the verse, leave its text alone".
function pushQuranBadge(lines, ref, inline = false) {
  lines.push('');
  const marker = inline ? '📑' : '📖';
  if (!ref.matched) { lines.push(`${marker} Quranic reference — no match found`); return; }
  const ayahLabel = ref.ayah_number_end && ref.ayah_number_end !== ref.ayah_number
    ? `${ref.ayah_number}-${ref.ayah_number_end}`
    : `${ref.ayah_number}`;
  lines.push(`${marker} ${ref.surah_name} ${ref.surah_number}:${ayahLabel}  —  ${ref.quran_link}  (confidence: ${ref.confidence})`);
}

// The English of a verse quoted inside the imam's prose must be the published translation,
// the same one the verse cards show (Sahih International, fetched from alquran.cloud), not
// Claude's rendering of it — Claude translated Quraysh 106:3 as "so let them worship the
// Lord of this House" while the cards beside it read Sahih International. So locate the
// verse in the block's translation and swap in the published text:
//  - the candidates are the translation's quoted runs, or — when Claude quoted nothing —
//    runs of 1-3 clauses (it rendered 106:3 unquoted, which also left it un-gilded);
//  - imams quote part of a long verse (Al Imran 3:97 "ومن دخله كان آمنا"), so the
//    replacement is the run of the verse's published SENTENCES that best matches, not the
//    whole verse;
//  - the swap happens only on a clear word match, so a hadith quoted in the same block is
//    never replaced by a verse.
// The result is always in double quotes, which is what the web reader gilds.
let _quranEn = null;
function publishedVerseEnglish(ref) {
  try { _quranEn ??= require('quran-json/dist/quran_en.json'); } catch { return ''; }
  const verses = _quranEn[(ref.surah_number ?? 0) - 1]?.verses ?? [];
  const end = ref.ayah_number_end ?? ref.ayah_number;
  return verses.filter(v => v.id >= ref.ayah_number && v.id <= end).map(v => v.translation).join(' ');
}
const enWords = t => t.toLowerCase().replace(/[^a-z\s']/g, ' ').split(/\s+/).filter(w => w.length >= 3);
function wordF1(a, b) {
  if (!a.length || !b.length) return 0;
  const bs = new Set(b), as = new Set(a);
  const p = a.filter(w => bs.has(w)).length / a.length, r = b.filter(w => as.has(w)).length / b.length;
  return p + r ? 2 * p * r / (p + r) : 0;
}
const EN_QUOTE_RE = /["\u201C]([^"\u201C\u201D]+)["\u201D]|(?<![A-Za-z])['\u2018](.+?)['\u2019](?=[\s.,;:!?)]|$)/g;
// Replace the best-matching run of `text` with the best-matching run of `published`.
// Candidates in `text` are its quoted runs or, when nothing is quoted, runs of 1-3 clauses;
// `published` is split into units by `unitRe` and runs of up to `maxRun` units are tried.
// Returns the new text, or null when nothing matches at least `minF1`. Spans in `locked`
// (text already replaced for another reference) are never candidates.
function swapInPublished(text, published, { unitRe, maxRun, minF1, locked }) {
  const units = published.replace(/["\u201C\u201D]/g, '').split(unitRe).map(u => u.trim()).filter(Boolean);
  if (!units.length) return null;
  const free = c => !locked.some(l => c.s < l.e && c.e > l.s);
  // Quoted runs, plus unquoted runs of 1-4 clauses — always both: a block can quote one
  // hadith and leave the next unquoted, and whichever was swapped first must not hide the
  // other. Clause runs never cut into a quote.
  const quotes = [...text.matchAll(EN_QUOTE_RE)]
    .map(m => ({ s: m.index, e: m.index + m[0].length, t: m[1] ?? m[2] }));
  const cands = quotes.filter(free);
  const clauses = [...text.matchAll(/[^,;:.!?\u201C\u201D"]+/g)].map(m => ({ s: m.index, e: m.index + m[0].length }));
  for (let i = 0; i < clauses.length; i++) for (let j = i; j < Math.min(i + 4, clauses.length); j++) {
    const c = { s: clauses[i].s, e: clauses[j].e, t: text.slice(clauses[i].s, clauses[j].e),
      edges: [enWords(text.slice(clauses[i].s, clauses[i].e)), enWords(text.slice(clauses[j].s, clauses[j].e))] };
    if (free(c) && !quotes.some(q => c.s < q.e && c.e > q.s)) cands.push(c);
  }
  let best = null;
  for (const c of cands) {
    const cw = enWords(c.t);
    if (cw.length < 3) continue;
    for (let i = 0; i < units.length; i++) for (let j = i; j < Math.min(i + maxRun, units.length); j++) {
      const run = units.slice(i, j + 1).join(' ');
      const rw = enWords(run);
      if (rw.length > cw.length * 2 + 4) break; // never pad a short quote with unquoted text
      // F1 alone favours the one clause that matches best and swaps in only that clause
      // (Tirmidhi 1639 became just "and an eye that spent the night…"). Weight by the
      // candidate's length so the whole quotation wins; extending into unrelated prose
      // still loses, because every unmatched word lowers F1.
      // A clause run must start and end on matching words, or it swallows the imam's
      // framing next to the quote ("Reported by al-Tirmidhi").
      if (c.edges) {
        const rs = new Set(rw);
        // Half the words, not any: common words ("allah", "the", "that") alone let the run
        // swallow "May Allah reward them…" after Tirmidhi 1639.
        if (!c.edges.every(ew => ew.length && ew.filter(w => rs.has(w)).length / ew.length >= 0.5)) continue;
      }
      const f = wordF1(cw, rw);
      const score = f * Math.sqrt(cw.length);
      if (f >= minF1 && (!best || score > best.score)) best = { ...c, run, f, score };
    }
  }
  if (!best) return null;
  const s = best.s + text.slice(best.s).match(/^\s*/)[0].length;
  const e = best.e - text.slice(best.s, best.e).match(/\s*$/)[0].length;
  const run = best.run.replace(/^['\u2018\u2019\s]+|['\u2018\u2019\s]+$/g, '').replace(/[.;,:]+$/, '');
  // A quote that closed the sentence ('…shall be safe.') must still close it.
  const stop = /[.!?]$/.test(best.t.trim()) && !/^[.!?]/.test(text.slice(e)) ? best.t.trim().slice(-1) : '';
  const inserted = '\u201C' + run + '\u201D';
  locked.push({ s, e: s + inserted.length });
  for (const l of locked.slice(0, -1)) if (l.s >= e) { l.s += inserted.length + stop.length - (e - s); l.e += inserted.length + stop.length - (e - s); }
  return text.slice(0, s) + inserted + stop + text.slice(e);
}

// Verses swap in whole published SENTENCES (an imam quotes part of a long verse; a
// sentence is the smallest unit that still reads as the verse). Hadith swap in CLAUSES:
// a sunnah.com entry carries the narrator's framing and often far more than the imam
// quoted — Bukhari 1587 runs on into the rules about Makkah's thorns and game, while the
// imam said only "إن هذا البلد حرمه الله" — so only the matching clauses are used. Hadith
// wording in translation varies more than verse wording ("made this town a sanctuary" vs
// "this land was made sacred"), hence the lower bar; the swap still requires the match to
// come from this block's own translation.
function usePublishedTranslations(english, qrefs = [], hrefs = []) {
  if (!english) return english;
  let text = english.replace(/,\s*:/g, ':'); // Claude's ",:" artefact
  const locked = [];
  for (const ref of qrefs) {
    const published = publishedVerseEnglish(ref);
    if (!published) continue;
    text = swapInPublished(text, published, { unitRe: /(?<=[.;!?])\s+/, maxRun: 99, minF1: 0.5, locked }) ?? text;
  }
  for (const ref of hrefs) {
    if (!ref.translation) continue;
    text = swapInPublished(text, ref.translation, { unitRe: /(?<=[,;:.!?])\s+/, maxRun: 8, minF1: 0.4, locked }) ?? text;
  }
  return text;
}

// `skipTranslation` suppresses the published sunnah.com text for this block because the
// block's own prose translation already renders the Hadith — showing both prints the same
// words twice.
function pushHadithBadge(lines, ref, skipTranslation = false) {
  lines.push('');
  lines.push(`📚 Hadith  ·  Narrator: ${ref.narrator ?? 'unknown'}  ·  Collection: ${ref.collection ?? 'unknown'}`);
  if (ref.translation && !skipTranslation) {
    lines.push('');
    lines.push(`❝ ${ref.translation}`);
  }
}

// ---- Reader coverage ----------------------------------------------------------
// Prose chunks are fixed when a khutbah is translated (they are cut around the pre-scan's
// Quran zones); cards come from references located afterwards. The two disagree at the edges
// and whenever a reference cannot be placed — a verse recited twice, a zone whose card was
// collapsed into another, zones carved out before MIN_ZONE_WORDS applied to chunking — and
// the words then rendered twice or nowhere. Five of seven published khutbahs lost text this
// way. reconcileCoverage() makes the final segments render every transcript word once.

function verseWordSet(ref) {
  const set = new Set();
  const surah = quranData?.[(ref?.surah_number ?? 0) - 1];
  if (!surah) return set;
  const end = ref.ayah_number_end ?? ref.ayah_number;
  for (const v of surah.verses) {
    if (v.id < ref.ayah_number || v.id > end) continue;
    for (const w of normalizeArabicDeep(v.text).split(/\s+/)) if (w) set.add(w);
  }
  return set;
}

// The transcript spells "الصلاة" where the mushaf has "الصلوة": allow one edit.
function oneEditApart(x, y) {
  if (Math.abs(x.length - y.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (x.length > y.length) i++; else if (y.length > x.length) j++; else { i++; j++; }
  }
  return edits + (x.length - i) + (y.length - j) <= 1;
}
const wordInVerse = (w, set) => set.has(w) || (w.length >= 4 && [...set].some(v => oneEditApart(w, v)));

// Recited, not cited: the isti'adha and basmala match 16:98 and 1:1, and the praise
// formula "الحمد لله رب العالمين" is all of 1:2, but none of them is the imam citing a verse
// (the same rule the minimum-word gate enforces for zone refs).
const RITUAL_RECITATION = /بالله من الشيطان الرجيم|بسم الله الرحمن الرحيم/;
const RITUAL_WHOLE = new Set(['الحمد لله رب العالمين'].map(p => normalizeArabicDeep(p)));
// The imam introducing a verse ("كما قال جل وعلا:") versus asking in du'a: the closing du'a
// borrows Quranic wording ("وجنبهم الفواحش … ما ظهر منها وما بطن", 6:151) without citing it.
const CITES_VERSE = /(^| )(قال|وقال|فقال|يقول|ويقول|تعالى|وتعالى|وعلا|سبحانه|وجل|قوله|وقوله|لقوله)( |$)/;

// Name the verse a run of uncovered words recites, or null when it is not a citation.
// `before` is the few transcript words just ahead of the run.
function identifyRecitation(words, before = []) {
  if (!quranData) return null;
  const deep = words.map(w => normalizeArabicDeep(w)).join(' ');
  if (RITUAL_RECITATION.test(deep) || RITUAL_WHOLE.has(deep.replace(/^و/, ''))) return null;
  const lead = before.map(w => normalizeArabic(w)).join(' ');
  const cited = CITES_VERSE.test(lead.split(' ').slice(-4).join(' '));
  if (!cited && lead.split(' ').slice(-15).includes('اللهم')) return null;

  let best = null;
  for (const z of prescanForQuranZones(words)) {
    if (!best || z.end - z.start > best.end - best.start) best = z;
  }
  if (!best) return null;
  const matched = best.end - best.start;
  // A whole verse counts however short it is ("فلما أسلما وتله للجبين" is all of 37:103).
  const verse = quranData[best.surah_id - 1]?.verses.find(v => v.id === best.ayah_id);
  const verseLen = verse ? normalizeArabicDeep(verse.text).split(/\s+/).filter(Boolean).length : Infinity;
  const whole = verseLen >= 3 && matched >= verseLen;
  if (!whole && matched < Math.max(MIN_ZONE_WORDS, Math.ceil(words.length * 0.6))) return null;

  const ids = (best.ayah_spans ?? []).filter(s => s.surah_id === best.surah_id).map(s => s.ayah_id).sort((a, b) => a - b);
  const first = ids[0] ?? best.ayah_id, last = ids[ids.length - 1] ?? best.ayah_id;
  const surah = quranData[best.surah_id - 1];
  return {
    detected_text: words.join(' '),
    matched: true,
    surah_name: surah?.transliteration ?? best.surah_name,
    surah_number: best.surah_id,
    ayah_number: first,
    ...(last !== first ? { ayah_number_end: last } : {}),
    quran_link: `https://quran.com/${best.surah_id}/${first}`,
    confidence: 0.8,
    verification: 'reader_gap',
    detection_method: 'reader_gap',
  };
}

function reconcileCoverage(segments, origWords) {
  const span = s => [s.startWord, s.startWord + s.words.length];
  const setWords = (s, a, b) => { s.startWord = a; s.words = origWords.slice(a, b); };
  const isCard = s => s?.type === 'quran';
  const isProse = s => s?.type === 'prose';
  const segs = [...segments].sort((a, b) => a.startWord - b.startWord);

  // 1. Words doubled at the edge of a card and the prose next to it. The card shows the
  //    whole verse anyway, so they leave the prose side ("يا أيها" ended one block and
  //    began the next verse card). A block nested wholly inside another is an inline case
  //    handled elsewhere and is left alone.
  for (let i = 1; i < segs.length; i++) {
    const prev = segs[i - 1], cur = segs[i];
    const [ps, pe] = span(prev), [cs, ce] = span(cur);
    if (cs >= pe || ce <= pe) continue;
    if (isProse(prev) && isCard(cur) && cs > ps) setWords(prev, ps, cs);
    else if (isCard(prev) && (isProse(cur) || isCard(cur))) setWords(cur, pe, ce);
  }

  // 2. Words no block renders.
  const gaps = [];
  let cursor = 0;
  for (const s of segs) {
    const [a, b] = span(s);
    if (a > cursor) gaps.push([cursor, a]);
    cursor = Math.max(cursor, b);
  }
  if (cursor < origWords.length) gaps.push([cursor, origWords.length]);

  for (const [gs, ge] of gaps) {
    const prev = segs.filter(s => span(s)[1] === gs).pop();
    const next = segs.find(s => span(s)[0] === ge);
    const gapWords = origWords.slice(gs, ge);
    const deep = gapWords.map(w => normalizeArabicDeep(w)).filter(Boolean);
    const partOf = card => {
      const set = verseWordSet(card.ref);
      return deep.filter(w => wordInVerse(w, set)).length >= Math.ceil(deep.length * 0.6);
    };
    // a. The card ran short of its own verse ("…والله ذو" without "الفضل العظيم").
    if (isCard(prev) && partOf(prev)) { setWords(prev, span(prev)[0], ge); continue; }
    if (isCard(next) && partOf(next)) { setWords(next, gs, span(next)[1]); continue; }
    // b. A recitation with no card: a verse recited a second time, or a zone whose card was
    //    dropped. A card also gives these words a translation, which they never got: they
    //    were outside every chunk sent to Claude. Not when it runs straight on from a quoted
    //    hadith — the Prophet's dhikr "له الملك وله الحمد وهو على كل شيء قدير" matches 64:1
    //    but is part of the hadith.
    const afterHadith = prev?.hadithRefs?.length > 0;
    if (!afterHadith && ge - gs >= 3) {
      const ref = identifyRecitation(gapWords, origWords.slice(Math.max(0, gs - 15), gs));
      if (ref) { segs.push({ type: 'quran', words: gapWords, ref, startWord: gs }); continue; }
    }
    // c. Otherwise the words stay in the prose where they were spoken.
    if (isProse(prev)) { setWords(prev, span(prev)[0], ge); continue; }
    if (isProse(next)) { setWords(next, gs, span(next)[1]); continue; }
    // d. Between two cards with no prose to join: its own block, marked untranslated.
    segs.push({ type: 'prose', words: gapWords, startWord: gs, untranslated: true });
  }

  return segs.filter(s => s.words.length).sort((a, b) => a.startWord - b.startWord);
}

// Splits the Arabic transcript around detected references and produces an
// annotated bilingual reader: Arabic chunk -> English chunk -> source badge.
function buildReaderView(transcript, result) {
  const { chunk_translations, quran_references, hadith_references } = result;

  const origWords = transcript.split(/\s+/).filter(Boolean);
  const normWords = normalizeArabic(transcript).split(/\s+/).filter(Boolean);
  const normTranscriptStr = normWords.join(' ');

  // Locate each reference in the transcript by matching its first 5 words
  const allRefs = [
    ...quran_references.map(r => ({ ...r, refType: 'quran' })),
    ...hadith_references.map(r => ({ ...r, refType: 'hadith' })),
  ];

  const located = [];
  for (const ref of allRefs) {
    const refNormWords = normalizeArabic(ref.detected_text ?? '').split(/\s+/).filter(Boolean);
    if (refNormWords.length < 3) continue;

    // Increase fingerprint length until only one match remains in the transcript.
    // Start at 5 words, or the whole ref when it is shorter — starting at a fixed 5
    // made the loop body unreachable for 3- and 4-word refs, silently dropping them
    // despite the length guard above (e.g. Ibrahim 14:7 "لئن شكرتم لأزيدنكم").
    let charPos = -1;
    const fpStart = Math.min(5, refNormWords.length);
    for (let fpLen = fpStart; fpLen <= refNormWords.length; fpLen++) {
      const fp = refNormWords.slice(0, fpLen).join(' ');
      const matches = [];
      let from = 0;
      while (true) {
        const p = normTranscriptStr.indexOf(fp, from);
        if (p === -1) break;
        matches.push(p);
        from = p + 1;
      }
      if (matches.length === 1) { charPos = matches[0]; break; }
      if (matches.length === 0) break; // phrase not in transcript at all
      // multiple matches — try longer fingerprint next iteration
    }
    // A hadith's opening words can be missing from the transcript as written: the imam
    // restarts a word ("عينان لا تمس لا تمسهما النار"), which Claude cleans up in the
    // detected text. The prefix fingerprint then never matches and the hadith lost its badge.
    // Anchor on a unique run further in instead. Hadith only: its span just decides which
    // prose chunk carries the badge, so being off by the stuttered word is harmless, whereas
    // a Quran span carves words out of prose and must be exact.
    let backOff = 0;
    if (charPos === -1 && ref.refType === 'hadith') {
      for (let k = 1; k <= 4 && charPos === -1 && k + 5 <= refNormWords.length; k++) {
        const fp = refNormWords.slice(k, k + 5).join(' ');
        const p = normTranscriptStr.indexOf(fp);
        if (p !== -1 && normTranscriptStr.indexOf(fp, p + 1) === -1) { charPos = p; backOff = k; }
      }
    }
    if (charPos === -1) continue;
    let startWord = Math.max(0,
      normTranscriptStr.slice(0, charPos).split(/\s+/).filter(Boolean).length - backOff);
    // The stutter shifts the anchor by the repeated words, so walk back to where the
    // hadith's first word actually is — otherwise its opening stays in the previous block.
    if (backOff) {
      for (let j = startWord; j >= Math.max(0, startWord - 4); j--) {
        if (normWords[j] === refNormWords[0]) { startWord = j; break; }
      }
    }
    located.push({ ref, startWord, endWord: startWord + refNormWords.length });
  }
  located.sort((a, b) => a.startWord - b.startWord);

  // Resolve overlapping entries. Two distinct ayahs recited back-to-back (e.g. Ta-Ha
  // 20:43 then 20:44) overlap here because a merged Quran zone gives the first ref a
  // detected_text spanning BOTH ayahs — so the second ayah starts inside the first's
  // span. That must NOT be deduped away. A true duplicate (the SAME ayah surfaced by
  // multiple detection layers) still collapses to the longer detected_text.
  const deduped = [];
  for (const loc of located) {
    const prev = deduped[deduped.length - 1];
    if (prev && loc.startWord < prev.endWord) {
      const bothQuran = prev.ref.refType !== 'hadith' && loc.ref.refType !== 'hadith';
      const distinctAyah = bothQuran && (
        prev.ref.surah_number !== loc.ref.surah_number ||
        prev.ref.ayah_number !== loc.ref.ayah_number
      );
      if (distinctAyah && loc.startWord > prev.startWord) {
        if (loc.endWord >= prev.endWord) {
          // Distinct, consecutive ayahs: trim the earlier ref to end where the next begins
          // so each renders its own words and keeps its own citation card.
          prev.endWord = loc.startWord;
          deduped.push(loc);
        } else {
          // Distinct ayah CONTAINED within the parent's span (the parent ref's detected_text
          // spans into the next ayah). Trim the parent to end where the child begins and push
          // the child. Do NOT re-emit the parent's remainder as a tail card — it would carry
          // the parent's label over the NEXT ayah's words (mislabeling, e.g. a "22:34" card
          // showing 22:35's text). Those words are covered by their own zone/card or prose.
          prev.endWord = loc.startWord;
          deduped.push(loc);
        }
      } else if ((loc.ref.detected_text ?? '').length > (prev.ref.detected_text ?? '').length) {
        // True duplicate or nested match — keep the longer (more specific) detected_text.
        deduped[deduped.length - 1] = loc;
      }
    } else {
      deduped.push(loc);
    }
  }

  // Collapse multiple cards for the SAME ayah into one. A long ayah recited with a pause,
  // an echoed phrase, or an ayah detected by several layers can produce 2+ cards for one
  // surah:ayah. Keep the longest span; drop the rest. The card renders canonical verse text,
  // so a single card always shows the COMPLETE ayah. Distinct ayahs (e.g. consecutive
  // 20:43/20:44) have different keys and are untouched. Hadith entries pass through.
  {
    const byAyah = new Map();
    const collapsed = [];
    for (const loc of deduped) {
      if (loc.ref.refType === 'hadith') { collapsed.push(loc); continue; }
      const key = `${loc.ref.surah_number}:${loc.ref.ayah_number}`;
      const existing = byAyah.get(key);
      if (!existing) { byAyah.set(key, loc); collapsed.push(loc); continue; }
      if ((loc.endWord - loc.startWord) > (existing.endWord - existing.startWord)) {
        collapsed[collapsed.indexOf(existing)] = loc;
        byAyah.set(key, loc);
      }
    }
    collapsed.sort((a, b) => a.startWord - b.startWord);
    deduped.length = 0;
    deduped.push(...collapsed);
  }

  // Per-chunk translations (new results) or fall back to proportional sentence slicing
  const chunkTranslations = result.chunk_translations;
  const proseChunkMap = result.prose_chunk_map ?? null; // [{wordStart, wordEnd, proseIdx}]
  const fullTranslationFallback = (result.translation || '');
  const englishSentences = chunkTranslations ? [] :
    fullTranslationFallback.replace(/\n+/g, ' ').split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  let engCursor = 0;

  // Build prose segments for the word range [from, to).
  // When prose_chunk_map is available, use its zone-aware entries directly so each
  // segment carries its proseIdx and exactly the right words. Falls back to fixed
  // 30-word chunks for old results without a map.
  const PROSE_CHUNK = 30;
  // Guard against emitting the same prose chunk twice. A ref that wasn't pre-scanned as a
  // Quran zone (e.g. detected only by Claude/Jaccard) can sit ENTIRELY INSIDE one prose
  // chunk; that chunk then satisfies the (wordEnd > from && wordStart < to) test on BOTH
  // sides of the ref and would render before AND after it. Emit each proseIdx at most once.
  const emittedProse = new Set();
  const buildProseSegs = (from, to) => {
    if (proseChunkMap) {
      // Use wordEnd > from (not wordStart >= from) so that a chunk whose wordStart falls
      // slightly inside a ref's span (due to ref detection / zone boundary mismatch) is
      // still included rather than silently dropped.
      return proseChunkMap
        .filter(e => e.wordEnd > from && e.wordStart < to && !emittedProse.has(e.proseIdx))
        .map(e => {
          emittedProse.add(e.proseIdx);
          return { type: 'prose', words: origWords.slice(e.wordStart, e.wordEnd), startWord: e.wordStart, proseIdx: e.proseIdx };
        });
    }
    const prose = origWords.slice(from, to);
    const segs = [];
    for (let i = 0; i < prose.length; i += PROSE_CHUNK) {
      segs.push({ type: 'prose', words: prose.slice(i, i + PROSE_CHUNK), startWord: from + i });
    }
    return segs;
  };

  // Quran zones are excluded from prose chunks, so a Quran ref renders as its own segment with
  // no duplication. Hadith words, however, ARE part of the prose chunks — emitting a separate
  // Hadith segment would show the Arabic twice (once in the prose chunk, once in the card).
  // So we interleave only Quran refs, then attach each Hadith's badge to the prose chunk that
  // contains it: the Hadith appears once, inside its prose chunk, with the citation badge below.
  const quranLocated = deduped.filter(l => l.ref.refType !== 'hadith');
  const hadithLocated = deduped.filter(l => l.ref.refType === 'hadith');

  // A Quran ref only gets its own segment when its words were carved out of prose. Zones
  // shorter than MIN_ZONE_WORDS are deliberately LEFT in prose (removing them without
  // rendering them made their text disappear), so a short ayah like Ibrahim 14:7
  // ("لئن شكرتم لأزيدنكم") still sits inside a prose chunk. Emitting a separate segment for
  // it would print the ayah twice — once inline where it was said, once as a card further
  // down. Attach those to their prose chunk instead, exactly as Hadith are handled, so the
  // citation appears under the passage where the imam actually said it.
  // Require MOST of the ref to sit in prose, not merely to touch it. Ref spans are located
  // by fingerprint and chunk spans by zone boundaries, so the two differ by a word or two
  // at the edges; treating a one-word overlap as "inline" made a carved-out ayah attach as
  // a badge while its words — already removed from prose — rendered nowhere at all.
  const wordsStillInProse = (startWord, endWord) => {
    if (!proseChunkMap) return false;
    const span = Math.max(endWord - startWord, 1);
    let inside = 0;
    for (const e of proseChunkMap) {
      inside += Math.max(0, Math.min(e.wordEnd, endWord) - Math.max(e.wordStart, startWord));
    }
    return inside / span >= 0.5;
  };

  const quranInline = quranLocated.filter(l => wordsStillInProse(l.startWord, l.endWord));
  const quranStandalone = quranLocated.filter(l => !wordsStillInProse(l.startWord, l.endWord));

  let segments = [];
  let cursor = 0;
  for (const { ref, startWord, endWord } of quranStandalone) {
    if (startWord > cursor) segments.push(...buildProseSegs(cursor, startWord));
    segments.push({ type: ref.refType, words: origWords.slice(startWord, endWord), ref, startWord });
    cursor = endWord;
  }
  if (cursor < origWords.length) segments.push(...buildProseSegs(cursor, origWords.length));

  // Badge each inline Quran ref onto the prose segment that contains it.
  for (const { ref, startWord, endWord } of quranInline) {
    const host = segments.find(s => s.type === 'prose' &&
      s.startWord < endWord && s.startWord + s.words.length > startWord);
    if (host) (host.quranRefs ??= []).push(ref);
    else segments.push({ type: 'quran', words: origWords.slice(startWord, endWord), ref, startWord });
  }

  // Attach each Hadith to the prose chunk(s) it covers. A long Hadith can span a prose-chunk
  // boundary (chunks break at breath pauses, and Hadith zones — unlike Quran — aren't known
  // when chunks are built). It can also enclose a Quran phrase: the Prophet's dhikr/dua often
  // contains words that match a Quran ayah (e.g. "له الملك وله الحمد وهو" = 64:1), which the
  // Quran pre-scan carves out as a zone, leaving a gap in the Hadith text. So we merge every
  // segment the Hadith overlaps — prose chunks, plus any Quran segment fully inside the span —
  // and rebuild the merged chunk from a CONTIGUOUS transcript slice, which refills those gaps.
  for (const { ref, startWord, endWord } of hadithLocated) {
    const overlap = segments.filter(s => {
      const sEnd = s.startWord + s.words.length;
      if (s.type === 'prose') return s.startWord < endWord && sEnd > startWord;
      // Absorb a Quran ref only when it sits entirely inside the Hadith (dhikr/dua case),
      // so a standalone recitation keeps its own card.
      if (s.type === 'quran') return s.startWord >= startWord && sEnd <= endWord;
      return false;
    });
    if (!overlap.length) {
      const before = segments.filter(s => s.type === 'prose' && s.startWord <= startWord);
      const host = before[before.length - 1];
      if (host) {
        (host.hadithRefs ??= []).push(ref);
        host._hadithCoverage = Math.max(host._hadithCoverage ?? 0,
          (endWord - startWord) / Math.max(host.words.length, 1));
      }
      else segments.push({ type: 'hadith', words: origWords.slice(startWord, endWord), ref, startWord });
      continue;
    }
    const spanStart = Math.min(...overlap.map(s => s.startWord));
    const spanEnd = Math.max(...overlap.map(s => s.startWord + s.words.length));
    const first = overlap[0];
    first.type = 'prose'; // render as prose+badge even if it began as a Quran segment
    first.startWord = spanStart;
    first.words = origWords.slice(spanStart, spanEnd); // contiguous — fills excluded-zone gaps
    first.proseIdxList = first.proseIdxList ?? (first.proseIdx != null ? [first.proseIdx] : []);
    for (let k = 1; k < overlap.length; k++) {
      const seg = overlap[k];
      if (seg.type === 'prose' && seg.proseIdx != null) first.proseIdxList.push(seg.proseIdx);
      seg._removed = true;
    }
    (first.hadithRefs ??= []).push(ref);
    // How much of this block is the Hadith itself? Used below to decide whether the block's
    // prose translation is just a second rendering of the Hadith.
    first._hadithCoverage = Math.max(first._hadithCoverage ?? 0,
      (endWord - startWord) / Math.max(first.words.length, 1));
    segments = segments.filter(s => !s._removed);
  }

  segments = reconcileCoverage(segments, origWords);

  const lines = ['ANNOTATED READER VIEW', '=====================\n'];

  // Insert a divider before the chunk that begins the second khutbah. Rendered as its own
  // block (Arabic-only label) so server-side chunk parsing drops it rather than mis-attaching it.
  // The split word usually falls mid-chunk (chunks break at breath pauses, not khutbah
  // boundaries), so place the divider before the chunk whose start is NEAREST the split word —
  // this keeps the bulk of a straddling chunk on the correct side.
  const splitWordIndex = result.second_khutbah?.word_index ?? -1;
  let dividerBeforeStartWord = null;
  if (splitWordIndex >= 0) {
    let bestDist = Infinity;
    for (const s of segments) {
      const d = Math.abs((s.startWord ?? 0) - splitWordIndex);
      if (d < bestDist) { bestDist = d; dividerBeforeStartWord = s.startWord ?? 0; }
    }
  }
  let dividerInserted = false;

  for (const seg of segments) {
    if (dividerBeforeStartWord !== null && !dividerInserted && (seg.startWord ?? 0) === dividerBeforeStartWord) {
      lines.push('الخطبة الثانية  ·  SECOND KHUTBAH');
      lines.push('');
      lines.push('─'.repeat(60));
      lines.push('');
      dividerInserted = true;
    }
    const arabic = seg.words.join(' ');
    let english;
    if (seg.untranslated) {
      // Words between two cards that were never sent for translation (see reconcileCoverage).
      english = '(Not translated.)';
    } else if (chunkTranslations) {
      if (seg.type === 'prose') {
        // Use proseIdx stored on the segment (from prose_chunk_map) when available;
        // fall back to position-based lookup for old results without a map. Merged chunks
        // (Hadith spanning a boundary) join their constituent chunk translations.
        if (seg.proseIdxList && seg.proseIdxList.length) {
          english = seg.proseIdxList
            .map(i => chunkTranslations[Math.min(i, chunkTranslations.length - 1)] || '')
            .join(' ').trim();
        } else {
          const idx = seg.proseIdx ?? Math.floor((seg.startWord ?? 0) / PROSE_CHUNK);
          english = chunkTranslations[Math.min(idx, chunkTranslations.length - 1)] || '';
        }
      } else {
        // Refs never get a chunk translation — they have their own cite label
        english = '';
      }
    } else {
      const fraction = seg.words.length / origWords.length;
      const engCount = Math.max(1, Math.round(fraction * englishSentences.length));
      english = englishSentences.slice(engCursor, engCursor + engCount).join(' ');
      engCursor = Math.min(engCursor + engCount, englishSentences.length);
    }

    // When a block is essentially just a quoted Hadith, its prose translation and the
    // published sunnah.com translation say the same thing, and the reader shows two
    // near-identical English paragraphs. Compare them directly rather than guessing from
    // how much of the block the Hadith spans — word overlap is what actually decides
    // whether the reader sees a duplicate. Blocks carrying real surrounding prose keep
    // their translation, or that prose would lose its English entirely.
    // A block must never show the same thing translated twice. Where the block's prose
    // translation and the published sunnah.com translation both render the quoted Hadith,
    // keep exactly one:
    // keep the block's own prose translation and drop the published one when it is
    // redundant. The prose translation is the only one that covers the WHOLE block — the
    // Hadith plus the imam's words around it, such as "رواه الإمام ابن ماجه وأحمد وحسنه
    // الألباني". Dropping it to keep the published translation leaves that framing with no
    // English at all, which is how this block briefly lost its attribution line. The
    // published translation still appears wherever the prose does not already render the
    // Hadith.
    // The rule is deterministic rather than a similarity score: word-overlap kept getting
    // this wrong in both directions, because "perform Wudu with a mudd" and "performed
    // ablution with one Mudd" share almost no content words while saying the same thing,
    // and common English words push unrelated sentences above any sensible threshold.
    // If the block has a prose translation it already renders the quoted Hadith, so the
    // published translation would repeat it.
    const skipFetched = new Set();
    if (english) for (const h of (seg.hadithRefs ?? [])) skipFetched.add(h);

    english = usePublishedTranslations(english, seg.quranRefs, seg.hadithRefs);
    lines.push(arabic);
    lines.push('');
    if (english) lines.push(english);

    if (seg.type === 'quran') {
      pushQuranBadge(lines, seg.ref);
    } else if (seg.type === 'hadith') {
      pushHadithBadge(lines, seg.ref);
    }

    // Badges for refs whose text lives inside this prose chunk rather than in a card of
    // its own — short Quran refs and Hadith both land here.
    if (seg.quranRefs) {
      for (const qref of seg.quranRefs) pushQuranBadge(lines, qref, true);
    }
    if (seg.hadithRefs) {
      for (const href of seg.hadithRefs) pushHadithBadge(lines, href, skipFetched.has(href));
    }

    lines.push('');
    lines.push('─'.repeat(60));
    lines.push('');
  }

  return lines.join('\n');
}

// ---- Readable output formatter ----------------------------------------------

function buildReadableOutput(result) {
  const { share_summary, summary, translation, chunk_translations, quran_references, hadith_references, metadata } = result;
  // Prefer joined chunk_translations (aligned, per-chunk) over monolithic translation
  const fullTranslation = (chunk_translations && chunk_translations.length)
    ? chunk_translations.join(' ')
    : (translation || '');
  const lines = [];

  lines.push('━'.repeat(60));
  lines.push('  JUMU\'AH KHUTBAH — QUICK SHARE');
  lines.push('━'.repeat(60));
  lines.push('');
  lines.push(share_summary ?? summary);
  lines.push('');
  lines.push('━'.repeat(60));
  lines.push('');

  lines.push('DETAILED SUMMARY');
  lines.push('================');
  lines.push(summary);
  lines.push('');

  lines.push('FULL TRANSLATION');
  lines.push('================');
  lines.push(fullTranslation);
  lines.push('');

  lines.push(
    `QURANIC REFERENCES (${metadata.quran_references_found} found, ${metadata.quran_references_matched} matched)`
  );
  lines.push('============================================');
  if (quran_references.length === 0) {
    lines.push('None detected.');
  } else {
    quran_references.forEach((ref, i) => {
      if (ref.matched) {
        const verif = ref.verification ?? '';
        const verifLabel = verif === 'claude+algorithm' ? '✓ Claude + Algorithm agree'
                         : verif === 'claude_only'      ? '~ Claude identified (algorithm uncertain)'
                         : verif === 'algorithm_only'   ? '~ Algorithm matched (Claude uncertain)'
                         : verif.startsWith('DISAGREEMENT') ? `⚠ DISAGREEMENT — ${verif.replace('DISAGREEMENT:', '')}`
                         : '';
        const ayahLabel = ref.ayah_number_end && ref.ayah_number_end !== ref.ayah_number
          ? `${ref.ayah_number}-${ref.ayah_number_end}`
          : `${ref.ayah_number}`;
        lines.push(`${i + 1}. ${ref.surah_name} ${ref.surah_number}:${ayahLabel}`);
        lines.push(`   Arabic: ${ref.detected_text}`);
        lines.push(`   Link: ${ref.quran_link}`);
        lines.push(`   Confidence: ${ref.confidence}  |  ${verifLabel}`);
      } else {
        lines.push(`${i + 1}. [No match found]`);
        lines.push(`   Arabic: ${ref.detected_text}`);
      }
      lines.push('');
    });
  }

  lines.push(`HADITH REFERENCES (${metadata.hadith_references_found} found)`);
  lines.push('==============================');
  if (hadith_references.length === 0) {
    lines.push('None detected.');
  } else {
    hadith_references.forEach((ref, i) => {
      lines.push(`${i + 1}. Narrator: ${ref.narrator ?? 'unknown'}`);
      lines.push(`   Collection: ${ref.collection ?? 'unknown'}`);
      lines.push(`   Arabic: ${ref.detected_text}`);
      lines.push(`   Note: ${ref.note}`);
      lines.push('');
    });
  }

  return lines.join('\n');
}

// ---- Audio preprocessing ----------------------------------------------------

// Whisper's VAD scores every 30-second chunk for "speech probability".
// Distant mics, AC noise, or uneven volume cause real speech to score below
// the threshold and get silently dropped — at the start AND mid-audio.
//
// Fix:
//   1. Loudness normalise (EBU R128) so quiet speech isn't mistaken for silence
//   2. Highpass at 80 Hz to remove AC hum / low-frequency rumble that confuses VAD
//   3. Prepend 1s silence so the first chunk's attention window starts on real audio
//   4. Convert to 16kHz mono PCM WAV (Whisper's native format — no decode overhead)
// Seconds of silence prepended in preprocessAudio. Whisper times the preprocessed audio, so
// all timestamps are offset by this much vs. the original file the player uses — subtracted back
// in main() after transcription.
const SILENCE_PREPEND_SEC = 1;

function preprocessAudio(audioPath) {
  return new Promise((resolve, reject) => {
    // MP3 at 48kbps mono — ~5 MB for a 15-min khutbah, well under Groq's 25 MB limit.
    // 48kbps is more than enough for speech recognition; Whisper internally works at 16kHz.
    const outPath = audioPath.replace(/\.[^.]+$/, '') + '_preprocessed.mp3';
    const ff = spawn('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-t', String(SILENCE_PREPEND_SEC), '-i', 'aevalsrc=0:s=16000:c=mono',
      '-i', audioPath,
      '-filter_complex',
      '[1:a]highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11,aformat=sample_rates=16000:channel_layouts=mono[speech];' +
      '[0:a][speech]concat=n=2:v=0:a=1[out]',
      '-map', '[out]',
      '-ar', '16000', '-ac', '1', '-codec:a', 'libmp3lame', '-b:a', '48k',
      outPath,
    ]);
    ff.stderr.on('data', () => {});
    ff.on('close', code => {
      if (code !== 0) {
        console.warn('[WARN] ffmpeg preprocessing failed — using original file (VAD may drop chunks)');
        resolve(audioPath);
      } else {
        resolve(outPath);
      }
    });
    ff.on('error', () => {
      console.warn('[WARN] ffmpeg not found — skipping preprocessing (install with: brew install ffmpeg)');
      resolve(audioPath);
    });
  });
}

// ---- Transcription backends -------------------------------------------------

async function transcribeWithAPI(audioPath) {
  const response = await openai.audio.transcriptions.create({
    file: createReadStream(audioPath),
    model: 'whisper-1',
    language: 'ar',
  });
  return response.text;
}

// Groq hosts whisper-large-v3 for free — typically ~10s for a 20-min file
// Groq's free tier caps audio-seconds per hour, and a run now makes several timing requests.
// On a 429, wait as long as the error says ("try again in 1m3.5s") and retry, rather than
// failing the run.
async function withGroqRateLimit(call, attempts = 6) {
  for (let i = 1; ; i++) {
    try { return await call(); }
    catch (e) {
      if (e?.status !== 429 || i >= attempts) throw e;
      const m = String(e.message).match(/try again in (?:(\d+)m)?([\d.]+)s/);
      const wait = m ? (+(m[1] ?? 0) * 60 + +m[2]) * 1000 + 1000 : 30_000;
      console.log(`  Groq rate limit — waiting ${Math.ceil(wait / 1000)}s`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

// `prompt: false` for timing-only passes. The prompt biases Whisper's wording toward the
// khutbah's opening formulas, which helps --groq text, but on the preprocessed audio it also
// sends Whisper into repetition loops that swallow speech: a 90 s window came back as
// "ورحمة الله الرحمن الرحيم" three times over (43 words instead of 128). The Gemini hybrid
// takes its text from Gemini, so its timing pass has nothing to gain from the prompt.
async function transcribeWithGroq(audioPath, { prompt = true } = {}) {
  const ext = path.extname(audioPath).toLowerCase().replace('.', '');
  const mimeMap = { mp3: 'audio/mpeg', mp4: 'audio/mp4', m4a: 'audio/mp4',
    wav: 'audio/wav', ogg: 'audio/ogg', webm: 'audio/webm',
    flac: 'audio/flac', opus: 'audio/opus', mpeg: 'audio/mpeg', mpga: 'audio/mpeg' };
  const mime = mimeMap[ext] ?? 'audio/mpeg';
  // Use native File so the filename/type are always set correctly regardless of extension case
  const file = new File([readFileSync(audioPath)], `audio.${ext}`, { type: mime });
  const response = await withGroqRateLimit(() => groq.audio.transcriptions.create({
    file,
    model: 'whisper-large-v3',
    language: 'ar',
    response_format: 'verbose_json',
    timestamp_granularities: ['word', 'segment'],
    ...(prompt ? { prompt: 'بسم الله الرحمن الرحيم، الحمد لله رب العالمين، والصلاة والسلام على رسول الله صلى الله عليه وسلم' } : {}),
  }));
  const text = typeof response === 'string' ? response : response.text;
  const segments = (response.segments ?? []).map(s => ({ start: s.start, end: s.end, text: s.text }));
  const words = (response.words ?? []).map(w => ({ word: w.word, start: w.start, end: w.end }));
  return { text, segments, words };
}

// Cut [start, start+dur) of an audio file to a 16 kHz mono mp3 in the temp dir.
function cutClip(audioPath, start, dur, tag) {
  const clip = path.join(os.tmpdir(), `khutbah_${tag}_${process.pid}_${Math.round(start * 10)}.mp3`);
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(start), '-t', String(dur),
      '-i', audioPath, '-ac', '1', '-ar', '16000', clip]);
    ff.on('error', reject);
    ff.on('close', code => code === 0 ? resolve(clip) : reject(new Error(`ffmpeg exited ${code}`)));
  });
}

function audioDuration(audioPath) {
  return new Promise(resolve => {
    const ff = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audioPath]);
    let out = '';
    ff.stdout.on('data', d => { out += d; });
    ff.on('error', () => resolve(null));
    ff.on('close', () => resolve(parseFloat(out) || null));
  });
}

// Whisper timing over overlapping windows instead of the whole file, with no prompt (see
// transcribeWithGroq). Run over a full khutbah, Whisper sometimes drops a passage outright — on 25 Sep 2026 it skipped ~90 s
// ("من صلى علي صلاة واحدة" … "اللهم اجعل تدبيره") and hallucinated a salutation in its
// place, which left the reader's highlight up to 30 s behind the imam — while the same
// passage as a 100 s clip came back complete and correctly timed. Each window keeps only
// the words in its central part, so every stretch of audio is timed by the window where it
// sits furthest from an edge. Falls back to a single whole-file pass if the audio's
// duration cannot be read.
const TIMING_WINDOW_SEC = 90, TIMING_OVERLAP_SEC = 10;
async function transcribeWithGroqWindowed(audioPath) {
  const total = await audioDuration(audioPath);
  if (!total || total <= TIMING_WINDOW_SEC + TIMING_OVERLAP_SEC) return transcribeWithGroq(audioPath, { prompt: false });
  const step = TIMING_WINDOW_SEC - TIMING_OVERLAP_SEC;
  const starts = [];
  for (let t = 0; t < total - TIMING_OVERLAP_SEC; t += step) starts.push(t);
  const results = new Array(starts.length);
  // A few windows at a time — plenty fast, and gentle on the Groq rate limit.
  for (let b = 0; b < starts.length; b += 3) {
    await Promise.all(starts.slice(b, b + 3).map(async (start, k) => {
      const i = b + k;
      const clip = await cutClip(audioPath, start, TIMING_WINDOW_SEC, 'win');
      try { results[i] = await transcribeWithGroq(clip, { prompt: false }); }
      finally { try { unlinkSync(clip); } catch {} }
    }));
  }
  const words = [], segments = [];
  results.forEach((r, i) => {
    const start = starts[i];
    const lo = i === 0 ? -Infinity : start + TIMING_OVERLAP_SEC / 2;
    const hi = i === starts.length - 1 ? Infinity : start + step + TIMING_OVERLAP_SEC / 2;
    for (const w of r.words ?? []) {
      const t = w.start + start;
      if (t >= lo && t < hi) words.push({ ...w, start: t, end: w.end + start });
    }
    for (const s of r.segments ?? []) {
      const t = s.start + start;
      if (t >= lo && t < hi) segments.push({ ...s, start: t, end: s.end + start });
    }
  });
  return { text: segments.map(s => s.text.trim()).join(' '), segments, words };
}

// Sequence-aligns display words (Gemini) to timed words (Whisper word-level timestamps).
// Returns one start time per display word. Words that match a Whisper word are anchored to
// that word's real audio time; words Whisper missed are linearly interpolated between the
// surrounding anchors. Because matches re-anchor to actual audio at hundreds of points, there
// is no cumulative drift — error stays local to each interpolated gap.
// Uses Needleman-Wunsch global alignment so repeated common tokens stay positionally constrained.
function alignWordTimestamps(displayWords, timedWords) {
  if (!displayWords.length || !timedWords.length) return null;
  return interpolateAnchors(anchorTimes(displayWords, timedWords));
}

function alignAnchors(A, B, timedWords, n, m, W, tb) {
  const times = new Array(n).fill(null);
  let i = n, j = m;
  while (i > 0 && j > 0) {
    const dir = tb[i * W + j];
    if (dir === 0) {
      if (A[i - 1] === B[j - 1]) times[i - 1] = timedWords[j - 1].start; // anchor
      i--; j--;
    } else if (dir === 1) { i--; } else { j--; }
  }
  return times;
}

// Raw anchors only: one real audio time per display word, or null where it matched nothing.
function anchorTimes(displayWords, timedWords) {
  const n = displayWords.length, m = timedWords.length;
  if (!n || !m) return new Array(n).fill(null);
  const A = displayWords.map(w => normalizeArabic(w));
  const B = timedWords.map(t => normalizeArabic(t.word));
  const MATCH = 2, MISMATCH = -1, GAP = -1;
  const W = m + 1;
  const score = new Int32Array((n + 1) * W);
  const tb = new Int8Array((n + 1) * W);
  for (let i = 1; i <= n; i++) { score[i * W] = i * GAP; tb[i * W] = 1; }
  for (let j = 1; j <= m; j++) { score[j] = j * GAP; tb[j] = 2; }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = score[(i - 1) * W + (j - 1)] + (A[i - 1] === B[j - 1] ? MATCH : MISMATCH);
      const up = score[(i - 1) * W + j] + GAP;
      const left = score[i * W + (j - 1)] + GAP;
      let best = diag, dir = 0;
      if (up > best) { best = up; dir = 1; }
      if (left > best) { best = left; dir = 2; }
      score[i * W + j] = best; tb[i * W + j] = dir;
    }
  }
  return alignAnchors(A, B, timedWords, n, m, W, tb);
}

// Anchor times from several Whisper passes, first source preferred. Each pass drops or
// mis-hears different stretches: the windowed pass recovered the 90 s the whole-file pass
// dropped on 25 Sep, while only the whole-file pass anchored the quiet sitting between the
// two khutbahs on 22 May. Anchors that break time order (a hallucinated word matched far
// from where it belongs) are dropped, keeping the longest time-ordered run.
function combineTimings(displayWords, sources) {
  const per = sources.filter(s => s?.length).map(s => anchorTimes(displayWords, s));
  if (!per.length) return null;
  const merged = displayWords.map((_, k) => per.find(p => p[k] !== null)?.[k] ?? null);
  // Longest non-decreasing subsequence of anchor times (patience sort, O(n log n)).
  const idx = merged.map((t, k) => t === null ? -1 : k).filter(k => k >= 0);
  const tails = [], prev = new Array(idx.length).fill(-1), tailAt = [];
  idx.forEach((k, p) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] <= merged[k]) lo = mid + 1; else hi = mid; }
    tails[lo] = merged[k]; tailAt[lo] = p; prev[p] = lo > 0 ? tailAt[lo - 1] : -1;
  });
  const keep = new Set();
  for (let p = tailAt[tails.length - 1]; p >= 0; p = prev[p]) keep.add(idx[p]);
  return interpolateAnchors(merged.map((t, k) => keep.has(k) ? t : null));
}

// Fill unanchored words by linear interpolation between neighbouring anchors.
function interpolateAnchors(times) {
  const n = times.length;
  const anchors = [];
  for (let k = 0; k < n; k++) if (times[k] !== null) anchors.push(k);
  if (!anchors.length) return null;
  const anchored = times.map(t => t !== null);
  for (let k = 0; k < anchors[0]; k++) times[k] = times[anchors[0]];
  const last = anchors[anchors.length - 1];
  for (let k = last + 1; k < n; k++) times[k] = times[last];
  for (let a = 0; a < anchors.length - 1; a++) {
    const p = anchors[a], q = anchors[a + 1];
    const tp = times[p], tq = times[q];
    for (let k = p + 1; k < q; k++) times[k] = tp + (tq - tp) * (k - p) / (q - p);
  }
  times.anchored = anchored; // which times are real audio anchors vs interpolated
  return times;
}

// Safety net behind the windowed timing: a long run of display words with no Whisper anchor
// is spread evenly across its gap, which puts the reader's highlight out of step with the
// imam. Re-run Groq on just that stretch (with context either side) and splice its timings
// in, replacing whatever Groq returned inside the gap. One pass, a few short requests at most.
const GAP_MIN_WORDS = 15;
async function retimeUnanchoredGaps(audioPath, displayWords, sources, times) {
  const gaps = [];
  for (let k = 0; k < displayWords.length;) {
    if (times.anchored[k]) { k++; continue; }
    let e = k;
    while (e < displayWords.length && !times.anchored[e]) e++;
    if (e - k >= GAP_MIN_WORDS && (e >= displayWords.length || k === 0 || times[e] - times[k - 1] >= 3)) {
      const from = k > 0 ? times[k - 1] : 0;
      const to = e < displayWords.length ? times[e] : times[displayWords.length - 1] + 5;
      gaps.push({ from, to, words: e - k });
    }
    k = e;
  }
  if (!gaps.length) return null;
  const timedWords = sources[0];
  let merged = timedWords;
  for (const g of gaps.slice(0, 6)) {
    // Whisper needs context: a clip cut tight to the gap can come back empty.
    const start = Math.max(0, g.from - 15), dur = Math.max(g.to + 15 - start, 45);
    let clip = null;
    try {
      clip = await cutClip(audioPath, start, dur, 'gap');
      const res = await transcribeWithGroq(clip, { prompt: false });
      const fresh = (res.words ?? []).map(w => ({ ...w, start: w.start + start, end: w.end + start }))
        .filter(w => w.start > g.from && w.start < g.to);
      merged = [...merged.filter(w => !(w.start > g.from && w.start < g.to)), ...fresh]
        .sort((a, b) => a.start - b.start);
      console.log(`  re-timed a ${g.words}-word gap at ${g.from.toFixed(0)}–${g.to.toFixed(0)}s (${fresh.length} words from a clip)`);
    } catch (e) {
      console.warn(`  [WARN] could not re-time gap at ${g.from.toFixed(0)}s: ${e.message}`);
    } finally {
      if (clip) try { unlinkSync(clip); } catch {}
    }
  }
  return merged === timedWords ? null : combineTimings(displayWords, [merged, ...sources.slice(1)]);
}

// Assigns each timed display word to one of the reference (Whisper) segments by actual time,
// preserving word order. Reuses Whisper's real breath-pause boundaries while placing Gemini's
// richer text in the correct time slots.
function buildSegmentsFromWordTimes(words, times, refSegments) {
  if (!refSegments.length) return [];
  const bucket = refSegments.map(() => []);
  let si = 0;
  for (let k = 0; k < words.length; k++) {
    while (si < refSegments.length - 1 && times[k] >= refSegments[si].end) si++;
    bucket[si].push(words[k]);
  }
  return refSegments
    .map((s, i) => ({ start: s.start, end: s.end, text: bucket[i].join(' ') }))
    .filter(s => s.text);
}

// Gemini 2.5 Flash for transcript quality + Groq Whisper for accurate timestamps.
// Gemini gets the text right (more words, better Arabic); Groq gives real audio-aligned timing.
// We align Gemini's words to Groq's word-level timestamps so each word gets a real audio time.
async function transcribeWithGemini(audioPath) {
  const ext = path.extname(audioPath).toLowerCase().replace('.', '');
  const mimeMap = { mp3: 'audio/mpeg', mp4: 'audio/mp4', m4a: 'audio/mp4',
    wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac' };
  const mimeType = mimeMap[ext] ?? 'audio/mpeg';

  // Run Gemini and Groq in parallel — Gemini for text quality, Groq for timing
  process.stdout.write('Uploading audio to Gemini Files API...');
  const uploadedFile = await gemini.files.upload({
    file: audioPath,
    config: { mimeType, displayName: path.basename(audioPath) },
  });
  let file = uploadedFile;
  while (file.state === 'PROCESSING') {
    await new Promise(r => setTimeout(r, 2000));
    file = await gemini.files.get({ name: file.name });
  }
  if (file.state !== 'ACTIVE') throw new Error(`Gemini file upload failed: ${file.state}`);
  console.log(' done');

  // The markup rules matter as much as the transcription instruction. Left unsaid, the model
  // decorates recited ayahs — and picks DIFFERENT decoration between runs of the same audio
  // (ornate ﴿…﴾ one run, {…} with "*" between verses the next). Anything that is not a spoken
  // word shifts word offsets or lands mid-recitation, which breaks reference alignment.
  // stripAyahMarkup() still cleans the output defensively; this just stops it being needed.
  const geminiPrompt = `Transcribe this Arabic khutbah (Friday sermon) audio exactly as spoken.
Output ONLY the Arabic transcript as plain text with no timestamps, no transliteration, no commentary.
Preserve all Arabic text exactly including Quranic verses and Hadith.

Formatting rules — follow these exactly:
- Write ONLY the spoken words. Do not add any character that was not spoken.
- Do NOT mark, quote, bracket or otherwise set apart Quranic verses or Hadith. Specifically do
  not use ﴿ ﴾ { } " " « » or any other quotation or ornament around them.
- Do NOT insert verse separators such as * or ۞ between consecutive Quranic verses. Recited
  verses run together as continuous text, exactly as the speaker says them.
- Ordinary sentence punctuation (. ، ؟ !) is fine.`;

  process.stdout.write('Transcribing (Gemini text + Groq timing in parallel)...');
  const [geminiResponse, groqResult, groqWindowed] = await Promise.all([
    gemini.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [{ parts: [{ text: geminiPrompt }, { fileData: { mimeType, fileUri: file.uri } }] }],
      // Transcription has one correct answer, so sample as little as possible. The default
      // temperature of 1.0 is why the same audio produced different ayah markup on
      // consecutive runs. temperature 0 + a fixed seed makes runs repeatable in practice,
      // though the API does not guarantee bit-identical output.
      config: { temperature: 0, seed: 42 },
    }),
    // Two Whisper passes for timing — whole file (as before; its segments still set the
    // chunk boundaries) and overlapping windows — combined per word in combineTimings.
    transcribeWithGroq(audioPath),
    transcribeWithGroqWindowed(audioPath),
  ]);
  console.log(' done');

  await gemini.files.delete({ name: file.name }).catch(() => {});

  const geminiText = (geminiResponse.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();
  const groqSegments = groqResult.segments ?? [];
  const groqWords = groqResult.words ?? [];
  // The hybrid already ran Groq for timing — expose its raw text too so callers can
  // compare Gemini vs Groq transcripts without a second transcription pass.
  const groqText = (groqResult.text ?? groqSegments.map(s => s.text).join(' ')).trim();

  if (!groqSegments.length) return { text: geminiText, segments: [], words: [], groqText };

  const geminiWords = geminiText.split(/\s+/).filter(Boolean);

  // Align Gemini's words to Groq's word-level timestamps for real, drift-free timing.
  const sources = [groqWindowed.words ?? [], groqWords];
  let times = combineTimings(geminiWords, sources);
  if (times) times = (await retimeUnanchoredGaps(audioPath, geminiWords, sources, times)) ?? times;
  if (times) {
    const wordTimes = geminiWords.map((word, k) => ({ word, start: Math.round(times[k] * 100) / 100 }));
    const segments = buildSegmentsFromWordTimes(geminiWords, times, groqSegments);
    return { text: geminiText, segments, words: wordTimes, groqText };
  }

  // Fallback: proportional segment mapping if word-level timestamps are unavailable.
  const groqTotalWords = groqSegments.reduce((n, s) => n + s.text.trim().split(/\s+/).filter(Boolean).length, 0);
  const scale = geminiWords.length / Math.max(groqTotalWords, 1);
  const segments = [];
  let gPos = 0;
  for (let i = 0; i < groqSegments.length; i++) {
    const seg = groqSegments[i];
    const groqWordCount = seg.text.trim().split(/\s+/).filter(Boolean).length;
    const count = i === groqSegments.length - 1
      ? geminiWords.length - gPos
      : Math.max(1, Math.round(groqWordCount * scale));
    const slice = geminiWords.slice(gPos, gPos + count);
    if (slice.length) segments.push({ start: seg.start, end: seg.end, text: slice.join(' ') });
    gPos += count;
  }
  return { text: geminiText, segments, words: [], groqText };
}

// Shells out to transcribe_local.py which runs faster-whisper.
// stdout carries only the transcript; progress goes to stderr (visible in terminal).
async function transcribeLocal(audioPath, modelName) {
  const scriptPath = path.join(__dirname, 'transcribe_local.py');
  return new Promise((resolve, reject) => {
    const py = spawn('python3', [scriptPath, path.resolve(audioPath), modelName]);
    let stdout = '';
    let stderr = '';
    py.stdout.on('data', d => { stdout += d; });
    py.stderr.on('data', d => {
      stderr += d;
      process.stderr.write(d); // stream model-loading progress to the terminal
    });
    py.on('close', code => {
      if (code !== 0) {
        reject(new Error(
          `Local transcription failed (exit ${code}).\n` +
          'Make sure faster-whisper is installed: pip install faster-whisper'
        ));
      } else {
        try {
          const parsed = JSON.parse(stdout.trim());
          resolve({ text: parsed.text, segments: parsed.segments ?? [] });
        } catch {
          resolve({ text: stdout.trim(), segments: [] });
        }
      }
    });
    py.on('error', err => {
      reject(new Error(
        `Could not launch python3: ${err.message}\n` +
        'Make sure python3 is in your PATH.'
      ));
    });
  });
}

// ---- Main pipeline ----------------------------------------------------------

async function main() {
  // Step 1: Parse CLI arguments
  // Usage:
  //   node pipeline.js audio.mp3                              (OpenAI Whisper API)
  //   node pipeline.js audio.mp3 --groq                      (Groq whisper-large-v3, free & fast)
  //   node pipeline.js audio.mp3 --gemini                    (Gemini 2.5 Flash, best quality)
  //   node pipeline.js audio.mp3 --local                     (mlx-whisper on Apple Silicon, faster-whisper fallback)
  //   node pipeline.js audio.mp3 --local --model <hf-model>  (custom model, prefix with "mlx" for MLX backend)
  const args = process.argv.slice(2);
  const useLocal = args.includes('--local');
  const useGroq = args.includes('--groq');
  const useGemini = args.includes('--gemini');
  // --type <friday|arafah|eid> frames the summary and ref wording (default: friday).
  const typeFlagIdx = args.indexOf('--type');
  const khutbahType = (typeFlagIdx !== -1 && KHUTBAH_TYPES[args[typeFlagIdx + 1]])
    ? args[typeFlagIdx + 1] : 'friday';
  // --single (alias --no-split): treat the audio as ONE continuous khutbah and skip
  // second-khutbah split detection. Use for Arafah, Eid, lectures — anything that
  // isn't a two-part Friday Jumu'ah khutbah. Non-two-part types (arafah, eid) imply it.
  const singleKhutbah = args.includes('--single') || args.includes('--no-split')
    || !KHUTBAH_TYPES[khutbahType].twoPart;
  const modelFlagIdx = args.indexOf('--model');
  const localModel = modelFlagIdx !== -1
    ? args[modelFlagIdx + 1]
    : 'Systran/faster-whisper-large-v3';
  const transcriptFlagIdx = args.indexOf('--transcript');
  const existingTranscriptPath = transcriptFlagIdx !== -1 ? args[transcriptFlagIdx + 1] : null;

  const skipValues = new Set([
    modelFlagIdx !== -1 ? args[modelFlagIdx + 1] : null,
    typeFlagIdx !== -1 ? args[typeFlagIdx + 1] : null,
    existingTranscriptPath,
  ].filter(Boolean));
  const audioPath = args.find(a => !a.startsWith('--') && !skipValues.has(a));

  if (!audioPath && !existingTranscriptPath) {
    console.error(
      'Usage: node pipeline.js path/to/khutbah.mp3 [--groq] [--local] [--single] [--type friday|arafah|eid] [--model <hf-model-id>]\n' +
      '       node pipeline.js --transcript outputs/<run>/transcript.txt'
    );
    process.exit(1);
  }

  // Step 2: Validate inputs
  if (existingTranscriptPath) {
    if (!existsSync(existingTranscriptPath)) {
      console.error(`Error: Transcript file not found -- ${existingTranscriptPath}`);
      process.exit(1);
    }
  } else {
    if (!existsSync(audioPath)) {
      console.error(`Error: File not found -- ${audioPath}`);
      process.exit(1);
    }
    // Note: the 25 MB Whisper limit is checked AFTER preprocessing (which compresses to
    // ~48kbps mono MP3), since that — not the raw upload — is what gets sent to the API.
  }

  // Create a timestamped output folder
  const audioBasename = existingTranscriptPath
    ? path.basename(path.dirname(existingTranscriptPath))
        .replace(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}_)+/, '') // strip leading timestamp(s)
    : path.basename(audioPath, path.extname(audioPath));
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.join(__dirname, 'outputs', `${timestamp}_${audioBasename}`);
  mkdirSync(outDir, { recursive: true });
  console.log(`Output folder: outputs/${timestamp}_${audioBasename}/`);

  // Step 3: Transcribe (or load existing transcript)
  let transcript;
  let transcriptSegments = [];
  let transcriptWordTimes = [];
  let groqText = null; // populated in --gemini mode (Groq side of the hybrid) for comparison
  if (existingTranscriptPath) {
    console.log(`Using existing transcript: ${existingTranscriptPath}`);
    transcript = readFileSync(existingTranscriptPath, 'utf8').trim();
    // Reuse Groq word-timings + segments from the sibling result.json so the regenerated
    // output keeps accurate audio alignment (chunk start_times) without re-transcribing.
    try {
      const sibPath = path.join(path.dirname(existingTranscriptPath), 'result.json');
      const sib = JSON.parse(readFileSync(sibPath, 'utf8'));
      if (Array.isArray(sib.transcript_segments)) transcriptSegments = sib.transcript_segments;
      if (Array.isArray(sib.transcript_words)) transcriptWordTimes = sib.transcript_words;
      if (transcriptWordTimes.length) console.log(`  reused timing: ${transcriptWordTimes.length} word times, ${transcriptSegments.length} segments`);
    } catch { /* no sibling timing — proceed without */ }
  } else {
    const fileSizeMB = statSync(audioPath).size / (1024 * 1024);
    console.log('Preprocessing audio (prepending silence, normalising to 16kHz)...');
    const processedPath = await preprocessAudio(audioPath);
    const usedPath = processedPath;

    // Whisper (Groq/OpenAI) caps uploads at 25 MB. Check the PREPROCESSED file — the raw
    // input can be far larger and still compress under the limit. --local has no cap.
    const processedSizeMB = statSync(usedPath).size / (1024 * 1024);
    if (!useLocal && processedSizeMB > 25) {
      console.error(
        `Error: Even after compression the audio is ${processedSizeMB.toFixed(1)} MB -- over Whisper's 25 MB limit.\n` +
        'Use --local (no size limit) or split the recording into shorter parts.'
      );
      if (usedPath !== audioPath) { const { unlinkSync } = await import('fs'); try { unlinkSync(usedPath); } catch {} }
      process.exit(1);
    }

    let transcriptResult;
    try {
      if (useLocal) {
        console.log(`Transcribing locally with ${localModel} (${fileSizeMB.toFixed(1)} MB)...`);
        transcriptResult = await transcribeLocal(usedPath, localModel);
      } else if (useGroq) {
        console.log(`Transcribing via Groq whisper-large-v3 (${fileSizeMB.toFixed(1)} MB)...`);
        transcriptResult = await transcribeWithGroq(usedPath);
      } else if (useGemini) {
        console.log(`Transcribing via Gemini 2.5 Flash + Groq timing (${fileSizeMB.toFixed(1)} MB)...`);
        transcriptResult = await transcribeWithGemini(usedPath);
      } else {
        console.log(`Transcribing via OpenAI Whisper API (${fileSizeMB.toFixed(1)} MB)...`);
        transcriptResult = await transcribeWithAPI(usedPath);
      }
    } catch (e) {
      console.error(`Transcription error: ${e.message}`);
      process.exit(1);
    } finally {
      // Clean up preprocessed temp file
      if (usedPath !== audioPath) {
        const { unlink } = await import('fs/promises');
        await unlink(usedPath).catch(() => {});
      }
    }
    transcript = typeof transcriptResult === 'string' ? transcriptResult : transcriptResult.text;
    transcriptSegments = typeof transcriptResult === 'string' ? [] : (transcriptResult.segments ?? []);
    transcriptWordTimes = typeof transcriptResult === 'string' ? [] : (transcriptResult.words ?? []).map(w => ({ word: w.word, start: w.start }));
    groqText = (typeof transcriptResult !== 'string' && transcriptResult.groqText) ? transcriptResult.groqText : null;

    // Whisper timed the preprocessed audio (1s silence prepended); shift back to original-audio time.
    if (usedPath !== audioPath) {
      transcriptSegments = transcriptSegments.map(s => ({
        ...s,
        start: Math.max(0, s.start - SILENCE_PREPEND_SEC),
        end: Math.max(0, s.end - SILENCE_PREPEND_SEC),
      }));
      transcriptWordTimes = transcriptWordTimes.map(w => ({
        ...w,
        start: Math.max(0, Math.round((w.start - SILENCE_PREPEND_SEC) * 100) / 100),
      }));
    }
  }

  // Remove Gemini's ayah-quotation markup before anything downstream reads the transcript.
  // Segments and word timings must be cleaned with it, or their token streams no longer
  // line up with the transcript that reference spans are computed against.
  transcript = stripAyahMarkup(transcript);
  transcriptSegments = transcriptSegments.map(s => ({ ...s, text: stripAyahMarkup(s.text ?? '') }));
  transcriptWordTimes = transcriptWordTimes
    .map(w => ({ ...w, word: stripAyahMarkup(w.word ?? '') }))
    .filter(w => w.word);

  // Step 4: Save raw Arabic transcript
  writeFileSync(path.join(outDir, 'transcript.txt'), transcript, 'utf8');
  // In --gemini mode the hybrid also produced a Groq transcript — save it for comparison.
  if (groqText) {
    writeFileSync(path.join(outDir, 'transcript_groq.txt'), groqText, 'utf8');
  }
  const wordCount = transcript.split(/\s+/).filter(Boolean).length;

  // Step 5: Send transcript to Claude for translation + reference extraction.
  // Pre-detect Quran zones algorithmically so chunks don't straddle ayah boundaries.
  const CHUNK_SIZE = 30;
  const transcriptWords = transcript.split(/\s+/).filter(Boolean);
  process.stdout.write('Pre-scanning Quran zones...');
  const quranZones = prescanForQuranZones(transcriptWords);
  console.log(` ${quranZones.length} zones detected`);

  const proseChunks = buildProseChunks(transcriptWords, quranZones, CHUNK_SIZE, transcriptSegments);
  const numberedChunks = proseChunks.map((c, i) => `[${i + 1}] ${c.text}`).join('\n');
  const chunkInstruction = `\n\nThe transcript has been divided into ${proseChunks.length} prose chunks below ` +
    `(Quranic verses are excluded and handled separately). ` +
    `Using your full understanding of the whole khutbah for context, translate each numbered chunk into natural, ` +
    `fluent English. Return these as "chunk_translations" — an array of exactly ${proseChunks.length} strings, ` +
    `one per chunk in order.\n\n${numberedChunks}`;

  let claudeRaw;
  try {
    // Use streaming so long transcripts don't hit the request timeout
    process.stdout.write('Analysing with Claude');
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
      messages: [
        {
          role: 'user',
          content: `${buildAnalysisPrompt(khutbahType)}\n\nTranscript:\n${transcript}${chunkInstruction}`,
        },
      ],
    });
    stream.on('text', () => process.stdout.write('.'));
    const message = await stream.finalMessage();
    console.log(' done');
    claudeRaw = message.content[0].text;
  } catch (e) {
    console.error(`\nClaude API error: ${e.message}`);
    process.exit(1);
  }

  // Step 6: Parse Claude's JSON response
  let analysis;
  try {
    // Strip accidental markdown fences if Claude wraps the JSON anyway
    const cleaned = claudeRaw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    analysis = JSON.parse(cleaned);
  } catch (e) {
    writeFileSync(path.join(outDir, 'claude_raw.txt'), claudeRaw, 'utf8');
    console.error(
      `Claude returned invalid JSON -- raw response saved to ${outDir}/claude_raw.txt\n` +
      `Parse error: ${e.message}`
    );
    process.exit(1);
  }

  // Step 7: Match each Quranic reference.
  // Claude identifies the surah/ayah from its Quran knowledge (primary).
  // The local algorithm independently scores the extracted text (cross-check).
  // If both agree  → high confidence.
  // If they disagree → flag for manual review (one may have erred).
  // If only algorithm matched → use it, note Claude was uncertain.
  const quranRefs = (analysis.quran_references ?? []).map(ref => {
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
  });

  if (!hadithCorpus) hadithCorpus = loadHadithCorpus();
  const claudeHadithRefs = deduplicateHadithRefs(
    (analysis.hadith_references ?? []).map(ref => {
      const match = findMatchingHadith(ref.arabic_text ?? '', hadithCorpus);
      return {
        detected_text: ref.arabic_text,
        narrator: ref.narrator ?? null,
        collection: match ? match.collection : (ref.collection ?? null),
        hadith_number: match ? match.number : null,
        link: match ? match.link : null,
        confidence: match ? match.confidence : null,
        detection_method: 'signal_phrase',
        note: match ? 'Matched against local corpus' : 'Manual verification recommended',
      };
    })
  );

  // Step 8: Scan full transcript for Quranic references missed by signal-phrase detection
  process.stdout.write('Scanning transcript for Quranic references...');
  const scanRefs = scanTranscriptForQuran(transcript, quranRefs);
  console.log(` found ${scanRefs.length} additional`);
  let allQuranRefs = [
    ...quranRefs.map(r => ({ ...r, detection_method: 'signal_phrase' })),
    ...scanRefs,
  ];

  // Step 8b: Surface ayahs the n-gram zones identified but both Claude and Jaccard scan missed.
  // This catches partial citations (imam recites ~half an ayah) where Jaccard score < 0.65.
  const zoneRefs = buildZoneRefs(quranZones, transcriptWords, allQuranRefs);
  if (zoneRefs.length) console.log(`  + ${zoneRefs.length} additional via ngram zones`);
  allQuranRefs = [...allQuranRefs, ...zoneRefs];
  // Label multi-ayah recitations with their full range so the reader renders the whole
  // passage rather than only the verse the detecting layer happened to name.
  allQuranRefs.forEach(annotateRefAyahRange);
  yieldTailToLaterRefs(allQuranRefs);

  // Step 8c: Scan for Hadith references
  process.stdout.write('Scanning transcript for Hadith references...');
  const hadithScanRefs = scanTranscriptForHadith(transcript, claudeHadithRefs, hadithCorpus);
  console.log(` found ${hadithScanRefs.length} additional`);
  const allHadithRefs = deduplicateHadithRefs([...claudeHadithRefs, ...hadithScanRefs]);

  // Step 8d: Replace corpus numbers/links with canonical sunnah.com permalinks
  // (searches sunnah.com for each matn; falls back to the corpus link on any failure).
  process.stdout.write('Resolving sunnah.com links...');
  await resolveSunnahLinksForRefs(allHadithRefs, transcript);
  console.log(` ${allHadithRefs.filter(r => r.verification === 'sunnah_search').length}/${allHadithRefs.length} verified`);

  // Step 9: Assemble final output object
  const matchedCount = allQuranRefs.filter(r => r.matched).length;
  const secondKhutbah = singleKhutbah
    ? null
    : locateSecondKhutbah(analysis.second_khutbah_start, transcript, transcriptSegments, transcriptWordTimes);
  if (singleKhutbah) console.log('✓ Single-khutbah mode: split detection skipped');
  if (secondKhutbah) {
    console.log(`✓ Second khutbah split at word ${secondKhutbah.word_index} (${secondKhutbah.via}${secondKhutbah.validated ? ', gap-validated' : ''})`);
    const didSplit = await splitChunkAtKhutbahBoundary(proseChunks, analysis.chunk_translations, secondKhutbah.word_index, transcriptWords, anthropic, 'claude-sonnet-4-6');
    if (didSplit) console.log('  ↳ split the straddling chunk into two (Khutbah 1 | Khutbah 2)');
  }

  const result = {
    share_summary: analysis.share_summary ?? '',
    summary: analysis.summary ?? '',
    chunk_translations: Array.isArray(analysis.chunk_translations) ? analysis.chunk_translations : null,
    prose_chunk_map: proseChunks.map(({ wordStart, wordEnd, proseIdx }) => ({ wordStart, wordEnd, proseIdx })),
    second_khutbah: secondKhutbah,
    quran_references: allQuranRefs,
    hadith_references: allHadithRefs,
    transcript_segments: transcriptSegments,
    transcript_words: transcriptWordTimes,
    metadata: {
      processed_at: new Date().toISOString(),
      transcription_mode: useLocal ? `local:${localModel}` : useGroq ? 'groq:whisper-large-v3' : useGemini ? 'gemini:2.5-flash' : 'openai:whisper-1',
      transcript_word_count: wordCount,
      quran_references_found: allQuranRefs.length,
      quran_references_matched: matchedCount,
      quran_references_by_scan: scanRefs.length,
      hadith_references_found: allHadithRefs.length,
      hadith_references_by_scan: hadithScanRefs.length,
    },
  };

  // Step 10: Save JSON result
  writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');

  // Step 11: Save human-readable version and annotated reader view
  writeFileSync(path.join(outDir, 'readable.txt'), buildReadableOutput(result), 'utf8');
  writeFileSync(path.join(outDir, 'reader.txt'), buildReaderView(transcript, result), 'utf8');

  // Step 12: Print clean summary
  console.log(`✓ Transcription complete -- ${wordCount} words`);
  console.log('✓ Translation complete');
  console.log(`✓ ${allQuranRefs.length} Quranic references detected (${quranRefs.length} signal-phrase + ${scanRefs.length} scan), ${matchedCount} matched`);
  console.log(`✓ ${allHadithRefs.length} Hadith references detected (${claudeHadithRefs.length} signal-phrase + ${hadithScanRefs.length} scan)`);
  console.log(`✓ Results saved to outputs/${timestamp}_${audioBasename}/  (transcript.txt, result.json, readable.txt, reader.txt)`);
}

// Only run main() when this file is executed directly (not imported)
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch(e => {
    console.error(`Unexpected error: ${e.message}`);
    process.exit(1);
  });
}

export {
  ANALYSIS_PROMPT,
  buildAnalysisPrompt,
  KHUTBAH_TYPES,
  buildReaderView,
  buildReadableOutput,
  buildProseChunks,
  locateSecondKhutbah,
  splitChunkAtKhutbahBoundary,
  prescanForQuranZones,
  buildZoneRefs,
  annotateRefAyahRange,
  yieldTailToLaterRefs,
  scanTranscriptForQuran,
  scanTranscriptForHadith,
  deduplicateHadithRefs,
  isLiturgicalFormula,
  stripAyahMarkup,
  findMatchingAyah,
  findMatchingHadith,
  loadHadithCorpus,
  resolveSunnahLinksForRefs,
  normalizeArabic,
  normalizeArabicDeep,
  getQuranNgramIndex,
  extractMatn,
  transcribeWithGroq,
  transcribeWithGroqWindowed,
  preprocessAudio,
  SILENCE_PREPEND_SEC,
  alignWordTimestamps,
  combineTimings,
  retimeUnanchoredGaps,
  buildSegmentsFromWordTimes,
};
