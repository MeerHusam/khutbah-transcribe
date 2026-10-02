#!/usr/bin/env node
// load_test.js — Many visitors at once against a local copy of the site (2 Oct 2026), before a big
// Friday: each opens a khutbah page, loads its text, keeps the viewer socket open and reports
// engagement every 30 s, as the reader does. Audio is not fetched (it comes from R2, not the server).
//
//   node scripts/load_test.js [--visitors 1000] [--over 60] [--hold 30]
//
// Starts its own server (empty data folder, port 3400+), prints response times, errors, the live
// count the server reports and its memory, then stops it. Free: nothing leaves this Mac.

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const opt = (name, def) => { const i = process.argv.indexOf(name); return i > 0 ? Number(process.argv[i + 1]) : def; };
const VISITORS = opt('--visitors', 1000), OVER = opt('--over', 60), HOLD = opt('--hold', 30);
const PORT = 3400 + Math.floor(Math.random() * 500);
const BASE = `http://localhost:${PORT}`;
const DATA = mkdtempSync(join(tmpdir(), 'khutbah-load-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const server = spawn('node', ['server/server.js'], { env: { ...process.env, PORT, DATA_DIR: DATA, ADMIN_TOKEN: 'load' }, stdio: 'ignore' });
for (let i = 0; i < 60 && !(await fetch(`${BASE}/api/results`).then(r => r.ok, () => false)); i++) await sleep(250);
const { featured } = await (await fetch(`${BASE}/api/results`)).json();
const slug = JSON.parse(readFileSync('server/khutbahs.seed.json', 'utf8')).find(k => k.folder === featured).slug;

const times = { page: [], text: [], socket: [] };
let errors = 0, lastLive = 0;
const sockets = [];
const timed = async (bucket, fn) => { const t = performance.now(); try { await fn(); } catch { errors++; } times[bucket].push(performance.now() - t); };
const ok = r => { if (!r.ok) throw new Error(r.status); return r; };
// Private addresses: the server skips the place lookup for them, so no request leaves this Mac.
const ip = n => `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;

async function visitor(n) {
  const headers = { 'x-forwarded-for': ip(n) };
  await timed('page', async () => (await ok(await fetch(`${BASE}/${slug}`, { headers }))).text());
  await timed('text', async () => (await ok(await fetch(`${BASE}/api/results/${featured}`, { headers }))).json());
  await timed('socket', () => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/?d=load-${n}-device&p=reader&k=${slug}`, { headers });
    let id = null;
    ws.on('message', m => {
      const j = JSON.parse(m);
      if (j.type === 'hello') id = j.id;
      if (j.type === 'viewers') { lastLive = Math.max(lastLive, j.live); resolve(); }
    });
    ws.on('error', reject);
    sockets.push(ws);
    const beat = setInterval(() => id && fetch(`${BASE}/api/engage`, { method: 'POST', body: JSON.stringify({ id, open_s: 30, played_s: 20, max_pos: 20, dur: 900, lang: 'ur' }) }).catch(() => errors++), 30_000);
    ws.on('close', () => clearInterval(beat));
  }));
}

const rss = () => Number(execFileSync('ps', ['-o', 'rss=', '-p', String(server.pid)]).toString().trim()) / 1024;
console.log(`${VISITORS} visitors over ${OVER} s to /${slug}, then ${HOLD} s with all of them open…`);
const start = performance.now();
const all = [];
for (let n = 0; n < VISITORS; n++) {
  all.push(visitor(n));
  await sleep((OVER * 1000) / VISITORS);
}
await Promise.all(all);
const arrived = (performance.now() - start) / 1000;
await sleep(HOLD * 1000);
// While everyone is still connected: how fast does a newcomer get the page?
const probe = performance.now();
await fetch(`${BASE}/${slug}`).then(r => r.text());
const probeMs = performance.now() - probe;
const memory = rss();

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : NaN; };
const row = (name, xs) => console.log(`  ${name.padEnd(22)} median ${pct(xs, 50).toFixed(0).padStart(5)} ms   95% ${pct(xs, 95).toFixed(0).padStart(5)} ms   slowest ${Math.max(...xs).toFixed(0).padStart(5)} ms`);
console.log(`arrived in ${arrived.toFixed(0)} s; errors: ${errors}`);
row('khutbah page', times.page);
row('khutbah text (JSON)', times.text);
row('live counter connect', times.socket);
console.log(`  a newcomer at the peak: ${probeMs.toFixed(0)} ms · live count reported: ${lastLive} · server memory: ${memory.toFixed(0)} MB (Render Starter has 512)`);

for (const ws of sockets) ws.close();
await sleep(500);
server.kill();
rmSync(DATA, { recursive: true, force: true });
process.exit(errors ? 1 : 0);
