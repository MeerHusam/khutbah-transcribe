#!/usr/bin/env node
// align_imam.js — When each word of the imam's recording is spoken, for word-by-word
// follow-along in the Arabic while he plays.
//
//   node voice/align_imam.js outputs/<folder> audio_files/<recording>.m4a
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
import { loadResult } from '../core/reader_chunks.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [folder, audio] = process.argv.slice(2);
if (!folder || !audio || !existsSync(audio)) {
  console.error('usage: node voice/align_imam.js outputs/<folder> <recording>');
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
const align = jobs => {
  const py = spawnSync(join(ROOT, '.venv-align', 'bin', 'python'), [join(ROOT, 'voice', 'align_words.py'), '-'], {
    input: JSON.stringify({ audio: resolve(audio), lang: 'ar', pad: 0.8, blocks: jobs }),
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'inherit'],
  });
  if (py.status !== 0) { console.error('align_words.py failed'); process.exit(1); }
  return new Map(JSON.parse(py.stdout.trim().split('\n').at(-1)).map(b => [b.i, b.words]));
};
const words = align(blocks.map(({ i, start, end, text }) => ({ i, start, end, text })));

// Each block is aligned alone, padded by 0.8 s, so the words at a boundary can be placed in the
// other block's sound: one block's first word timed before the block before it ends. On 9 Oct 2026
// 12 of 50 boundaries overlapped (the next block's first word early in 9, the last word late in 3);
// the page lit the next word while the imam was still on the last, and the voice tracks' recitation,
// cut to end before the next block's first word, lost 9:40's "معنا" and 12:87's "الكافرون". Blocks
// that overlap are aligned again as one stretch, so the aligner sets the boundary with both texts.
const overlaps = (a, b) => words.get(a.i)?.length && words.get(b.i)?.length && words.get(b.i)[0][1] < words.get(a.i).at(-1)[2];
const runs = [];
for (let k = 0; k + 1 < blocks.length; k++) {
  if (!overlaps(blocks[k], blocks[k + 1])) continue;
  if (runs.at(-1)?.at(-1) === k) runs.at(-1).push(k + 1); else runs.push([k, k + 1]);
}
if (runs.length) {
  const again = align(runs.map((r, n) => ({ i: n, start: blocks[r[0]].start, end: blocks[r.at(-1)].end, text: r.map(k => blocks[k].text).join(' ') })));
  runs.forEach((r, n) => {
    const all = again.get(n) ?? [];
    const counts = r.map(k => words.get(blocks[k].i)?.length ?? 0);
    if (all.length !== counts.reduce((x, y) => x + y, 0)) return; // the words differ: keep the first pass
    let at = 0;
    r.forEach((k, j) => { words.set(blocks[k].i, all.slice(at, at + counts[j])); at += counts[j]; });
  });
  console.log(`  ${runs.length} block boundar${runs.length === 1 ? 'y' : 'ies'} overlapped; aligned again across them`);
}

// One block per line, as align_words.py writes the voice tracks.
const out = join(folder, 'words_imam.json');
const lines = blocks.map(b => JSON.stringify({ ...b, text: undefined, words: words.get(b.i) }));
writeFileSync(out, `{\n "audio": ${JSON.stringify(basename(audio))},\n "words_by": "mms_fa",\n "created": ${JSON.stringify(new Date().toISOString())},\n "blocks": [\n  ${lines.join(',\n  ')}\n ]\n}\n`);
console.log(`Wrote ${out}`);
