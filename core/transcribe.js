// Transcription (split out of pipeline.js): audio preprocessing, Groq Whisper and Gemini, and the
// word timings.

import 'dotenv/config';
import { readFileSync, unlinkSync } from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import os from 'os';
import Groq from 'groq-sdk';
import { GoogleGenAI } from '@google/genai';
import { normalizeArabic } from './arabic.js';

// Fallback placeholder keys so importing this module (e.g. server.js live mode)
// never throws when an optional provider key is absent — the API call itself
// will fail with a clear auth error if that provider is actually used.
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || 'not-set' });
const gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || 'not-set' });

// ---- Audio preprocessing ----------------------------------------------------

// Whisper's VAD scores every 30-second chunk for "speech probability".
// Distant mics, AC noise, or uneven volume cause real speech to score below
// the threshold and get silently dropped — at the start AND mid-audio.
//
// Fix:
//   1. Loudness normalise (EBU R128) so quiet speech isn't mistaken for silence
//   2. Highpass at 80 Hz to remove AC hum / low-frequency rumble that confuses VAD
//   3. Prepend 1s silence so the first chunk's attention window starts on real audio
//   4. Convert to 16kHz mono PCM WAV (Whisper's native format — no decode overhead)
// Seconds of silence prepended in preprocessAudio. Whisper times the preprocessed audio, so
// all timestamps are offset by this much vs. the original file the player uses — subtracted back
// in main() after transcription.
const SILENCE_PREPEND_SEC = 1;

function preprocessAudio(audioPath) {
  return new Promise((resolve, reject) => {
    // MP3 at 48kbps mono — ~5 MB for a 15-min khutbah, well under Groq's 25 MB limit.
    // 48kbps is more than enough for speech recognition; Whisper internally works at 16kHz.
    const outPath = audioPath.replace(/\.[^.]+$/, '') + '_preprocessed.mp3';
    const ff = spawn('ffmpeg', [
      '-y',
      '-f', 'lavfi', '-t', String(SILENCE_PREPEND_SEC), '-i', 'aevalsrc=0:s=16000:c=mono',
      '-i', audioPath,
      '-filter_complex',
      '[1:a]highpass=f=80,loudnorm=I=-16:TP=-1.5:LRA=11,aformat=sample_rates=16000:channel_layouts=mono[speech];' +
      '[0:a][speech]concat=n=2:v=0:a=1[out]',
      '-map', '[out]',
      '-ar', '16000', '-ac', '1', '-codec:a', 'libmp3lame', '-b:a', '48k',
      outPath,
    ]);
    ff.stderr.on('data', () => {});
    ff.on('close', code => {
      if (code !== 0) {
        console.warn('[WARN] ffmpeg preprocessing failed — using original file (VAD may drop chunks)');
        resolve(audioPath);
      } else {
        resolve(outPath);
      }
    });
    ff.on('error', () => {
      console.warn('[WARN] ffmpeg not found — skipping preprocessing (install with: brew install ffmpeg)');
      resolve(audioPath);
    });
  });
}

// ---- Transcription backends -------------------------------------------------

// Groq hosts whisper-large-v3 for free — typically ~10s for a 20-min file
// Groq's free tier caps audio-seconds per hour, and a run now makes several timing requests.
// On a 429, wait as long as the error says ("try again in 1m3.5s") and retry, rather than
// failing the run.
async function withGroqRateLimit(call, attempts = 6) {
  for (let i = 1; ; i++) {
    try { return await call(); }
    catch (e) {
      if (e?.status !== 429 || i >= attempts) throw e;
      const m = String(e.message).match(/try again in (?:(\d+)m)?([\d.]+)s/);
      const wait = m ? (+(m[1] ?? 0) * 60 + +m[2]) * 1000 + 1000 : 30_000;
      console.log(`  Groq rate limit — waiting ${Math.ceil(wait / 1000)}s`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

// `prompt: false` for timing-only passes. The prompt biases Whisper's wording toward the
// khutbah's opening formulas, which helps --groq text, but on the preprocessed audio it also
// sends Whisper into repetition loops that swallow speech: a 90 s window came back as
// "ورحمة الله الرحمن الرحيم" three times over (43 words instead of 128). The Gemini hybrid
// takes its text from Gemini, so its timing pass has nothing to gain from the prompt.
async function transcribeWithGroq(audioPath, { prompt = true } = {}) {
  const ext = path.extname(audioPath).toLowerCase().replace('.', '');
  const mimeMap = { mp3: 'audio/mpeg', mp4: 'audio/mp4', m4a: 'audio/mp4',
    wav: 'audio/wav', ogg: 'audio/ogg', webm: 'audio/webm',
    flac: 'audio/flac', opus: 'audio/opus', mpeg: 'audio/mpeg', mpga: 'audio/mpeg' };
  const mime = mimeMap[ext] ?? 'audio/mpeg';
  // Use native File so the filename/type are always set correctly regardless of extension case
  const file = new File([readFileSync(audioPath)], `audio.${ext}`, { type: mime });
  const response = await withGroqRateLimit(() => groq.audio.transcriptions.create({
    file,
    model: 'whisper-large-v3',
    language: 'ar',
    response_format: 'verbose_json',
    timestamp_granularities: ['word', 'segment'],
    ...(prompt ? { prompt: 'بسم الله الرحمن الرحيم، الحمد لله رب العالمين، والصلاة والسلام على رسول الله صلى الله عليه وسلم' } : {}),
  }));
  const text = typeof response === 'string' ? response : response.text;
  const segments = (response.segments ?? []).map(s => ({ start: s.start, end: s.end, text: s.text }));
  const words = (response.words ?? []).map(w => ({ word: w.word, start: w.start, end: w.end }));
  return { text, segments, words };
}

// Cut [start, start+dur) of an audio file to a 16 kHz mono mp3 in the temp dir.
function cutClip(audioPath, start, dur, tag) {
  const clip = path.join(os.tmpdir(), `khutbah_${tag}_${process.pid}_${Math.round(start * 10)}.mp3`);
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(start), '-t', String(dur),
      '-i', audioPath, '-ac', '1', '-ar', '16000', clip]);
    ff.on('error', reject);
    ff.on('close', code => code === 0 ? resolve(clip) : reject(new Error(`ffmpeg exited ${code}`)));
  });
}

function audioDuration(audioPath) {
  return new Promise(resolve => {
    const ff = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audioPath]);
    let out = '';
    ff.stdout.on('data', d => { out += d; });
    ff.on('error', () => resolve(null));
    ff.on('close', () => resolve(parseFloat(out) || null));
  });
}

// Whisper timing over overlapping windows instead of the whole file, with no prompt (see
// transcribeWithGroq). Run over a full khutbah, Whisper sometimes drops a passage outright — on 25 Sep 2026 it skipped ~90 s
// ("من صلى علي صلاة واحدة" … "اللهم اجعل تدبيره") and hallucinated a salutation in its
// place, which left the reader's highlight up to 30 s behind the imam — while the same
// passage as a 100 s clip came back complete and correctly timed. Each window keeps only
// the words in its central part, so every stretch of audio is timed by the window where it
// sits furthest from an edge. Falls back to a single whole-file pass if the audio's
// duration cannot be read.
const TIMING_WINDOW_SEC = 90, TIMING_OVERLAP_SEC = 10;
async function transcribeWithGroqWindowed(audioPath) {
  const total = await audioDuration(audioPath);
  if (!total || total <= TIMING_WINDOW_SEC + TIMING_OVERLAP_SEC) return transcribeWithGroq(audioPath, { prompt: false });
  const step = TIMING_WINDOW_SEC - TIMING_OVERLAP_SEC;
  const starts = [];
  for (let t = 0; t < total - TIMING_OVERLAP_SEC; t += step) starts.push(t);
  const results = new Array(starts.length);
  // A few windows at a time — plenty fast, and gentle on the Groq rate limit.
  for (let b = 0; b < starts.length; b += 3) {
    await Promise.all(starts.slice(b, b + 3).map(async (start, k) => {
      const i = b + k;
      const clip = await cutClip(audioPath, start, TIMING_WINDOW_SEC, 'win');
      try { results[i] = await transcribeWithGroq(clip, { prompt: false }); }
      finally { try { unlinkSync(clip); } catch {} }
    }));
  }
  const words = [], segments = [];
  results.forEach((r, i) => {
    const start = starts[i];
    const lo = i === 0 ? -Infinity : start + TIMING_OVERLAP_SEC / 2;
    const hi = i === starts.length - 1 ? Infinity : start + step + TIMING_OVERLAP_SEC / 2;
    for (const w of r.words ?? []) {
      const t = w.start + start;
      if (t >= lo && t < hi) words.push({ ...w, start: t, end: w.end + start });
    }
    for (const s of r.segments ?? []) {
      const t = s.start + start;
      if (t >= lo && t < hi) segments.push({ ...s, start: t, end: s.end + start });
    }
  });
  return { text: segments.map(s => s.text.trim()).join(' '), segments, words };
}

// Sequence-aligns display words (Gemini) to timed words (Whisper word-level timestamps).
// Returns one start time per display word. Words that match a Whisper word are anchored to
// that word's real audio time; words Whisper missed are linearly interpolated between the
// surrounding anchors. Because matches re-anchor to actual audio at hundreds of points, there
// is no cumulative drift — error stays local to each interpolated gap.
// Uses Needleman-Wunsch global alignment so repeated common tokens stay positionally constrained.
function alignWordTimestamps(displayWords, timedWords) {
  if (!displayWords.length || !timedWords.length) return null;
  return interpolateAnchors(anchorTimes(displayWords, timedWords), displayWords);
}

function alignAnchors(A, B, timedWords, n, m, W, tb) {
  const times = new Array(n).fill(null);
  let i = n, j = m;
  while (i > 0 && j > 0) {
    const dir = tb[i * W + j];
    if (dir === 0) {
      if (A[i - 1] === B[j - 1]) times[i - 1] = timedWords[j - 1].start; // anchor
      i--; j--;
    } else if (dir === 1) { i--; } else { j--; }
  }
  return times;
}

// Raw anchors only: one real audio time per display word, or null where it matched nothing.
function anchorTimes(displayWords, timedWords) {
  const n = displayWords.length, m = timedWords.length;
  if (!n || !m) return new Array(n).fill(null);
  const A = displayWords.map(w => normalizeArabic(w));
  const B = timedWords.map(t => normalizeArabic(t.word));
  const MATCH = 2, MISMATCH = -1, GAP = -1;
  const W = m + 1;
  const score = new Int32Array((n + 1) * W);
  const tb = new Int8Array((n + 1) * W);
  for (let i = 1; i <= n; i++) { score[i * W] = i * GAP; tb[i * W] = 1; }
  for (let j = 1; j <= m; j++) { score[j] = j * GAP; tb[j] = 2; }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diag = score[(i - 1) * W + (j - 1)] + (A[i - 1] === B[j - 1] ? MATCH : MISMATCH);
      const up = score[(i - 1) * W + j] + GAP;
      const left = score[i * W + (j - 1)] + GAP;
      let best = diag, dir = 0;
      if (up > best) { best = up; dir = 1; }
      if (left > best) { best = left; dir = 2; }
      score[i * W + j] = best; tb[i * W + j] = dir;
    }
  }
  return alignAnchors(A, B, timedWords, n, m, W, tb);
}

// Anchor times from several Whisper passes, first source preferred. Each pass drops or
// mis-hears different stretches: the windowed pass recovered the 90 s the whole-file pass
// dropped on 25 Sep, while only the whole-file pass anchored the quiet sitting between the
// two khutbahs on 22 May. Anchors that break time order (a hallucinated word matched far
// from where it belongs) are dropped, keeping the longest time-ordered run.
function combineTimings(displayWords, sources) {
  const per = sources.filter(s => s?.length).map(s => anchorTimes(displayWords, s));
  if (!per.length) return null;
  const merged = displayWords.map((_, k) => per.find(p => p[k] !== null)?.[k] ?? null);
  // Longest non-decreasing subsequence of anchor times (patience sort, O(n log n)).
  const idx = merged.map((t, k) => t === null ? -1 : k).filter(k => k >= 0);
  const tails = [], prev = new Array(idx.length).fill(-1), tailAt = [];
  idx.forEach((k, p) => {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tails[mid] <= merged[k]) lo = mid + 1; else hi = mid; }
    tails[lo] = merged[k]; tailAt[lo] = p; prev[p] = lo > 0 ? tailAt[lo - 1] : -1;
  });
  const keep = new Set();
  for (let p = tailAt[tails.length - 1]; p >= 0; p = prev[p]) keep.add(idx[p]);
  return interpolateAnchors(merged.map((t, k) => keep.has(k) ? t : null), displayWords);
}

// Fill unanchored words by linear interpolation between neighbouring anchors.
// Not across a pause, though: when a run's gap is far longer than its words take to say, the
// gap holds a silence, and spreading the words evenly put them in it. The first word of the
// second khutbah ("الحمد") was timed 15 s into the sitting pause (11 Sep, 22 May, 21 Aug), so
// the highlight moved while the imam was still seated. There the words are packed at speaking
// pace against the anchor they belong to: those up to the run's last sentence end after the
// previous anchor, the rest before the next one. `words` (the display words) gives the
// sentence ends; without it the old even spread is used.
const SPEECH_SEC_PER_WORD = 0.45;
const ENDS_SENTENCE = /[.؟!?:]$/;
function interpolateAnchors(times, words = null) {
  const n = times.length;
  const anchors = [];
  for (let k = 0; k < n; k++) if (times[k] !== null) anchors.push(k);
  if (!anchors.length) return null;
  const anchored = times.map(t => t !== null);
  for (let k = 0; k < anchors[0]; k++) times[k] = times[anchors[0]];
  const last = anchors[anchors.length - 1];
  for (let k = last + 1; k < n; k++) times[k] = times[last];
  for (let a = 0; a < anchors.length - 1; a++) {
    const p = anchors[a], q = anchors[a + 1];
    const tp = times[p], tq = times[q];
    let split = null;
    if (words && tq - tp > (q - p) * 1.5) {
      split = p;
      for (let k = q - 1; k > p; k--) if (ENDS_SENTENCE.test(words[k] ?? '')) { split = k; break; }
      if (split === p && !ENDS_SENTENCE.test(words[p] ?? '')) split = null; // no sentence end: pause unknown
    }
    for (let k = p + 1; k < q; k++) {
      times[k] = split === null ? tp + (tq - tp) * (k - p) / (q - p)
        : k <= split ? tp + (k - p) * SPEECH_SEC_PER_WORD : tq - (q - k) * SPEECH_SEC_PER_WORD;
    }
  }
  times.anchored = anchored; // which times are real audio anchors vs interpolated
  return times;
}

// The same repair for a run already saved, whose anchors are no longer known: a word timed
// alone in a silence (over 5 s from both neighbours) moves next to the word it belongs to, by
// the sentence end on its side. Returns how many words moved; keeps second_khutbah.time in step.
function settleLoneWords(result) {
  const tw = result.transcript_words ?? [];
  let moved = 0;
  for (let i = 1; i < tw.length - 1; i++) {
    const before = tw[i].start - tw[i - 1].start, after = tw[i + 1].start - tw[i].start;
    if (before <= 5 || after <= 5) continue;
    let t = null;
    if (ENDS_SENTENCE.test(tw[i - 1].word)) t = tw[i + 1].start - SPEECH_SEC_PER_WORD;
    else if (ENDS_SENTENCE.test(tw[i].word)) t = tw[i - 1].start + SPEECH_SEC_PER_WORD;
    if (t === null) continue;
    tw[i].start = Math.round(t * 1000) / 1000;
    if (result.second_khutbah?.word_index === i) result.second_khutbah.time = Math.round(t * 10) / 10;
    moved++;
  }
  return moved;
}

// Safety net behind the windowed timing: a long run of display words with no Whisper anchor
// is spread evenly across its gap, which puts the reader's highlight out of step with the
// imam. Re-run Groq on just that stretch (with context either side) and splice its timings
// in, replacing whatever Groq returned inside the gap. One pass, a few short requests at most.
const GAP_MIN_WORDS = 15;
async function retimeUnanchoredGaps(audioPath, displayWords, sources, times) {
  const gaps = [];
  for (let k = 0; k < displayWords.length;) {
    if (times.anchored[k]) { k++; continue; }
    let e = k;
    while (e < displayWords.length && !times.anchored[e]) e++;
    if (e - k >= GAP_MIN_WORDS && (e >= displayWords.length || k === 0 || times[e] - times[k - 1] >= 3)) {
      const from = k > 0 ? times[k - 1] : 0;
      const to = e < displayWords.length ? times[e] : times[displayWords.length - 1] + 5;
      gaps.push({ from, to, words: e - k });
    }
    k = e;
  }
  if (!gaps.length) return null;
  const timedWords = sources[0];
  let merged = timedWords;
  for (const g of gaps.slice(0, 6)) {
    // Whisper needs context: a clip cut tight to the gap can come back empty.
    const start = Math.max(0, g.from - 15), dur = Math.max(g.to + 15 - start, 45);
    let clip = null;
    try {
      clip = await cutClip(audioPath, start, dur, 'gap');
      const res = await transcribeWithGroq(clip, { prompt: false });
      const fresh = (res.words ?? []).map(w => ({ ...w, start: w.start + start, end: w.end + start }))
        .filter(w => w.start > g.from && w.start < g.to);
      merged = [...merged.filter(w => !(w.start > g.from && w.start < g.to)), ...fresh]
        .sort((a, b) => a.start - b.start);
      console.log(`  re-timed a ${g.words}-word gap at ${g.from.toFixed(0)}–${g.to.toFixed(0)}s (${fresh.length} words from a clip)`);
    } catch (e) {
      console.warn(`  [WARN] could not re-time gap at ${g.from.toFixed(0)}s: ${e.message}`);
    } finally {
      if (clip) try { unlinkSync(clip); } catch {}
    }
  }
  return merged === timedWords ? null : combineTimings(displayWords, [merged, ...sources.slice(1)]);
}

// Assigns each timed display word to one of the reference (Whisper) segments by actual time,
// preserving word order. Reuses Whisper's real breath-pause boundaries while placing Gemini's
// richer text in the correct time slots.
function buildSegmentsFromWordTimes(words, times, refSegments) {
  if (!refSegments.length) return [];
  const bucket = refSegments.map(() => []);
  let si = 0;
  for (let k = 0; k < words.length; k++) {
    while (si < refSegments.length - 1 && times[k] >= refSegments[si].end) si++;
    bucket[si].push(words[k]);
  }
  return refSegments
    .map((s, i) => ({ start: s.start, end: s.end, text: bucket[i].join(' ') }))
    .filter(s => s.text);
}

// Gemini 3.5 Flash for transcript quality + Groq Whisper for accurate timestamps (3 Oct 2026: gemini-2.5-flash
// and -pro answer 404 "no longer available to new users" to the key made on 2 Oct. On the 2 Oct Madinah
// khutbah 3.5-flash and 3.1-pro-preview agreed on 99.8% of 1544 words, no broken words; 3.8-flash and
// 3.7-flash answered 503 "high demand". 3.8-flash broke words on 11 Sep).
// Gemini gets the text right (more words, better Arabic); Groq gives real audio-aligned timing.
// We align Gemini's words to Groq's word-level timestamps so each word gets a real audio time.
async function transcribeWithGemini(audioPath) {
  const ext = path.extname(audioPath).toLowerCase().replace('.', '');
  const mimeMap = { mp3: 'audio/mpeg', mp4: 'audio/mp4', m4a: 'audio/mp4',
    wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac' };
  const mimeType = mimeMap[ext] ?? 'audio/mpeg';

  // Run Gemini and Groq in parallel — Gemini for text quality, Groq for timing
  process.stdout.write('Uploading audio to Gemini Files API...');
  const uploadedFile = await gemini.files.upload({
    file: audioPath,
    config: { mimeType, displayName: path.basename(audioPath) },
  });
  let file = uploadedFile;
  while (file.state === 'PROCESSING') {
    await new Promise(r => setTimeout(r, 2000));
    file = await gemini.files.get({ name: file.name });
  }
  if (file.state !== 'ACTIVE') throw new Error(`Gemini file upload failed: ${file.state}`);
  console.log(' done');

  // The markup rules matter as much as the transcription instruction. Left unsaid, the model
  // decorates recited ayahs — and picks DIFFERENT decoration between runs of the same audio
  // (ornate ﴿…﴾ one run, {…} with "*" between verses the next). Anything that is not a spoken
  // word shifts word offsets or lands mid-recitation, which breaks reference alignment.
  // stripAyahMarkup() still cleans the output defensively; this just stops it being needed.
  const geminiPrompt = `Transcribe this Arabic khutbah (Friday sermon) audio exactly as spoken.
Output ONLY the Arabic transcript as plain text with no timestamps, no transliteration, no commentary.
Preserve all Arabic text exactly including Quranic verses and Hadith.

Formatting rules — follow these exactly:
- Write ONLY the spoken words. Do not add any character that was not spoken.
- Do NOT mark, quote, bracket or otherwise set apart Quranic verses or Hadith. Specifically do
  not use ﴿ ﴾ { } " " « » or any other quotation or ornament around them.
- Do NOT insert verse separators such as * or ۞ between consecutive Quranic verses. Recited
  verses run together as continuous text, exactly as the speaker says them.
- Ordinary sentence punctuation (. ، ؟ !) is fine.`;

  process.stdout.write('Transcribing (Gemini text + Groq timing in parallel)...');
  const [geminiResponse, groqResult, groqWindowed] = await Promise.all([
    gemini.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: [{ parts: [{ text: geminiPrompt }, { fileData: { mimeType, fileUri: file.uri } }] }],
      // Transcription has one correct answer, so sample as little as possible. The default
      // temperature of 1.0 is why the same audio produced different ayah markup on
      // consecutive runs. temperature 0 + a fixed seed makes runs repeatable in practice,
      // though the API does not guarantee bit-identical output.
      config: { temperature: 0, seed: 42 },
    }),
    // Two Whisper passes for timing — whole file (as before; its segments still set the
    // chunk boundaries) and overlapping windows — combined per word in combineTimings.
    transcribeWithGroq(audioPath),
    transcribeWithGroqWindowed(audioPath),
  ]);
  console.log(' done');

  await gemini.files.delete({ name: file.name }).catch(() => {});

  const geminiText = (geminiResponse.candidates?.[0]?.content?.parts?.[0]?.text ?? '').trim();
  const groqSegments = groqResult.segments ?? [];
  const groqWords = groqResult.words ?? [];
  // The hybrid already ran Groq for timing — expose its raw text too so callers can
  // compare Gemini vs Groq transcripts without a second transcription pass.
  const groqText = (groqResult.text ?? groqSegments.map(s => s.text).join(' ')).trim();

  if (!groqSegments.length) return { text: geminiText, segments: [], words: [], groqText };

  const geminiWords = geminiText.split(/\s+/).filter(Boolean);

  // Align Gemini's words to Groq's word-level timestamps for real, drift-free timing.
  const sources = [groqWindowed.words ?? [], groqWords];
  let times = combineTimings(geminiWords, sources);
  if (times) times = (await retimeUnanchoredGaps(audioPath, geminiWords, sources, times)) ?? times;
  if (times) {
    const wordTimes = geminiWords.map((word, k) => ({ word, start: Math.round(times[k] * 100) / 100 }));
    const segments = buildSegmentsFromWordTimes(geminiWords, times, groqSegments);
    return { text: geminiText, segments, words: wordTimes, groqText };
  }

  // Fallback: proportional segment mapping if word-level timestamps are unavailable.
  const groqTotalWords = groqSegments.reduce((n, s) => n + s.text.trim().split(/\s+/).filter(Boolean).length, 0);
  const scale = geminiWords.length / Math.max(groqTotalWords, 1);
  const segments = [];
  let gPos = 0;
  for (let i = 0; i < groqSegments.length; i++) {
    const seg = groqSegments[i];
    const groqWordCount = seg.text.trim().split(/\s+/).filter(Boolean).length;
    const count = i === groqSegments.length - 1
      ? geminiWords.length - gPos
      : Math.max(1, Math.round(groqWordCount * scale));
    const slice = geminiWords.slice(gPos, gPos + count);
    if (slice.length) segments.push({ start: seg.start, end: seg.end, text: slice.join(' ') });
    gPos += count;
  }
  return { text: geminiText, segments, words: [], groqText };
}

export {
  preprocessAudio,
  transcribeWithGroq,
  transcribeWithGemini,
  SILENCE_PREPEND_SEC,
  transcribeWithGroqWindowed,
  alignWordTimestamps,
  combineTimings,
  retimeUnanchoredGaps,
  interpolateAnchors,
  settleLoneWords,
  buildSegmentsFromWordTimes,
};
