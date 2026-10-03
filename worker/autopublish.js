#!/usr/bin/env node
// autopublish.js — From a khutbah recording to a live page, with no one in between (2 Oct 2026).
// Run by upload_worker.js for each recording sent from the upload page, or by hand.
//
//   node worker/autopublish.js <recording> [--masjid "Masjid Name"] [--single] [--date 2026-10-02]
//        [--job <upload id>] [--no-push] [--clean]   --no-push: everything but publishing; --clean: the page plays the recording with the hall's echo taken out
//   node worker/autopublish.js --resume outputs/<folder> [--masjid …] [--no-push]
//        after a failed run: the steps already done are kept (the voices come from the cache)
//
// Steps, each timed (the slow local ones run beside the API calls):
//   1. the recording into audio_files/ (streamable), then pipeline.js --gemini: the Arabic,
//      the English, the Quran and hadith cards
//   2. a short title from the summary (one small Claude call)
//   3. side by side: the Urdu (translate_urdu.js, review_urdu.js) and, locally, the imam's word
//      times and his delivery (with --clean, also the recording with the hall's echo taken out)
//   4. verse_excerpts.js: a verse he recited only in part shows (and is voiced) only in part
//   5. the voices, side by side: Urdu (Orus, a direction per sentence, a passage at a time) and
//      English (Charon); each then gets its word times (the Urdu's come with its voice) and his
//      recitation before each verse
//   6. publish.js: the checks, the test set, then the site's publish API (one page with English
//      and Urdu); the page is live at once, with no commit and no deploy, and is checked.
// With --job, every stage is reported to the upload page (/admin/uploads/<id>/status).
// Our masjid gets the date as its link (/2026-10-02) and is featured; another masjid gets
// /2026-10-02-<masjid> and is not.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, appendFileSync } from 'fs';
import { join, extname, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { siteSlugs } from './site.js';

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
  console.error('usage: node worker/autopublish.js <recording> [--masjid "Name"] [--single] [--date YYYY-MM-DD] [--job <id>] [--no-push]\n'
    + '       node worker/autopublish.js --resume outputs/<folder> [--masjid "Name"] [--no-push]');
  process.exit(1);
}
// A resumed run keeps its link and name (outputs/<time>_khutbah-<slug>).
const resumedSlug = resume ? basename(resume).replace(/^[^_]*_khutbah-/, '') : null;
const jobId = opt('--job');
const single = flag('--single');
const push = !flag('--no-push');

// ── Names ──────────────────────────────────────────────────────────────────────
const riyadhDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const dateISO = opt('--date', resumedSlug?.slice(0, 10) ?? riyadhDate);
const dateText = new Date(`${dateISO}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const masjidIn = (opt('--masjid') || '').trim();
const home = !masjidIn || /ma'?ather|معذر/i.test(masjidIn);
const masjid = home ? HOME.masjid : masjidIn;
const masjidSlug = masjidIn.normalize('NFKD').replace(/[^\x00-\x7f]/g, '').toLowerCase().replace(/\b(masjid|mosque|jami|jamia)\b/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
const taken = resume || !push ? [] : await siteSlugs(SITE).catch(e => { console.error(`cannot reach ${SITE}: ${e.message}`); process.exit(1); });
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

  // 3. Urdu (API) beside the imam's timing (local).
  await report('urdu');
  let cleanAudio = null;
  await Promise.all([
    (async () => {
      await step(() => result.urdu, 'Urdu translation', 'node', ['urdu/translate_urdu.js', F]);
      await step(() => has('review_ur.json'), 'Urdu review', 'node', ['urdu/review_urdu.js', F]);
    })(),
    (async () => {
      await step(() => has('words_imam.json'), 'imam word timing', 'node', ['voice/align_imam.js', F, audioOut]);
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
    })(),
  ]);

  // 4. Verses recited only in part.
  await run('verse excerpts', 'node', ['core/verse_excerpts.js', F]);

  // 5. Voices, then the recitation. Both are voiced a passage at a time with a direction per
  //    sentence (--direct): about 4 Gemini requests each since 3 Oct (13 before; one per block,
  //    67 for the English, on 2 Oct, when two runs in a day hit the 100-a-day limit), and the word
  //    times come with the passage split, so align_words.py runs only if that failed.
  await report('voices', { message: 'Urdu (Orus) and English (Charon)' });
  const recitation = cleanAudio ? join('audio_files', `${name}-clean.wav`) : audioOut;
  let voiced = 0;
  const voice = async (lang, label, args) => {
    await run(`${label} voice`, 'node', ['voice/tts.js', F, '--engine', 'gemini', '--lang', lang, ...args, '--tempo', '1.15']);
    if (++voiced === 2) await report('timing');
    const m = JSON.parse(readFileSync(join(ROOT, F, `tts_${lang}.json`), 'utf8'));
    if (!m.blocks.every(b => b.words?.length)) await run(`${lang} word timing`, PY_ALIGN, ['voice/align_words.py', F, lang]);
    await run(`${lang} recitation`, 'node', ['voice/recite.js', F, lang, recitation, '--lift', '2']);
  };
  // One after the other, Urdu first: side by side they sent 21 requests in a minute against a
  // limit of 10 (3 Oct), and the turned-away requests counted toward the 100 a day.
  // A voice that cannot be made now (every key spent, a refusal) does not hold back the page:
  // it goes live with its text, and the worker adds the voice later (logs/voices_pending.json).
  const voiceFailed = [];
  for (const [lang, label, args] of [['ur', 'Urdu', ['--voice', 'Orus', '--direct']], ['en', 'English', ['--direct']]]) {
    try { await voice(lang, label, args); } catch (e) {
      // The line of its output that says what went wrong ("✗ …", "…Error: …"), not the stack.
      const why = (e.tail ?? '').split('\n').map(l => l.trim()).filter(l => /✗|Error\b/.test(l)).pop() ?? e.message;
      voiceFailed.push(`${label}: ${why}`.slice(0, 240));
      log(`✗ ${label} voice: the page goes up without it for now`);
    }
  }

  // 6. Publish: checks, test set, then the site's publish API (one page). The page plays the
  // imam's recording (the echo-removed one with --clean).
  await report('publishing', { message: push ? 'checks, then the site' : 'checks (not publishing: --no-push)' });
  await run('checks and site entry', 'node', ['worker/publish.js', audioOut, '--from-folder', F, '--keep-audio', '--slug', slug, '--title', title, '--date', dateText,
    '--name', name, '--masjid', masjid, ...(home ? ['--masjid-ar', HOME.masjid_ar, '--maps-url', HOME.maps_url] : ['--no-feature']),
    '--page', 'reader-ur.html', ...(cleanAudio ? ['--audio', cleanAudio] : []), ...(single ? ['--single'] : []),
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
  await report('live', { link, message: `${mins()} min from upload start${pendingNote}` });
  if (voiceFailed.length) process.exit(4);
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
    args: ['--resume', key, ...(jobId ? ['--job', jobId] : []), ...(masjidIn ? ['--masjid', masjidIn] : []), '--date', dateISO,
      ...(single ? ['--single'] : []), ...(push ? [] : ['--no-push']), ...(flag('--clean') ? ['--clean'] : [])],
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
