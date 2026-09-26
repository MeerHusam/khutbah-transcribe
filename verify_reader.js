#!/usr/bin/env node
// verify_reader.js — Assert on what the reader ACTUALLY renders.
//
// Every defect this catches was shipped at least once, because the checks that existed
// looked at intermediate data (zone spans, ref labels, coverage counts) rather than at the
// blocks the site builds. Those intermediate checks passed while whole verses were
// invisible on the page. This validates the final artifact instead.
//
// Usage: node verify_reader.js outputs/<folder>          (exit 1 on any failure)
// Also importable: verifyReader(folder) -> { failures, warnings, blocks, result, ... }

import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { pathToFileURL } from 'url';
import { normalizeArabic, normalizeArabicDeep } from './pipeline.js';
import { loadResult } from './reader_chunks.js';
import { checkEnglish } from './check_english.js';

const quran = JSON.parse(readFileSync(new URL('./node_modules/quran-json/dist/quran.json', import.meta.url), 'utf8'));
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
  const aHit = new Uint8Array(n), bHit = new Uint8Array(m);
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { aHit[i] = bHit[j] = 1; i++; j++; }
    else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) i++;
    else j++;
  }
  return { aHit, bHit };
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
  const { aHit, bHit } = lcsMatch(tWords, rWords);
  for (const run of runsOf(aHit, tWords)) {
    const msg = `text missing from the reader (${run.words.length} word${run.words.length > 1 ? 's' : ''} at transcript word ${run.at}): "${run.words.join(' ').slice(0, 70)}"`;
    run.words.length >= 2 ? fail(msg) : warn(msg);
  }
  for (const run of runsOf(bHit, rWords)) {
    const msg = `text shown twice (${run.words.length} word${run.words.length > 1 ? 's' : ''}): "${run.words.join(' ').slice(0, 70)}"`;
    run.words.length >= 2 ? fail(msg) : warn(msg);
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
    for (let i = 1; i < rc.length; i++) {
      const a = rc[i - 1].start_time, b = rc[i].start_time;
      if (typeof a !== 'number' || typeof b !== 'number') continue;
      if (b <= a) {
        fail(`chunk ${i} starts at ${b}s, not after chunk ${i - 1} at ${a}s — it can never be highlighted`);
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
    console.error('Usage: node verify_reader.js outputs/<folder>');
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
