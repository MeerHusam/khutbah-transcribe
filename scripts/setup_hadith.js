#!/usr/bin/env node
/**
 * One-time setup: downloads major Hadith collections as local JSON files, and each language's
 * editions (core/langs/*.js) of them and of the Quran, which core/translate.js reads instead of
 * the network. Run once, and again after adding a language:
 *   node scripts/setup_hadith.js
 *
 * Downloads to hadith_data/. Safe to re-run — skips existing files.
 */

import { mkdirSync, writeFileSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { LANGS } from '../core/languages.js';

const DATA_DIR = './hadith_data';
const BASE = 'https://cdn.jsdelivr.net/gh/fawazahmed0/hadith-api@1/editions';
const QURAN = 'https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions';

const COLLECTIONS = [
  { id: 'ara-bukhari',   name: 'Sahih al-Bukhari' },
  { id: 'ara-muslim',    name: 'Sahih Muslim' },
  { id: 'ara-abudawud',  name: 'Sunan Abu Dawud' },
  { id: 'ara-nasai',     name: "Sunan an-Nasa'i" },
  { id: 'ara-ibnmajah',  name: 'Sunan Ibn Majah' },
  { id: 'ara-tirmidhi',  name: 'Jami` at-Tirmidhi' },
];
// The same collections in each language, and the language's Quran translation (saved as quran-<edition>).
for (const L of LANGS) {
  for (const { id, name } of COLLECTIONS.filter(c => c.id.startsWith('ara-'))) {
    COLLECTIONS.push({ id: id.replace('ara', L.hadith.edition), name: `${name} (${L.name})` });
  }
  COLLECTIONS.push({ id: `quran-${L.quran.edition}`, name: `Quran, ${L.quran.name} (${L.name})`, url: `${QURAN}/${L.quran.edition}.min.json` });
}

mkdirSync(DATA_DIR, { recursive: true });

let downloaded = 0;
let skipped = 0;

for (const col of COLLECTIONS) {
  const outPath = join(DATA_DIR, `${col.id}.json`);

  if (existsSync(outPath)) {
    const kb = Math.round(statSync(outPath).size / 1024);
    console.log(`✓ ${col.name} already exists (${kb} KB) — skipping`);
    skipped++;
    continue;
  }

  const url = col.url ?? `${BASE}/${col.id}.min.json`;
  process.stdout.write(`  Downloading ${col.name}...`);

  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    console.log(` FAILED (network error: ${e.message})`);
    continue;
  }

  if (!res.ok) {
    console.log(` FAILED (HTTP ${res.status})`);
    continue;
  }

  const data = await res.json();
  writeFileSync(outPath, JSON.stringify(data));
  const kb = Math.round(statSync(outPath).size / 1024);
  console.log(` done (${kb} KB, ${data.hadiths?.length ?? data.quran?.length ?? '?'} ${data.quran ? 'ayaat' : 'hadiths'})`);
  downloaded++;
}

console.log(`\nDone. ${downloaded} downloaded, ${skipped} already present.`);
console.log('You can now run the pipeline — Hadith scan will use these files.');
