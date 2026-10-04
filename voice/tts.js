#!/usr/bin/env node
// tts.js — A voice track for a khutbah (30 Sep 2026): reads each reader block's English
// (--lang en) or another language's text (--lang ur, bn …; core/languages.js) aloud and writes one audio track the page can play in place of
// the imam's, with Gemini TTS (gemini-3.8-flash-tts, tts_gemini.mjs), voice Charon or Orus.
// (The ElevenLabs engine, unused since 1 Oct 2026, was removed on 3 Oct; it is in git history.)
//
//  - Blocks are the page's blocks (reader_chunks.js), so the voice track and the reader
//    highlight line up block for block.
//  - Prose: the block's English with the reference badge lines left out. Honorifics the
//    translation keeps in Arabic (تعالى, صلى الله عليه وسلم …) are spoken in English.
//  - A verse card: the verse's English (Sahih International), cut to the part the imam recited
//    when the card shows only that part (verse_excerpts), as the page does.
//  - The Quran itself is never synthesised: only its English meaning is spoken.
//  - Arabic names and terms: Gemini is told to say them the Arabic way.
// Writes tts_<lang>.mp3 (the track) and tts_<lang>.json (voice, and each block's start/end in the
// track, with its opening Arabic words so a rebuilt reader cannot be paired with stale times).
//
// Usage: node voice/tts.js outputs/<folder> [--lang en|ur] [--voice Charon] [--direct] [--limit N] [--dry-run]
//   --direct: a direction for every sentence (voice_directions.js, from delivery_imam.json when
//     imam_delivery.py has run) and the blocks voiced a passage at a time, then split back into
//     blocks with the word aligner (.venv-align).
//   --limit N speaks only the first N blocks into tts_<lang>_preview_<voice>.mp3, to listen to;
//     the page's track (tts_<lang>.mp3, tts_<lang>.json) is left as it is.
//   --dry-run prints the text of every block and makes no audio.

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { loadResult } from '../core/reader_chunks.js';
import { directions } from './voice_directions.js';
import { LANGS, langOf } from '../core/languages.js';
import '../public/recited.js';

const { recitedSpans } = globalThis.KTRecited;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const folder = args[0];
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const lang = opt('--lang', 'en');
const L = langOf(lang); // undefined for English
const model = opt('--model', 'gemini-3.8-flash-tts');
const voice = opt('--voice', 'Charon');
// Gemini's delivery, given as a style note (text in the transcript itself would be spoken); another
// language's is in its file (voice.style).
const GEMINI_STYLE = 'calm, clear and reverent, at a steady pace, like a translator reading a Friday sermon; Arabic names and Islamic terms (Allah, Muhammad, taqwa, Quraysh, Makkah) pronounced the Arabic way, as a Muslim scholar would';
// With --direct each sentence's note follows this ("… For this sentence: raised, indignant…"); another
// language's is voice.base.
const GEMINI_BASE = 'The English translation of a Friday khutbah, read from the minbar; Arabic names and Islamic terms (Allah, Muhammad, taqwa, Quraysh, Makkah) pronounced the Arabic way, as a Muslim scholar would';
const limit = +opt('--limit', '0');
// Faster delivery without re-generating: ffmpeg's atempo keeps the pitch; times scale with it.
const tempo = +opt('--tempo', '1');
const dryRun = args.includes('--dry-run');
// A direction for every sentence (voice_directions.js, from the imam's delivery
// and the meaning) and the blocks voiced a passage at a time, so the tone carries from one
// block into the next (Orus, 1 Oct 2026).
const direct = args.includes('--direct');
const directEffort = opt('--direct-effort', 'high');
// Characters a passage aims for (about 5 min of Urdu); it ends at the first sentence end past
// 60% of this, and at 150% wherever it is. Was 1,500 until 3 Oct 2026: about 4 requests a khutbah
// per voice instead of 13–16, under the 100 a day per Google project (a request can return up to
// ~655 s of audio; 6,000 characters is about 8 min).
const PASSAGE_CHARS = 4000;
if (!folder || !existsSync(join(folder, 'result.json')) || (lang !== 'en' && !L)) {
  console.error(`Usage: node voice/tts.js outputs/<folder> [--lang en|${LANGS.map(l => l.code).join('|')}] [--voice Charon] [--direct [--direct-effort high]] [--limit N] [--tempo 1.15] [--dry-run]\n'
    + '  --direct: a note per sentence, voiced a passage at a time`);
  process.exit(1);
}

const quran = JSON.parse(readFileSync(join(ROOT, 'node_modules/quran-json/dist/quran.json'), 'utf8'));
const quranEn = JSON.parse(readFileSync(join(ROOT, 'node_modules/quran-json/dist/quran_en.json'), 'utf8'));
const verseAr = (s, a) => quran[s - 1]?.verses?.find(v => v.id === a)?.text ?? '';
const verseEn = (s, a) => quranEn[s - 1]?.verses?.find(v => v.id === a)?.translation?.trim() ?? '';
// The language's verse translation the page shows (core/translate.js; core/langs/<code>.js).
const verseTr = (s, a) => result[L.field]?.verses?.[`${s}:${a}`]?.trim() ?? '';
const words = t => (t ?? '').split(/\s+/).filter(Boolean);
// The English Quran text often ends a verse without punctuation ("…of the elephant"); read a
// passage as separate sentences rather than one run.
const joinVerses = texts => texts.filter(Boolean).map(t => t.trim())
  .map(t => (/[.!?,;:"”’۔।]$/.test(t) ? t : t + (L ? L.sentenceEnd[0] : '.'))).join(' ');

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

// Another language keeps the Arabic honorifics as its speakers say them; only a symbol is spelled
// out (voice.spoken in its file), and a dash becomes its comma.
function cleanTranslation(text) {
  for (const [sign, said] of Object.entries(L.voice.spoken)) text = text.split(sign).join(said);
  return text
    .replace(/[[\]]/g, '')
    .replace(/\s*[—–]\s*|\s+-\s+/g, L.comma)
    .replace(/·/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// The verse translation a card shows: the recited part when the page cuts the verse to it,
// otherwise the whole verse (or passage). Mirrors enhanceQuranRefs in public/reader.html.
function verseSpeech(chunk, s, a, e, excerpts) {
  const nums = [];
  for (let n = a; n <= e && nums.length < 25; n++) nums.push(n);
  const ar = nums.map(n => verseAr(s, n));
  const en = nums.map(n => (L ? verseTr : verseEn)(s, n));
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
      const v = ex.verses?.[nums[i]]; // only an excerpt made for these words
      const t = whole[i] ? en[i] : String(v?.span) === String(spans[i]) && v[lang];
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
const VERSE_INTRO = { en: 'Allah says:', ...Object.fromEntries(LANGS.map(l => [l.code, l.voice.intro])) };
// Only after a finished sentence: text ending in ":" or "said," introduces the verse itself,
// and text ending mid-sentence ("And how can he invoke") runs on into it.
const introduced = text => !/[.!?۔।]["”’)]?\s*$/u.test(text);
const lastAyah = chunk => {
  const refs = [...(chunk?.english ?? '').matchAll(/^[📖📑]\s+.+?\s+(\d+):(\d+)(?:\s*-\s*(\d+))?\s+—/gmu)];
  const m = refs.at(-1);
  return m ? [+m[1], +m[2], +(m[3] ?? m[2])] : null;
};

function blockSpeech(chunk, excerpts, before, prevChunk) {
  const out = [];
  for (const part of (L ? chunk[L.field] ?? '' : chunk.english).split(/\n\n+/)) {
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
  return (L ? cleanTranslation : cleanEnglish)(out.join(' '));
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

// A preview is named after its voice, so previews of different voices sit side by side.
const base = limit ? `tts_${lang}_preview_gemini_${voice}${tempo !== 1 ? `_x${tempo}` : ''}` : `tts_${lang}`;
const wav = join(folder, `${base}.wav`);
// A few seconds of quiet where the imam sits between the two khutbahs, so the second one
// doesn't run straight on from the first (before --tempo, which shortens it a little). It
// goes before the first spoken block of the second khutbah.
const KHUTBAH_PAUSE = 4;
const secondAt = chunks.findIndex(c => c.second_khutbah_start);
const secondBlock = secondAt < 0 ? null : blocks.find(b => b.i >= secondAt)?.i ?? null;
const notes = direct ? await directions({ folder, lang, blocks, effort: directEffort,
  arabic: new Map(blocks.map(b => [b.i, chunks[b.i].arabic])) }) : null;
const job = {
  block_pause: 0.7,
  out: resolve(wav),
  blocks: blocks.map(({ i, text }) => ({ i, text, ...(i === secondBlock ? { pause_before: KHUTBAH_PAUSE } : {}),
    ...(notes ? { parts: notes.get(i) } : {}) })),
  model, voice, style: direct ? (L?.voice.base ?? GEMINI_BASE) : (L?.voice.style ?? GEMINI_STYLE), concurrency: 2,
  ...(direct ? { passages: PASSAGE_CHARS, lang, iso: L?.voice.iso ?? 'eng', whisper: L?.voice.whisper ?? 'en', hear: L ? L.voice.hear : true } : {}),
};
const chars = blocks.reduce((n, b) => n + b.text.length, 0);
console.log(`Speaking ${blocks.length} blocks (${chars} characters) with Gemini ${model} (${voice}, ${lang})...`);
const began = Date.now();
const py = spawnSync(process.execPath, [join(ROOT, 'voice', 'tts_gemini.mjs')], {
  cwd: ROOT, input: JSON.stringify(job),
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'inherit'],
});
if (py.status !== 0) { console.error('tts_gemini.mjs failed'); process.exit(1); }
// The times are the last line: libraries may print their own lines on stdout too.
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
  engine: `gemini:${model}`,
  voice, ...(direct ? { directed: `voice_directions.js (${directEffort})`, passages: PASSAGE_CHARS } : {}),
  lang,
  created: new Date().toISOString(),
  audio: `${base}.mp3`,
  tempo,
  // Word times come with a passage-voiced track (the aligner already ran to split it).
  ...(blocks.every(b => times.get(b.i)?.words) ? { words_by: 'mms_fa (passages)' } : {}),
  blocks: blocks.map(b => {
    const t = times.get(b.i);
    return { ...b, start: at(t?.start), end: at(t?.end), ...(t?.words ? { words: t.words.map(([w, s, e]) => [w, at(s), at(e)]) } : {}) };
  }),
};
writeFileSync(join(folder, `${base}.json`), JSON.stringify(manifest, null, 1));
const last = manifest.blocks.at(-1);
console.log(`Wrote ${mp3} (${(last.end / 60).toFixed(1)} min of audio in ${took} min) and ${base}.json`);
