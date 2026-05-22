#!/usr/bin/env node
/**
 * Side-by-side comparison: the CURRENT Quran-detection pipeline
 * (prescanForQuranZones + scanTranscriptForQuran + buildZoneRefs) vs the
 * `quran-detector` Python library (via quran_detect.py).
 *
 * Read-only / prototype — does NOT modify the production pipeline.
 *
 * Usage:  node compare_quran.js outputs/<folder>
 */
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import {
  prescanForQuranZones,
  scanTranscriptForQuran,
  buildZoneRefs,
} from './pipeline.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Arabic surah name -> id, from the same corpus the pipeline uses.
const quranData = require('quran-json/dist/quran.json');
const arNameToId = new Map();
for (const s of quranData) {
  arNameToId.set(s.name, s.id);                       // e.g. "البقرة"
  arNameToId.set((s.name || '').replace(/^ال/, ''), s.id);
}

const folder = process.argv[2];
if (!folder) { console.error('Usage: node compare_quran.js outputs/<folder>'); process.exit(1); }
const dir = path.resolve(__dirname, folder);
const transcript = readFileSync(path.join(dir, 'transcript.txt'), 'utf8').trim();
const words = transcript.split(/\s+/).filter(Boolean);

const trunc = (s, n = 60) => { const t = (s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };

// ---- CURRENT pipeline (algorithmic only — no Claude) ------------------------
const zones = prescanForQuranZones(words);
const scanRefs = scanTranscriptForQuran(transcript, []);
const zoneRefs = buildZoneRefs(zones, words, []);

console.log('\n========== CURRENT PIPELINE (algorithmic) ==========\n');

console.log(`-- prescanForQuranZones: ${zones.length} zones (drive prose-chunk EXCLUSION) --`);
for (const z of zones) {
  const ayahs = [`${z.surah_id}:${z.ayah_id}`, ...(z.extra_ayahs ?? []).map(e => `${e.surah_id}:${e.ayah_id}`)];
  console.log(`  words[${z.start}-${z.end}]  ${z.surah_name} ${ayahs.join(',')}  «${trunc(words.slice(z.start, z.end).join(' '))}»`);
}

console.log(`\n-- scanTranscriptForQuran (Jaccard >=0.65): ${scanRefs.length} refs --`);
for (const r of scanRefs) console.log(`  ${r.surah_number}:${r.ayah_number}  conf=${r.confidence}  «${trunc(r.detected_text)}»`);

console.log(`\n-- buildZoneRefs (n-gram fallback): ${zoneRefs.length} refs --`);
for (const r of zoneRefs) console.log(`  ${r.surah_number}:${r.ayah_number}  «${trunc(r.detected_text)}»`);

// ---- quran-detector library -------------------------------------------------
const py = path.join(__dirname, '.venv', 'bin', 'python');
let detected;
try {
  const raw = execFileSync(py, [path.join(__dirname, 'quran_detect.py'), path.join(dir, 'transcript.txt')], { encoding: 'utf8' });
  detected = JSON.parse(raw);
} catch (e) {
  console.error('\nquran_detect.py failed:', e.message);
  process.exit(1);
}

console.log('\n========== quran-detector LIBRARY ==========\n');
console.log(`-- detect(): ${detected.length} matches (start_word/end_word = library tokenization) --`);
for (const m of detected) {
  const id = arNameToId.get(m.surah_name_ar) ?? '?';
  const aya = m.aya_start === m.aya_end ? `${m.aya_start}` : `${m.aya_start}-${m.aya_end}`;
  // Slice OUR whitespace tokenization at the library's indices to check alignment.
  const ourSlice = words.slice(m.start_word, m.end_word + 1).join(' ');
  const nErr = (m.errors || []).reduce((a, e) => a + (Array.isArray(e) ? e.length : 0), 0);
  console.log(`  ${id}:${aya}  words[${m.start_word}-${m.end_word}] errs=${nErr}`);
  console.log(`      verse:  «${trunc(m.verses.join(' | '))}»`);
  console.log(`      ourSlice:«${trunc(ourSlice)}»`);
}

// ---- quick delta ------------------------------------------------------------
const cur = new Set([
  ...zones.flatMap(z => [`${z.surah_id}:${z.ayah_id}`, ...(z.extra_ayahs ?? []).map(e => `${e.surah_id}:${e.ayah_id}`)]),
  ...scanRefs.map(r => `${r.surah_number}:${r.ayah_number}`),
  ...zoneRefs.map(r => `${r.surah_number}:${r.ayah_number}`),
]);
const det = new Set(detected.map(m => `${arNameToId.get(m.surah_name_ar) ?? '?'}:${m.aya_start}`));
console.log('\n========== DELTA (surah:ayah) ==========');
console.log('current only :', [...cur].filter(x => !det.has(x)).join(', ') || '(none)');
console.log('detector only:', [...det].filter(x => !cur.has(x)).join(', ') || '(none)');
console.log('both         :', [...cur].filter(x => det.has(x)).join(', ') || '(none)');
