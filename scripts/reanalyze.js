#!/usr/bin/env node
// reanalyze.js — Rebuild reader.txt from existing result.json + transcript.txt
// using the improved canonical-span alignment. No API calls needed, except: when a fix moves
// some chunk boundaries but keeps the number of chunks (a Quran zone that now ends where the
// verse does), the English of just those chunks is translated again, and the Urdu commands
// for the same chunks are printed (translate_urdu.js / review_urdu.js --chunks).
//
// Usage: node scripts/reanalyze.js outputs/<folder> [--keep-chunks] [--no-swaps]
//
// --keep-chunks reuses the stored prose chunks and Quran refs exactly as they are and only
// re-applies the hadith filters and rebuilds the reader. For runs translated under older
// chunking rules (the May khutbahs), where recomputing the chunks would pair every block
// with another block's translation.
//
// Quotes inside the prose are matched to their published English by quote_swaps.js (one
// call per quote whose inputs changed, claude-sonnet-5-5 by default; nothing when they did not).
// --no-swaps skips that and keeps whatever plan result.json already has.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  prescanForQuranZones,
  dropBorrowedPhrases,
  buildZoneRefs,
  buildProseChunks,
  scanTranscriptForQuran,
  findMatchingAyah,
  yieldTailToLaterRefs,
} from '../core/arabic.js';
import { buildReaderView } from '../core/reader.js';
import { deduplicateHadithRefs, resolveSunnahLinksForRefs } from '../core/hadith.js';
import { settleLoneWords } from '../core/transcribe.js';
import { planQuoteSwaps } from '../core/quote_swaps.js';

const folder = process.argv[2];
if (!folder || !existsSync(folder)) {
  console.error('Usage: node scripts/reanalyze.js outputs/<folder>');
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
const keepChunks = process.argv.includes('--keep-chunks');
if (keepChunks) console.log('Keeping the stored prose chunks and Quran refs (--keep-chunks)');

let moved = [];
const allQuranRefs = keepChunks ? (result.quran_references || []) : recomputeChunksAndZones();
if (moved.length) {
  await retranslateEnglish(moved);
  console.log(`  then: node urdu/translate_urdu.js ${folder} --chunks ${moved.join(',')} && node urdu/review_urdu.js ${folder} --chunks ${moved.join(',')}`);
}

// English for the chunks whose boundaries moved, one call each, with the whole khutbah and the
// English on either side so it reads on; the model of the first analysis (pipeline.js).
async function retranslateEnglish(indices) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 300_000, maxRetries: 4 });
  const map = result.prose_chunk_map, en = result.chunk_translations;
  for (const i of indices) {
    const arabic = transcriptWords.slice(map[i].wordStart, map[i].wordEnd).join(' ');
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-5-5', max_tokens: 4000, output_config: { effort: 'low' },
      messages: [{ role: 'user', content:
        `The transcript of an Arabic Friday khutbah, for context:\n${transcript}\n\n` +
        'Translate one chunk of it into natural, fluent English: exactly its own words, no more and no less (Quran verses are ' +
        'shown separately on the page, so never add the words of a verse next to the chunk). Match the style of the English ' +
        'around it (honorifics such as صلى الله عليه وسلم stay in Arabic) and make it read on from the English before it. ' +
        '«متفق عليه» after a hadith is "Narrated by al-Bukhari and Muslim", never "Agreed upon". ' +
        'Do not use em dashes or en dashes. Reply with the English only.\n\n' +
        `English before: ${en[i - 1] ?? '(start of the khutbah)'}\nChunk: ${arabic}\nEnglish after: ${en[i + 1] ?? '(end)'}` }],
    });
    en[i] = msg.content.find(b => b.type === 'text')?.text.trim() || en[i];
    console.log(`  chunk ${i}: boundaries moved, English translated again: ${en[i].slice(0, 70)}…`);
  }
}

// Steps 1-4: recompute Quran zones, prose chunks and zone refs with the current code.
function recomputeChunksAndZones() {
  // Step 1: Re-run prescan with improved alignment
  console.log('Pre-scanning Quran zones with canonical-span alignment...');
  const quranZones = dropBorrowedPhrases(prescanForQuranZones(transcriptWords), transcriptWords);
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
  // Translations are matched to prose chunks by position, so the chunks must be exactly the
  // ones that were translated. A changed boundary pairs every later block with the wrong
  // English — re-timing a run with fresh Whisper segments did exactly that, shifting two
  // boundaries, which the old count-only check (drift <= 2) let through silently.
  const newMap = proseChunks.map(({ wordStart, wordEnd, proseIdx }) => ({ wordStart, wordEnd, proseIdx }));
  const oldMap = result.prose_chunk_map;
  if (oldMap?.length === newMap.length && result.chunk_translations && !process.argv.includes('--force')) {
    // The same chunks, some with moved boundaries (a fix to the Quran zones): those are
    // translated again below; every other chunk keeps its English, and its voice.
    moved = newMap.map((e, i) => (JSON.stringify(e) !== JSON.stringify(oldMap[i]) ? i : -1)).filter(i => i >= 0);
  } else if (oldMap && result.chunk_translations &&
      JSON.stringify(oldMap) !== JSON.stringify(newMap) && !process.argv.includes('--force')) {
    const at = newMap.findIndex((e, i) => JSON.stringify(e) !== JSON.stringify(result.prose_chunk_map[i]));
    console.error(`✗ Prose chunk boundaries changed from chunk ${at} on — the stored translations would pair`);
    console.error('  with the wrong blocks. Nothing written. Re-run the full pipeline for this folder, or pass');
    console.error('  --force if the translations are known to be regenerated separately.');
    process.exit(1);
  }
  result.prose_chunk_map = newMap;

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
  return allQuranRefs;
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

if (!process.argv.includes('--no-swaps')) {
  console.log('Matching quoted hadith and verses to their published English...');
  const usage = await planQuoteSwaps(transcript, result);
  console.log(`  ${usage.published} published, ${usage.ours} ours; ${usage.calls} ${usage.model} call(s), ` +
    `${usage.input_tokens} in / ${usage.output_tokens} out tokens, $${usage.cost_usd.toFixed(4)}`);
  if (usage.calls) result.metadata.english_swaps = usage;
}

// Words interpolated into a pause (the first word of the second khutbah, timed while the
// imam was still seated) move next to the words they belong to.
const settled = settleLoneWords(result);
if (settled) console.log(`  ${settled} word(s) timed alone in a pause moved next to their sentence`);

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
