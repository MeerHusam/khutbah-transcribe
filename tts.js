#!/usr/bin/env node
// tts.js — An English voice for a khutbah (first try, 30 Sep 2026). Reads each reader block's
// English aloud with Kokoro-82M, a free open-weights model that runs locally (tts_kokoro.py),
// and writes one audio track the page can play in place of the imam's.
//
//  - Blocks are the page's blocks (reader_chunks.js), so the English track and the reader
//    highlight line up block for block.
//  - Prose: the block's English with the reference badge lines left out. Honorifics the
//    translation keeps in Arabic (تعالى, صلى الله عليه وسلم …) are spoken in English.
//  - A verse card: the verse's English (Sahih International), cut to the part the imam recited
//    when the card shows only that part (verse_excerpts), as the page does.
//  - The Quran itself is never synthesised: only its English meaning is spoken.
//  - Arabic names and terms are said as in Arabic, from tts_lexicon.txt.
// Writes tts_en.mp3 (the track) and tts_en.json (voice, and each block's start/end in the
// track, with its opening Arabic words so a rebuilt reader cannot be paired with stale times).
//
// Usage: node tts.js outputs/<folder> [--voice am_michael] [--speed 1] [--dry-run]
//   --dry-run prints the text of every block and makes no audio.
// Needs: ./.venv/bin/pip install kokoro-onnx soundfile, and in models/kokoro/ the files
//   kokoro-v1.0.onnx and voices-v1.0.bin from
//   https://github.com/thewh1teagle/kokoro-onnx/releases/tag/model-files-v1.0

import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { loadResult } from './reader_chunks.js';
import './public/recited.js';

const { recitedSpans } = globalThis.KTRecited;
const ROOT = dirname(fileURLToPath(import.meta.url));
const MODEL_DIR = join(ROOT, 'models', 'kokoro');
const PYTHON = join(ROOT, '.venv', 'bin', 'python');

const args = process.argv.slice(2);
const folder = args[0];
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const voice = opt('--voice', 'am_michael');
const speed = +opt('--speed', '1');
const dryRun = args.includes('--dry-run');
if (!folder || !existsSync(join(folder, 'result.json'))) {
  console.error('Usage: node tts.js outputs/<folder> [--voice am_michael] [--speed 1] [--dry-run]');
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
  .filter(b => b.text);

if (dryRun) {
  for (const b of blocks) console.log(`[${b.i}] ${b.text}\n`);
  console.log(`${blocks.length} of ${chunks.length} blocks, ${blocks.reduce((n, b) => n + b.text.length, 0)} characters`);
  process.exit(0);
}

for (const f of ['kokoro-v1.0.onnx', 'voices-v1.0.bin']) {
  if (!existsSync(join(MODEL_DIR, f))) { console.error(`Missing ${join('models/kokoro', f)} — see the header of tts.js`); process.exit(1); }
}

const wav = join(folder, 'tts_en.wav');
console.log(`Speaking ${blocks.length} blocks with Kokoro (${voice}, speed ${speed})...`);
const py = spawnSync(PYTHON, [join(ROOT, 'tts_kokoro.py')], {
  input: JSON.stringify({
    model: join(MODEL_DIR, 'kokoro-v1.0.onnx'),
    voices: join(MODEL_DIR, 'voices-v1.0.bin'),
    voice, speed,
    lang: voice.startsWith('b') ? 'en-gb' : 'en-us',
    block_pause: 0.7, sentence_pause: 0.2,
    lexicon: join(ROOT, 'tts_lexicon.txt'),
    out: resolve(wav),
    blocks: blocks.map(({ i, text }) => ({ i, text })),
  }),
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'inherit'],
});
if (py.status !== 0) { console.error('tts_kokoro.py failed'); process.exit(1); }
const times = new Map(JSON.parse(py.stdout).map(t => [t.i, t]));

const mp3 = join(folder, 'tts_en.mp3');
const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-ac', '1', '-b:a', '48k', mp3], { stdio: 'inherit' });
if (ff.status !== 0) { console.error('ffmpeg failed'); process.exit(1); }
unlinkSync(wav);

const manifest = {
  engine: 'kokoro-82m-v1.0',
  voice, speed,
  created: new Date().toISOString(),
  audio: 'tts_en.mp3',
  blocks: blocks.map(b => ({ ...b, start: times.get(b.i)?.start, end: times.get(b.i)?.end })),
};
writeFileSync(join(folder, 'tts_en.json'), JSON.stringify(manifest, null, 1));
const last = manifest.blocks.at(-1);
console.log(`Wrote ${mp3} (${(last.end / 60).toFixed(1)} min) and tts_en.json`);
