#!/usr/bin/env node
// autopublish.js — From a khutbah recording to a live page, with no one in between (2 Oct 2026).
// Run by upload_worker.js for each recording sent from the upload page, or by hand.
//
//   node autopublish.js <recording> [--masjid "Masjid Name"] [--single] [--date 2026-10-02]
//        [--job <upload id>] [--no-push]
//
// Steps, each timed (the slow local ones run beside the API calls):
//   1. the recording into audio_files/ (streamable), then pipeline.js --gemini: the Arabic,
//      the English, the Quran and hadith cards
//   2. a short title from the summary (one small Claude call)
//   3. side by side: the Urdu (translate_urdu.js, review_urdu.js) and, locally, the imam's word
//      times, his delivery and the recording with the hall's echo taken out (clean_audio.py)
//   4. verse_excerpts.js: a verse he recited only in part shows (and is voiced) only in part
//   5. the voices, side by side: Urdu (Orus, a direction per sentence, a passage at a time) and
//      English (Charon); then word timing and his recitation before each verse
//   6. publish.js (the checks, the test set, the site entry: one page with English and Urdu),
//      then commit and push to main; Render deploys it, and the page is checked live.
// With --job, every stage is reported to the upload page (/admin/uploads/<id>/status).
// Our masjid gets the date as its link (/2026-10-02) and is featured; another masjid gets
// /2026-10-02-<masjid> and is not.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { spawn, spawnSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync, appendFileSync } from 'fs';
import { join, extname, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SITE = process.env.SITE_URL || 'https://khutbah-live.onrender.com';
const HOME = { masjid: 'Askan AlMaather Mosque', masjid_ar: 'جامع إسكان المعذر', maps_url: 'https://maps.app.goo.gl/J8ghwSqr3yUyrTQA6' };
const PY_ALIGN = join(ROOT, '.venv-align', 'bin', 'python');
const PY_CLEAN = join(ROOT, '.venv-clean', 'bin', 'python');

const argv = process.argv.slice(2);
const opt = (f, d = null) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : d);
const flag = f => argv.includes(f);
const input = argv[0];
if (!input || input.startsWith('--') || !existsSync(input)) {
  console.error('usage: node autopublish.js <recording> [--masjid "Name"] [--single] [--date YYYY-MM-DD] [--job <id>] [--no-push]');
  process.exit(1);
}
const jobId = opt('--job');
const single = flag('--single');
const push = !flag('--no-push');

// ── Names ──────────────────────────────────────────────────────────────────────
const riyadhDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const dateISO = opt('--date', riyadhDate);
const dateText = new Date(`${dateISO}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const masjidIn = (opt('--masjid') || '').trim();
const home = !masjidIn || /ma'?ather|معذر/i.test(masjidIn);
const masjid = home ? HOME.masjid : masjidIn;
const masjidSlug = masjidIn.normalize('NFKD').replace(/[^\x00-\x7f]/g, '').toLowerCase().replace(/\b(masjid|mosque|jami|jamia)\b/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
const serverJs = () => readFileSync(join(ROOT, 'server.js'), 'utf8');
let slug = home ? dateISO : `${dateISO}-${masjidSlug || 'masjid'}`;
for (let n = 2; serverJs().includes(`slug: '${slug}'`); n++) slug = `${home ? dateISO : `${dateISO}-${masjidSlug || 'masjid'}`}-${n}`;
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
function run(label, cmd, args) {
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
      else reject(new Error(`${label} failed: ${tail.trim().split('\n').slice(-3).join(' / ')}`));
    });
  });
}

async function main() {
  log(`${input} → /${slug} (${masjid}, ${dateText}${single ? ', one khutbah' : ''})`);
  await report('transcribing', { slug, message: 'writing down the Arabic' });

  // 1. The recording, streamable: an mp4/m4a gets its index (moov) first, anything else AAC.
  const ext = extname(input).slice(1).toLowerCase();
  const audioName = ['m4a', 'mp4', 'mov', 'mp3'].includes(ext) ? `${name}.${ext === 'mp3' ? 'mp3' : 'm4a'}` : `${name}.m4a`;
  const audioOut = join('audio_files', audioName);
  const copy = ['m4a', 'mp4', 'mov', 'mp3'].includes(ext);
  await run('audio', 'ffmpeg', ['-v', 'error', '-y', '-i', input, ...(copy ? ['-c', 'copy'] : ['-ac', '1', '-c:a', 'aac', '-b:a', '96k']),
    ...(ext === 'mp3' ? [] : ['-movflags', '+faststart']), audioOut]);
  const before = new Set(readdirSync(join(ROOT, 'outputs')));
  await run('pipeline (Arabic, English, cards)', 'node', ['pipeline.js', audioOut, '--gemini', ...(single ? ['--single'] : [])]);
  const made = readdirSync(join(ROOT, 'outputs')).filter(f => !before.has(f) && f.endsWith(`_${name}`));
  if (made.length !== 1) throw new Error(`expected one new outputs/*_${name} folder, found ${made.length}`);
  const F = join('outputs', made[0]);
  const result = JSON.parse(readFileSync(join(ROOT, F, 'result.json'), 'utf8'));

  // 2. Title.
  let title = null;
  try {
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60_000, maxRetries: 2 });
    const r = await anthropic.messages.create({
      model: 'claude-sonnet-5-5', max_tokens: 2000, output_config: { effort: 'low' },
      messages: [{ role: 'user', content: `Give this Friday khutbah a short English title for its web page: 2 to 5 words, Title Case, no quotation marks, no "Khutbah" or date, like "The Blessing of Security" or "Lofty Aspiration". Reply with the title only.\n\nSummary: ${result.summary}\n\nIn short: ${result.share_summary}` }],
    });
    title = r.content.find(b => b.type === 'text')?.text.trim().replace(/^["'“]|["'”.]$/g, '').split('\n')[0].slice(0, 60) || null;
  } catch (e) { log(`title: ${e.message}`); }
  title ||= (result.share_summary || 'Friday Khutbah').split(/\s+/).slice(0, 5).join(' ');
  await report('english', { title, message: title });

  // 3. Urdu (API) beside the imam's timing and the cleaned recording (local).
  await report('urdu', { message: 'translating and reviewing' });
  let cleanAudio = null;
  await Promise.all([
    (async () => {
      await run('Urdu translation', 'node', ['translate_urdu.js', F]);
      await run('Urdu review', 'node', ['review_urdu.js', F]);
    })(),
    (async () => {
      await run('imam word timing', 'node', ['align_imam.js', F, audioOut]);
      await run('imam delivery', PY_ALIGN, ['imam_delivery.py', F, audioOut]);
      try {
        const wav = join('audio_files', `${name}-clean.wav`);
        await run('echo removal', PY_CLEAN, ['clean_audio.py', audioOut, F, wav]);
        await run('cleaned recording', 'ffmpeg', ['-v', 'error', '-y', '-i', wav, '-af', 'loudnorm=I=-17', '-ac', '1', '-c:a', 'aac', '-b:a', '128k',
          '-movflags', '+faststart', join('audio_files', `${name}-clean.m4a`)]);
        cleanAudio = `${name}-clean.m4a`;
      } catch (e) { log(`echo removal skipped: ${e.message}`); }
    })(),
  ]);

  // 4. Verses recited only in part.
  await run('verse excerpts', 'node', ['verse_excerpts.js', F]);

  // 5. Voices, then word timing and the recitation.
  await report('voices', { message: 'Urdu (Orus) and English (Charon)' });
  await Promise.all([
    run('Urdu voice', 'node', ['tts.js', F, '--engine', 'gemini', '--voice', 'Orus', '--lang', 'ur', '--direct', '--tempo', '1.15']),
    run('English voice', 'node', ['tts.js', F, '--engine', 'gemini', '--lang', 'en', '--tempo', '1.15']),
  ]);
  await report('timing', { message: 'word by word' });
  const recitation = cleanAudio ? join('audio_files', `${name}-clean.wav`) : audioOut;
  for (const lang of ['ur', 'en']) {
    const m = JSON.parse(readFileSync(join(ROOT, F, `tts_${lang}.json`), 'utf8'));
    if (!m.blocks.every(b => b.words?.length)) await run(`${lang} word timing`, PY_ALIGN, ['align_words.py', F, lang]);
    await run(`${lang} recitation`, 'node', ['recite.js', F, lang, recitation, '--lift', '2']);
  }

  // 6. Publish: checks, test set, site entry (one page), then commit and push.
  await report('publishing', { message: push ? 'checks, then the site' : 'checks (not pushing: --no-push)' });
  await run('checks and site entry', 'node', ['publish.js', audioOut, '--from-folder', F, '--keep-audio', '--slug', slug, '--title', title, '--date', dateText,
    '--name', name, '--masjid', masjid, ...(home ? ['--masjid-ar', HOME.masjid_ar, '--maps-url', HOME.maps_url] : ['--no-feature']),
    '--page', 'reader-ur.html', ...(cleanAudio ? ['--audio', cleanAudio] : []), ...(single ? ['--single'] : [])]);
  let gi = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  for (const line of [cleanAudio && `!audio_files/${cleanAudio}`, `!${F}/tts_ur.mp3`, `!${F}/tts_en.mp3`].filter(Boolean)) {
    if (!gi.includes(line)) gi = gi.trimEnd() + '\n' + line + '\n';
  }
  writeFileSync(join(ROOT, '.gitignore'), gi);
  const paths = [audioOut, F, 'server.js', '.gitignore', 'tests/khutbahs.json', ...(cleanAudio ? [join('audio_files', cleanAudio)] : [])];
  const link = `${SITE}/${slug}`;
  const summary = times.map(([l, s]) => `${l} ${s}s`).join(', ');
  if (!push) {
    log(`not pushed (--no-push). Steps: ${summary}`);
    await report('live', { link: `(not pushed) ${link}`, message: `${mins()} min, not pushed` });
    return;
  }
  const git = args => { const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' }); if (r.status !== 0) throw new Error(`git ${args[0]}: ${(r.stderr || r.stdout).trim().slice(-300)}`); return r.stdout; };
  git(['add', ...paths]);
  git(['commit', '-m', `Publish ${title} (${dateText}, ${masjid})`, '--', ...paths]);
  git(['pull', '--rebase', '--autostash', 'origin', 'main']);
  git(['push', 'origin', 'HEAD:main']);
  log('pushed; waiting for the site');
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 10000));
    try {
      const r = await fetch(`${SITE}/${slug}`);
      if (r.ok) {
        log(`live: ${link}. Steps: ${summary}`);
        await report('live', { link, message: `${mins()} min from upload start` });
        return;
      }
    } catch { /* still deploying */ }
  }
  throw new Error('pushed, but the page did not come up within 7 minutes');
}

main().catch(async e => {
  log(`✗ ${e.message}`);
  await report('failed', { message: e.message.slice(0, 400) });
  process.exit(1);
});
