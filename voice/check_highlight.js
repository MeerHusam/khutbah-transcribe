#!/usr/bin/env node
// check_highlight.js — Is the word the page lights while the imam plays the word he is saying?
//
//   node voice/check_highlight.js outputs/<folder> audio_files/<recording> [--samples 20] [--shift 0]
//
// The page lights each Arabic word at its time in words_imam.json (align_imam.js). Until 8 Oct 2026
// that was measured once by hand (25 Sep: median 20 ms); nothing checked a new khutbah's. Here a
// spread of words is heard again: for each, ~3.5 s of the recording around its time goes to Groq's
// Whisper (free) with word timestamps, and the word must be heard within TOLERANCE of where the
// page lights it. A page whose words are off by seconds (fix 29: 30 s behind; fix 33: 15 s into the
// sitting pause) fails; Whisper missing a word now and then does not.
// It also fails when words_imam.json no longer matches the reader's blocks: the server then drops
// the word times and the page lights no word at all.
// Writes highlight_check.json; exit 1 on a failure, 0 when it passes or Groq cannot be reached
// (a warning: the check is skipped, never the page). --shift moves every time, to test the check.

import 'dotenv/config';
import Groq from 'groq-sdk';
import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { loadResult } from '../core/reader_chunks.js';
import { normalizeArabicDeep } from '../core/arabic.js';

const args = process.argv.slice(2);
const opt = (name, d) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : d);
const [folder, audio] = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!folder || !audio || !existsSync(audio)) {
  console.error('usage: node voice/check_highlight.js outputs/<folder> <recording> [--samples 20] [--shift 0]');
  process.exit(1);
}
const SAMPLES = opt('--samples', 20), SHIFT = opt('--shift', 0);
const PAD = 1.5;          // seconds of recording either side of the word sent to Whisper
const TOLERANCE = 0.8;    // a heard word this close to the page's time counts (Whisper's own times are ±0.3 s)
const MIN_HEARD = 0.6;    // at least this share of the sampled words must be heard at all…
const MIN_ON_TIME = 0.85; // …and of those, this share on time

const out = join(folder, 'highlight_check.json');
const finish = (verdict, detail) => {
  writeFileSync(out, JSON.stringify({ checked_at: new Date().toISOString(), verdict, ...detail }, null, 1));
  console.log(`${verdict === 'fail' ? '✗' : verdict === 'skipped' ? '⚠' : '✓'} highlight ${verdict}: ${detail.summary}`);
  process.exit(verdict === 'fail' ? 1 : 0);
};

// 1. The word times must be the ones the page will use (server/khutbahs.js drops them otherwise).
const words = JSON.parse(readFileSync(join(folder, 'words_imam.json'), 'utf8'));
const chunks = loadResult(folder).reader_chunks ?? [];
const head = c => c.arabic.split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
const stale = words.blocks.filter(b => !chunks[b.i] || head(chunks[b.i]) !== b.arabic_head);
if (stale.length) finish('fail', { summary: `${stale.length} block(s) of words_imam.json no longer match the page's blocks: the page would light no word`, stale: stale.map(b => b.i) });
// A block's first word may not be timed before the block before it ends (align_imam.js realigns
// those): the page would light it while the imam is still on the last word, and the voice tracks'
// recitation of an ayah would be cut short (9 Oct 2026: "معنا", "الكافرون").
const timed = words.blocks.filter(b => b.words?.length);
const overlapping = timed.slice(1).filter((b, k) => b.words[0][1] < timed[k].words.at(-1)[2]).map(b => b.i);
if (overlapping.length) finish('fail', { summary: `${overlapping.length} block(s) of words_imam.json start before the block before them ends (blocks ${overlapping.join(', ')}): run voice/align_imam.js again`, overlapping });

// 2. Words to hear: spread evenly over the khutbah, long enough for Whisper to catch alone.
const key = w => normalizeArabicDeep(w).replace(/[^ء-ي]/g, '').replace(/^(?:و|ف)?(?:ب|ل|ك)?(?:ال)?/, '');
const all = words.blocks.flatMap(b => b.words.map(([w, s, e]) => ({ block: b.i, word: w, start: s + SHIFT, end: e + SHIFT })))
  .filter(w => key(w.word).length >= 3 && w.end - w.start >= 0.15);
if (all.length < SAMPLES) finish('skipped', { summary: `only ${all.length} timed words` });
const picked = Array.from({ length: SAMPLES }, (_, k) => all[Math.floor((k + 0.5) * all.length / SAMPLES)]);

// Close enough to be the same word: Whisper and the transcript spell a word differently at times.
const similar = (a, b) => {
  if (a === b) return true;
  if (Math.min(a.length, b.length) >= 3 && (a.includes(b) || b.includes(a))) return true;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return 1 - d[a.length][b.length] / Math.max(a.length, b.length) >= 0.7;
};

// 3. Hear each one. Groq's free tier allows 20 requests a minute: one every 3.2 s.
if (!process.env.GROQ_API_KEY) finish('skipped', { summary: 'no GROQ_API_KEY' });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY, maxRetries: 0 });
const tmp = mkdtempSync(join(tmpdir(), 'kt-highlight-'));
const samples = [];
let errors = 0;
for (const w of picked) {
  const from = Math.max(0, w.start - PAD), clip = join(tmp, `${samples.length}.mp3`);
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', from.toFixed(2), '-t', (w.end - w.start + 2 * PAD).toFixed(2), '-i', audio, '-ac', '1', '-ar', '16000', clip]);
  let heard = null;
  for (let attempt = 1; attempt <= 3 && !heard; attempt++) {
    try {
      const r = await groq.audio.transcriptions.create({
        file: await Groq.toFile(readFileSync(clip), 'clip.mp3'), model: 'whisper-large-v3', language: 'ar',
        response_format: 'verbose_json', timestamp_granularities: ['word'], temperature: 0,
      });
      heard = (r.words ?? []).map(x => ({ word: x.word, start: from + x.start }));
    } catch (e) {
      if (e?.status !== 429 && attempt === 3) { errors++; break; }
      await new Promise(r => setTimeout(r, e?.status === 429 ? 20_000 : 3_000));
    }
  }
  if (heard == null) { samples.push({ ...w, heard: null }); continue; }
  const match = heard.filter(h => similar(key(h.word), key(w.word)))
    .sort((a, b) => Math.abs(a.start - w.start) - Math.abs(b.start - w.start))[0];
  samples.push({ ...w, heard: match ? +(match.start - w.start).toFixed(2) : null, around: heard.map(h => h.word).join(' ') });
  await new Promise(r => setTimeout(r, 3200));
}
rmSync(tmp, { recursive: true, force: true });
if (errors > SAMPLES / 2) finish('skipped', { summary: `Groq did not answer ${errors} of ${SAMPLES} requests`, samples });

// 4. The verdict.
const asked = samples.filter(s => s.around != null);
const found = asked.filter(s => s.heard != null);
const onTime = found.filter(s => Math.abs(s.heard) <= TOLERANCE);
const offs = found.map(s => Math.abs(s.heard)).sort((a, b) => a - b);
const median = offs.length ? offs[Math.floor(offs.length / 2)] : null;
const summary = `${found.length}/${asked.length} sampled words heard, ${onTime.length} of them within ${TOLERANCE} s of where the page lights them (median ${median == null ? '–' : median.toFixed(2)} s)`;
const late = found.filter(s => Math.abs(s.heard) > TOLERANCE).map(s => `${s.word} at ${s.start.toFixed(1)} s: heard ${s.heard > 0 ? '+' : ''}${s.heard} s`);
for (const l of late) console.log(`  off: ${l}`);
const pass = asked.length >= SAMPLES / 2 && found.length >= MIN_HEARD * asked.length && onTime.length >= MIN_ON_TIME * found.length;
finish(pass ? 'pass' : 'fail', { summary, median_offset: median, samples });
