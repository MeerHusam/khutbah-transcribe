#!/usr/bin/env node
// upload_worker.js — Runs on Meer's Mac (2 Oct 2026). Every 15 s it asks the site for recordings
// sent from the upload page (/admin/upload), takes the oldest, downloads it, and runs
// autopublish.js on it; one at a time, in the order they were sent. It only calls out to the
// site, so nothing on the Mac is reachable from the internet.
//
//   caffeinate -is node worker/upload_worker.js        (caffeinate keeps the Mac awake while it runs)
//
// Needs ADMIN_TOKEN in .env (the same key the site has on Render). SITE_URL defaults to the
// live site. Extra arguments for autopublish.js (e.g. --no-push for a test) go in
// AUTOPUBLISH_ARGS.

import 'dotenv/config';
import { spawn } from 'child_process';
import { createWriteStream, mkdirSync, appendFileSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SITE = process.env.SITE_URL || 'https://khutbah.dev';
const KEY = process.env.ADMIN_TOKEN;
const EXTRA = (process.env.AUTOPUBLISH_ARGS || '').split(/\s+/).filter(Boolean);
if (!KEY) { console.error('Put ADMIN_TOKEN=<the site\'s admin key> in .env first.'); process.exit(1); }

mkdirSync(join(ROOT, 'audio_files', 'inbox'), { recursive: true });
mkdirSync(join(ROOT, 'logs'), { recursive: true });
const log = msg => { const line = `${new Date().toISOString()} ${msg}`; console.log(line); appendFileSync(join(ROOT, 'logs', 'worker.log'), line + '\n'); };
const headers = { 'x-admin-key': KEY };
const status = (id, s, message = '') => fetch(`${SITE}/admin/uploads/${id}/status`, {
  method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ status: s, message }),
});

async function next() {
  const r = await fetch(`${SITE}/admin/uploads?status=uploaded`, { headers });
  if (!r.ok) throw new Error(`list: ${r.status}`);
  const jobs = (await r.json()).sort((a, b) => a.uploaded_at.localeCompare(b.uploaded_at));
  for (const job of jobs) {
    const c = await status(job.id, 'claimed', 'the Mac is downloading it');
    if (c.status === 409) continue; // another worker took it
    if (!c.ok) throw new Error(`claim: ${c.status}`);
    log(`job ${job.id}: ${job.name}, ${(job.bytes / 1048576).toFixed(1)} MB, masjid "${job.masjid}"${job.single ? ', one khutbah' : ''}`);
    const ext = (job.name.match(/\.([a-z0-9]{2,5})$/i)?.[1] || 'm4a').toLowerCase();
    const file = join(ROOT, 'audio_files', 'inbox', `${job.id}.${ext}`);
    const d = await fetch(`${SITE}/admin/uploads/${job.id}/file`, { headers });
    if (!d.ok) { await status(job.id, 'failed', `download: ${d.status}`); continue; }
    await pipeline(Readable.fromWeb(d.body), createWriteStream(file));
    await status(job.id, 'downloaded', 'on the Mac');
    const args = ['worker/autopublish.js', file, '--job', job.id, ...(job.masjid ? ['--masjid', job.masjid] : []), ...(job.single ? ['--single'] : []), ...(job.date ? ['--date', job.date] : []), ...EXTRA];
    const code = await new Promise(res => spawn('node', args, { cwd: ROOT, stdio: 'inherit', env: process.env }).on('close', res));
    log(`job ${job.id}: autopublish exited ${code}`);
    return true; // ask again straight away
  }
  return false;
}

// Voices a run could not make (every key spent, a refusal): autopublish published the page
// without them and listed the job in logs/voices_pending.json. When an entry's time comes it runs
// again with --resume, which adds the voices to the live page; hourly, for at most a day.
const PENDING = join(ROOT, 'logs', 'voices_pending.json');
async function pendingVoices() {
  let all;
  try { all = JSON.parse(readFileSync(PENDING, 'utf8')); } catch { return false; }
  const due = Object.entries(all).find(([, p]) => Date.parse(p.next) <= Date.now());
  if (!due) return false;
  const [folder, p] = due;
  if (p.tries >= 24) {
    delete all[folder];
    writeFileSync(PENDING, JSON.stringify(all, null, 1));
    log(`voices for ${folder}: given up after ${p.tries} tries (${p.why.join('; ')})`);
    if (p.job) await status(p.job, 'live', `voices failed after a day of tries: ${p.why.join('; ')}`.slice(0, 400)).catch(() => {});
    return false;
  }
  // Counted and moved on before the run, so a run that dies early is not repeated at once.
  all[folder] = { ...p, tries: p.tries + 1, next: new Date(Date.now() + 60 * 60_000).toISOString() };
  writeFileSync(PENDING, JSON.stringify(all, null, 1));
  log(`voices for ${folder}: try ${p.tries + 1}`);
  const code = await new Promise(res => spawn('node', ['worker/autopublish.js', ...p.args, ...EXTRA], { cwd: ROOT, stdio: 'inherit', env: process.env }).on('close', res));
  log(`voices for ${folder}: autopublish exited ${code}${code === 0 ? ' (voices added)' : ''}`);
  return true;
}

log(`worker started: ${SITE}${EXTRA.length ? ` (autopublish ${EXTRA.join(' ')})` : ''}`);
// Every model and key the pipeline needs, checked once at the start (scripts/check_keys.js).
await new Promise(res => spawn('node', ['scripts/check_keys.js'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'] })
  .on('close', code => { log(code === 0 ? 'check: everything the pipeline needs answers' : 'check: something the pipeline needs is DOWN (npm run check)'); res(); }));
for (;;) {
  let worked = false;
  try { worked = await next(); } catch (e) { log(`(site not reachable: ${e.message})`); }
  if (!worked) try { worked = await pendingVoices(); } catch (e) { log(`(pending voices: ${e.message})`); }
  if (!worked) await new Promise(r => setTimeout(r, 15000));
}
