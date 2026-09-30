#!/usr/bin/env node
// recite.js — Put the imam's own recitation of each verse into a voice track, the way an Urdu
// dars quotes the Quran: the lead-in ("Allah says:") where the track has one, then the verse in
// Arabic in the imam's voice, then its translation. The recitation is never synthesized and
// never sped up: it is cut from his recording and played at its own pace.
//
//   node recite.js outputs/<folder> ur audio_files/<recording> [--lift 2]     (or en)
//
// Rewrites tts_<lang>.mp3 and tts_<lang>.json in place, with every block start and word time
// moved to the new timeline (and the imam's words of each verse, as `arabic_words`), and marks the manifest `recited` so it is never spliced twice
// (tts.js rebuilds the plain track from its cache for nothing). Needs the words in
// tts_<lang>.json (align_words.py), to find where a lead-in ends and the translation starts,
// and words_imam.json (align_imam.js), to find where his recitation starts and ends. No API.

import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { loadResult } from './reader_chunks.js';

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
  console.error('usage: node recite.js outputs/<folder> en|ur <recording>');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
if (manifest.recited) { console.error(`${manifestPath} already has the recitation in it`); process.exit(1); }
if (!manifest.blocks.every(b => Array.isArray(b.words))) { console.error('run align_words.py first'); process.exit(1); }
const imam = JSON.parse(readFileSync(join(folder, 'words_imam.json'), 'utf8')).blocks;

// The verse blocks: a block whose English is only a verse card (📖) is the imam reciting.
const chunks = loadResult(folder).reader_chunks ?? [];
const isVerse = i => {
  const parts = (chunks[i]?.english ?? '').split(/\n\n+/).map(p => p.trim()).filter(Boolean);
  return parts.some(p => p.startsWith('📖')) && parts.every(p => /^[📖📑📚]/u.test(p));
};

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

// The imam's recitation of block `ib`, from just before his first word to just after his last
// (never into the next block's first word), cleaned up, `lift` dB above the voice, with short fades.
function recitation(ib, next) {
  const a = ib.words[0][1] - 0.15;
  const b = Math.min(ib.words.at(-1)[2] + 0.35, next ? next.words[0][1] - 0.05 : Infinity);
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
  const ib = isVerse(b.i) && imam.find(x => x.i === b.i);
  if (!ib || !ib.words?.length) {
    copy(oldStart, oldEnd);
    b.words = b.words.map(w => moved(w, oldStart, start));
  } else {
    const next = imam.find(x => x.i > ib.i && x.words?.length);
    const n = b.text.startsWith(VERSE_INTRO[lang]) ? VERSE_INTRO[lang].split(/\s+/).length : 0;
    const lead = b.words.slice(0, n), rest = b.words.slice(n);
    let restFrom = oldStart;
    if (n && rest.length) {
      copy(oldStart, lead.at(-1)[2] + 0.08);
      quiet(BEFORE);
      restFrom = rest[0][1] - 0.06;
    }
    const clipAt = now();
    const { clip, from } = recitation(ib, next);
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
console.log(`Recitation of ${recited.length} verse block(s) (${recited.join(', ')}) put into ${mp3}: ${(track.length / SR / 60).toFixed(1)} -> ${(len / SR / 60).toFixed(1)} min`);
