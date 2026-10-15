#!/usr/bin/env node
// autopublish.js — From a khutbah recording to a live page, with no one in between (2 Oct 2026).
// Run by upload_worker.js for each recording sent from the upload page, or by hand.
//
//   node worker/autopublish.js <recording> [--masjid "Masjid Name"] [--single] [--date 2026-10-02]
//        [--job <upload id>] [--langs ur,bn] [--no-push] [--clean]   --no-push: everything but publishing; --clean: the page plays the recording with the hall's echo taken out
//        --langs: the languages besides English (core/languages.js; default ur,bn, or LANGS in .env)
//   node worker/autopublish.js --resume outputs/<folder> [--masjid …] [--no-push]
//        after a failed run: the steps already done are kept (the voices come from the cache)
//
// Steps, each timed (the slow local ones run beside the API calls):
//   1. the recording into audio_files/ (streamable), then pipeline.js --gemini: the Arabic,
//      the English, the Quran and hadith cards
//   2. a short title from the summary (one small Claude call)
//   3–5. each voice as soon as its text is final (13 Oct 2026): the English review, its verse parts
//      (verse_excerpts.js) and the English voice (Charon); beside it, each language's translation and
//      review (translate.js, review_translation.js), their verse parts, then their voices side by side
//      (Urdu and Bengali in Orus); locally, the imam's word times, the highlight check and his delivery,
//      which every voice waits for (with --clean, also the recording with the hall's echo taken out).
//      A voice is a passage at a time with a direction per sentence; each then gets its word times
//      (they come with the voice) and his recitation before each verse
//   6. publish.js: the checks, the test set, then the site's publish API (one page with English
//      and Urdu); the page is live at once, with no commit and no deploy, and is checked.
// With --job, every stage is reported to the upload page (/admin/uploads/<id>/status).
// Our masjid gets the date as its link (/2026-10-02) and is featured; another masjid gets
// /2026-10-02-<masjid> and is not.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { spawn, spawnSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, appendFileSync, copyFileSync, rmSync, renameSync } from 'fs';
import { join, extname, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { siteItems } from './site.js';
import { langOf } from '../core/languages.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = process.env.SITE_URL || 'https://khutbah.dev';
const HOME = { masjid: 'Askan AlMaather Mosque', masjid_ar: 'جامع إسكان المعذر', maps_url: 'https://maps.app.goo.gl/J8ghwSqr3yUyrTQA6' };
const PY_ALIGN = join(ROOT, '.venv-align', 'bin', 'python');
const PY_CLEAN = join(ROOT, '.venv-clean', 'bin', 'python');

const argv = process.argv.slice(2);
const opt = (f, d = null) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const flag = f => argv.includes(f);
const resume = opt('--resume')?.replace(/\/+$/, '');
const input = resume ?? argv[0];
if (!input || input.startsWith('--') || !existsSync(input) || (resume && !existsSync(join(resume, 'result.json')))) {
  console.error('usage: node worker/autopublish.js <recording> [--masjid "Name"] [--speaker "Sheikh …"] [--single] [--date YYYY-MM-DD] [--job <id>] [--langs ur,bn] [--no-push]\n'
    + '       node worker/autopublish.js --resume outputs/<folder> [--masjid "Name"] [--no-push]');
  process.exit(1);
}
// A resumed run keeps its link and name (outputs/<time>_khutbah-<slug>).
const resumedSlug = resume ? basename(resume).replace(/^[^_]*_khutbah-/, '') : null;
const jobId = opt('--job');
const single = flag('--single');
const push = !flag('--no-push');
const langs = (opt('--langs') ?? process.env.LANGS ?? 'ur,bn').split(',').filter(Boolean).map(c => langOf(c) ?? (console.error(`unknown language ${c}`), process.exit(1)));

// ── Names ──────────────────────────────────────────────────────────────────────
const riyadhDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const dateISO = opt('--date', resumedSlug?.slice(0, 10) ?? riyadhDate);
const dateText = new Date(`${dateISO}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const masjidIn = (opt('--masjid') || '').trim();
const speaker = (opt('--speaker') || '').trim(); // the imam's name, from the upload page; else publish.js says "Friday Khutbah"
const home = !masjidIn || /ma'?ather|معذر/i.test(masjidIn);
const masjid = home ? HOME.masjid : masjidIn;
const masjidSlug = masjidIn.normalize('NFKD').replace(/[^\x00-\x7f]/g, '').toLowerCase().replace(/\b(masjid|mosque|jami|jamia)\b/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
const items = !push ? [] : await siteItems(SITE).catch(e => { console.error(`cannot reach ${SITE}: ${e.message}`); process.exit(1); });
const taken = resume ? [] : items.map(i => i.slug);
// Another masjid's map link: a page of it already on the site has one, else a map search for its
// name (2 Oct 2026: the Haramain pages went up with none).
const place = home ? HOME : { maps_url: items.find(i => i.masjid === masjid && i.maps_url)?.maps_url
  ?? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(masjid)}` };
let slug = resumedSlug ?? (home ? dateISO : `${dateISO}-${masjidSlug || 'masjid'}`);
for (let n = 2; taken.includes(slug); n++) slug = `${home ? dateISO : `${dateISO}-${masjidSlug || 'masjid'}`}-${n}`;
const name = `khutbah-${slug}`;

// ── Log, report, run ───────────────────────────────────────────────────────────
mkdirSync(join(ROOT, 'logs'), { recursive: true });
const LOG = join(ROOT, 'logs', `${name}.log`);
const began = Date.now();
const mins = () => ((Date.now() - began) / 60000).toFixed(1);
const log = msg => { const line = `[${mins()} min] ${msg}`; console.log(line); appendFileSync(LOG, line + '\n'); };
const times = [];

async function report(status, extra = {}) {
  log(`status: ${status}${extra.message ? ` (${extra.message})` : ''}`);
  if (!jobId || !process.env.ADMIN_TOKEN) return;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const r = await fetch(`${SITE}/admin/uploads/${jobId}/status`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-key': process.env.ADMIN_TOKEN },
        body: JSON.stringify({ status, ...extra }),
      });
      if (r.ok || r.status === 409) return;
    } catch { /* the site may be redeploying */ }
    await new Promise(r => setTimeout(r, 10000));
  }
}

// One command; its output goes to the log. Resolves when it succeeds, rejects otherwise.
function runOnce(label, cmd, args) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    log(`▶ ${label}`);
    const p = spawn(cmd, args, { cwd: ROOT, env: process.env });
    let tail = '';
    const keep = d => { const s = d.toString(); appendFileSync(LOG, s); tail = (tail + s).slice(-1500); };
    p.stdout.on('data', keep); p.stderr.on('data', keep);
    p.on('close', code => {
      const secs = Math.round((Date.now() - t0) / 1000);
      times.push([label, secs]);
      if (code === 0) { log(`✓ ${label} (${secs} s)`); resolve(tail); }
      else reject(Object.assign(new Error(`${label} failed: ${tail.trim().split('\n').slice(-3).join(' / ')}`), { tail }));
    });
  });
}

// A step that failed on a passing API problem (Anthropic or Gemini overloaded or rate-limited, a
// dropped connection) runs again after a minute, up to 3 times, before the run gives up. On 2 Oct
// a 529 "Overloaded" from Anthropic stopped a run at the Urdu review.
const PASSING = /overloaded|\b529\b|\b503\b|\b429\b|rate_limit|RESOURCE_EXHAUSTED|UNAVAILABLE|InternalServerError|APIConnection|ECONNRESET|ETIMEDOUT|socket hang up|fetch failed/i;
async function run(label, cmd, args, { tries = 3, wait = 60_000 } = {}) {
  for (let n = 1; ; n++) {
    try { return await runOnce(label, cmd, args); } catch (e) {
      // Gemini's daily limit does not pass in a minute: no point trying again.
      if (n > tries || !PASSING.test(e.tail ?? '') || /daily voice limit/.test(e.tail ?? '')) throw e;
      log(`… ${label}: the API is busy (${(e.tail.match(PASSING) || [''])[0]}); trying again in ${wait / 1000} s (${n}/${tries})`);
      await new Promise(r => setTimeout(r, wait));
    }
  }
}

async function main() {
  log(`${input} → /${slug} (${masjid}, ${dateText}${single ? ', one khutbah' : ''})`);
  await report('transcribing', { slug });

  // A step whose output is already there (a resumed run) is not run again.
  const step = (done, label, cmd, args) => {
    if (resume && done()) { log(`= ${label} (kept)`); return Promise.resolve(); }
    return run(label, cmd, args);
  };
  const has = file => existsSync(join(ROOT, F ?? '', file));

  // 1. The recording, streamable: an mp4/m4a gets its index (moov) first, anything else AAC.
  let audioName, F = resume ?? null;
  if (resume) {
    audioName = ['m4a', 'mp3'].map(e => `${name}.${e}`).find(f => existsSync(join(ROOT, 'audio_files', f)));
    if (!audioName) throw new Error(`audio_files/${name}.m4a is not there to resume from`);
  } else {
    const ext = extname(input).slice(1).toLowerCase();
    audioName = ['m4a', 'mp4', 'mov', 'mp3'].includes(ext) ? `${name}.${ext === 'mp3' ? 'mp3' : 'm4a'}` : `${name}.m4a`;
    const copy = ['m4a', 'mp4', 'mov', 'mp3'].includes(ext);
    await run('audio', 'ffmpeg', ['-v', 'error', '-y', '-i', input, ...(copy ? ['-c', 'copy'] : ['-ac', '1', '-c:a', 'aac', '-b:a', '96k']),
      ...(ext === 'mp3' ? [] : ['-movflags', '+faststart']), join('audio_files', audioName)]);
    const before = new Set(readdirSync(join(ROOT, 'outputs')));
    await run('pipeline (Arabic, English, cards)', 'node', ['pipeline.js', join('audio_files', audioName), '--gemini', ...(single ? ['--single'] : [])]);
    const made = readdirSync(join(ROOT, 'outputs')).filter(f => !before.has(f) && f.endsWith(`_${name}`));
    if (made.length !== 1) throw new Error(`expected one new outputs/*_${name} folder, found ${made.length}`);
    F = join('outputs', made[0]);
  }
  const audioOut = join('audio_files', audioName);
  const result = JSON.parse(readFileSync(join(ROOT, F, 'result.json'), 'utf8'));

  // 2. Title, kept in the folder: a resumed run (voices added later) keeps the page's title.
  const titleFile = join(ROOT, F, 'title.txt');
  let title = existsSync(titleFile) ? readFileSync(titleFile, 'utf8').trim() || null : null;
  if (!title) try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60_000, maxRetries: 6 }); // 6: rides out a short "Overloaded"
    const r = await anthropic.messages.create({
      model: 'claude-sonnet-5-5', max_tokens: 2000, output_config: { effort: 'low' },
      messages: [{ role: 'user', content: `Give this Friday khutbah a short English title for its web page: 2 to 5 words, Title Case, no quotation marks, no "Khutbah" or date, like "The Blessing of Security" or "Lofty Aspiration". Reply with the title only.\n\nSummary: ${result.summary}\n\nIn short: ${result.share_summary}` }],
    });
    title = r.content.find(b => b.type === 'text')?.text.trim().replace(/^["'“]|["'”.]$/g, '').split('\n')[0].slice(0, 60) || null;
  } catch (e) { log(`title: ${e.message}`); }
  if (title && !existsSync(titleFile)) writeFileSync(titleFile, title + '\n'); // only a real title is kept
  title ||= (result.share_summary || 'Friday Khutbah').split(/\s+/).slice(0, 5).join(' ');
  await report('english', { title, message: title });
  // The picture a shared link shows (title, date, masjid, languages), drawn by the Mac's Chrome; the site's own without it.
  await run('link preview', 'node', ['scripts/og_image.js', F, '--title', title, '--date', dateText, '--masjid', masjid, '--langs', ['en', ...langs.map(L => L.code)].join(',')], { tries: 1 })
    .catch(e => log(`✗ link preview: ${whyFailed(e)} (the site's own picture is used)`));

  // 3–5. Each voice starts as soon as its own text is final (13 Oct 2026; before, the three waited for every translation
  // and then went one after another, about 15 of a run's 24 minutes):
  //   - the English: its review, its verse parts, then its voice;
  //   - the other languages: after the English review (their second reference), each translated and reviewed on its own
  //     copy of the folder's result (two writers to one file would lose one's work), merged back; then their verse parts
  //     and their voices side by side, one call for both their style notes;
  //   - beside them, locally, the imam's word times, the check that the page lights the word he says, and his delivery:
  //     every voice waits for these (its style notes use his delivery, and a failed check stops the run before any
  //     voice is paid for).
  // The voices share the Gemini keys' per-minute limits (voice/tts_gemini.mjs paces every voice on this Mac together).
  // A language that fails does not hold back the page: it goes live without it and the language waits with the voices
  // (logs/voices_pending.json); so does a voice that cannot be made now.
  await report('translations', { message: langs.map(L => L.name).join(', ') });
  let cleanAudio = null;
  const failed = [], voiceFailed = [];
  const imam = (async () => {
    await step(() => has('words_imam.json'), 'imam word timing', 'node', ['voice/align_imam.js', F, audioOut]);
    // The word the page lights is the word he is saying: 20 of them heard again (Groq, free); a page
    // off by a second or more stops here (voice/check_highlight.js, 8 Oct 2026).
    await step(() => has('highlight_check.json'), 'highlight check', 'node', ['voice/check_highlight.js', F, audioOut]);
    await step(() => has('delivery_imam.json'), 'imam delivery', PY_ALIGN, ['voice/imam_delivery.py', F, audioOut]);
    // The hall's echo taken out (clean_audio.py): off since 2 Oct 2026, the imam sounded processed
    // with it. It never fed the text, cards or timing, only what is heard. --clean turns it back on.
    if (!flag('--clean')) return;
    try {
      const wav = join('audio_files', `${name}-clean.wav`);
      await step(() => existsSync(join(ROOT, wav)), 'echo removal', PY_CLEAN, ['voice/clean_audio.py', audioOut, F, wav]);
      await step(() => existsSync(join(ROOT, 'audio_files', `${name}-clean.m4a`)), 'cleaned recording', 'ffmpeg', ['-v', 'error', '-y', '-i', wav, '-af', 'loudnorm=I=-17', '-ac', '1', '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart', join('audio_files', `${name}-clean.m4a`)]);
      cleanAudio = `${name}-clean.m4a`;
    } catch (e) { log(`echo removal skipped: ${e.message}`); }
  })();
  const englishReview = step(() => has('review_en.json'), 'English review', 'node', ['core/review_english.js', F]);

  // A voice, then its word times (they come with the voice; the aligner only if that failed) and the imam's recitation
  // before each verse. Voiced a passage at a time with a direction per sentence (--direct): about 6 Gemini requests each.
  let voicing = false;
  const voice = async (lang, label, args, styleLangs) => {
    if (!voicing) { voicing = true; await report('voices', { message: `${label} first, the others as their text is ready` }); }
    try {
      await run(`${label} voice`, 'node', ['voice/tts.js', F, '--lang', lang, ...args, '--direct-langs', styleLangs.join(','), '--tempo', '1.15']);
      const m = JSON.parse(readFileSync(join(ROOT, F, `tts_${lang}.json`), 'utf8'));
      if (!m.blocks.every(b => b.words?.length)) await run(`${lang} word timing`, PY_ALIGN, ['voice/align_words.py', F, lang, ...(langOf(lang) ? [langOf(lang).voice.iso] : [])]);
      const recitation = cleanAudio ? join('audio_files', `${name}-clean.wav`) : audioOut;
      await run(`${lang} recitation`, 'node', ['voice/recite.js', F, lang, recitation, '--lift', '2']);
    } catch (e) {
      voiceFailed.push(`${label}: ${whyFailed(e)}`.slice(0, 240));
      log(`✗ ${label} voice: the page goes up without it for now`);
    }
  };

  // Which Arabic phrase each translation phrase translates (align_phrases.js, ~9 cents), once every language is in,
  // while the voices are made: the page lights the Arabic the voice is translating. A page without it lights no part,
  // so a failure here is logged and the page goes up anyway.
  let aligning = Promise.resolve();
  const startAligning = () => {
    aligning = (resume && existsSync(join(ROOT, F, 'align.json')) ? Promise.resolve(log('= phrase matching (kept)'))
      : run('phrase matching', 'node', ['core/align_phrases.js', F])).catch(e => log(`✗ phrase matching: ${whyFailed(e)} (the page goes up without it)`));
  };

  await Promise.all([
    imam,
    (async () => {
      await englishReview;
      // Verses recited only in part (verse_excerpts.js): the English parts now, for the English voice.
      await withResult(() => run('verse excerpts (English)', 'node', ['core/verse_excerpts.js', F, '--keep']));
      await imam;
      await voice('en', 'English', ['--direct'], ['en']);
    })(),
    (async () => {
      await englishReview;
      await Promise.all(langs.map(L => translateLang(L, F, has).catch(e => {
        failed.push({ L, why: `${L.name} text: ${whyFailed(e)}` });
        log(`✗ ${L.name}: the page goes up without it for now`);
      })));
      startAligning();
      const voiced = langs.filter(L => !failed.some(f => f.L === L));
      if (!voiced.length) return;
      // Their verse parts, the English ones kept as the English voice said them (--keep).
      await withResult(() => run('verse excerpts', 'node', ['core/verse_excerpts.js', F, '--keep']));
      await imam;
      await Promise.all(voiced.map(L => voice(L.code, L.name, ['--voice', L.voice.name, '--direct'], voiced.map(v => v.code))));
    })(),
  ]);
  await report('timing');
  await aligning;
  voiceFailed.unshift(...failed.map(f => f.why));

  // 6. Publish: checks, test set, then the site's publish API (one page). The page plays the
  // imam's recording (the echo-removed one with --clean).
  await report('publishing', { message: push ? 'checks, then the site' : 'checks (not publishing: --no-push)' });
  await run('checks and site entry', 'node', ['worker/publish.js', audioOut, '--from-folder', F, '--keep-audio', '--slug', slug, '--title', title, '--date', dateText,
    '--name', name, '--masjid', masjid, ...(speaker ? ['--speaker', speaker] : []), ...(place.masjid_ar ? ['--masjid-ar', place.masjid_ar] : []), '--maps-url', place.maps_url, ...(home ? [] : ['--no-feature']),
    ...(cleanAudio ? ['--audio', cleanAudio] : []), ...(single ? ['--single'] : []),
    ...(push ? ['--site', SITE] : ['--no-site'])]);
  const link = `${SITE}/${slug}`;
  const summary = times.map(([l, s]) => `${l} ${s}s`).join(', ');
  const pendingNote = voicesPending(voiceFailed, F);
  if (!push) {
    log(`not published (--no-push). Steps: ${summary}`);
    await report('live', { link: `(not published) ${link}`, message: `${mins()} min, not published${pendingNote}` });
    if (voiceFailed.length) process.exit(4);
    return;
  }
  const r = await fetch(link).catch(() => null);
  if (!r?.ok) throw new Error(`published, but ${link} did not load (${r?.status ?? 'no answer'})`);
  log(`live: ${link}. Steps: ${summary}`);
  commitPublished(`Publish ${title} (${dateText}, ${masjid})`);
  await report('live', { link, message: `${mins()} min from upload start${pendingNote}` });
  if (voiceFailed.length) process.exit(4);
}

// One language's text: its translation, then its review. Each runs on a copy of the folder's
// result.json (they would overwrite each other's), merged back as <field> once both steps are done.
async function translateLang(L, F, has) {
  const dir = join(ROOT, F), work = join(dir, `.${L.code}`);
  const done = () => JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'))[L.field];
  if (resume && done() && has(`review_${L.code}.json`)) { log(`= ${L.name} translation and review (kept)`); return; }
  mkdirSync(work, { recursive: true });
  for (const f of ['result.json', 'transcript.txt', 'reader.txt']) copyFileSync(join(dir, f), join(work, f));
  const w = join(F, `.${L.code}`);
  await run(`${L.name} translation`, 'node', ['core/translate.js', w, '--lang', L.code]);
  await run(`${L.name} review`, 'node', ['core/review_translation.js', w, '--lang', L.code]);
  const own = JSON.parse(readFileSync(join(work, 'result.json'), 'utf8'))[L.field];
  await withResult(() => {
    const r = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
    r[L.field] = own;
    writeFileSync(join(dir, 'result.json.tmp'), JSON.stringify(r, null, 2), 'utf8');
    renameSync(join(dir, 'result.json.tmp'), join(dir, 'result.json')); // whole, then moved in: a voice may be reading it
    for (const f of [`reader_${L.code}.txt`, `review_${L.code}.json`]) copyFileSync(join(work, f), join(dir, f));
    rmSync(work, { recursive: true, force: true });
  });
}
// The steps that write the folder's result.json (a language merged back, the verse parts) one at a time.
let resultLock = Promise.resolve();
function withResult(fn) {
  const p = resultLock.then(fn);
  resultLock = p.catch(() => {});
  return p;
}

// The line of a failed step's output that says what went wrong ("✗ …", "…Error: …"), not the stack.
const whyFailed = e => (e.tail ?? '').split('\n').map(l => l.trim()).filter(l => /✗|Error\b/.test(l)).pop() ?? e.message;

// One commit on main per khutbah: the list publish.js wrote (server/khutbahs.seed.json) and the
// test set. Render's build filter (render.yaml) skips the deploy for these files, so the site
// stays up. The khutbah is already live: a git problem is logged, never fatal.
function commitPublished(message) {
  const git = args => spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  const paths = ['server/khutbahs.seed.json', 'tests/khutbahs.json'];
  if (!git(['status', '--porcelain', '--', ...paths]).stdout.trim()) return;
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
  if (branch !== 'main') return log(`⚠ on branch ${branch}, not main: the list is updated but not committed`);
  for (const args of [['commit', '-m', message, '--', ...paths], ['pull', '--rebase', '--autostash', 'origin', 'main'], ['push', 'origin', 'main']]) {
    const r = git(args);
    if (r.status !== 0) return log(`⚠ git ${args[0]} failed, commit the list by hand: ${(r.stderr || r.stdout).trim().slice(-200)}`);
  }
  log('list committed and pushed to main (no deploy)');
}

// Voices still to make: the worker (upload_worker.js) runs this job again with --resume when
// `next` comes (finished steps are kept and voiced passages come from the cache); it counts the
// tries and gives up after a day. Exit code 4 = live without some voice. Once every voice is
// made, the entry is removed.
function voicesPending(failed, key) {
  const file = join(ROOT, 'logs', 'voices_pending.json');
  let all = {};
  try { all = JSON.parse(readFileSync(file, 'utf8')); } catch { /* none yet */ }
  if (!failed.length) {
    if (all[key]) { delete all[key]; writeFileSync(file, JSON.stringify(all, null, 1)); log('voices: the pending entry is done'); }
    return '';
  }
  all[key] = {
    job: jobId, slug, why: failed, tries: all[key]?.tries ?? 0,
    next: all[key]?.next ?? new Date(Date.now() + 60 * 60_000).toISOString(),
    args: ['--resume', key, ...(jobId ? ['--job', jobId] : []), ...(masjidIn ? ['--masjid', masjidIn] : []), ...(speaker ? ['--speaker', speaker] : []), '--date', dateISO,
      ...(single ? ['--single'] : []), ...(push ? [] : ['--no-push']), ...(flag('--clean') ? ['--clean'] : []),
      '--langs', langs.map(L => L.code).join(',')],
  };
  writeFileSync(file, JSON.stringify(all, null, 1));
  log(`voices pending (${failed.join('; ')}); the worker tries again at ${all[key].next}`);
  return ` · voices pending, added automatically: ${failed.join('; ')}`;
}

main().catch(async e => {
  log(`✗ ${e.message}`);
  await report('failed', { message: e.message.slice(0, 400) });
  process.exit(1);
});
