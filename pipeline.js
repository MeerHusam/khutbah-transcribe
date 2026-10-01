// Khutbah Processing Pipeline
// Transcribes Arabic audio -> translates -> extracts Quranic/Hadith references -> matches Ayahs

import 'dotenv/config';
import { writeFileSync, mkdirSync, readFileSync, existsSync, statSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import {
  stripAyahMarkup,
  prescanForQuranZones,
  buildProseChunks,
  findMatchingAyah,
  getQuranAyahWords,
  normalizeArabicDeep,
  scanTranscriptForQuran,
  buildZoneRefs,
  annotateRefAyahRange,
  yieldTailToLaterRefs,
  normalizeArabic,
  getQuranNgramIndex,
} from './core/arabic.js';
import {
  loadHadithCorpus,
  deduplicateHadithRefs,
  findMatchingHadith,
  scanTranscriptForHadith,
  resolveSunnahLinksForRefs,
  isLiturgicalFormula,
  parseSunnahNarrator,
  chooseNarrator,
  nameKeys,
  fetchSunnahPage,
  cachedSunnahPage,
  extractMatn,
} from './core/hadith.js';
import {
  KHUTBAH_TYPES,
  buildAnalysisPrompt,
  locateSecondKhutbah,
  splitChunkAtKhutbahBoundary,
  ANALYSIS_PROMPT,
} from './core/analyze.js';
import {
  buildReadableOutput,
  buildReaderView,
  publishedVerseEnglish,
  applyQuoteSwaps,
} from './core/reader.js';
import {
  preprocessAudio,
  transcribeLocal,
  transcribeWithGroq,
  transcribeWithGemini,
  transcribeWithAPI,
  SILENCE_PREPEND_SEC,
  transcribeWithGroqWindowed,
  alignWordTimestamps,
  combineTimings,
  retimeUnanchoredGaps,
  interpolateAnchors,
  settleLoneWords,
  buildSegmentsFromWordTimes,
} from './core/transcribe.js';

// Fallback placeholder keys so importing this module (e.g. server.js live mode)
// never throws when an optional provider key is absent — the API call itself
// will fail with a clear auth error if that provider is actually used.
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || 'not-set',
  timeout: 120_000,  // 2-minute timeout (large transcripts take a while)
  maxRetries: 3,
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Hadith corpus loaded lazily in main() after normalizeArabic is defined.
let hadithCorpus = null;

// ---- Main pipeline ----------------------------------------------------------

async function main() {
  // Step 1: Parse CLI arguments
  // Usage:
  //   node pipeline.js audio.mp3                              (OpenAI Whisper API)
  //   node pipeline.js audio.mp3 --groq                      (Groq whisper-large-v3, free & fast)
  //   node pipeline.js audio.mp3 --gemini                    (Gemini 2.5 Flash, best quality)
  //   node pipeline.js audio.mp3 --local                     (mlx-whisper on Apple Silicon, faster-whisper fallback)
  //   node pipeline.js audio.mp3 --local --model <hf-model>  (custom model, prefix with "mlx" for MLX backend)
  const args = process.argv.slice(2);
  const useLocal = args.includes('--local');
  const useGroq = args.includes('--groq');
  const useGemini = args.includes('--gemini');
  // --type <friday|arafah|eid> frames the summary and ref wording (default: friday).
  const typeFlagIdx = args.indexOf('--type');
  const khutbahType = (typeFlagIdx !== -1 && KHUTBAH_TYPES[args[typeFlagIdx + 1]])
    ? args[typeFlagIdx + 1] : 'friday';
  // --single (alias --no-split): treat the audio as ONE continuous khutbah and skip
  // second-khutbah split detection. Use for Arafah, Eid, lectures — anything that
  // isn't a two-part Friday Jumu'ah khutbah. Non-two-part types (arafah, eid) imply it.
  const singleKhutbah = args.includes('--single') || args.includes('--no-split')
    || !KHUTBAH_TYPES[khutbahType].twoPart;
  const modelFlagIdx = args.indexOf('--model');
  const localModel = modelFlagIdx !== -1
    ? args[modelFlagIdx + 1]
    : 'Systran/faster-whisper-large-v3';
  const transcriptFlagIdx = args.indexOf('--transcript');
  const existingTranscriptPath = transcriptFlagIdx !== -1 ? args[transcriptFlagIdx + 1] : null;

  const skipValues = new Set([
    modelFlagIdx !== -1 ? args[modelFlagIdx + 1] : null,
    typeFlagIdx !== -1 ? args[typeFlagIdx + 1] : null,
    existingTranscriptPath,
  ].filter(Boolean));
  const audioPath = args.find(a => !a.startsWith('--') && !skipValues.has(a));

  if (!audioPath && !existingTranscriptPath) {
    console.error(
      'Usage: node pipeline.js path/to/khutbah.mp3 [--groq] [--local] [--single] [--type friday|arafah|eid] [--model <hf-model-id>]\n' +
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

  // Create a timestamped output folder
  const audioBasename = existingTranscriptPath
    ? path.basename(path.dirname(existingTranscriptPath))
        .replace(/^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}_)+/, '') // strip leading timestamp(s)
    : path.basename(audioPath, path.extname(audioPath));
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.join(__dirname, 'outputs', `${timestamp}_${audioBasename}`);
  mkdirSync(outDir, { recursive: true });
  console.log(`Output folder: outputs/${timestamp}_${audioBasename}/`);

  // Step 3: Transcribe (or load existing transcript)
  let transcript;
  let transcriptSegments = [];
  let transcriptWordTimes = [];
  let groqText = null; // populated in --gemini mode (Groq side of the hybrid) for comparison
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

    // Whisper (Groq/OpenAI) caps uploads at 25 MB. Check the PREPROCESSED file — the raw
    // input can be far larger and still compress under the limit. --local has no cap.
    const processedSizeMB = statSync(usedPath).size / (1024 * 1024);
    if (!useLocal && processedSizeMB > 25) {
      console.error(
        `Error: Even after compression the audio is ${processedSizeMB.toFixed(1)} MB -- over Whisper's 25 MB limit.\n` +
        'Use --local (no size limit) or split the recording into shorter parts.'
      );
      if (usedPath !== audioPath) { const { unlinkSync } = await import('fs'); try { unlinkSync(usedPath); } catch {} }
      process.exit(1);
    }

    let transcriptResult;
    try {
      if (useLocal) {
        console.log(`Transcribing locally with ${localModel} (${fileSizeMB.toFixed(1)} MB)...`);
        transcriptResult = await transcribeLocal(usedPath, localModel);
      } else if (useGroq) {
        console.log(`Transcribing via Groq whisper-large-v3 (${fileSizeMB.toFixed(1)} MB)...`);
        transcriptResult = await transcribeWithGroq(usedPath);
      } else if (useGemini) {
        console.log(`Transcribing via Gemini 2.5 Flash + Groq timing (${fileSizeMB.toFixed(1)} MB)...`);
        transcriptResult = await transcribeWithGemini(usedPath);
      } else {
        console.log(`Transcribing via OpenAI Whisper API (${fileSizeMB.toFixed(1)} MB)...`);
        transcriptResult = await transcribeWithAPI(usedPath);
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
  const quranZones = prescanForQuranZones(transcriptWords);
  console.log(` ${quranZones.length} zones detected`);

  const proseChunks = buildProseChunks(transcriptWords, quranZones, CHUNK_SIZE, transcriptSegments);
  const numberedChunks = proseChunks.map((c, i) => `[${i + 1}] ${c.text}`).join('\n');
  const chunkInstruction = `\n\nThe transcript has been divided into ${proseChunks.length} prose chunks below ` +
    `(Quranic verses are excluded and handled separately). ` +
    `Using your full understanding of the whole khutbah for context, translate each numbered chunk into natural, ` +
    `fluent English. Return these as "chunk_translations" — an array of exactly ${proseChunks.length} strings, ` +
    `one per chunk in order.\n\n${numberedChunks}`;

  let claudeRaw;
  try {
    // Use streaming so long transcripts don't hit the request timeout
    process.stdout.write('Analysing with Claude');
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-6',
      max_tokens: 16000,
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
    claudeRaw = message.content[0].text;
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

  // Step 7: Match each Quranic reference.
  // Claude identifies the surah/ayah from its Quran knowledge (primary).
  // The local algorithm independently scores the extracted text (cross-check).
  // If both agree  → high confidence.
  // If they disagree → flag for manual review (one may have erred).
  // If only algorithm matched → use it, note Claude was uncertain.
  const quranRefs = (analysis.quran_references ?? []).map(ref => {
    const algoMatch = findMatchingAyah(ref.arabic_text ?? '');

    const claudeSurahNum = ref.surah_number ?? null;
    const claudeAyahNum  = ref.ayah_number  ?? null;
    const claudeIdentified = claudeSurahNum !== null && claudeAyahNum !== null;

    // Determine agreement
    const bothAgree = claudeIdentified && algoMatch &&
      algoMatch.surah_number === claudeSurahNum &&
      algoMatch.ayah_number  === claudeAyahNum;
    const disagree = claudeIdentified && algoMatch &&
      (algoMatch.surah_number !== claudeSurahNum || algoMatch.ayah_number !== claudeAyahNum);

    // On a disagreement, let the detected words themselves break the tie. Claude reads
    // meaning and is usually right about which passage is being cited, but it mislabels an
    // adjacent verse when two share a phrase: Al-Hajj 22:36 and 22:37 both contain
    // "كذلك سخر…ها لكم", and Claude labelled 22:36's closing words as 22:37. Deferring to
    // Claude unconditionally put the wrong verse on the card. Prefer the algorithm only when
    // its verse contains clearly more of the detected text, so an ordinary near-tie still
    // goes to Claude.
    const ayahCoverage = (sNum, aNum) => {
      const verse = getQuranAyahWords().get(sNum)?.find(v => v.ayah_id === aNum);
      if (!verse) return 0;
      const inVerse = new Set(verse.words);
      const det = normalizeArabicDeep(ref.arabic_text ?? '').split(/\s+/).filter(Boolean);
      if (!det.length) return 0;
      return det.filter(w => inVerse.has(w)).length / det.length;
    };
    // Neighbouring verses of the same surah are a different case: a recitation that runs
    // across both contains words of both, and whole-text coverage then favours whichever
    // verse is longer — Quraysh 106:3-4 was labelled 106:4 because 106:4 has twice the
    // words, and the range walk (which only extends forward) could never recover 106:3.
    // The label must name the verse the recitation STARTS in, so decide on the leading words.
    const leadCoverage = (sNum, aNum) => {
      const verse = getQuranAyahWords().get(sNum)?.find(v => v.ayah_id === aNum);
      if (!verse) return 0;
      const inVerse = new Set(verse.words);
      const lead = normalizeArabicDeep(ref.arabic_text ?? '').split(/\s+/).filter(Boolean).slice(0, 3);
      return lead.filter(w => inVerse.has(w)).length;
    };
    const adjacent = disagree && algoMatch.surah_number === claudeSurahNum &&
      Math.abs(algoMatch.ayah_number - claudeAyahNum) === 1;
    const preferAlgo = disagree && (adjacent
      ? leadCoverage(algoMatch.surah_number, algoMatch.ayah_number)
          > leadCoverage(claudeSurahNum, claudeAyahNum)
      : ayahCoverage(algoMatch.surah_number, algoMatch.ayah_number)
          > ayahCoverage(claudeSurahNum, claudeAyahNum) + 0.15);

    // Choose which identification to use:
    //  - Agreed: either (they match)
    //  - Claude only: trust Claude, algorithm couldn't confirm
    //  - Algorithm only: use algorithm, Claude was uncertain
    //  - Disagreement: whichever verse the words belong to (above), defaulting to Claude
    const useClaude = claudeIdentified && !preferAlgo;
    const surahNum  = useClaude ? claudeSurahNum  : (algoMatch?.surah_number ?? null);
    const ayahNum   = useClaude ? claudeAyahNum   : (algoMatch?.ayah_number  ?? null);
    const surahName = useClaude ? (ref.surah_name ?? algoMatch?.surah_name ?? null)
                                : (algoMatch?.surah_name ?? null);

    if (!surahNum || !ayahNum) {
      return {
        detected_text: ref.arabic_text,
        matched: false,
        surah_name: null, surah_number: null, ayah_number: null,
        quran_link: null, confidence: 0,
        verification: 'no_match',
      };
    }

    const quranLink = `https://quran.com/${surahNum}/${ayahNum}`;
    const confidence = bothAgree
      ? Math.max(algoMatch.confidence, 0.95)   // both agree → high confidence
      : claudeIdentified && !algoMatch
        ? 0.85                                  // Claude only
        : disagree
          ? 0.75                                // disagreement — flagged
          : (algoMatch?.confidence ?? 0.7);     // algorithm only

    return {
      detected_text: ref.arabic_text,
      matched: true,
      surah_name: surahName,
      surah_number: surahNum,
      ayah_number: ayahNum,
      quran_link: quranLink,
      confidence: Math.round(confidence * 100) / 100,
      verification: bothAgree    ? 'claude+algorithm'
                  : disagree     ? `DISAGREEMENT:claude=${claudeSurahNum}:${claudeAyahNum},algo=${algoMatch.surah_number}:${algoMatch.ayah_number}${preferAlgo ? ',used=algo' : ',used=claude'}`
                  : claudeIdentified ? 'claude_only'
                  : 'algorithm_only',
    };
  });

  if (!hadithCorpus) hadithCorpus = loadHadithCorpus();
  const claudeHadithRefs = deduplicateHadithRefs(
    (analysis.hadith_references ?? []).map(ref => {
      const match = findMatchingHadith(ref.arabic_text ?? '', hadithCorpus);
      return {
        detected_text: ref.arabic_text,
        narrator: ref.narrator ?? null,
        collection: match ? match.collection : (ref.collection ?? null),
        hadith_number: match ? match.number : null,
        link: match ? match.link : null,
        confidence: match ? match.confidence : null,
        detection_method: 'signal_phrase',
        note: match ? 'Matched against local corpus' : 'Manual verification recommended',
      };
    })
  );

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

  // Step 8c: Scan for Hadith references
  process.stdout.write('Scanning transcript for Hadith references...');
  const hadithScanRefs = scanTranscriptForHadith(transcript, claudeHadithRefs, hadithCorpus);
  console.log(` found ${hadithScanRefs.length} additional`);
  const allHadithRefs = deduplicateHadithRefs([...claudeHadithRefs, ...hadithScanRefs]);

  // Step 8d: Replace corpus numbers/links with canonical sunnah.com permalinks
  // (searches sunnah.com for each matn; falls back to the corpus link on any failure).
  process.stdout.write('Resolving sunnah.com links...');
  await resolveSunnahLinksForRefs(allHadithRefs, transcript);
  console.log(` ${allHadithRefs.filter(r => r.verification === 'sunnah_search').length}/${allHadithRefs.length} verified`);

  // Step 9: Assemble final output object
  const matchedCount = allQuranRefs.filter(r => r.matched).length;
  const secondKhutbah = singleKhutbah
    ? null
    : locateSecondKhutbah(analysis.second_khutbah_start, transcript, transcriptSegments, transcriptWordTimes);
  if (singleKhutbah) console.log('✓ Single-khutbah mode: split detection skipped');
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
    // Corpus-scan finds, not shown (see deduplicateHadithRefs); kept for review.
    hadith_scan_suggestions: hadithScanRefs,
    transcript_segments: transcriptSegments,
    transcript_words: transcriptWordTimes,
    metadata: {
      processed_at: new Date().toISOString(),
      transcription_mode: useLocal ? `local:${localModel}` : useGroq ? 'groq:whisper-large-v3' : useGemini ? 'gemini:2.5-flash' : 'openai:whisper-1',
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
  const { planQuoteSwaps } = await import('./core/quote_swaps.js');
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
  console.log(`✓ ${allHadithRefs.length} Hadith references detected (${hadithScanRefs.length} more corpus-scan suggestions not shown)`);
  console.log(`✓ Results saved to outputs/${timestamp}_${audioBasename}/  (transcript.txt, result.json, readable.txt, reader.txt)`);
}

// Only run main() when this file is executed directly (not imported)
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch(e => {
    console.error(`Unexpected error: ${e.message}`);
    process.exit(1);
  });
}

export {
  ANALYSIS_PROMPT,
  buildAnalysisPrompt,
  KHUTBAH_TYPES,
  buildReaderView,
  buildReadableOutput,
  buildProseChunks,
  locateSecondKhutbah,
  splitChunkAtKhutbahBoundary,
  prescanForQuranZones,
  buildZoneRefs,
  annotateRefAyahRange,
  yieldTailToLaterRefs,
  scanTranscriptForQuran,
  scanTranscriptForHadith,
  deduplicateHadithRefs,
  isLiturgicalFormula,
  stripAyahMarkup,
  findMatchingAyah,
  findMatchingHadith,
  loadHadithCorpus,
  resolveSunnahLinksForRefs,
  parseSunnahNarrator,
  chooseNarrator,
  nameKeys,
  fetchSunnahPage,
  cachedSunnahPage,
  publishedVerseEnglish,
  applyQuoteSwaps,
  normalizeArabic,
  normalizeArabicDeep,
  getQuranNgramIndex,
  extractMatn,
  transcribeWithGroq,
  transcribeWithGroqWindowed,
  preprocessAudio,
  SILENCE_PREPEND_SEC,
  alignWordTimestamps,
  combineTimings,
  retimeUnanchoredGaps,
  interpolateAnchors,
  settleLoneWords,
  buildSegmentsFromWordTimes,
};
