// tests/server.test.js — The site against a real server: pages, khutbah API, viewer socket,
// feedback, the admin and upload API, and publishing a khutbah. The server runs on its own port
// with an empty data folder (a fresh database, seeded from server/khutbahs.seed.json), so
// nothing touches real visit counts or the real list.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { publishToSite } from '../worker/site.js';

const PORT = 3200 + Math.floor(Math.random() * 600);
const BASE = `http://localhost:${PORT}`;
const KEY = 'test-admin-key';
const DATA = mkdtempSync(join(tmpdir(), 'khutbah-server-test-'));
const khutbahs = JSON.parse(readFileSync('server/khutbahs.seed.json', 'utf8'));
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

test('publishing: a new khutbah is live at once, with its files, recording and voice track', async () => {
  // A copy of 25 Sep's run under a new folder name, as the Mac would have it.
  const src = join('outputs', khutbahs[0].folder);
  const tmp = mkdtempSync(join(tmpdir(), 'khutbah-publish-test-'));
  const folderPath = join(tmp, '2026-10-02T12-00-00_khutbah-test-publish');
  mkdirSync(folderPath);
  for (const f of ['result.json', 'reader.txt', 'reader_ur.txt', 'tts_ur.json', 'tts_ur.mp3', 'words_imam.json']) copyFileSync(join(src, f), join(folderPath, f));
  const recording = join(tmp, 'khutbah-test-publish.m4a');
  writeFileSync(recording, Buffer.alloc(1000, 1));
  const entry = { slug: 'test-publish', title: 'Test Publish', date: '2 October 2026', page: 'reader-ur.html', featured: true };
  try {
    await assert.rejects(publishToSite({ site: BASE, key: 'wrong-key', folderPath, recording, entry }), /401/);
    assert.equal(await publishToSite({ site: BASE, key: KEY, folderPath, recording, entry }), `${BASE}/test-publish`);

    const page = await get('/test-publish');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Test Publish · KhutbahTranscribe<\/title>/);
    const list = await (await get('/api/results')).json();
    assert.equal(list.items[0].slug, 'test-publish');
    assert.equal(list.featured, '2026-10-02T12-00-00_khutbah-test-publish');
    assert.deepEqual(list.items.filter(i => i.featured).map(i => i.slug), ['test-publish']);
    const r = await (await get('/api/results/2026-10-02T12-00-00_khutbah-test-publish')).json();
    assert.equal(r.audio_url, '/audio_files/khutbah-test-publish.m4a');
    assert.equal((await (await get(r.audio_url)).arrayBuffer()).byteLength, 1000);
    assert.equal((await get(r.tts_ur.url)).status, 200);
    assert.ok(existsSync(join(DATA, 'outputs', '2026-10-02T12-00-00_khutbah-test-publish', 'reader.txt')));

    // A slug belongs to one folder; a bad slug is refused.
    const other = { folderPath: join(tmp, 'x'), recording: null };
    mkdirSync(other.folderPath);
    copyFileSync(join(src, 'result.json'), join(other.folderPath, 'result.json'));
    copyFileSync(join(src, 'reader.txt'), join(other.folderPath, 'reader.txt'));
    await assert.rejects(publishToSite({ site: BASE, key: KEY, ...other, entry: { slug: 'test-publish', title: 'T' } }), /409/);
    await assert.rejects(publishToSite({ site: BASE, key: KEY, ...other, entry: { slug: 'Bad Slug', title: 'T' } }), /400/);
    // Publishing again updates in place: same place in the list, new title.
    await publishToSite({ site: BASE, key: KEY, folderPath, recording, entry: { ...entry, title: 'Test Publish, corrected' } });
    const again = await (await get('/api/results')).json();
    assert.equal(again.items[0].title, 'Test Publish, corrected');
    assert.equal(again.items.length, list.items.length);
    // A new slug for the same khutbah: the old link redirects to it.
    await publishToSite({ site: BASE, key: KEY, folderPath, recording, entry: { ...entry, slug: 'test-publish-2' } });
    const moved = await get('/test-publish');
    assert.equal(moved.status, 301);
    assert.equal(moved.headers.get('location'), '/test-publish-2');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a khutbah whose audio is on R2: its recording and voice links point there', async () => {
  const src = join('outputs', khutbahs[0].folder);
  const folder = '2026-10-02T13-00-00_khutbah-test-r2';
  const headers = { 'x-admin-key': KEY, 'content-type': 'application/octet-stream' };
  for (const f of ['result.json', 'reader.txt', 'tts_ur.json']) {
    assert.equal((await get(`/admin/api/files/${folder}/${f}`, { method: 'PUT', headers, body: readFileSync(join(src, f)) })).status, 200);
  }
  const post = body => get('/admin/api/khutbahs', { method: 'POST', headers: { 'x-admin-key': KEY, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const entry = { folder, slug: 'test-r2', title: 'On R2', audio: 'recording.m4a' };
  assert.equal((await post({ ...entry, media_url: 'http://media.example/test-r2/' })).status, 400);
  assert.equal((await post({ ...entry, media_url: 'https://media.example/test-r2/' })).status, 200);
  const r = await (await get(`/api/results/${folder}`)).json();
  assert.equal(r.audio_url, 'https://media.example/test-r2/recording.m4a');
  assert.equal(r.tts_ur.url, 'https://media.example/test-r2/tts_ur.mp3');
});
