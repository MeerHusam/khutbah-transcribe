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

import 'dotenv/config';
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
const lang = opt('--lang', 'en');
// ElevenLabs stock voices, by name (the API key needs only text-to-speech permission).
const ELEVEN_VOICES = { daniel: 'onwK4e9ZLuTAKqWW03F9', george: 'JBFqnCBsd6RMkjVDRZzb', brian: 'nPczCjzI2devNBz1zQrb', bill: 'pqHfZKP75CvOlQylNhV4' };
const model = opt('--model', engine === 'gemini' ? 'gemini-3.8-flash-tts' : 'eleven_v3');
const voice = opt('--voice', { elevenlabs: 'daniel', gemini: 'Charon' }[engine] ?? 'am_michael');
// Gemini's delivery, given as a style note (text in the transcript itself would be spoken).
const GEMINI_STYLE = {
  en: 'calm, clear and reverent, at a steady pace, like a translator reading a Friday sermon; Arabic names and Islamic terms (Allah, Muhammad, taqwa, Quraysh, Makkah) pronounced the Arabic way, as a Muslim scholar would',
  ur: 'calm, clear and reverent, like a scholar reading the Urdu translation of a Friday sermon in standard Pakistani Urdu; Arabic names and Quranic terms pronounced the Arabic way',
};
const speed = +opt('--speed', '1');
const ref = opt('--ref', null);
const exaggeration = +opt('--exaggeration', '0.5');
const cfgWeight = +opt('--cfg', '0.5');
const limit = +opt('--limit', '0');
// Faster delivery without re-generating: ffmpeg's atempo keeps the pitch; times scale with it.
const tempo = +opt('--tempo', '1');
// ElevenLabs spends paid credits: a run that would cost more than this stops before sending.
const maxCredits = +opt('--max-credits', '2000');
const dryRun = args.includes('--dry-run');
const elevenKey = process.env.ELEVEN_LABS_API_KEY || process.env.ELEVENLABS_API_KEY;
if (!folder || !existsSync(join(folder, 'result.json')) || !['kokoro', 'chatterbox', 'elevenlabs', 'omnivoice', 'gemini'].includes(engine)
    || !['en', 'ur'].includes(lang) || (lang === 'ur' && !['elevenlabs', 'omnivoice', 'gemini'].includes(engine) && !dryRun)
    || (['chatterbox', 'omnivoice'].includes(engine) && !dryRun && !(ref && existsSync(ref)))
    || (engine === 'elevenlabs' && !dryRun && !elevenKey)) {
  console.error('Usage: node tts.js outputs/<folder> [--engine kokoro|chatterbox|elevenlabs|omnivoice] [--lang en|ur] [--limit N] [--tempo 1.15] [--dry-run]\n'
    + '  kokoro: [--voice am_michael] [--speed 1]   chatterbox: --ref <clip.wav> [--exaggeration 0.5] [--cfg 0.5]\n'
    + '  elevenlabs (ELEVEN_LABS_API_KEY in .env): [--model eleven_v3|eleven_flash_v2] [--voice daniel] [--max-credits 2000]\n'
    + '  omnivoice: --ref <clip.wav> (its words in <clip>.txt)   Urdu: elevenlabs (eleven_v3) or omnivoice');
  process.exit(1);
}

const quran = JSON.parse(readFileSync(join(ROOT, 'node_modules/quran-json/dist/quran.json'), 'utf8'));
const quranEn = JSON.parse(readFileSync(join(ROOT, 'node_modules/quran-json/dist/quran_en.json'), 'utf8'));
const verseAr = (s, a) => quran[s - 1]?.verses?.find(v => v.id === a)?.text ?? '';
const verseEn = (s, a) => quranEn[s - 1]?.verses?.find(v => v.id === a)?.translation?.trim() ?? '';
// The Urdu verse translation the page shows (translate_urdu.js; Junagarhi, a placeholder).
const verseUr = (s, a) => result.urdu?.verses?.[`${s}:${a}`]?.trim() ?? '';
const words = t => (t ?? '').split(/\s+/).filter(Boolean);
// The English Quran text often ends a verse without punctuation ("…of the elephant"); read a
// passage as separate sentences rather than one run.
const joinVerses = texts => texts.filter(Boolean).map(t => t.trim())
  .map(t => (/[.!?,;:"”’۔]$/.test(t) ? t : t + (lang === 'ur' ? '۔' : '.'))).join(' ');

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

// Urdu keeps the Arabic honorifics as Urdu speakers say them; only the symbol is spelled out.
function cleanUrdu(text) {
  return text
    .replace(/ﷺ/g, ' صلی اللہ علیہ وسلم ')
    .replace(/[[\]]/g, '')
    .replace(/\s*[—–]\s*|\s+-\s+/g, '، ')
    .replace(/·/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// The verse translation a card shows: the recited part when the page cuts the verse to it,
// otherwise the whole verse (or passage). Mirrors enhanceQuranRefs in public/index.html.
function verseSpeech(chunk, s, a, e, excerpts) {
  const nums = [];
  for (let n = a; n <= e && nums.length < 25; n++) nums.push(n);
  const ar = nums.map(n => verseAr(s, n));
  const en = nums.map(n => (lang === 'ur' ? verseUr : verseEn)(s, n));
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
      const t = whole[i] ? en[i] : ex.verses?.[nums[i]]?.[lang];
      if (!t) return joinVerses(en);
      out.push(t);
    }
    return joinVerses(out);
  }
  return joinVerses(en);
}

// A verse the imam recites without introducing it ("…those who come after." and then the
// verse) gets a short lead-in, so a listener knows the Quran is being quoted. One he
// introduces himself ("…and He said, Glorified and Exalted:"), or one that carries on the
// verse quoted just before it, is left as he said it. Hadith need none: the imam's own "The
// Prophet ﷺ said" is already in the prose.
const VERSE_INTRO = { en: 'Allah says:', ur: 'ارشادِ باری تعالیٰ ہے:' };
// Only after a finished sentence: text ending in ":" or "said," introduces the verse itself,
// and text ending mid-sentence ("And how can he invoke") runs on into it.
const introduced = text => !/[.!?۔]["”’)]?\s*$/u.test(text);
const lastAyah = chunk => {
  const refs = [...(chunk?.english ?? '').matchAll(/^[📖📑]\s+.+?\s+(\d+):(\d+)(?:\s*-\s*(\d+))?\s+—/gmu)];
  const m = refs.at(-1);
  return m ? [+m[1], +m[2], +(m[3] ?? m[2])] : null;
};

function blockSpeech(chunk, excerpts, before, prevChunk) {
  const out = [];
  for (const part of (lang === 'ur' ? chunk.urdu ?? '' : chunk.english).split(/\n\n+/)) {
    const verse = part.match(/^📖\s+.+?\s+(\d+):(\d+)(?:\s*-\s*(\d+))?\s+—/);
    if (verse) {
      const [s, a] = [+verse[1], +verse[2]];
      const text = verseSpeech(chunk, s, a, +(verse[3] ?? verse[2]), excerpts);
      const prev = !out.length && lastAyah(prevChunk);
      const continues = prev && prev[0] === s && a >= prev[1] && a <= prev[2] + 1;
      // Verses the imam says as his own words need no lead-in either: a du'a ("ربنا آتنا…",
      // 2:201) or the closing "سبحان ربك رب العزة…" (37:180).
      const own = /^(?:ربنا|رب)\s/.test(bareAr(chunk.arabic).trim()) || (s === 37 && a === 180);
      if (text) out.push(introduced(out.length ? out.join(' ') : before) || continues || own ? text : `${VERSE_INTRO[lang]} ${text}`);
    } else if (/^\s*[📖📑📚]/u.test(part)) continue; // badge line: the reference, not speech
    else out.push(part);
  }
  return (lang === 'ur' ? cleanUrdu : cleanEnglish)(out.join(' '));
}

const result = loadResult(folder);
const chunks = result.reader_chunks ?? [];
if (!chunks.length) { console.error(`No reader blocks in ${folder}`); process.exit(1); }
const excerpts = result.verse_excerpts ?? [];
let before = '';
const blocks = chunks
  .map((c, i) => {
    const text = blockSpeech(c, excerpts, before, chunks[i - 1]);
    if (text) before = text;
    return { i, arabic_head: words(c.arabic).slice(0, 6).join(' '), text };
  })
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
const voiceName = engine === 'chatterbox' ? basename(ref).replace(/\.[^.]+$/, '')
  : engine === 'omnivoice' ? `omnivoice_${basename(ref).replace(/\.[^.]+$/, '')}`
  : engine === 'elevenlabs' ? `${model}_${voice}`
  : engine === 'gemini' ? `gemini_${voice}` : voice;
const base = limit ? `tts_${lang}_preview_${voiceName}${tempo !== 1 ? `_x${tempo}` : ''}` : `tts_${lang}`;
const wav = join(folder, `${base}.wav`);
const job = {
  block_pause: 0.7, sentence_pause: 0.2,
  out: resolve(wav),
  blocks: blocks.map(({ i, text }) => ({ i, text })),
  ...{
    kokoro: {
      model: join(MODEL_DIR, 'kokoro-v1.0.onnx'),
      voices: join(MODEL_DIR, 'voices-v1.0.bin'),
      voice, speed,
      lang: voice.startsWith('b') ? 'en-gb' : 'en-us',
      lexicon: join(ROOT, 'tts_lexicon.txt'),
    },
    chatterbox: { ref: resolve(ref ?? ''), exaggeration, cfg_weight: cfgWeight },
    omnivoice: {
      ref: resolve(ref ?? ''),
      ref_text: existsSync((ref ?? '').replace(/\.[^.]+$/, '.txt')) ? readFileSync(ref.replace(/\.[^.]+$/, '.txt'), 'utf8').trim() : undefined,
      language: lang,
      ...(lang === 'en' ? { lexicon: join(ROOT, 'tts_lexicon.txt') } : {}),
    },
    gemini: { model, voice, style: GEMINI_STYLE[lang], concurrency: 4 },
    elevenlabs: {
      model, voice: ELEVEN_VOICES[voice] ?? voice, language_code: lang, max_credits: maxCredits,
      // Whole blocks: the model reads a paragraph with better flow than sentence by sentence.
      whole_blocks: 3000,
      // Only Flash v2 honours inline <phoneme> tags; v3 is left to say names its own way.
      ...(lang === 'en' && model === 'eleven_flash_v2' ? { lexicon: join(ROOT, 'tts_lexicon.txt') } : {}),
    },
  }[engine],
};
const [python, script] = {
  kokoro: [join(ROOT, '.venv', 'bin', 'python'), 'tts_kokoro.py'],
  chatterbox: [join(ROOT, '.venv-tts', 'bin', 'python'), 'tts_chatterbox.py'],
  elevenlabs: [join(ROOT, '.venv', 'bin', 'python'), 'tts_elevenlabs.py'],
  omnivoice: [join(ROOT, '.venv-omni', 'bin', 'python'), 'tts_omnivoice.py'],
  gemini: [process.execPath, 'tts_gemini.mjs'],
}[engine];
const chars = blocks.reduce((n, b) => n + b.text.length, 0);
console.log(`Speaking ${blocks.length} blocks (${chars} characters) with ${{
  kokoro: `Kokoro (${voice}, speed ${speed})`,
  chatterbox: `Chatterbox (voice of ${ref})`,
  elevenlabs: `ElevenLabs ${model} (${voice}, ${lang})`,
  omnivoice: `OmniVoice (voice of ${ref}, ${lang})`,
  gemini: `Gemini ${model} (${voice}, ${lang})`,
}[engine]}...`);
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
const ff = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, ...(tempo !== 1 ? ['-af', `atempo=${tempo}`] : []),
  '-ac', '1', '-b:a', '64k', mp3], { stdio: 'inherit' });
const at = t => (typeof t === 'number' ? Math.round((t / tempo) * 100) / 100 : t);
if (ff.status !== 0) { console.error('ffmpeg failed'); process.exit(1); }
unlinkSync(wav);
const took = ((Date.now() - began) / 60000).toFixed(1);

if (limit) {
  const end = at(times.get(blocks.at(-1).i)?.end ?? 0);
  console.log(`Wrote ${mp3}: first ${blocks.length} blocks, ${(end / 60).toFixed(1)} min of audio in ${took} min`);
  process.exit(0);
}

const manifest = {
  engine: { kokoro: 'kokoro-82m-v1.0', chatterbox: 'chatterbox', elevenlabs: `elevenlabs:${model}`, omnivoice: 'omnivoice', gemini: `gemini:${model}` }[engine],
  ...{
    kokoro: { voice, speed },
    chatterbox: { voice: basename(ref ?? ''), exaggeration, cfg_weight: cfgWeight },
    elevenlabs: { voice },
    omnivoice: { voice: basename(ref ?? '') },
    gemini: { voice },
  }[engine],
  lang,
  created: new Date().toISOString(),
  audio: `${base}.mp3`,
  tempo,
  blocks: blocks.map(b => ({ ...b, start: at(times.get(b.i)?.start), end: at(times.get(b.i)?.end) })),
};
writeFileSync(join(folder, `${base}.json`), JSON.stringify(manifest, null, 1));
const last = manifest.blocks.at(-1);
console.log(`Wrote ${mp3} (${(last.end / 60).toFixed(1)} min of audio in ${took} min) and ${base}.json`);
