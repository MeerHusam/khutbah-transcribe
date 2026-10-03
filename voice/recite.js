#!/usr/bin/env node
// recite.js — Put the imam's own recitation of each verse into a voice track, the way an Urdu
// dars quotes the Quran: the lead-in ("Allah says:") where the track has one, then the verse in
// Arabic in the imam's voice, then its translation. The recitation is never synthesized and
// never sped up: it is cut from his recording and played at its own pace.
//
//   node voice/recite.js outputs/<folder> ur audio_files/<recording> [--lift 2]     (or en)
//
// A verse quoted inside a prose block (📑) gets the same: his recitation goes in just before
// the verse's translation, which the voice reads in quotation marks.
//
// Rewrites tts_<lang>.mp3 and tts_<lang>.json in place, with every block start and word time
// moved to the new timeline (and the imam's words of each verse, as `arabic_words`), and marks the manifest `recited` so it is never spliced twice
// (tts.js rebuilds the plain track from its cache for nothing). Needs the words in
// tts_<lang>.json (align_words.py), to find where a lead-in ends and the translation starts,
// and words_imam.json (align_imam.js), to find where his recitation starts and ends. No API.

import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { loadResult } from '../core/reader_chunks.js';

const SR = 24000;
const VERSE_INTRO = { en: 'Allah says:', ur: 'ارشادِ باری تعالیٰ ہے:' }; // as tts.js
const BEFORE = 0.35, AFTER = 0.5; // seconds of quiet either side of the recitation
// The recitation is a room recording: the same measured loudness as the voice sounds farther
// and quieter (some of it is the echo, it is duller, and it swings more between loud and soft).
// So it is cleaned up a little (the rumble cut, some presence added, the swings evened out)
// and set --lift dB above the voice's loudness (LUFS).
const CLEAN = 'highpass=f=90,equalizer=f=3000:t=q:w=1.2:g=3,acompressor=threshold=0.1:ratio=3:attack=10:release=150';

const [folder, lang, recording] = process.argv.slice(2);
const lift = process.argv.includes('--lift') ? +process.argv[process.argv.indexOf('--lift') + 1] : 2;
const manifestPath = join(folder ?? '', `tts_${lang}.json`);
if (!folder || !VERSE_INTRO[lang] || !recording || !existsSync(manifestPath) || !existsSync(recording)) {
  console.error('usage: node voice/recite.js outputs/<folder> en|ur <recording>');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest.recited) { console.error(`${manifestPath} already has the recitation in it`); process.exit(1); }
if (!manifest.blocks.every(b => Array.isArray(b.words))) { console.error('run align_words.py first'); process.exit(1); }
const imam = JSON.parse(readFileSync(join(folder, 'words_imam.json'), 'utf8')).blocks;

// The verse blocks: a block whose English is only a verse card (📖) is the imam reciting.
const loaded = loadResult(folder);
const chunks = loaded.reader_chunks ?? [];
const refs = loaded.quran_references ?? [];
const isVerse = i => {
  const parts = (chunks[i]?.english ?? '').split(/\n\n+/).map(p => p.trim()).filter(Boolean);
  return parts.some(p => p.startsWith('📖')) && parts.every(p => /^[📖📑📚]/u.test(p));
};

// An Arabic word as compared: no diacritics, tatweel, alif or hamza (as the page compares them).
const arKey = w => w.normalize('NFC').replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, '')
  .replace(/[\u0671\u0623\u0625\u0622\u0627\u0621]/g, '').replace(/\u0649/g, '\u064A').replace(/\u0629/g, '\u0647')
  .replace(/\u0624/g, '\u0648').replace(/\u0626/g, '\u064A').replace(/[^\p{L}\p{N}]/gu, '');

// The verses quoted inside block i's prose (📑), as spans of the imam's words there: where the
// words the reference detected in his speech run in the block.
function inlineVerses(i, words) {
  const out = [];
  const have = words.map(w => arKey(w[0]));
  for (const m of (chunks[i]?.english ?? '').matchAll(/^📑\s+.+?\s+(\d+):(\d+)/gmu)) {
    const q = refs.find(r => r.surah_number === +m[1] && r.ayah_number === +m[2] && r.detected_text);
    if (!q) continue;
    const want = q.detected_text.split(/\s+/).map(arKey).filter(Boolean);
    let best = null;
    for (let s = 0; s + want.length <= have.length; s++) {
      const hits = want.filter((w, k) => have[s + k] === w).length;
      if (!best || hits > best.hits) best = { from: s, to: s + want.length - 1, hits, ref: `${m[1]}:${m[2]}` };
    }
    if (best && best.hits >= Math.ceil(want.length * 0.6)) out.push(best);
  }
  return out.sort((x, y) => x.from - y.from);
}

const decode = path => {
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-i', path, '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`ffmpeg could not read ${path}`);
  return new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.length));
};
const track = decode(join(folder, manifest.audio));
const voice = decode(recording);
const at = t => Math.max(0, Math.round(t * SR));

// Samples through an ffmpeg filter, and the integrated loudness (LUFS) of samples.
const filter = (x, af) => {
  const r = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', '-', '-af', af, '-f', 'f32le', '-'],
    { input: Buffer.from(x.buffer, x.byteOffset, x.byteLength), maxBuffer: 1 << 30 });
  return new Float32Array(r.stdout.buffer.slice(r.stdout.byteOffset, r.stdout.byteOffset + r.stdout.length));
};
const lufs = x => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', '-', '-af', 'ebur128', '-f', 'null', '-'],
    { input: Buffer.from(x.buffer, x.byteOffset, x.byteLength), maxBuffer: 1 << 30 });
  return parseFloat(r.stderr.toString().split('Summary:').at(-1).match(/I:\s+(-?[\d.]+) LUFS/)[1]);
};
const trackLufs = lufs(track);

// The imam saying `words`, from just before the first to just after the last (never into the
// word that follows, at `nextStart`), cleaned up, `lift` dB above the voice, with short fades.
function recitation(words, nextStart) {
  const a = words[0][1] - 0.15;
  const b = Math.min(words.at(-1)[2] + 0.35, nextStart - 0.05);
  const clean = filter(voice.slice(at(a), at(b)), CLEAN);
  const gain = trackLufs + lift - lufs(clean);
  const clip = filter(clean, `volume=${gain.toFixed(2)}dB,alimiter=limit=0.95:attack=5:release=50:level=disabled`);
  const fadeIn = at(0.03), fadeOut = at(0.15);
  for (let k = 0; k < clip.length; k++) clip[k] *= Math.min(1, k / fadeIn, (clip.length - 1 - k) / fadeOut);
  return { clip, from: a };
}

const out = [];
let len = 0; // samples written so far
const put = x => { out.push(x); len += x.length; };
const copy = (a, b) => { if (b > a) put(track.slice(at(a), at(b))); };
const quiet = s => put(new Float32Array(at(s)));
const now = () => len / SR;
const moved = (w, from, to) => [w[0], +(w[1] - from + to).toFixed(2), +(w[2] - from + to).toFixed(2)];

const blocks = [...manifest.blocks].sort((x, y) => x.start - y.start);
const recited = [];
let cursor = 0; // seconds of the old track copied so far
for (const b of blocks) {
  const [oldStart, oldEnd] = [b.start, b.end];
  copy(cursor, oldStart); // the pause before the block, as it was
  const start = now();
  const ib = imam.find(x => x.i === b.i && x.words?.length);
  const next = ib && imam.find(x => x.i > ib.i && x.words?.length);
  const nextStart = next ? next.words[0][1] : Infinity;
  const inline = ib && !isVerse(b.i) ? inlineVerses(b.i, ib.words) : [];
  if (inline.length) {
    // Each verse's translation starts at an opening quotation mark: the one whose place in the
    // block is nearest the verse's place in the Arabic (a block can quote a hadith too).
    const quotes = b.words.map((w, k) => (/^[“"«]/u.test(w[0]) ? k : -1)).filter(k => k >= 0);
    const cuts = [];
    for (const v of inline) {
      const r = v.from / ib.words.length;
      const q = quotes.filter(k => !cuts.length || k > cuts.at(-1).k)
        .sort((x, y) => Math.abs(x / b.words.length - r) - Math.abs(y / b.words.length - r))[0];
      if (q != null) cuts.push({ k: q, v });
      else console.error(`  block ${b.i}: no quotation mark for ${v.ref} in the ${lang} text; left without recitation`);
    }
    let from = oldStart, k0 = 0;
    const words = [], arabic = [];
    for (const { k, v } of cuts) {
      const cut = b.words[k][1] - 0.06;
      const segAt = now();
      copy(from, cut);
      words.push(...b.words.slice(k0, k).map(w => moved(w, from, segAt)));
      quiet(BEFORE);
      const said = ib.words.slice(v.from, v.to + 1);
      const clipAt = now();
      const { clip, from: src } = recitation(said, ib.words[v.to + 1]?.[1] ?? nextStart);
      put(clip);
      arabic.push(...said.map(w => moved(w, src, clipAt)));
      quiet(AFTER);
      [from, k0] = [cut, k];
    }
    const segAt = now();
    copy(from, oldEnd);
    words.push(...b.words.slice(k0).map(w => moved(w, from, segAt)));
    b.words = words;
    if (arabic.length) { b.arabic_words = arabic; recited.push(b.i); }
  } else if (!ib || !isVerse(b.i)) {
    copy(oldStart, oldEnd);
    b.words = b.words.map(w => moved(w, oldStart, start));
  } else {
    const n = b.text.startsWith(VERSE_INTRO[lang]) ? VERSE_INTRO[lang].split(/\s+/).length : 0;
    const lead = b.words.slice(0, n), rest = b.words.slice(n);
    let restFrom = oldStart;
    if (n && rest.length) {
      copy(oldStart, lead.at(-1)[2] + 0.08);
      quiet(BEFORE);
      restFrom = rest[0][1] - 0.06;
    }
    const clipAt = now();
    const { clip, from } = recitation(ib.words, nextStart);
    put(clip);
    const clipEnd = now();
    quiet(AFTER);
    const restAt = now();
    copy(restFrom, oldEnd);
    b.words = [...lead.map(w => moved(w, oldStart, start)), ...rest.map(w => moved(w, restFrom, restAt))];
    b.recitation = [+clipAt.toFixed(2), +clipEnd.toFixed(2)];
    // His words on this track's timeline, so the Arabic can follow while he recites.
    b.arabic_words = ib.words.map(w => moved(w, from, clipAt));
    recited.push(b.i);
  }
  [b.start, b.end] = [+start.toFixed(2), +now().toFixed(2)];
  cursor = oldEnd;
}
copy(cursor, track.length / SR); // the end of the old track after its last block

// Write the track and the manifest (one block per line, as align_words.py writes it).
const pcm = new Float32Array(len);
let o = 0;
for (const x of out) { pcm.set(x, o); o += x.length; }
const mp3 = join(folder, manifest.audio);
const enc = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', '-', '-b:a', '64k', mp3],
  { input: Buffer.from(pcm.buffer) });
if (enc.status !== 0) { console.error('ffmpeg could not write the track'); process.exit(1); }
manifest.recited = { from: basename(recording), blocks: recited };
const head = { ...manifest }; delete head.blocks;
const lines = manifest.blocks.map(b => JSON.stringify(b));
writeFileSync(manifestPath, JSON.stringify(head, null, 1).slice(0, -2) + `,\n "blocks": [\n  ${lines.join(',\n  ')}\n ]\n}\n`);
console.log(`Recitation in ${recited.length} block(s) (${recited.join(', ')}) put into ${mp3}: ${(track.length / SR / 60).toFixed(1)} -> ${(len / SR / 60).toFixed(1)} min`);
