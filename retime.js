#!/usr/bin/env node
// retime.js — Redo the word timings of an existing run without re-transcribing its text or
// re-running Claude. Aligns the saved transcript to fresh Groq passes (whole file + windows,
// combined per word, plus the gap re-timing in retimeUnanchoredGaps), writes transcript_words
// into result.json and re-times the existing transcript_segments without moving their
// boundaries.
// Run reanalyze.js afterwards to rebuild reader.txt from the new timings.
//
//   node retime.js outputs/<folder> audio_files/<audio>

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import {
  preprocessAudio, SILENCE_PREPEND_SEC, transcribeWithGroq, transcribeWithGroqWindowed,
  combineTimings, retimeUnanchoredGaps,
} from './pipeline.js';

const [folder, audio] = process.argv.slice(2);
if (!folder || !audio || !existsSync(join(folder, 'result.json')) || !existsSync(audio)) {
  console.error('Usage: node retime.js outputs/<folder> audio_files/<audio>');
  process.exit(1);
}

const resultPath = join(folder, 'result.json');
const result = JSON.parse(readFileSync(resultPath, 'utf8'));
const words = readFileSync(join(folder, 'transcript.txt'), 'utf8').trim().split(/\s+/).filter(Boolean);

console.log('Preprocessing audio...');
const pre = await preprocessAudio(audio);
try {
  console.log('Timing with Groq...');
  const [whole, windowed] = await Promise.all([transcribeWithGroq(pre), transcribeWithGroqWindowed(pre)]);
  const sources = [windowed.words ?? [], whole.words ?? []];
  let times = combineTimings(words, sources);
  if (!times) { console.error('Alignment failed — no Groq words'); process.exit(1); }
  const before = times.anchored.filter(Boolean).length;
  times = (await retimeUnanchoredGaps(pre, words, sources, times)) ?? times;
  console.log(`  anchored words: ${before} -> ${times.anchored.filter(Boolean).length} of ${words.length}`);

  // Groq timed the preprocessed audio (silence prepended) — shift back to the original file.
  const shift = pre !== audio ? SILENCE_PREPEND_SEC : 0;
  result.transcript_words = words.map((word, k) => ({ word, start: Math.max(0, Math.round((times[k] - shift) * 100) / 100) }));
  // Keep the existing segments' word boundaries and only re-time them. Prose chunks are cut
  // at segment boundaries and their translations are matched to chunks by position, so new
  // boundaries would pair every later block with the wrong English.
  const newStart = k => result.transcript_words[Math.min(k, words.length - 1)].start;
  let k = 0;
  const segs = result.transcript_segments ?? [];
  const firstWord = segs.map(s => { const at = k; k += s.text.trim().split(/\s+/).filter(Boolean).length; return at; });
  if (k !== words.length) {
    console.error(`Segments hold ${k} words but the transcript has ${words.length} — not re-timing segments.`);
    process.exit(1);
  }
  result.transcript_segments = segs.map((s, i) => ({
    ...s,
    start: newStart(firstWord[i]),
    end: i + 1 < segs.length ? newStart(firstWord[i + 1]) : newStart(words.length - 1) + 2,
  }));
  writeFileSync(resultPath, JSON.stringify(result, null, 2), 'utf8');
  console.log(`✓ Saved new timings to ${resultPath} — now run: node reanalyze.js ${folder}`);
} finally {
  if (pre !== audio) try { unlinkSync(pre); } catch {}
}
