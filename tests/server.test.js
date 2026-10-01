// tests/server.test.js — The site against a real server: pages, khutbah API, viewer socket,
// feedback, and the admin and upload API. The server runs on its own port with an empty data
// folder, so nothing touches real visit counts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const PORT = 3200 + Math.floor(Math.random() * 600);
const BASE = `http://localhost:${PORT}`;
const KEY = 'test-admin-key';
const DATA = mkdtempSync(join(tmpdir(), 'khutbah-server-test-'));
const khutbahs = JSON.parse(readFileSync('server/khutbahs.json', 'utf8'));
let server;

before(async () => {
  server = spawn(process.execPath, ['server/server.js'], {
    env: { ...process.env, PORT: String(PORT), ADMIN_TOKEN: KEY, DATA_DIR: DATA },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    server.stdout.on('data', d => { if (/Cached \d+\/\d+ khutbahs/.test(d)) resolve(); });
    server.on('exit', code => reject(new Error(`server exited (${code})`)));
  });
}, { timeout: 60_000 });

after(() => {
  server?.kill();
  rmSync(DATA, { recursive: true, force: true });
});

const get = (path, init) => fetch(BASE + path, { redirect: 'manual', ...init });

test('home page carries its link-preview tags', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<meta property="og:title" content="KhutbahTranscribe">/);
});

test('every published khutbah opens at its short link; old links redirect; others are 404', async () => {
  for (const k of khutbahs) {
    const r = await get(`/${k.slug}`);
    assert.equal(r.status, 200, k.slug);
    assert.ok((await r.text()).includes(`<title>${k.title.replace(/&/g, '&amp;')} · KhutbahTranscribe</title>`), k.slug);
    for (const old of k.old_slugs ?? []) {
      const m = await get(`/${old}`);
      assert.equal(m.status, 301);
      assert.equal(m.headers.get('location'), `/${k.slug}`);
    }
  }
  assert.equal((await get('/no-such-khutbah')).status, 404);
});

test('/api/results lists the published khutbahs, and each one loads', async () => {
  const list = await (await get('/api/results')).json();
  assert.deepEqual(list.items.map(i => i.folder), khutbahs.map(k => k.folder));
  assert.equal(list.featured, (khutbahs.find(k => k.featured) ?? khutbahs[0]).folder);
  for (const k of khutbahs) {
    const r = await (await get(`/api/results/${k.folder}`)).json();
    assert.equal(r.title, k.title);
    assert.ok(r.reader_chunks.length > 0, k.folder);
  }
  assert.equal((await get('/api/results/not-a-published-folder')).status, 404);
});

test('/api/quran gives a verse with its translation', async () => {
  const v = await (await get('/api/quran/112/1')).json();
  assert.equal(v.surah, 112);
  assert.ok(v.text && v.translation);
  assert.equal((await get('/api/quran/115/1')).status, 404);
});

test('the viewer socket counts a visit and logs it', async () => {
  const messages = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/?d=test-device-1&p=home`);
    const got = [];
    ws.on('message', m => { got.push(JSON.parse(m)); if (got.length === 2) { ws.close(); resolve(got); } });
    ws.on('error', reject);
  });
  assert.equal(messages[0].type, 'hello');
  assert.deepEqual({ ...messages[1], live: undefined }, { type: 'viewers', live: undefined, total: 1, unique: 1, devices: 1 });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(JSON.parse(readFileSync(join(DATA, 'visits.jsonl'), 'utf8').trim()).page, 'home');
});

test('feedback is stored, and readable only with the admin key', async () => {
  const post = body => get('/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ message: 'jazakAllah khair' })).status, 200);
  assert.equal((await get('/admin/feedback')).status, 401);
  const page = await get(`/admin/feedback?key=${KEY}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /jazakAllah khair/);
  assert.equal((await get(`/admin/traffic?key=${KEY}`)).status, 200);
});

test('upload API: upload, claim once, download, and the recording is removed', async () => {
  const headers = { 'x-admin-key': KEY };
  assert.equal((await get('/admin/upload', { method: 'POST', body: Buffer.alloc(200 * 1024) })).status, 401);
  const job = await (await get('/admin/upload', { method: 'POST', headers: { ...headers, 'x-file-name': 'khutbah.m4a', 'x-masjid': 'Test' }, body: Buffer.alloc(200 * 1024) })).json();
  assert.equal(job.status, 'uploaded');
  assert.equal(job.masjid, 'Test');
  const queued = await (await get('/admin/uploads?status=uploaded', { headers })).json();
  assert.deepEqual(queued.map(j => j.id), [job.id]);
  const status = s => get(`/admin/uploads/${job.id}/status`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ status: s }) });
  assert.equal((await status('claimed')).status, 200);
  assert.equal((await status('claimed')).status, 409);
  const file = await get(`/admin/uploads/${job.id}/file`, { headers });
  assert.equal((await file.arrayBuffer()).byteLength, 200 * 1024);
  assert.equal((await status('downloaded')).status, 200);
  assert.equal(existsSync(join(DATA, 'uploads', `${job.id}.m4a`)), false);
  assert.equal((await get(`/admin/uploads/${job.id}/file`, { headers })).status, 404);
});
