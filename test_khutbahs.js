#!/usr/bin/env node
// test_khutbahs.js — Run every khutbah in tests/khutbahs.json through the reader checks and
// compare its cards against the expected lists. A fix for one khutbah must not break another:
// run this before and after every change to the pipeline or the reader.
//
// Usage:
//   node test_khutbahs.js              check the outputs on disk
//   node test_khutbahs.js --rebuild    rebuild each reader in memory with the current code first
//                                      (tests buildReaderView changes without writing any files)
//   node test_khutbahs.js --only 2026-08-21 --warnings
//   node test_khutbahs.js --root <dir>    check copies of the output folders under <dir> instead
//                                      (e.g. a regeneration made elsewhere, before it replaces outputs/)
//
// Besides the cards, each khutbah may list `hadith_english`: per quoted hadith (slug:number),
// the narrator the card must name and words its block's English must / must not contain.

import { readFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { verifyReader } from './verify_reader.js';
import { buildReaderView, deduplicateHadithRefs, nameKeys } from './pipeline.js';

const args = process.argv.slice(2);
const rebuild = args.includes('--rebuild');
const showWarnings = args.includes('--warnings');
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const root = args.includes('--root') ? resolve(args[args.indexOf('--root') + 1]) : null;

const spec = JSON.parse(readFileSync(new URL('./tests/khutbahs.json', import.meta.url), 'utf8'));

// Multiset difference: what `want` has that `got` lacks, and the reverse.
function diff(want, got) {
  const left = [...got];
  const missing = [];
  for (const w of want) {
    const i = left.indexOf(w);
    if (i === -1) missing.push(w); else left.splice(i, 1);
  }
  return { missing, unexpected: left };
}

const hadithKey = h => {
  const m = (h.link || '').match(/sunnah\.com\/([a-z]+):([\w.]+)/);
  if (m) return `${m[1]}:${m[2]}`;
  return `${(h.collection || '?').toLowerCase().split(/\s+/).pop()}:${h.hadith_number ?? '?'}`;
};

let failed = 0, ran = 0;
for (const k of spec.khutbahs) {
  if (only && k.slug !== only) continue;
  if (root) k.folder = join(root, k.folder);
  if (!existsSync(k.folder)) { console.log(`–  ${k.slug}: folder missing (${k.folder}), skipped`); continue; }
  ran++;

  let readerRaw = null, result = null;
  if (rebuild) {
    // Mirror reanalyze.js: re-apply the hadith filters to the stored refs, then rebuild.
    const transcript = readFileSync(join(k.folder, 'transcript.txt'), 'utf8').trim();
    result = JSON.parse(readFileSync(join(k.folder, 'result.json'), 'utf8'));
    result.hadith_references = deduplicateHadithRefs(result.hadith_references ?? []);
    readerRaw = buildReaderView(transcript, result);
  }
  const v = verifyReader(k.folder, { readerRaw, result });

  const quran = [];
  for (const b of v.blocks) for (const p of b.englishParas) {
    const m = p.match(v.badgeRe);
    if (m) quran.push(`${p.startsWith('📑') ? '~' : ''}${m[2]}:${m[3]}${m[4] ? '-' + m[4] : ''}`);
  }
  const hadith = (v.result.hadith_references ?? []).map(hadithKey);
  const q = diff(k.quran, quran), h = diff(k.hadith, hadith);

  // Each quoted hadith: its card's narrator, and the English of the block it sits in.
  const english = [];
  const hadithRefs = v.result.hadith_references ?? [];
  for (const [key, want] of Object.entries(k.hadith_english ?? {})) {
    const ref = hadithRefs.find(h => hadithKey(h) === key);
    if (!ref) { english.push(`${key}: no such hadith card`); continue; }
    if (want.narrator) {
      const have = nameKeys(ref.narrator);
      if ([...nameKeys(want.narrator)].some(x => !have.has(x))) english.push(`${key}: narrator "${ref.narrator}", expected "${want.narrator}"`);
    }
    const badge = `Narrator: ${ref.narrator ?? 'unknown'}  ·  Collection: ${ref.collection ?? 'unknown'}`;
    const block = v.blocks.find(b => b.englishParas.some(p => p.startsWith('📚') && p.includes(badge)));
    if (!block) { english.push(`${key}: its badge is on no block`); continue; }
    const text = block.englishParas.filter(p => !/^(📖|📑|📚)/.test(p)).join(' ').replace(/[’‘`]/g, "'").toLowerCase();
    for (const w of want.has ?? []) if (!text.includes(w.toLowerCase())) english.push(`${key}: English lacks "${w}"`);
    for (const w of want.not ?? []) if (text.includes(w.toLowerCase())) english.push(`${key}: English has "${w}"`);
  }

  const problems = [
    ...v.failures.map(f => `check: ${f}`),
    ...english.map(e => `hadith english: ${e}`),
    ...q.missing.map(x => `quran card missing: ${x}`),
    ...q.unexpected.map(x => `quran card not expected: ${x}`),
    ...h.missing.map(x => `hadith card missing: ${x}`),
    ...h.unexpected.map(x => `hadith card not expected: ${x}`),
  ];
  if (problems.length) failed++;
  console.log(`${problems.length ? '✗' : '✓'}  ${k.slug.padEnd(18)} ${problems.length} problem(s), ${v.warnings.length} warning(s)${k.confirmed ? '' : '   [expected lists not yet confirmed]'}`);
  for (const p of problems) console.log(`     ${p}`);
  if (showWarnings) for (const w of v.warnings) console.log(`     ⚠ ${w}`);
}

console.log(`\n${ran - failed}/${ran} khutbahs pass${rebuild ? ' (readers rebuilt with current code)' : ''}`);
process.exit(failed ? 1 : 0);
