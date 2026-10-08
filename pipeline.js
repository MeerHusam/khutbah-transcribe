// pipeline.js — The command line: one khutbah recording (or an earlier run's transcript) to an
// outputs/<time>_<name>/ folder with transcript.txt, result.json, reader.txt and readable.txt.
//
//   node pipeline.js audio.mp3          Gemini 3.5 Flash text + Groq timing (best quality; --gemini says the same)
//   node pipeline.js audio.mp3 --groq   Groq whisper-large-v3 alone (free & fast)
//   node pipeline.js --transcript outputs/<run>/transcript.txt   reuse a transcript and its timings
//   --type friday|arafah|eid            frames the summary (default friday)
//   --single (alias --no-split)         one continuous khutbah: no second-khutbah split
//
// Stages, in main() below: transcribe → find the Quran zones and cut the prose into chunks →
// Claude translates the chunks and names the references → Quran references (Claude's, checked
// against the corpus, plus the ones a scan and the zones find) → hadith references (the same,
// then sunnah.com links) → where the second khutbah starts → published English for quoted
// verses and hadith → the files.

import 'dotenv/config';
import { writeFileSync, mkdirSync, readFileSync, existsSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { stripAyahMarkup, prescanForQuranZones, dropBorrowedPhrases, buildProseChunks, scanTranscriptForQuran, buildZoneRefs, annotateRefAyahRange, yieldTailToLaterRefs, matchClaudeQuranRef, findRestarts, restartNotes } from './core/arabic.js';
import { loadHadithCorpus, deduplicateHadithRefs, scanTranscriptForHadith, findAttributedHadith, resolveSunnahLinksForRefs, matchClaudeHadithRef } from './core/hadith.js';
import { KHUTBAH_TYPES, buildAnalysisPrompt, locateSecondKhutbah, splitChunkAtKhutbahBoundary, completeChunkTranslations } from './core/analyze.js';
import { buildReadableOutput, buildReaderView } from './core/reader.js';
import { preprocessAudio, transcribeWithGroq, transcribeWithGemini, SILENCE_PREPEND_SEC } from './core/transcribe.js';
import { planQuoteSwaps } from './core/quote_swaps.js';
import { QURAN_EN } from './core/quran_en.js';

export const ANALYSIS_MODEL = 'claude-sonnet-5-5';

// A missing key fails at the API call with a clear auth error, not at startup.
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || 'not-set',
  timeout: 120_000,  // 2-minute timeout (large transcripts take a while)
  maxRetries: 3,
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Stages ------------------------------------------------------------------

// Steps 1-2: the command line, checked.
function parseArgs(args) {
  const useGroq = args.includes('--groq');
  // --type <friday|arafah|eid> frames the summary and ref wording (default: friday).
  const typeFlagIdx = args.indexOf('--type');
  const khutbahType = (typeFlagIdx !== -1 && KHUTBAH_TYPES[args[typeFlagIdx + 1]])
    ? args[typeFlagIdx + 1] : 'friday';
  // --single (alias --no-split): treat the audio as ONE continuous khutbah and skip
  // second-khutbah split detection. Use for Arafah, Eid, lectures — anything that
  // isn't a two-part Friday Jumu'ah khutbah. Non-two-part types (arafah, eid) imply it.
  const singleKhutbah = args.includes('--single') || args.includes('--no-split')
    || !KHUTBAH_TYPES[khutbahType].twoPart;
  const transcriptFlagIdx = args.indexOf('--transcript');
  const existingTranscriptPath = transcriptFlagIdx !== -1 ? args[transcriptFlagIdx + 1] : null;

  const skipValues = new Set([
    typeFlagIdx !== -1 ? args[typeFlagIdx + 1] : null,
    existingTranscriptPath,
  ].filter(Boolean));
  const audioPath = args.find(a => !a.startsWith('--') && !skipValues.has(a));

  if (!audioPath && !existingTranscriptPath) {
    console.error(
      'Usage: node pipeline.js path/to/khutbah.mp3 [--groq] [--single] [--type friday|arafah|eid]\n' +
      '       node pipeline.js --transcript outputs/<run>/transcript.txt'
    );
    process.exit(1);
  }

  // Step 2: Validate inputs
  if (existingTranscriptPath) {
    if (!existsSync(existingTranscriptPath)) {
      console.error(`Error: Transcript file not found -- ${existingTranscriptPath}`);
      process.exit(1);
    }
  } else {
    if (!existsSync(audioPath)) {
      console.error(`Error: File not found -- ${audioPath}`);
      process.exit(1);
    }
    // Note: the 25 MB Whisper limit is checked AFTER preprocessing (which compresses to
    // ~48kbps mono MP3), since that — not the raw upload — is what gets sent to the API.
  }
  return { useGroq, khutbahType, singleKhutbah, existingTranscriptPath, audioPath };
}

// A timestamped output folder: outputs/<time>_<name>/.
function createOutputFolder({ existingTranscriptPath, audioPath }) {
  const audioBasename = existingTranscriptPath
    ? path.basename(path.dirname(existingTranscriptPath))
        .replace(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}_)+/, '') // strip leading timestamp(s)
    : path.basename(audioPath, path.extname(audioPath));
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.join(__dirname, 'outputs', `${timestamp}_${audioBasename}`);
  mkdirSync(outDir, { recursive: true });
  console.log(`Output folder: outputs/${timestamp}_${audioBasename}/`);
  return { outDir, timestamp, audioBasename };
}

// Step 3: transcribe the recording, or reuse an earlier transcript and its timings.
async function getTranscript({ existingTranscriptPath, audioPath, useGroq }) {
  let transcript;
  let transcriptSegments = [];
  let transcriptWordTimes = [];
  let groqText = null; // populated in --gemini mode (Groq side of the hybrid) for comparison
  let model = null; // which model gave the text (transcribeWithGemini falls back along a list)
  if (existingTranscriptPath) {
    console.log(`Using existing transcript: ${existingTranscriptPath}`);
    transcript = readFileSync(existingTranscriptPath, 'utf8').trim();
    // Reuse Groq word-timings + segments from the sibling result.json so the regenerated
    // output keeps accurate audio alignment (chunk start_times) without re-transcribing.
    try {
      const sibPath = path.join(path.dirname(existingTranscriptPath), 'result.json');
      const sib = JSON.parse(readFileSync(sibPath, 'utf8'));
      if (Array.isArray(sib.transcript_segments)) transcriptSegments = sib.transcript_segments;
      if (Array.isArray(sib.transcript_words)) transcriptWordTimes = sib.transcript_words;
      if (transcriptWordTimes.length) console.log(`  reused timing: ${transcriptWordTimes.length} word times, ${transcriptSegments.length} segments`);
    } catch { /* no sibling timing — proceed without */ }
  } else {
    const fileSizeMB = statSync(audioPath).size / (1024 * 1024);
    console.log('Preprocessing audio (prepending silence, normalising to 16kHz)...');
    const processedPath = await preprocessAudio(audioPath);
    const usedPath = processedPath;

    // Groq's Whisper caps uploads at 25 MB. Check the PREPROCESSED file — the raw
    // input can be far larger and still compress under the limit.
    const processedSizeMB = statSync(usedPath).size / (1024 * 1024);
    if (processedSizeMB > 25) {
      console.error(
        `Error: Even after compression the audio is ${processedSizeMB.toFixed(1)} MB -- over Whisper's 25 MB limit.\n` +
        'Split the recording into shorter parts.'
      );
      if (usedPath !== audioPath) { const { unlinkSync } = await import('fs'); try { unlinkSync(usedPath); } catch {} }
      process.exit(1);
    }

    let transcriptResult;
    try {
      if (useGroq) {
        console.log(`Transcribing via Groq whisper-large-v3 (${fileSizeMB.toFixed(1)} MB)...`);
        transcriptResult = await transcribeWithGroq(usedPath);
      } else {
        console.log(`Transcribing via Gemini 3.5 Flash + Groq timing (${fileSizeMB.toFixed(1)} MB)...`);
        transcriptResult = await transcribeWithGemini(usedPath);
      }
    } catch (e) {
      console.error(`Transcription error: ${e.message}`);
      process.exit(1);
    } finally {
      // Clean up preprocessed temp file
      if (usedPath !== audioPath) {
        const { unlink } = await import('fs/promises');
        await unlink(usedPath).catch(() => {});
      }
    }
    transcript = typeof transcriptResult === 'string' ? transcriptResult : transcriptResult.text;
    transcriptSegments = typeof transcriptResult === 'string' ? [] : (transcriptResult.segments ?? []);
    transcriptWordTimes = typeof transcriptResult === 'string' ? [] : (transcriptResult.words ?? []).map(w => ({ word: w.word, start: w.start }));
    groqText = (typeof transcriptResult !== 'string' && transcriptResult.groqText) ? transcriptResult.groqText : null;
    model = useGroq ? 'groq:whisper-large-v3' : transcriptResult.model;

    // Whisper timed the preprocessed audio (1s silence prepended); shift back to original-audio time.
    if (usedPath !== audioPath) {
      transcriptSegments = transcriptSegments.map(s => ({
        ...s,
        start: Math.max(0, s.start - SILENCE_PREPEND_SEC),
        end: Math.max(0, s.end - SILENCE_PREPEND_SEC),
      }));
      transcriptWordTimes = transcriptWordTimes.map(w => ({
        ...w,
        start: Math.max(0, Math.round((w.start - SILENCE_PREPEND_SEC) * 100) / 100),
      }));
    }
  }

  // Remove Gemini's ayah-quotation markup before anything downstream reads the transcript.
  // Segments and word timings must be cleaned with it, or their token streams no longer
  // line up with the transcript that reference spans are computed against.
  transcript = stripAyahMarkup(transcript);
  transcriptSegments = transcriptSegments.map(s => ({ ...s, text: stripAyahMarkup(s.text ?? '') }));
  transcriptWordTimes = transcriptWordTimes
    .map(w => ({ ...w, word: stripAyahMarkup(w.word ?? '') }))
    .filter(w => w.word);
  return { transcript, transcriptSegments, transcriptWordTimes, groqText, model };
}

// Steps 5-6: Claude translates the numbered prose chunks and names the references it hears.
async function analyzeWithClaude({ transcript, proseChunks, khutbahType, outDir }) {
  const numberedChunks = proseChunks.map((c, i) => `[${i + 1}] ${c.text}`).join('\n');
  const restarts = restartNotes(findRestarts(proseChunks.map(c => c.text)), i => i + 1);
  const chunkInstruction = `\n\nThe transcript has been divided into ${proseChunks.length} prose chunks below ` +
    `(the verses the khatib recites are cut out and shown separately; Quranic words left inside a chunk are translated with it). ` +
    `Using your full understanding of the whole khutbah for context, translate each numbered chunk into natural, ` +
    `fluent English. Return these as "chunk_translations": an object with one key for every chunk number, ` +
    `"1" to "${proseChunks.length}", each holding that chunk's English only.\n\n${numberedChunks}` +
    (restarts ? `\n\n${restarts}` : '');

  let claudeRaw;
  try {
    // Use streaming so long transcripts don't hit the request timeout
    process.stdout.write('Analysing with Claude');
    // Claude Sonnet 5.5 since 4 Oct 2026 (was Sonnet 4.6). Its thinking counts toward max_tokens.
    const stream = anthropic.messages.stream({
      model: ANALYSIS_MODEL,
      max_tokens: 32000,
      output_config: { effort: 'medium' },
      messages: [
        {
          role: 'user',
          content: `${buildAnalysisPrompt(khutbahType)}\n\nTranscript:\n${transcript}${chunkInstruction}`,
        },
      ],
    });
    stream.on('text', () => process.stdout.write('.'));
    const message = await stream.finalMessage();
    console.log(' done');
    claudeRaw = message.content.find(b => b.type === 'text')?.text ?? '';
  } catch (e) {
    console.error(`\nClaude API error: ${e.message}`);
    process.exit(1);
  }

  // Step 6: Parse Claude's JSON response
  let analysis;
  try {
    // Strip accidental markdown fences if Claude wraps the JSON anyway
    const cleaned = claudeRaw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    analysis = JSON.parse(cleaned);
  } catch (e) {
    writeFileSync(path.join(outDir, 'claude_raw.txt'), claudeRaw, 'utf8');
    console.error(
      `Claude returned invalid JSON -- raw response saved to ${outDir}/claude_raw.txt\n` +
      `Parse error: ${e.message}`
    );
    process.exit(1);
  }
  const { list, missing } = await completeChunkTranslations(anthropic, analysis.chunk_translations, proseChunks, transcript, ANALYSIS_MODEL);
  if (missing.length) console.log(`  ${missing.length} chunk(s) had no English from the analysis, translated on their own: ${missing.join(', ')}`);
  analysis.chunk_translations = list;
  return analysis;
}

// Steps 7, 8, 8b: Claude's Quran references checked against the corpus (matchClaudeQuranRef),
// then the ones a scan of the whole transcript and the n-gram zones find.
function findQuranRefs({ analysis, transcript, transcriptWords, quranZones }) {
  const quranRefs = (analysis.quran_references ?? []).map(matchClaudeQuranRef);

  // Step 8: Scan full transcript for Quranic references missed by signal-phrase detection
  process.stdout.write('Scanning transcript for Quranic references...');
  const scanRefs = scanTranscriptForQuran(transcript, quranRefs);
  console.log(` found ${scanRefs.length} additional`);
  let allQuranRefs = [
    ...quranRefs.map(r => ({ ...r, detection_method: 'signal_phrase' })),
    ...scanRefs,
  ];

  // Step 8b: Surface ayahs the n-gram zones identified but both Claude and Jaccard scan missed.
  // This catches partial citations (imam recites ~half an ayah) where Jaccard score < 0.65.
  const zoneRefs = buildZoneRefs(quranZones, transcriptWords, allQuranRefs);
  if (zoneRefs.length) console.log(`  + ${zoneRefs.length} additional via ngram zones`);
  allQuranRefs = [...allQuranRefs, ...zoneRefs];
  // Label multi-ayah recitations with their full range so the reader renders the whole
  // passage rather than only the verse the detecting layer happened to name.
  allQuranRefs.forEach(annotateRefAyahRange);
  yieldTailToLaterRefs(allQuranRefs);
  return { quranRefs, scanRefs, allQuranRefs };
}

// Steps 7, 8c, 8d for hadith: Claude's references matched to the corpus, the ones a scan finds,
// then sunnah.com links.
async function findHadithRefs({ analysis, transcript, quranZones }) {
  const hadithCorpus = loadHadithCorpus();
  const claudeHadithRefs = deduplicateHadithRefs(
    (analysis.hadith_references ?? []).map(ref => matchClaudeHadithRef(ref, hadithCorpus)), transcript
  );

  // Step 8c: hadith the imam quotes without naming them (core/hadith.js)
  process.stdout.write('Scanning transcript for Hadith the imam does not name...');
  const hadithScanRefs = scanTranscriptForHadith(transcript, claudeHadithRefs, hadithCorpus, quranZones);
  console.log(` found ${hadithScanRefs.length}`);
  // and the ones he quotes and attributes aloud that neither found ("الدعاء هو العبادة. أخرجه أبو داود")
  const attributed = findAttributedHadith(transcript, [...claudeHadithRefs, ...hadithScanRefs], hadithCorpus);
  const allHadithRefs = deduplicateHadithRefs([...claudeHadithRefs, ...hadithScanRefs, ...attributed], transcript);

  // Step 8d: Replace corpus numbers/links with canonical sunnah.com permalinks
  // (searches sunnah.com for each matn; falls back to the corpus link on any failure).
  process.stdout.write('Resolving sunnah.com links...');
  await resolveSunnahLinksForRefs(allHadithRefs, transcript, hadithCorpus);
  console.log(` ${allHadithRefs.filter(r => r.verification === 'sunnah_search').length}/${allHadithRefs.length} verified`);
  return { hadithScanRefs, allHadithRefs };
}

// ---- Main ----------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { useGroq, khutbahType, singleKhutbah } = opts;
  const { outDir, timestamp, audioBasename } = createOutputFolder(opts);
  const { transcript, transcriptSegments, transcriptWordTimes, groqText, model } = await getTranscript(opts);

  // Step 4: Save raw Arabic transcript
  writeFileSync(path.join(outDir, 'transcript.txt'), transcript, 'utf8');
  // In --gemini mode the hybrid also produced a Groq transcript — save it for comparison.
  if (groqText) {
    writeFileSync(path.join(outDir, 'transcript_groq.txt'), groqText, 'utf8');
  }
  const wordCount = transcript.split(/\s+/).filter(Boolean).length;

  // Step 5: Send transcript to Claude for translation + reference extraction.
  // Pre-detect Quran zones algorithmically so chunks don't straddle ayah boundaries.
  const CHUNK_SIZE = 30;
  const transcriptWords = transcript.split(/\s+/).filter(Boolean);
  process.stdout.write('Pre-scanning Quran zones...');
  const quranZones = dropBorrowedPhrases(prescanForQuranZones(transcriptWords), transcriptWords);
  console.log(` ${quranZones.length} zones detected`);

  const proseChunks = buildProseChunks(transcriptWords, quranZones, CHUNK_SIZE, transcriptSegments);
  const analysis = await analyzeWithClaude({ transcript, proseChunks, khutbahType, outDir });
  const { quranRefs, scanRefs, allQuranRefs } = findQuranRefs({ analysis, transcript, transcriptWords, quranZones });
  const { hadithScanRefs, allHadithRefs } = await findHadithRefs({ analysis, transcript, quranZones });

  // Step 9: Assemble final output object
  const matchedCount = allQuranRefs.filter(r => r.matched).length;
  const secondKhutbah = singleKhutbah
    ? null
    : locateSecondKhutbah(analysis.second_khutbah_start, transcript, transcriptSegments, transcriptWordTimes);
  if (singleKhutbah) console.log('✓ Single-khutbah mode: split detection skipped');
  if (secondKhutbah) {
    console.log(`✓ Second khutbah split at word ${secondKhutbah.word_index} (${secondKhutbah.via}${secondKhutbah.validated ? ', gap-validated' : ''})`);
    const didSplit = await splitChunkAtKhutbahBoundary(proseChunks, analysis.chunk_translations, secondKhutbah.word_index, transcriptWords, anthropic, ANALYSIS_MODEL);
    if (didSplit) console.log('  ↳ split the straddling chunk into two (Khutbah 1 | Khutbah 2)');
  }

  const result = {
    share_summary: analysis.share_summary ?? '',
    summary: analysis.summary ?? '',
    chunk_translations: Array.isArray(analysis.chunk_translations) ? analysis.chunk_translations : null,
    prose_chunk_map: proseChunks.map(({ wordStart, wordEnd, proseIdx }) => ({ wordStart, wordEnd, proseIdx })),
    second_khutbah: secondKhutbah,
    quran_en: QURAN_EN, // the English under the ayah cards (core/quran_en.js)
    quran_references: allQuranRefs,
    hadith_references: allHadithRefs,
    transcript_segments: transcriptSegments,
    transcript_words: transcriptWordTimes,
    metadata: {
      processed_at: new Date().toISOString(),
      transcription_mode: model ?? (useGroq ? 'groq:whisper-large-v3' : 'existing transcript'),
      transcript_word_count: wordCount,
      quran_references_found: allQuranRefs.length,
      quran_references_matched: matchedCount,
      quran_references_by_scan: scanRefs.length,
      hadith_references_found: allHadithRefs.length,
      hadith_references_by_scan: hadithScanRefs.length,
    },
  };

  // Step 9b: Published translations for quotes inside the prose (one model call per quote, see quote_swaps.js).
  console.log('\nMatching quoted hadith and verses to their published English...');
  result.metadata.english_swaps = await planQuoteSwaps(transcript, result);
  console.log(` ${result.metadata.english_swaps.published} published, ${result.metadata.english_swaps.ours} ours ($${result.metadata.english_swaps.cost_usd.toFixed(4)})`);

  // Step 10: Save JSON result
  writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');

  // Step 11: Save human-readable version and annotated reader view
  writeFileSync(path.join(outDir, 'readable.txt'), buildReadableOutput(result), 'utf8');
  writeFileSync(path.join(outDir, 'reader.txt'), buildReaderView(transcript, result), 'utf8');

  // Step 12: Print clean summary
  console.log(`✓ Transcription complete -- ${wordCount} words`);
  console.log('✓ Translation complete');
  console.log(`✓ ${allQuranRefs.length} Quranic references detected (${quranRefs.length} signal-phrase + ${scanRefs.length} scan), ${matchedCount} matched`);
  console.log(`✓ ${allHadithRefs.length} Hadith references detected (${hadithScanRefs.length} the imam did not name)`);
  console.log(`✓ Results saved to outputs/${timestamp}_${audioBasename}/  (transcript.txt, result.json, readable.txt, reader.txt)`);
}

main().catch(e => {
  console.error(`Unexpected error: ${e.message}`);
  process.exit(1);
});
