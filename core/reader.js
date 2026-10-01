// The reader (split out of pipeline.js): reader.txt, the annotated bilingual view the site
// renders, and readable.txt.

import { createRequire } from 'module';
import { quranData, normalizeArabicDeep, normalizeArabic, prescanForQuranZones, MIN_ZONE_WORDS } from './arabic.js';

const require = createRequire(import.meta.url);

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

// The English of a verse quoted inside the imam's prose should be the published translation,
// the same one the verse cards show (Sahih International), and a hadith's the sunnah.com
// one, not Claude's rendering of them. Matching Claude's English against the published
// English by word overlap put the wrong clause in (Ashura for Arafah in Muslim 1162a) and
// clauses the imam never said (Laylat al-Qadr in Nasa'i 2202), so the swap is now planned
// ahead by quote_swaps.js: it stores on each ref the exact text of Claude's rendering and
// the exact published excerpt that says the same thing (`english_swap`), or why no
// excerpt does. Rendering only replaces one exact string with the other.
let _quranEn = null;
function publishedVerseEnglish(ref) {
  try { _quranEn ??= require('quran-json/dist/quran_en.json'); } catch { return ''; }
  const verses = _quranEn[(ref.surah_number ?? 0) - 1]?.verses ?? [];
  const end = ref.ayah_number_end ?? ref.ayah_number;
  return verses.filter(v => v.id >= ref.ayah_number && v.id <= end).map(v => v.translation).join(' ');
}

// Put each ref's planned published excerpt in place of Claude's rendering: “excerpt”, with
// Claude's own quote marks around it dropped. A rendering that is not found exactly once
// stays as it is.
const QUOTE_MARKS = /^["'\u2018\u2019\u201C\u201D]$/;
function applyQuoteSwaps(english, refs) {
  if (!english) return english;
  let text = english;
  for (const ref of refs) {
    const sw = ref.english_swap;
    if (sw?.status !== 'published' || !sw.ours || !sw.published) continue;
    const at = text.indexOf(sw.ours);
    if (at < 0 || text.indexOf(sw.ours, at + 1) >= 0) continue;
    let s = at, e = at + sw.ours.length;
    if (s > 0 && e < text.length && QUOTE_MARKS.test(text[s - 1]) && QUOTE_MARKS.test(text[e])) { s--; e++; }
    const body = sw.published.trim().replace(/^["'\u2018\u201C]+|["'\u2019\u201D]+$/g, '').replace(/[,;:]+$/, '');
    // A quote that closed its sentence ("…shall be safe.") must still close it.
    const stop = /[.!?]$/.test(sw.ours.trim()) && !/[.!?]$/.test(body) && !/^\s*[.!?]/.test(text.slice(e)) ? sw.ours.trim().slice(-1) : '';
    text = text.slice(0, s) + '\u201C' + body + '\u201D' + stop + text.slice(e);
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
// `opts.quotes`: when an array, every block that quotes a verse or hadith inside its prose is
// pushed to it ({ arabic, english, quranRefs, hadithRefs }) — quote_swaps.js plans the
// published-translation swaps from these. `opts.untranslated`: the text for words that were
// never sent for translation (another language's reader, e.g. Urdu, passes its own).
function buildReaderView(transcript, result, opts = {}) {
  const { chunk_translations, quran_references, hadith_references } = result;

  const origWords = transcript.split(/\s+/).filter(Boolean);
  const normWords = normalizeArabic(transcript).split(/\s+/).filter(Boolean);
  const normTranscriptStr = normWords.join(' ');

  // Locate each reference in the transcript by matching its first 5 words
  const allRefs = [
    ...quran_references.map((r, i) => ({ ...r, refType: 'quran', refIndex: i })),
    ...hadith_references.map((r, i) => ({ ...r, refType: 'hadith', refIndex: i })),
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
      english = opts.untranslated ?? '(Not translated.)';
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

    if (english) english = english.replace(/,\s*:/g, ':'); // Claude's ",:" artefact
    if (opts.quotes && english && (seg.quranRefs?.length || seg.hadithRefs?.length)) {
      opts.quotes.push({ arabic, english, quranRefs: seg.quranRefs ?? [], hadithRefs: seg.hadithRefs ?? [] });
    }
    english = applyQuoteSwaps(english, [...(seg.quranRefs ?? []), ...(seg.hadithRefs ?? [])]);
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

export {
  buildReadableOutput,
  buildReaderView,
  publishedVerseEnglish,
  applyQuoteSwaps,
};
