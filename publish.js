#!/usr/bin/env node
// publish.js — Take a khutbah recording to a publishable state in one command, and stop
// before anything is committed or pushed (Render deploys main).
//
//   1. audio: remux to audio_files/<name>.<ext> with the moov atom first (phone recordings put it
//      last, so the player shows 0:00 until the whole file downloads), optionally trimming
//      silence or the adhan; lossless (-c copy)
//   2. pipeline: node pipeline.js <audio> --gemini [--single] [--type …]   (Claude, Gemini, Groq)
//   3. gate: verify_reader.js must pass
//   4. test set: the khutbah is added to tests/khutbahs.json with its current cards, marked
//      unconfirmed, and test_khutbahs.js --rebuild must pass for every khutbah
//   5. site: a PUBLIC_KHUTBAHS entry in server.js (featured unless --no-feature) and the
//      .gitignore allowlist lines for its audio and output folder
// Then it prints what to check and the git commands. It never commits or pushes.
//
// Usage:
//   node publish.js <recording> --slug 2026-10-02 --title "…" --date "2 October 2026"
//        [--name khutbah-2026-10-02-masjid] [--trim-start 17] [--trim-end 35]
//        [--masjid "Askan AlMaather Mosque" --masjid-ar "جامع إسكان المعذر" --maps-url …]
//        [--speaker "Friday Khutbah"] [--single] [--type friday|arafah|eid]
//        [--from-folder outputs/<run>]   reuse a finished pipeline run instead of step 2
//        [--no-feature] [--review]        --review also runs review_blocks.js (about $0.07)
//        [--keep-audio]                   audio_files/<name>.<ext> is already in place (autopublish.js)
//        [--page reader-ur.html] [--audio <file in audio_files/>]   the entry's own page and recording
//        [--dry-run]                      print the plan, change nothing

import { spawnSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, openSync, readSync, closeSync, readdirSync, statSync } from 'fs';
import { join, extname, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { verifyReader } from './core/verify_reader.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = f => argv.includes(f);
const opt = (f, d = null) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const die = msg => { console.error(`✗ ${msg}`); process.exit(1); };
const step = msg => console.log(`\n── ${msg}`);

const input = argv[0];
const slug = opt('--slug'), title = opt('--title'), date = opt('--date');
if (!input || input.startsWith('--') || !slug || !title || !date) {
  die('usage: node publish.js <recording> --slug <slug> --title "<title>" --date "<d Month yyyy>" [options] (see the header)');
}
if (!/^[a-z0-9-]+$/.test(slug)) die(`slug "${slug}" must be lowercase letters, digits and dashes`);
if (!existsSync(input)) die(`recording not found: ${input}`);
const ext = extname(input).slice(1).toLowerCase();
const name = opt('--name', `khutbah-${slug}-masjid`);
const audioOut = join('audio_files', `${name}.${ext}`);
const trimStart = +opt('--trim-start', 0), trimEnd = +opt('--trim-end', 0);
const fromFolder = opt('--from-folder');
const dryRun = flag('--dry-run');

const serverJs = readFileSync(join(ROOT, 'server.js'), 'utf8');
if (serverJs.includes(`slug: '${slug}'`)) die(`slug "${slug}" is already in PUBLIC_KHUTBAHS`);

const run = (cmd, args) => {
  console.log(`  $ ${cmd} ${args.join(' ')}`);
  if (dryRun) return { status: 0, stdout: '' };
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status !== 0) die(`${cmd} failed (exit ${r.status})`);
  return r;
};

// The top-level box order of an MP4/M4A: the player can start before the download ends
// only when moov comes before mdat.
function moovFirst(file) {
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size, head = Buffer.alloc(16);
    for (let at = 0; at + 8 <= size;) {
      readSync(fd, head, 0, 16, at);
      let len = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (type === 'moov') return true;
      if (type === 'mdat') return false;
      if (len === 1) len = Number(head.readBigUInt64BE(8));
      if (len < 8) return null;
      at += len;
    }
    return null;
  } finally { closeSync(fd); }
}

function duration(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const d = parseFloat(r.stdout);
  if (!Number.isFinite(d)) die(`ffprobe could not read the duration of ${file}`);
  return d;
}

// ── 1. Audio ──────────────────────────────────────────────────────────────────
step(`1. Audio → ${audioOut}`);
const keepAudio = flag('--keep-audio') && existsSync(join(ROOT, audioOut));
if (existsSync(join(ROOT, audioOut)) && !flag('--overwrite-audio') && !keepAudio) die(`${audioOut} exists (pass --overwrite-audio to replace it)`);
const total = duration(input);
const keep = total - trimStart - trimEnd;
if (keep <= 60) die(`only ${keep.toFixed(0)} s would remain after trimming ${total.toFixed(0)} s`);
if (keepAudio) console.log(`  keeping ${audioOut} as it is`);
else run('ffmpeg', ['-v', 'error', '-y', ...(trimStart ? ['-ss', String(trimStart)] : []), '-i', input,
  ...(trimEnd ? ['-t', keep.toFixed(2)] : []), '-c', 'copy', '-movflags', '+faststart', audioOut]);
if (!dryRun && !keepAudio && ['m4a', 'mp4'].includes(ext)) {
  if (moovFirst(join(ROOT, audioOut)) !== true) die(`${audioOut}: moov is not before mdat, the player would not stream it`);
  console.log(`  ✓ moov before mdat; ${duration(audioOut).toFixed(0)} s (was ${total.toFixed(0)} s)`);
}

// ── 2. Pipeline ───────────────────────────────────────────────────────────────
step('2. Pipeline');
let folder = fromFolder;
if (!folder) {
  const pipeArgs = ['pipeline.js', audioOut, '--gemini', ...(flag('--single') ? ['--single'] : []),
    ...(opt('--type') ? ['--type', opt('--type')] : [])];
  const before = new Set(readdirSync(join(ROOT, 'outputs')));
  run('node', pipeArgs);
  if (!dryRun) {
    const made = readdirSync(join(ROOT, 'outputs')).filter(f => !before.has(f) && f.endsWith(`_${name}`));
    if (made.length !== 1) die(`expected one new outputs/*_${name} folder, found ${made.length}`);
    folder = join('outputs', made[0]);
  }
} else {
  console.log(`  reusing ${folder}`);
  if (!basename(folder).endsWith(`_${name}`)) die(`${folder} does not end in _${name}; the site finds its audio by that name (pass --name)`);
}
if (dryRun) { console.log('\n(dry run: stopping before the checks)'); process.exit(0); }
if (!existsSync(join(ROOT, folder, 'result.json'))) die(`${folder}/result.json missing`);
const runName = basename(folder);

// ── 3. Gate ───────────────────────────────────────────────────────────────────
step('3. verify_reader');
const v = verifyReader(folder);
for (const w of v.warnings) console.log(`  ⚠ ${w}`);
for (const f of v.failures) console.log(`  ✗ ${f}`);
if (v.failures.length) die(`verify_reader found ${v.failures.length} problem(s); fix them before publishing`);
console.log(`  ✓ ${v.blocks.length} blocks, ${v.warnings.length} warning(s)`);

// ── 4. Test set ───────────────────────────────────────────────────────────────
step('4. Test set');
const specPath = join(ROOT, 'tests', 'khutbahs.json');
const spec = JSON.parse(readFileSync(specPath, 'utf8'));
if (!spec.khutbahs.some(k => k.slug === slug)) {
  const quran = [];
  for (const b of v.blocks) for (const p of b.englishParas) {
    const m = p.match(v.badgeRe);
    if (m) quran.push(`${p.startsWith('📑') ? '~' : ''}${m[2]}:${m[3]}${m[4] ? '-' + m[4] : ''}`);
  }
  const hadith = (v.result.hadith_references ?? []).map(h => {
    const m = (h.link || '').match(/sunnah\.com\/([a-z]+):([\w.]+)/);
    return m ? `${m[1]}:${m[2]}` : `${(h.collection || '?').toLowerCase().split(/\s+/).pop()}:${h.hadith_number ?? '?'}`;
  });
  spec.khutbahs.unshift({ slug, folder, quran, hadith, hadith_english: {}, corrections: [], confirmed: false });
  writeFileSync(specPath, JSON.stringify(spec, null, 2) + '\n');
  console.log(`  + ${slug}: ${quran.length} verse card(s), ${hadith.length} hadith card(s), unconfirmed`);
}
run('node', ['test_khutbahs.js', '--rebuild']);

// ── 5. Site ───────────────────────────────────────────────────────────────────
step('5. PUBLIC_KHUTBAHS and .gitignore');
const feature = !flag('--no-feature');
const q = s => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const fields = [
  ['folder', runName], ['slug', slug], ['title', title], ['speaker', opt('--speaker', 'Friday Khutbah')],
  ['masjid', opt('--masjid')], ['masjid_ar', opt('--masjid-ar')], ['maps_url', opt('--maps-url')], ['date', date],
  ['audio', opt('--audio')], ['page', opt('--page')],
].filter(([, val]) => val);
const entry = `  {\n${fields.map(([k, val]) => `    ${k}: ${q(val)},`).join('\n')}${feature ? '\n    featured: true,' : ''}\n  },\n`;
let js = serverJs;
if (feature) js = js.replace(/\n    featured: true,/g, '');
js = js.replace('const PUBLIC_KHUTBAHS = [\n', `const PUBLIC_KHUTBAHS = [\n${entry}`);
if (js === serverJs) die('could not find "const PUBLIC_KHUTBAHS = [" in server.js');
writeFileSync(join(ROOT, 'server.js'), js);
console.log(`  + PUBLIC_KHUTBAHS: ${slug}${feature ? ' (featured)' : ''}`);

let gi = readFileSync(join(ROOT, '.gitignore'), 'utf8');
const addAfterLast = (text, prefix, line) => {
  if (text.includes(line)) return text;
  const lines = text.split('\n');
  let at = -1;
  lines.forEach((l, i) => { if (l.startsWith(prefix)) at = i; });
  if (at < 0) die(`no "${prefix}" lines in .gitignore`);
  lines.splice(at + 1, 0, line);
  return lines.join('\n');
};
gi = addAfterLast(gi, '!audio_files/', `!${audioOut}`);
gi = addAfterLast(gi, '!outputs/', `!outputs/${runName}/`);
writeFileSync(join(ROOT, '.gitignore'), gi);
console.log(`  + .gitignore: !${audioOut}, !outputs/${runName}/`);

if (flag('--review')) { step('Review'); run('node', ['core/review_blocks.js', folder]); }

console.log(`
✓ Ready to check. Not committed, not pushed.
  1. node server.js, then open http://localhost:3000/${slug} in Safari or Chrome (not VS Code's
     browser: it cannot play .m4a) and read it through; play the audio and follow the highlight.
  2. Confirm the cards in tests/khutbahs.json (entry "${slug}", "confirmed": false).
  3. git add ${audioOut} ${folder} server.js .gitignore tests/khutbahs.json
     git commit -m "Publish ${title} (${date})"
  4. Push when traffic is low: git push origin main   (Render deploys main in about a minute)`);
