#!/usr/bin/env node
// align_imam.js — When each word of the imam's recording is spoken, for word-by-word
// follow-along in the Arabic while he plays.
//
//   node align_imam.js outputs/<folder> audio_files/<recording>.m4a
//
// Writes words_imam.json in the folder: each reader block's Arabic with [[word, start, end],
// ...] in seconds of the recording. The aligner is align_words.py (Meta's MMS model, offline,
// no API), given the block's stretch of the recording and the Arabic the transcript has for
// it. A block runs from its start to the next block's start; those times come from the
// transcript and are rougher than a voice track's, so align_words.py pads them.

import { spawnSync } from 'child_process';
import { writeFileSync, existsSync } from 'fs';
import { join, dirname, basename, resolve } from 'path';
import { fileURLToPath } from 'url';
import { loadResult } from './core/reader_chunks.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const [folder, audio] = process.argv.slice(2);
if (!folder || !audio || !existsSync(audio)) {
  console.error('usage: node align_imam.js outputs/<folder> <recording>');
  process.exit(1);
}

const duration = parseFloat(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', audio], { encoding: 'utf8' }).stdout);
const chunks = loadResult(folder).reader_chunks ?? [];
const head = c => c.arabic.split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
const blocks = [];
chunks.forEach((c, i) => {
  if (c.start_time == null || !c.arabic.trim()) return;
  const next = chunks.slice(i + 1).find(n => n.start_time != null);
  blocks.push({ i, arabic_head: head(c), start: c.start_time, end: next ? next.start_time : duration, text: c.arabic });
});

console.log(`Aligning ${blocks.length} blocks of ${basename(audio)} (${(duration / 60).toFixed(1)} min)...`);
const py = spawnSync(join(ROOT, '.venv-align', 'bin', 'python'), [join(ROOT, 'align_words.py'), '-'], {
  input: JSON.stringify({ audio: resolve(audio), lang: 'ar', pad: 0.8, blocks: blocks.map(({ i, start, end, text }) => ({ i, start, end, text })) }),
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'inherit'],
});
if (py.status !== 0) { console.error('align_words.py failed'); process.exit(1); }
const words = new Map(JSON.parse(py.stdout.trim().split('\n').at(-1)).map(b => [b.i, b.words]));

// One block per line, as align_words.py writes the voice tracks.
const out = join(folder, 'words_imam.json');
const lines = blocks.map(b => JSON.stringify({ ...b, text: undefined, words: words.get(b.i) }));
writeFileSync(out, `{\n "audio": ${JSON.stringify(basename(audio))},\n "words_by": "mms_fa",\n "created": ${JSON.stringify(new Date().toISOString())},\n "blocks": [\n  ${lines.join(',\n  ')}\n ]\n}\n`);
console.log(`Wrote ${out}`);
