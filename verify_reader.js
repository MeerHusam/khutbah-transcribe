#!/usr/bin/env node
// verify_reader.js — Assert on what the reader ACTUALLY renders.
//
// Every defect this catches was shipped at least once, because the checks that existed
// looked at intermediate data (zone spans, ref labels, coverage counts) rather than at the
// blocks the site builds. Those intermediate checks passed while whole verses were
// invisible on the page. This validates the final artifact instead.
//
// Usage: node verify_reader.js outputs/<folder>          (exit 1 on any failure)

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { normalizeArabic } from './pipeline.js';
import { loadResult } from './reader_chunks.js';

const folder = process.argv[2];
if (!folder || !existsSync(folder)) {
  console.error('Usage: node verify_reader.js outputs/<folder>');
  process.exit(1);
}

const transcript = readFileSync(join(folder, 'transcript.txt'), 'utf8');
const result = JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8'));
const readerRaw = readFileSync(join(folder, 'reader.txt'), 'utf8');

const quran = JSON.parse(readFileSync('node_modules/quran-json/dist/quran.json', 'utf8'));
const ayahText = (s, a) =>
  quran.find(x => x.id === s)?.verses?.find(v => v.id === a)?.text ?? null;

// Parse reader.txt exactly as server.js does, so we test what the site consumes.
const isArabicDominant = s => {
  const total = s.replace(/\s/g, '').length;
  if (!total) return false;
  return (s.match(/[؀-ۿ]/g) || []).length / total > 0.4;
};
const blocks = readerRaw
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

const failures = [];
const warnings = [];
const fail = m => failures.push(m);
const warn = m => warnings.push(m);

// ── 1. No transcript word may be lost ────────────────────────────────────────
// Words removed from prose but never rendered in a card simply vanish from the page.
// This is how "إنه هو الغفور الرحيم" and the closing "وسلام على المرسلين" disappeared.
const words = w => normalizeArabic(w).split(/\s+/).filter(Boolean);
const tWords = words(transcript);
const renderedArabic = blocks.map(b => b.arabic).join(' ');
const renderedCounts = new Map();
for (const w of words(renderedArabic)) renderedCounts.set(w, (renderedCounts.get(w) ?? 0) + 1);

const transcriptCounts = new Map();
for (const w of tWords) transcriptCounts.set(w, (transcriptCounts.get(w) ?? 0) + 1);

// Quran cards render canonical text, which legitimately differs from the spoken words, so
// compare on a run-length basis: look for transcript runs absent from the rendered text.
const renderedJoined = ' ' + words(renderedArabic).join(' ') + ' ';
let missingRun = [];
const missingRuns = [];
for (let i = 0; i < tWords.length; i++) {
  if (!renderedJoined.includes(' ' + tWords[i] + ' ')) missingRun.push(tWords[i]);
  else if (missingRun.length) { missingRuns.push(missingRun); missingRun = []; }
}
if (missingRun.length) missingRuns.push(missingRun);
for (const run of missingRuns.filter(r => r.length >= 3)) {
  fail(`text not rendered anywhere (${run.length} words): "${run.join(' ').slice(0, 70)}"`);
}

// ── 2. No passage may render twice ───────────────────────────────────────────
// A ref left inside a prose chunk AND emitted as its own card prints the Arabic twice —
// this is what put Ibrahim 14:7 inline and again as a card below.
for (const [w, n] of transcriptCounts) {
  const seen = renderedCounts.get(w) ?? 0;
  if (w.length >= 4 && seen > n + 1) {
    warn(`word "${w}" appears ${seen}x in reader vs ${n}x in transcript (possible duplicate block)`);
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
  const served = loadResult(folder);
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

// ── 6. Blocks should not end mid-sentence ────────────────────────────────────
const proseBlocks = blocks.filter(b => !b.englishParas.some(p => /^(📖|📑|📚)/.test(p)));
// A block that ends right before a recited verse is its lead-in ("فقال جل وعلا"), which
// is meant to end there — the verse card that follows completes the sentence.
const leadsIntoVerse = b => blocks[blocks.indexOf(b) + 1]?.englishParas.some(p => /^📖/.test(p));
// Sentence ends come from the transcript's own punctuation and, in newer runs, from the
// stored sentence_ends (positions only — the text carries no mark there). Locate each
// block's closing words in the transcript, in reading order, to test the stored positions.
const storedEnds = new Set(result.sentence_ends ?? []);
const endsAtStoredSentenceEnd = (() => {
  const at = new Map();
  let cursor = 0;
  for (const b of blocks) {
    const bw = words(b.arabic);
    const tail = bw.slice(-3);
    for (let i = cursor; i + tail.length <= tWords.length; i++) {
      if (tail.every((w, k) => tWords[i + k] === w)) { at.set(b, i + tail.length); cursor = i + 1; break; }
    }
  }
  return b => storedEnds.has(at.get(b));
})();
const midSentence = proseBlocks.filter(b =>
  !/[.؟!…،:]$/.test(b.arabic.trim()) && !endsAtStoredSentenceEnd(b) && !leadsIntoVerse(b));
if (midSentence.length > proseBlocks.length * 0.25) {
  warn(`${midSentence.length}/${proseBlocks.length} prose blocks end mid-sentence`);
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log(`\nverify_reader — ${folder}`);
console.log(`  blocks rendered: ${blocks.length}   transcript words: ${tWords.length}`);
console.log(`  quran refs: ${(result.quran_references ?? []).length}   hadith refs: ${(result.hadith_references ?? []).length}`);
for (const w of warnings) console.log(`  ⚠ ${w}`);
for (const f of failures) console.log(`  ✗ ${f}`);
if (!failures.length) console.log(`  ✓ all checks passed${warnings.length ? ` (${warnings.length} warning(s))` : ''}`);
process.exit(failures.length ? 1 : 0);
