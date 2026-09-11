#!/usr/bin/env node
// reanalyze.js — Rebuild reader.txt from existing result.json + transcript.txt
// using the improved canonical-span alignment. No API calls needed.
//
// Usage: node reanalyze.js outputs/<folder>

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  prescanForQuranZones,
  buildZoneRefs,
  buildProseChunks,
  buildReaderView,
  scanTranscriptForQuran,
  findMatchingAyah,
  deduplicateHadithRefs,
} from './pipeline.js';

const folder = process.argv[2];
if (!folder || !existsSync(folder)) {
  console.error('Usage: node reanalyze.js outputs/<folder>');
  process.exit(1);
}

const resultPath = join(folder, 'result.json');
const transcriptPath = join(folder, 'transcript.txt');
if (!existsSync(resultPath) || !existsSync(transcriptPath)) {
  console.error('Missing result.json or transcript.txt in', folder);
  process.exit(1);
}

const result = JSON.parse(readFileSync(resultPath, 'utf8'));
const transcript = readFileSync(transcriptPath, 'utf8').trim();
const transcriptWords = transcript.split(/\s+/).filter(Boolean);
const segments = result.transcript_segments || [];

console.log(`Transcript: ${transcriptWords.length} words`);

// Step 1: Re-run prescan with improved alignment
console.log('Pre-scanning Quran zones with canonical-span alignment...');
const quranZones = prescanForQuranZones(transcriptWords);
console.log(`  ${quranZones.length} zones detected`);

// Step 2: Rebuild prose chunks
const CHUNK_SIZE = 30;
const proseChunks = buildProseChunks(transcriptWords, quranZones, CHUNK_SIZE, segments);
console.log(`  ${proseChunks.length} prose chunks`);

// Step 3: Surface zone-only refs
const existingRefs = result.quran_references || [];
const zoneRefs = buildZoneRefs(quranZones, transcriptWords, existingRefs);
if (zoneRefs.length) console.log(`  + ${zoneRefs.length} additional zone refs`);
const allQuranRefs = [...existingRefs, ...zoneRefs];

// Step 4: Update result with new prose map and refs
result.quran_references = allQuranRefs;
result.prose_chunk_map = proseChunks.map(({ wordStart, wordEnd, proseIdx }) => ({ wordStart, wordEnd, proseIdx }));

// Ensure chunk_translations length matches prose chunks.
// If we have more prose chunks than translations (because zone changes shifted boundaries),
// pad with empty strings so buildReaderView doesn't crash.
if (result.chunk_translations) {
  while (result.chunk_translations.length < proseChunks.length) {
    result.chunk_translations.push('');
  }
}

// Re-apply the hadith ref filters to the stored refs. Detection needs the corpus and
// stays in pipeline.js, but the filtering (liturgical formulas, attribution-only matches)
// is pure and cheap — running it here means a fix to those filters reaches an existing
// run without re-transcribing. Idempotent on refs that are already clean.
const hadithBefore = (result.hadith_references || []).length;
result.hadith_references = deduplicateHadithRefs(result.hadith_references || []);
const hadithDropped = hadithBefore - result.hadith_references.length;
if (hadithDropped) console.log(`  − ${hadithDropped} hadith ref(s) filtered (liturgical / attribution-only)`);

// Update metadata
const matchedCount = allQuranRefs.filter(r => r.matched).length;
result.metadata.quran_references_found = allQuranRefs.length;
result.metadata.quran_references_matched = matchedCount;
result.metadata.hadith_references_found = result.hadith_references.length;

// Step 5: Rebuild reader.txt
console.log('Building reader view...');
const readerView = buildReaderView(transcript, result);

// Step 6: Save
writeFileSync(join(folder, 'reader.txt'), readerView, 'utf8');
writeFileSync(join(folder, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
console.log(`✓ Saved reader.txt and result.json to ${folder}/`);
