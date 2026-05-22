#!/usr/bin/env node
/**
 * Re-run Claude analysis on an existing transcript.
 * Reads transcript.txt, skips transcription, overwrites result.json / reader.txt / readable.txt.
 *
 * Usage:
 *   node reanalyze.js outputs/2026-05-17T23-18-48_1779059928622
 */

import 'dotenv/config';
import { writeFileSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';

import {
  ANALYSIS_PROMPT,
  buildReaderView,
  buildReadableOutput,
  buildProseChunks,
  locateSecondKhutbah,
  splitChunkAtKhutbahBoundary,
  prescanForQuranZones,
  buildZoneRefs,
  scanTranscriptForQuran,
  scanTranscriptForHadith,
  deduplicateHadithRefs,
  findMatchingAyah,
  findMatchingHadith,
  loadHadithCorpus,
  resolveSunnahLinksForRefs,
} from './pipeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 120_000, maxRetries: 3 });

async function main() {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error('Usage: node reanalyze.js <output-folder>');
    process.exit(1);
  }

  const dir = path.resolve(__dirname, outDir);
  const transcript = readFileSync(path.join(dir, 'transcript.txt'), 'utf8').trim();
  const wordCount = transcript.split(/\s+/).filter(Boolean).length;
  console.log(`Loaded transcript: ${wordCount} words`);

  // Preserve existing transcription metadata and segment timestamps
  let existingMeta = {};
  let existingSegments = [];
  let existingWords = [];
  try {
    const prev = JSON.parse(readFileSync(path.join(dir, 'result.json'), 'utf8'));
    existingMeta = prev.metadata ?? {};
    existingSegments = prev.transcript_segments ?? [];
    existingWords = prev.transcript_words ?? [];
  } catch {}

  // Pre-detect Quran zones so chunks don't straddle ayah boundaries
  const CHUNK_SIZE = 30;
  const transcriptWords = transcript.split(/\s+/).filter(Boolean);
  process.stdout.write('Pre-scanning Quran zones...');
  const quranZones = prescanForQuranZones(transcriptWords);
  console.log(` ${quranZones.length} zones`);

  const proseChunks = buildProseChunks(transcriptWords, quranZones, CHUNK_SIZE, existingSegments);
  const chunkInstruction = `\n\nThe transcript has been divided into ${proseChunks.length} prose chunks below ` +
    `(Quranic verses are excluded and handled separately). ` +
    `Using your full understanding of the whole khutbah for context, translate each numbered chunk into natural, ` +
    `fluent English. Return these as "chunk_translations" — an array of exactly ${proseChunks.length} strings, one per chunk in order.\n\n` +
    proseChunks.map((c, i) => `[${i + 1}] ${c.text}`).join('\n');

  // Claude analysis
  let claudeRaw;
  process.stdout.write('Analysing with Claude');
  const stream = anthropic.messages.stream({
    model: 'claude-sonnet-4-6',
    max_tokens: 16000,
    messages: [{ role: 'user', content: `${ANALYSIS_PROMPT}\n\nTranscript:\n${transcript}${chunkInstruction}` }],
  });
  stream.on('text', () => process.stdout.write('.'));
  claudeRaw = (await stream.finalMessage()).content[0].text;
  console.log(' done');

  let analysis;
  try {
    analysis = JSON.parse(claudeRaw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim());
  } catch (e) {
    writeFileSync(path.join(dir, 'claude_raw.txt'), claudeRaw, 'utf8');
    console.error('Claude returned invalid JSON — saved to claude_raw.txt\n' + e.message);
    process.exit(1);
  }

  // Match Quran refs (same logic as pipeline.js Step 7)
  const quranRefs = (analysis.quran_references ?? []).map(ref => {
    const algoMatch = findMatchingAyah(ref.arabic_text ?? '');
    const claudeSurahNum = ref.surah_number ?? null;
    const claudeAyahNum  = ref.ayah_number  ?? null;
    const claudeIdentified = claudeSurahNum !== null && claudeAyahNum !== null;
    const bothAgree = claudeIdentified && algoMatch && algoMatch.surah_number === claudeSurahNum && algoMatch.ayah_number === claudeAyahNum;
    const disagree  = claudeIdentified && algoMatch && (algoMatch.surah_number !== claudeSurahNum || algoMatch.ayah_number !== claudeAyahNum);
    const surahNum  = claudeIdentified ? claudeSurahNum : (algoMatch?.surah_number ?? null);
    const ayahNum   = claudeIdentified ? claudeAyahNum  : (algoMatch?.ayah_number  ?? null);
    const surahName = claudeIdentified ? (ref.surah_name ?? algoMatch?.surah_name ?? null) : (algoMatch?.surah_name ?? null);
    if (!surahNum || !ayahNum) return { detected_text: ref.arabic_text, matched: false, surah_name: null, surah_number: null, ayah_number: null, quran_link: null, confidence: 0, verification: 'no_match' };
    const confidence = bothAgree ? Math.max(algoMatch.confidence, 0.95) : claudeIdentified && !algoMatch ? 0.85 : disagree ? 0.75 : (algoMatch?.confidence ?? 0.7);
    return {
      detected_text: ref.arabic_text, matched: true, surah_name: surahName, surah_number: surahNum, ayah_number: ayahNum,
      quran_link: `https://quran.com/${surahNum}/${ayahNum}`,
      confidence: Math.round(confidence * 100) / 100,
      verification: bothAgree ? 'claude+algorithm' : disagree ? `DISAGREEMENT:claude=${claudeSurahNum}:${claudeAyahNum},algo=${algoMatch.surah_number}:${algoMatch.ayah_number}` : claudeIdentified ? 'claude_only' : 'algorithm_only',
      detection_method: 'signal_phrase',
    };
  });

  process.stdout.write('Scanning Quran refs...');
  const scanRefs = scanTranscriptForQuran(transcript, quranRefs);
  console.log(` +${scanRefs.length} via scan`);
  let allQuranRefs = [...quranRefs, ...scanRefs];
  const zoneRefs = buildZoneRefs(quranZones, transcriptWords, allQuranRefs);
  if (zoneRefs.length) console.log(`  + ${zoneRefs.length} via ngram zones`);
  allQuranRefs = [...allQuranRefs, ...zoneRefs];

  // Match Hadith refs
  const hadithCorpus = loadHadithCorpus();
  const claudeHadithRefs = deduplicateHadithRefs(
    (analysis.hadith_references ?? []).map(ref => {
      const match = findMatchingHadith(ref.arabic_text ?? '', hadithCorpus);
      return {
        detected_text: ref.arabic_text, narrator: ref.narrator ?? null,
        collection: match ? match.collection : (ref.collection ?? null),
        hadith_number: match ? match.number : null, link: match ? match.link : null,
        confidence: match ? match.confidence : null, detection_method: 'signal_phrase',
        note: match ? 'Matched against local corpus' : 'Manual verification recommended',
      };
    })
  );
  process.stdout.write('Scanning Hadith refs...');
  const hadithScanRefs = scanTranscriptForHadith(transcript, claudeHadithRefs, hadithCorpus);
  console.log(` +${hadithScanRefs.length} via scan`);
  const allHadithRefs = deduplicateHadithRefs([...claudeHadithRefs, ...hadithScanRefs]);

  // Replace corpus numbers/links with canonical sunnah.com permalinks (matn search; falls back on failure).
  process.stdout.write('Resolving sunnah.com links...');
  await resolveSunnahLinksForRefs(allHadithRefs);
  console.log(` ${allHadithRefs.filter(r => r.verification === 'sunnah_search').length}/${allHadithRefs.length} verified`);

  const matchedCount = allQuranRefs.filter(r => r.matched).length;
  const secondKhutbah = locateSecondKhutbah(analysis.second_khutbah_start, transcript, existingSegments, existingWords);
  if (secondKhutbah) {
    console.log(`✓ Second khutbah split at word ${secondKhutbah.word_index} (${secondKhutbah.via}${secondKhutbah.validated ? ', gap-validated' : ''})`);
    const didSplit = await splitChunkAtKhutbahBoundary(proseChunks, analysis.chunk_translations, secondKhutbah.word_index, transcriptWords, anthropic, 'claude-sonnet-4-6');
    if (didSplit) console.log('  ↳ split the straddling chunk into two (Khutbah 1 | Khutbah 2)');
  }

  const result = {
    share_summary: analysis.share_summary ?? '',
    summary: analysis.summary ?? '',
    chunk_translations: Array.isArray(analysis.chunk_translations) ? analysis.chunk_translations : null,
    prose_chunk_map: proseChunks.map(({ wordStart, wordEnd, proseIdx }) => ({ wordStart, wordEnd, proseIdx })),
    second_khutbah: secondKhutbah,
    quran_references: allQuranRefs,
    hadith_references: allHadithRefs,
    transcript_segments: existingSegments,
    transcript_words: existingWords,
    metadata: {
      ...existingMeta,
      processed_at: new Date().toISOString(),
      transcript_word_count: wordCount,
      quran_references_found: allQuranRefs.length,
      quran_references_matched: matchedCount,
      quran_references_by_scan: scanRefs.length,
      hadith_references_found: allHadithRefs.length,
      hadith_references_by_scan: hadithScanRefs.length,
    },
  };

  writeFileSync(path.join(dir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  writeFileSync(path.join(dir, 'reader.txt'),  buildReaderView(transcript, result), 'utf8');
  writeFileSync(path.join(dir, 'readable.txt'), buildReadableOutput(result), 'utf8');

  console.log(`\n✓ ${matchedCount}/${allQuranRefs.length} Quran refs matched, ${allHadithRefs.length} Hadith refs`);
  console.log(`✓ Updated result.json, reader.txt, readable.txt in ${outDir}`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
