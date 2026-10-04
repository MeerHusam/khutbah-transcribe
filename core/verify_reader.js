#!/usr/bin/env node
// verify_reader.js — Assert on what the reader ACTUALLY renders.
//
// Every defect this catches was shipped at least once, because the checks that existed
// looked at intermediate data (zone spans, ref labels, coverage counts) rather than at the
// blocks the site builds. Those intermediate checks passed while whole verses were
// invisible on the page. This validates the final artifact instead.
//
// Usage: node core/verify_reader.js outputs/<folder>          (exit 1 on any failure)
// Also importable: verifyReader(folder) -> { failures, warnings, blocks, result, ... }

import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { normalizeArabic, normalizeArabicDeep, splitsPhrase } from './arabic.js';
import { loadResult } from './reader_chunks.js';
import { checkEnglish } from './check_english.js';
import '../public/recited.js';

const { recitedSpans } = globalThis.KTRecited;

const quran = JSON.parse(readFileSync(new URL('../node_modules/quran-json/dist/quran.json', import.meta.url), 'utf8'));
const ayahText = (s, a) =>
  quran.find(x => x.id === s)?.verses?.find(v => v.id === a)?.text ?? null;

// Parse reader.txt exactly as server.js does, so we test what the site consumes.
const isArabicDominant = s => {
  const total = s.replace(/\s/g, '').length;
  if (!total) return false;
  return (s.match(/[؀-ۿ]/g) || []).length / total > 0.4;
};
export function parseReaderBlocks(readerRaw) {
  return readerRaw
    .split(/─{20,}/)
    .map(b => b.replace(/^ANNOTATED READER VIEW\s*=+\s*/i, '').trim())
    .filter(Boolean)
    .map(b => {
      const paras = b.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
      return {
        arabic: paras.filter(isArabicDominant).join(' '),
        englishParas: paras.filter(p => !isArabicDominant(p)),
      };
    })
    .filter(b => b.arabic && b.englishParas.length); // server drops blocks missing either
}

const words = w => normalizeArabic(w).split(/\s+/).filter(Boolean);
const deepWords = w => normalizeArabicDeep(w).split(/\s+/).filter(Boolean);

// Longest common subsequence of two word lists; returns which positions of each side are
// matched. Used to check the reader renders every transcript word exactly once, in order.
function lcsMatch(a, b) {
  const n = a.length, m = b.length, W = m + 1;
  const dp = new Int32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = a[i] === b[j] ? dp[(i + 1) * W + j + 1] + 1
        : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }
  const aHit = new Uint8Array(n), bHit = new Uint8Array(m), aTo = new Int32Array(n).fill(-1);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { aHit[i] = bHit[j] = 1; aTo[i] = j; i++; j++; }
    else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) i++;
    else j++;
  }
  return { aHit, bHit, aTo };
}
const runsOf = (hits, list) => {
  const runs = [];
  let cur = null;
  for (let k = 0; k < hits.length; k++) {
    if (!hits[k]) { if (!cur) { cur = { at: k, words: [] }; runs.push(cur); } cur.words.push(list[k]); }
    else cur = null;
  }
  return runs;
};

// Words are compared loosely against canonical verse text: the transcript spells
// "الصلاة" where the mushaf has "الصلوة", and so on.
const editDistance1 = (x, y) => {
  if (Math.abs(x.length - y.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (x.length > y.length) i++; else if (y.length > x.length) j++; else { i++; j++; }
  }
  return edits + (x.length - i) + (y.length - j) <= 1;
};
const inVerse = (w, set) => set.has(w) || (w.length >= 4 && [...set].some(v => editDistance1(w, v)));
// The imam's own words that introduce a verse; a card may legitimately begin with them.
const LEAD_IN = new Set(['قال', 'وقال', 'يقول', 'ويقول', 'تعالى', 'وتعالى', 'سبحانه', 'جل', 'وعلا', 'عز', 'وجل',
  'الله', 'المولى', 'ربنا', 'في', 'كتابه', 'الكريم', 'كما', 'قوله', 'لقوله', 'وقوله', 'فقال', 'اذ', 'حيث']);

// `readerRaw` checks a reader built in memory (test_khutbahs.js --rebuild) instead of reader.txt.
export function verifyReader(folder, { readerRaw: readerOverride = null, result: resultOverride = null } = {}) {
  const transcript = readFileSync(join(folder, 'transcript.txt'), 'utf8');
  const result = resultOverride ?? JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8'));
  const readerRaw = readerOverride ?? readFileSync(join(folder, 'reader.txt'), 'utf8');
  const blocks = parseReaderBlocks(readerRaw);

  const failures = [];
  const warnings = [];
  const fail = m => failures.push(m);
  const warn = m => warnings.push(m);

  // ── 1. Every transcript word renders exactly once, in order ──────────────────
  // Checked by position, not by text: the old check looked for each word anywhere on the
  // page, so when Al Imran 3:31 was recited twice and the second recitation vanished, the
  // first card's copy of the same words hid the loss. An LCS alignment of the transcript
  // against the reader's Arabic, in order, shows both lost words and doubled words.
  const tWords = words(transcript);
  const rWords = words(blocks.map(b => b.arabic).join(' '));
  const { aHit, bHit, aTo } = lcsMatch(tWords, rWords);
  for (const run of runsOf(aHit, tWords)) {
    const msg = `text missing from the reader (${run.words.length} word${run.words.length > 1 ? 's' : ''} at transcript word ${run.at}): "${run.words.join(' ').slice(0, 70)}"`;
    run.words.length >= 2 ? fail(msg) : warn(msg);
  }
  for (const run of runsOf(bHit, rWords)) {
    const msg = `text shown twice (${run.words.length} word${run.words.length > 1 ? 's' : ''}): "${run.words.join(' ').slice(0, 70)}"`;
    run.words.length >= 2 ? fail(msg) : warn(msg);
  }

  // ── 2a. No "no match found" Quran card (it hid a hadith qudsi's card, Madinah 25 Sep) ──
  if (/Quranic reference — no match found/.test(readerRaw)) fail('a "Quranic reference — no match found" card is shown');

  // ── 2b. No block starts with the previous hadith's attribution ─────────────────
  // "متفق عليه." / "رواه البخاري." closes the hadith before it (buildProseChunks keeps it there
  // since 2 Oct 2026); a block that opens with one shows the source under the wrong hadith.
  for (const b of blocks) {
    const ws = b.arabic.split(/\s+/);
    if (/^(?:متفق عليه|(?:رواه|اخرجه|خرجه) )/.test(normalizeArabic(ws.slice(0, 3).join(' '))) && ws.slice(0, 6).some(w => /[.؟!…]$/.test(w))) {
      fail(`a block starts with the previous hadith's attribution: "${ws.slice(0, 6).join(' ')}"`);
    }
  }

  // ── 2c. No word or two of a verse left outside its card ───────────────────────
  // "ويكفر" and "يا" stood as blocks of their own beside the verse cards, each with a full
  // sentence of translation (2 Oct 2026 Madinah: the verse match missed a leading و and the
  // split يا أيها). A lead-in such as "قال تعالى:" is a short block beside a verse too, and is fine.
  const isVerse = b => b?.englishParas.some(p => /^📖/.test(p));
  blocks.forEach((b, k) => {
    const ws = b.arabic.split(/\s+/).filter(Boolean);
    if (isVerse(b) || ws.length > 2 || !(isVerse(blocks[k - 1]) || isVerse(blocks[k + 1]))) return;
    if (/[:：]$/.test(b.arabic.trim()) || /^(?:ف|و)?(?:قال|يقول|تعالي|تعالى|سبحانه|وجل)/.test(normalizeArabic(ws[0]))) return;
    // The fragments carried a whole sentence of English ("and He will expiate his sins and grant
    // him a great reward"); a short block that is really short ("نعم. نعم", Arafah) does not.
    const english = b.englishParas.filter(p => !/^(📖|📑|📚|❝)/.test(p)).join(' ').split(/\s+/).filter(Boolean).length;
    if (english <= 6) return;
    fail(`a ${ws.length}-word block beside a verse card, likely a verse word the match missed: "${b.arabic}"`);
  });

  // ── 2f. A prose block's English translates only words shown in prose ───────────
  // The reader gives the words at a card's edge to the card, but the chunk Claude translated
  // still had them, so its English repeated them beside the card: "O people of insight." after
  // 59:2, "And a reminder for the believers." after 11:120 (2 Oct 2026 Makkah; the verse match
  // stopped short of the mushaf's spellings). Each chunk's words (prose_chunk_map, transcript
  // word indexes) are followed through the alignment above to the block that shows them.
  const blockOfR = blocks.flatMap((b, k) => words(b.arabic).map(() => k));
  const tOfRaw = [];
  for (const w of transcript.split(/\s+/).filter(Boolean)) tOfRaw.push(tOfRaw.length ? tOfRaw.at(-1) + words(w).length : words(w).length);
  const tIndex = i => (i ? tOfRaw[i - 1] : 0); // transcript word i -> first tWords index
  for (const c of result.prose_chunk_map ?? []) {
    const inCard = [];
    for (let i = c.wordStart; i < c.wordEnd; i++) {
      const r = aTo[tIndex(i)];
      if (r >= 0 && isVerse(blocks[blockOfR[r]])) inCard.push(tWords[tIndex(i)]);
    }
    if (inCard.length >= 2) fail(`the English of chunk ${c.proseIdx} translates ${inCard.length} words shown in a verse card: "${inCard.join(' ').slice(0, 60)}"`);
  }

  // ── 2d. No block break inside "صلى الله عليه وسلم" or a like phrase ───────────────
  // A block ended "يقول النبي صلى" and the next began "الله عليه وسلم:", so its English began
  // "وسلم said:" (2 Oct 2026 Madinah; a timing segment ended there).
  blocks.forEach((b, k) => {
    if (!k) return;
    const prev = blocks[k - 1].arabic.split(/\s+/).filter(Boolean).slice(-4), next = b.arabic.split(/\s+/).filter(Boolean).slice(0, 4);
    if (splitsPhrase([...prev, ...next], prev.length)) fail(`a block break splits a phrase: "${prev.join(' ')} | ${next.join(' ')}"`);
  });

  // ── 2e. A verse card marks only what the imam recited ─────────────────────────
  // 65:4's recited part was taken from a lone "من" 18 words before what he said, so the card,
  // its translation and the voices gave nearly the whole verse (2 Oct 2026 Madinah;
  // public/recited.js now drops such strays). A stored excerpt serves only the words it was
  // made for: after a change to the alignment, core/verse_excerpts.js must run again.
  for (const b of blocks) {
    const badge = b.englishParas.map(p => p.match(/^📖\s+.+?\s+(\d+):(\d+)(?:-(\d+))?\s+—/)).find(Boolean);
    if (!badge) continue;
    const s = +badge[1], a = +badge[2], e = +(badge[3] ?? badge[2]);
    const texts = [];
    for (let n = a; n <= e && texts.length < 25; n++) texts.push(ayahText(s, n));
    if (texts.some(t => !t)) continue;
    const spans = recitedSpans(b.arabic, texts);
    const ref = `${s}:${a}${e > a ? `-${e}` : ''}`;
    const said = words(b.arabic).length;
    const marked = spans.reduce((n, sp) => n + (sp ? sp[1] - sp[0] + 1 : 0), 0);
    if (marked > 1.5 * said + 4) fail(`${ref} card marks ${marked} words as recited, but the imam said ${said}: "${b.arabic.slice(0, 50)}"`);
    const ex = (result.verse_excerpts ?? []).find(x => x.arabic === b.arabic && x.surah === s && x.ayah === a);
    for (const [n, v] of Object.entries(ex?.verses ?? {})) {
      if (!v.whole && String(v.span) !== String(spans[+n - a])) fail(`${s}:${n} excerpt was made for words ${v.span}, the card marks ${spans[+n - a]}: run core/verse_excerpts.js`);
    }
  }

  // ── 3. No block may show two translations of the same thing ──────────────────
  // The hadith cards briefly rendered Claude's paraphrase and the published translation
  // stacked on top of each other.
  const wordsOf = s => s.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);
  for (const b of blocks) {
    const prose = b.englishParas.filter(p => !/^(📖|📑|📚|❝)/.test(p));
    const fetched = b.englishParas.filter(p => /^❝/.test(p));
    if (!prose.length || !fetched.length) continue;
    const proseWords = wordsOf(prose.join(' '));
    const a = new Set(proseWords);
    const bb = wordsOf(fetched.join(' '));
    if (!bb.length) continue;
    const overlap = bb.filter(w => a.has(w)).length / bb.length;
    // Only a duplicate if the prose says the same thing AND little else. A block where the
    // hadith sits inside a longer passage legitimately translates the whole passage, and the
    // published translation is then additional detail rather than a repetition.
    if (overlap > 0.6 && proseWords.length < bb.length * 1.8) {
      fail(`duplicate translation in one block (${Math.round(overlap * 100)}% overlap): "${fetched[0].slice(2, 60)}..."`);
    }
  }

  // ── 4. Every Quran badge must name the verses it displays ────────────────────
  // A short ayah that could not be anchored used to claim its whole zone, which showed
  // Al-Baqarah 2:201 under the citation As-Saffat 37:181.
  // 📖 = this block IS the recitation; 📑 = the block cites a verse quoted inside its prose.
  const badgeRe = /^(?:📖|📑)\s+(.+?)\s+(\d+):(\d+)(?:-(\d+))?\s+—\s+https:\/\/quran\.com\/(\d+)\/(\d+)/;
  for (const b of blocks) {
    for (const p of b.englishParas) {
      const m = p.match(badgeRe);
      if (!m) continue;
      const [, , surah, first, last, linkS, linkA] = m;
      if (+surah !== +linkS || +first !== +linkA) {
        fail(`badge label ${surah}:${first} disagrees with its link ${linkS}/${linkA}`);
      }
      const cited = [];
      for (let a = +first; a <= +(last ?? first); a++) {
        const t = ayahText(+surah, a);
        if (t) cited.push(...words(t));
      }
      if (!cited.length) { fail(`badge cites ${surah}:${first} which is not in the corpus`); continue; }
    }
  }

  // ── 4b. A verse card's text must stop where the verse stops ──────────────────
  // Al-Anfal 8:27's card ended with "واعلموا أن", the opening of 8:28, so 8:28's card
  // began two words late and its bolding implied the imam skipped them. Trailing words
  // that are not in the cited verses mean the card boundary is off.
  for (const b of blocks) {
    const card = b.englishParas.map(p => p.match(badgeRe)).find(m => m && /^📖/.test(m.input));
    if (!card) continue;
    const [, , surah, first, last] = card;
    const cited = new Set();
    for (let a = +first; a <= +(last ?? first); a++) for (const w of deepWords(ayahText(+surah, a) ?? '')) cited.add(w);
    if (!cited.size) continue;
    const bw = deepWords(b.arabic);
    let tail = 0;
    while (tail < bw.length && !inVerse(bw[bw.length - 1 - tail], cited)) tail++;
    if (tail >= 2 && tail < bw.length) {
      warn(`card ${surah}:${first}${last ? '-' + last : ''} ends with ${tail} words outside the verse: "${words(b.arabic).slice(-tail).join(' ')}"`);
    }
    let head = 0;
    while (head < bw.length && !inVerse(bw[head], cited)) head++;
    const nonLeadIn = bw.slice(0, head).filter(w => !LEAD_IN.has(w)).length;
    if (nonLeadIn >= 3 && head < bw.length) {
      warn(`card ${surah}:${first}${last ? '-' + last : ''} starts with ${head} words outside the verse: "${words(b.arabic).slice(0, head).join(' ')}"`);
    }
  }

  // ── 5. Every detected reference must reach the page ──────────────────────────
  const badgeKeys = new Set();
  for (const b of blocks) {
    for (const p of b.englishParas) {
      const m = p.match(badgeRe);
      if (m) for (let a = +m[3]; a <= +(m[4] ?? m[3]); a++) badgeKeys.add(`${m[2]}:${a}`);
    }
  }
  // A reference's own text must actually belong to the verses it cites. Checking the
  // reference (not the block) avoids flagging a partial recitation — the imam often recites
  // only part of a verse — while still catching a genuine mislabel, which is how
  // Al-Baqarah 2:201 came to be displayed under the citation As-Saffat 37:181.
  for (const q of result.quran_references ?? []) {
    if (!q.matched || !q.detected_text) continue;
    const cited = [];
    for (let a = q.ayah_number; a <= (q.ayah_number_end ?? q.ayah_number); a++) {
      const t = ayahText(q.surah_number, a);
      if (t) cited.push(...words(t));
    }
    if (!cited.length) continue;
    const citedSet = new Set(cited);
    const detected = words(q.detected_text);
    const belong = detected.filter(w => citedSet.has(w)).length / Math.max(detected.length, 1);
    if (belong < 0.5) {
      fail(`ref labelled ${q.surah_number}:${q.ayah_number} but only ${Math.round(belong * 100)}% of its text is in that verse — "${q.detected_text.slice(0, 55)}"`);
    }
  }

  for (const q of result.quran_references ?? []) {
    if (!q.matched) continue;
    const covered = Array.from({ length: (q.ayah_number_end ?? q.ayah_number) - q.ayah_number + 1 },
      (_, i) => `${q.surah_number}:${q.ayah_number + i}`);
    if (!covered.some(k => badgeKeys.has(k))) {
      warn(`ref ${q.surah_number}:${q.ayah_number} is in result.json but renders no badge`);
    }
  }
  const hadithBadges = blocks.reduce((n, b) => n + b.englishParas.filter(p => /^📚/.test(p)).length, 0);
  if (hadithBadges !== (result.hadith_references ?? []).length) {
    warn(`${(result.hadith_references ?? []).length} hadith refs but ${hadithBadges} badges rendered`);
  }
  // A hadith from a collection sunnah.com has, but no link: its search found nothing (Madinah 25 Sep,
  // Tirmidhi's "bricks of gold and silver", the imam's wording differs) or sunnah.com was unreachable.
  // A warning: it can be a hadith sunnah.com doesn't carry, so check it by hand.
  for (const h of result.hadith_references ?? []) {
    if (!h.link && /bukhari|muslim|tirmidhi|abu ?dawud|nasa|ibn ?majah|muwatta|malik|ahmad/i.test(h.collection ?? '')) {
      warn(`hadith card without a sunnah.com link (${h.collection}): "${(h.detected_text ?? '').slice(0, 50)}"`);
    }
    // Only from the local copy (sunnah.com unreachable or its search found nothing): its numbers
    // agree with sunnah.com's for most collections but not every Muslim hadith, so check it.
    if (h.link && h.verification !== 'sunnah_search') {
      warn(`hadith link not confirmed on sunnah.com, from the local copy (${h.link}): "${(h.detected_text ?? '').slice(0, 40)}"`);
    }
  }

  // ── 5a. Every hadith card must be confirmed by sunnah.com ─────────────────────
  // A card that sunnah.com's search did not confirm is a guess from the local corpus, and
  // those guesses put hadith badges on the imam's own sentences: "الاحتفال بمولد النبي ﷺ"
  // matched a corpus fragment on nothing but "كان النبي صلى الله عليه وسلم".
  // A hadith Claude found because the imam introduced it ("قال رسول الله ﷺ") is kept even
  // when sunnah.com has no page for it (much of Musnad Ahmad): it is a real quotation that
  // just lacks a link. Only the corpus scan's unconfirmed guesses fail.
  for (const h of result.hadith_references ?? []) {
    if (h.verification === 'sunnah_search') continue;
    const tag = [h.collection, h.hadith_number].filter(Boolean).join(' ') || 'hadith';
    const msg = `hadith card not confirmed by sunnah.com (${tag}, found by ${h.detection_method ?? '?'}): "${(h.detected_text ?? '').slice(0, 60)}"`;
    h.detection_method === 'signal_phrase' ? warn(msg) : fail(msg);
  }

  // ── 5b. An inline (📑) verse must be locatable inside its block's Arabic ──────
  // The web reader highlights an inline verse by finding the ref's detected words as a
  // contiguous run in the block and wrapping just those words. If the run is not there the
  // highlight silently no-ops and the verse reads as ordinary prose — which is exactly how
  // Ibrahim 14:7 shipped unmarked.
  for (const b of blocks) {
    const blockWords = words(b.arabic);
    const joined = ' ' + blockWords.join(' ') + ' ';
    for (const p of b.englishParas) {
      if (!p.trim().startsWith('📑')) continue;
      const m = p.match(badgeRe);
      if (!m) continue;
      const key = `${m[2]}:${m[3]}`;
      const cands = (result.quran_references ?? []).filter(
        q => `${q.surah_number}:${q.ayah_number}` === key && q.detected_text);
      if (!cands.length) { fail(`inline badge ${key} has no ref in result.json to highlight`); continue; }
      if (!cands.some(q => joined.includes(' ' + words(q.detected_text).join(' ') + ' '))) {
        fail(`inline badge ${key}: detected text is not a contiguous run in its block — the reader cannot mark it`);
      }
    }
  }

  // ── 5c. Chunk start times must be strictly increasing ────────────────────────
  // The player highlights the last chunk whose start_time is <= the current time, so two
  // chunks on the same value make the earlier one unreachable — it is never highlighted and
  // the reader appears to skip a block. Built through the same module the server uses, so
  // this tests the timings the site actually serves.
  try {
    const served = loadResult(folder, readerOverride);
    const rc = served.reader_chunks ?? [];
    // An Urdu reader (translate_urdu.js) must give every block its Urdu.
    if (existsSync(join(folder, 'reader_ur.txt'))) {
      const without = rc.map((c, i) => (c.urdu ? null : i)).filter(i => i !== null);
      if (without.length) warn(`${without.length} block(s) have no Urdu: ${without.slice(0, 10).join(', ')}`);
    }
    for (let i = 1; i < rc.length; i++) {
      const a = rc[i - 1].start_time, b = rc[i].start_time;
      if (typeof a !== 'number' || typeof b !== 'number') continue;
      if (b <= a) {
        fail(`chunk ${i} starts at ${b}s, not after chunk ${i - 1} at ${a}s — it can never be highlighted`);
      }
    }
    // The "Second Khutbah" divider must sit at the split. The 25 Sep Makkah khutbah opens
    // both khutbahs with "الحمد لله. الحمد لله", and the divider was drawn above block 0.
    const sk = served.second_khutbah;
    if (sk && typeof sk.time === 'number' && rc.length) {
      const at = rc.findIndex(c => c.second_khutbah_start);
      if (at < 0) warn(`second khutbah detected at ${sk.time}s but no block carries the divider`);
      else if (typeof rc[at].start_time === 'number' && Math.abs(rc[at].start_time - sk.time) > 30) {
        fail(`"Second Khutbah" divider is on block ${at} at ${rc[at].start_time}s, but the split is at ${sk.time}s`);
      }
    }
  } catch (e) {
    warn(`could not build reader chunks to check timings: ${e.message}`);
  }

  // ── 5d. No word may be timed alone in the middle of a silence ────────────────
  // The first word of the 21 Aug second khutbah was placed 13 s into the sitting pause,
  // 15 s before the next word, so the highlight started while the imam was still seated.
  const tw = result.transcript_words ?? [];
  for (let i = 1; i < tw.length - 1; i++) {
    const before = tw[i].start - tw[i - 1].start, after = tw[i + 1].start - tw[i].start;
    if (before > 5 && after > 5) {
      warn(`word "${tw[i].word}" timed alone at ${tw[i].start.toFixed(1)}s (${before.toFixed(0)}s after the previous word, ${after.toFixed(0)}s before the next)`);
    }
  }

  // ── 5e. Swapped-in published translations must say what the imam said ──────
  // Wrong clause (Ashura for Arafah), clauses he never said (Laylat al-Qadr), words he said
  // dropped ("and remembrance of Allah"), framing doubled ("The Prophet, “The Messenger of
  // Allah … said”"). See check_english.js.
  const english = checkEnglish(blocks, result);
  for (const f of english.failures) fail(f);
  for (const w of english.warnings) warn(w);

  // ── 6. Blocks should not end mid-sentence ────────────────────────────────────
  const proseBlocks = blocks.filter(b => !b.englishParas.some(p => /^(📖|📑|📚)/.test(p)));
  const midSentence = proseBlocks.filter(b => !/[.؟!…،:]$/.test(b.arabic.trim()));
  if (midSentence.length > proseBlocks.length * 0.25) {
    warn(`${midSentence.length}/${proseBlocks.length} prose blocks end mid-sentence`);
  }

  return { failures, warnings, blocks, result, transcriptWords: tWords.length, badgeRe, swaps: english.swaps };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  const folder = process.argv[2];
  if (!folder || !existsSync(folder)) {
    console.error('Usage: node core/verify_reader.js outputs/<folder>');
    process.exit(1);
  }
  const { failures, warnings, blocks, result, transcriptWords } = verifyReader(folder);
  console.log(`\nverify_reader — ${folder}`);
  console.log(`  blocks rendered: ${blocks.length}   transcript words: ${transcriptWords}`);
  console.log(`  quran refs: ${(result.quran_references ?? []).length}   hadith refs: ${(result.hadith_references ?? []).length}`);
  for (const w of warnings) console.log(`  ⚠ ${w}`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  if (!failures.length) console.log(`  ✓ all checks passed${warnings.length ? ` (${warnings.length} warning(s))` : ''}`);
  process.exit(failures.length ? 1 : 0);
}
