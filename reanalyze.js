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
  resolveSunnahLinksForRefs,
  yieldTailToLaterRefs,
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
const allQuranRefs = yieldTailToLaterRefs([...existingRefs, ...zoneRefs]);

// Step 4: Update result with new prose map and refs
result.quran_references = allQuranRefs;
result.prose_chunk_map = proseChunks.map(({ wordStart, wordEnd, proseIdx }) => ({ wordStart, wordEnd, proseIdx }));

// Ensure chunk_translations length matches prose chunks.
// If we have more prose chunks than translations (because zone changes shifted boundaries),
// pad with empty strings so buildReaderView doesn't crash.
//
// A large mismatch means the chunking parameters (MIN_CHUNK / MAX_CHUNK / MIN_ZONE_WORDS)
// changed since this run was translated. Translations are matched to chunks BY INDEX, so
// padding then silently pairs each chunk with another chunk's English. Warn loudly —
// the fix is to re-run the full pipeline, not to reanalyze.
if (result.chunk_translations) {
  const drift = proseChunks.length - result.chunk_translations.length;
  if (Math.abs(drift) > 2) {
    console.warn(`⚠ chunk/translation mismatch: ${proseChunks.length} chunks vs ${result.chunk_translations.length} translations.`);
    console.warn('  Chunking parameters have changed since this run was translated; translations are');
    console.warn('  index-matched, so the reader will pair text with the wrong English.');
    console.warn('  Re-run the full pipeline for this folder instead of reanalyze.');
  }
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

// Backfill the published sunnah.com translation (and narrator) for the surviving refs.
// Disk-cached, so this is a no-op on a second run.
if (result.hadith_references.length) {
  console.log('Resolving sunnah.com links + translations...');
  await resolveSunnahLinksForRefs(result.hadith_references, transcript);
  const withTrans = result.hadith_references.filter(h => h.translation).length;
  console.log(`  ${withTrans}/${result.hadith_references.length} hadith translations fetched`);
}

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
