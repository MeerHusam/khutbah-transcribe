#!/usr/bin/env node
// tts.js — An English voice for a khutbah (first try, 30 Sep 2026). Reads each reader block's
// English aloud with a free model that runs locally, and writes one audio track the page can
// play in place of the imam's. Two engines:
//  - kokoro (default, tts_kokoro.py): Kokoro-82M, stock voices, fast (~4x real time).
//  - chatterbox (tts_chatterbox.py): Chatterbox in the voice of a reference clip (--ref),
//    which also carries the speaker's accent; slower.
//
//  - Blocks are the page's blocks (reader_chunks.js), so the English track and the reader
//    highlight line up block for block.
//  - Prose: the block's English with the reference badge lines left out. Honorifics the
//    translation keeps in Arabic (تعالى, صلى الله عليه وسلم …) are spoken in English.
//  - A verse card: the verse's English (Sahih International), cut to the part the imam recited
//    when the card shows only that part (verse_excerpts), as the page does.
//  - The Quran itself is never synthesised: only its English meaning is spoken.
//  - Arabic names and terms are said as in Arabic: from tts_lexicon.txt (kokoro), or from the
//    reference speaker's own way of saying them (chatterbox).
// Writes tts_en.mp3 (the track) and tts_en.json (voice, and each block's start/end in the
// track, with its opening Arabic words so a rebuilt reader cannot be paired with stale times).
//
// Usage: node tts.js outputs/<folder> [--engine kokoro|chatterbox] [--limit N] [--dry-run]
//   kokoro:     [--voice am_michael] [--speed 1]
//   chatterbox: --ref audio_files/voice_ref/<clip>.wav [--exaggeration 0.5] [--cfg 0.5]
//   --limit N speaks only the first N blocks into tts_en_preview_<voice>.mp3, to listen to;
//     the page's track (tts_en.mp3, tts_en.json) is left as it is.
//   --dry-run prints the text of every block and makes no audio.
// Needs: kokoro: ./.venv/bin/pip install kokoro-onnx soundfile, and in models/kokoro/ the
//   files kokoro-v1.0.onnx and voices-v1.0.bin from
//   https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0
//   chatterbox: see the header of tts_chatterbox.py (.venv-tts).

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname, resolve, basename } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { loadResult } from './reader_chunks.js';
import './public/recited.js';

const { recitedSpans } = globalThis.KTRecited;
const ROOT = dirname(fileURLToPath(import.meta.url));
const MODEL_DIR = join(ROOT, 'models', 'kokoro');

const args = process.argv.slice(2);
const folder = args[0];
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const engine = opt('--engine', 'kokoro');
const voice = opt('--voice', 'am_michael');
const speed = +opt('--speed', '1');
const ref = opt('--ref', null);
const exaggeration = +opt('--exaggeration', '0.5');
const cfgWeight = +opt('--cfg', '0.5');
const limit = +opt('--limit', '0');
const dryRun = args.includes('--dry-run');
if (!folder || !existsSync(join(folder, 'result.json')) || !['kokoro', 'chatterbox'].includes(engine)
    || (engine === 'chatterbox' && !dryRun && !(ref && existsSync(ref)))) {
  console.error('Usage: node tts.js outputs/<folder> [--engine kokoro|chatterbox] [--limit N] [--dry-run]\n'
    + '  kokoro: [--voice am_michael] [--speed 1]   chatterbox: --ref <clip.wav> [--exaggeration 0.5] [--cfg 0.5]');
  process.exit(1);
}

const quran = JSON.parse(readFileSync(join(ROOT, 'node_modules/quran-json/dist/quran.json'), 'utf8'));
const quranEn = JSON.parse(readFileSync(join(ROOT, 'node_modules/quran-json/dist/quran_en.json'), 'utf8'));
const verseAr = (s, a) => quran[s - 1]?.verses?.find(v => v.id === a)?.text ?? '';
const verseEn = (s, a) => quranEn[s - 1]?.verses?.find(v => v.id === a)?.translation?.trim() ?? '';
const words = t => (t ?? '').split(/\s+/).filter(Boolean);
// The English Quran text often ends a verse without punctuation ("…of the elephant"); read a
// passage as separate sentences rather than one run.
const joinVerses = texts => texts.filter(Boolean).map(t => t.trim())
  .map(t => (/[.!?,;:"”’]$/.test(t) ? t : t + '.')).join(' ');

// Arabic the English keeps, as it is said in English. Supplications are set off by commas
// ("Ibrahim, peace be upon him, called"); epithets are not ("Allah the Most High says").
// Longest first, so "سبحانه وتعالى" is not read as "سبحانه" + "تعالى".
const HONORIFICS = [
  ['صلى الله عليه وسلم', ', peace and blessings be upon him,'],
  ['ﷺ', ', peace and blessings be upon him,'],
  ['رضي الله عنهما', ', may Allah be pleased with them both,'],
  ['رضي الله عنهم', ', may Allah be pleased with them,'],
  ['رضي الله عنها', ', may Allah be pleased with her,'],
  ['رضي الله عنه', ', may Allah be pleased with him,'],
  ['عليهم السلام', ', peace be upon them,'],
  ['عليه السلام', ', peace be upon him,'],
  ['رحمه الله', ', may Allah have mercy on him,'],
  ['سبحانه وتعالى', ', Glorified and Exalted is He,'],
  ['تبارك وتعالى', ', Blessed and Exalted is He,'],
  ['جل جلاله', ', exalted is His majesty,'],
  ['جل وعلا', ', Exalted and Majestic is He,'],
  ['عز وجل', ' the Mighty and Majestic'],
  ['سبحانه', ', Glorified is He,'],
  ['تعالى', ' the Most High'],
];
const bareAr = s => s.replace(/[ً-ٰٟـ]/g, '');

function speakArabic(run) {
  let s = bareAr(run).trim();
  for (const [ar, en] of HONORIFICS) s = s.split(ar).join(` ${en} `);
  return ' ' + s.replace(/[؀-ۿﭐ-﷿ﹰ-﻿]+/g, ' ') + ' ';
}

function cleanEnglish(text) {
  return text
    .replace(/[؀-ۿﭐ-﷿ﹰ-﻿][؀-ۿﭐ-﷿ﹰ-﻿\s]*/g, speakArabic)
    .replace(/[[\]]/g, '')             // Sahih International's added words are read as words
    .replace(/\s*[—–]\s*|\s+-\s+/g, ', ')
    .replace(/,(?=[A-Za-z])/g, ', ')
    .replace(/·/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/,\s*,+/g, ',')
    .replace(/([.;:!?]),|,([.;:!?])/g, '$1$2')
    .replace(/^[\s,]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// The verse English a card shows: the recited part when the page cuts the verse to it,
// otherwise the whole verse (or passage). Mirrors enhanceQuranRefs in public/index.html.
function verseSpeech(chunk, s, a, e, excerpts) {
  const nums = [];
  for (let n = a; n <= e && nums.length < 25; n++) nums.push(n);
  const ar = nums.map(n => verseAr(s, n));
  const en = nums.map(n => verseEn(s, n));
  if (ar.some(t => !t)) return joinVerses(en);
  const spans = recitedSpans(chunk.arabic, ar);
  const lens = ar.map(t => words(t).length);
  const whole = spans.map((sp, i) => sp && sp[0] <= 1 && sp[1] >= lens[i] - 2);
  const partial = spans.some(Boolean) && !whole.every(Boolean);
  const ex = partial && excerpts.find(x => x.arabic === chunk.arabic && x.surah === s && x.ayah === a);
  if (ex) {
    const out = [];
    for (let i = 0; i < nums.length; i++) {
      if (!spans[i]) continue;
      const t = whole[i] ? en[i] : ex.verses?.[nums[i]]?.en;
      if (!t) return joinVerses(en);
      out.push(t);
    }
    return joinVerses(out);
  }
  return joinVerses(en);
}

function blockSpeech(chunk, excerpts) {
  const out = [];
  for (const part of chunk.english.split(/\n\n+/)) {
    const verse = part.match(/^📖\s+.+?\s+(\d+):(\d+)(?:\s*-\s*(\d+))?\s+—/);
    if (verse) out.push(verseSpeech(chunk, +verse[1], +verse[2], +(verse[3] ?? verse[2]), excerpts));
    else if (/^\s*[📖📑📚]/u.test(part)) continue; // badge line: the reference, not speech
    else out.push(part);
  }
  return cleanEnglish(out.join(' '));
}

const result = loadResult(folder);
const chunks = result.reader_chunks ?? [];
if (!chunks.length) { console.error(`No reader blocks in ${folder}`); process.exit(1); }
const excerpts = result.verse_excerpts ?? [];
const blocks = chunks
  .map((c, i) => ({ i, arabic_head: words(c.arabic).slice(0, 6).join(' '), text: blockSpeech(c, excerpts) }))
  .filter(b => b.text)
  .slice(0, limit || undefined);

if (dryRun) {
  for (const b of blocks) console.log(`[${b.i}] ${b.text}\n`);
  console.log(`${blocks.length} of ${chunks.length} blocks, ${blocks.reduce((n, b) => n + b.text.length, 0)} characters`);
  process.exit(0);
}

if (engine === 'kokoro') {
  for (const f of ['kokoro-v1.0.onnx', 'voices-v1.0.bin']) {
    if (!existsSync(join(MODEL_DIR, f))) { console.error(`Missing ${join('models/kokoro', f)} — see the header of tts.js`); process.exit(1); }
  }
}

// A preview is named after its voice, so previews of different voices sit side by side.
const voiceName = engine === 'chatterbox' ? basename(ref).replace(/\.[^.]+$/, '') : voice;
const base = limit ? `tts_en_preview_${voiceName}` : 'tts_en';
const wav = join(folder, `${base}.wav`);
const job = {
  block_pause: 0.7, sentence_pause: 0.2,
  out: resolve(wav),
  blocks: blocks.map(({ i, text }) => ({ i, text })),
  ...(engine === 'kokoro' ? {
    model: join(MODEL_DIR, 'kokoro-v1.0.onnx'),
    voices: join(MODEL_DIR, 'voices-v1.0.bin'),
    voice, speed,
    lang: voice.startsWith('b') ? 'en-gb' : 'en-us',
    lexicon: join(ROOT, 'tts_lexicon.txt'),
  } : {
    ref: resolve(ref), exaggeration, cfg_weight: cfgWeight,
  }),
};
const [python, script] = engine === 'kokoro'
  ? [join(ROOT, '.venv', 'bin', 'python'), 'tts_kokoro.py']
  : [join(ROOT, '.venv-tts', 'bin', 'python'), 'tts_chatterbox.py'];
console.log(`Speaking ${blocks.length} blocks with ${engine === 'kokoro' ? `Kokoro (${voice}, speed ${speed})` : `Chatterbox (voice of ${ref})`}...`);
const began = Date.now();
const py = spawnSync(python, [join(ROOT, script)], {
  cwd: ROOT, input: JSON.stringify(job),
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'inherit'],
});
if (py.status !== 0) { console.error(`${script} failed`); process.exit(1); }
// The times are the last line: libraries print their own lines on stdout too (Chatterbox's
// watermarker says "loaded PerthNet …").
const times = new Map(JSON.parse(py.stdout.trim().split('\n').at(-1)).map(t => [t.i, t]));

const mp3 = join(folder, `${base}.mp3`);
const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-ac', '1', '-b:a', '48k', mp3], { stdio: 'inherit' });
if (ff.status !== 0) { console.error('ffmpeg failed'); process.exit(1); }
unlinkSync(wav);
const took = ((Date.now() - began) / 60000).toFixed(1);

if (limit) {
  const end = times.get(blocks.at(-1).i)?.end ?? 0;
  console.log(`Wrote ${mp3}: first ${blocks.length} blocks, ${(end / 60).toFixed(1)} min of audio in ${took} min`);
  process.exit(0);
}

const manifest = {
  engine: engine === 'kokoro' ? 'kokoro-82m-v1.0' : 'chatterbox',
  ...(engine === 'kokoro' ? { voice, speed } : { voice: ref.split('/').pop(), exaggeration, cfg_weight: cfgWeight }),
  created: new Date().toISOString(),
  audio: 'tts_en.mp3',
  blocks: blocks.map(b => ({ ...b, start: times.get(b.i)?.start, end: times.get(b.i)?.end })),
};
writeFileSync(join(folder, 'tts_en.json'), JSON.stringify(manifest, null, 1));
const last = manifest.blocks.at(-1);
console.log(`Wrote ${mp3} (${(last.end / 60).toFixed(1)} min of audio in ${took} min) and tts_en.json`);
