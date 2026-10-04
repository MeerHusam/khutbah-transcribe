// tests/server.test.js — The site against a real server: pages, khutbah API, viewer socket,
// feedback, the admin and upload API, and publishing a khutbah. The server runs on its own port
// with an empty data folder (a fresh database, seeded from server/khutbahs.seed.json), so
// nothing touches real visit counts or the real list. The khutbahs' files are not in the repo:
// each listed khutbah is given tests/fixture/ (2 Oct 2026's run) as its files.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, cpSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import WebSocket from 'ws';
import { publishToSite, recordInSeed } from '../worker/site.js';

const PORT = 3200 + Math.floor(Math.random() * 600);
const BASE = `http://localhost:${PORT}`;
const KEY = 'test-admin-key';
const DATA = mkdtempSync(join(tmpdir(), 'khutbah-server-test-'));
const khutbahs = JSON.parse(readFileSync('server/khutbahs.seed.json', 'utf8'));
const FIXTURE = 'tests/fixture';
let server;

before(async () => {
  for (const k of khutbahs) cpSync(FIXTURE, join(DATA, 'outputs', k.folder), { recursive: true });
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
  const html = await r.text();
  assert.match(html, /<meta property="og:title" content="Khutbah.dev · Friday Khutbahs in Arabic, English &amp; Urdu">/);
  assert.match(html, /<link rel="canonical" href="https:\/\/khutbah.dev\/">/);
});

test('sitemap.xml lists the home page and every khutbah; robots.txt points to it', async () => {
  const xml = await (await get('/sitemap.xml')).text();
  for (const p of ['/', ...khutbahs.map(k => `/${k.slug}`)]) assert.ok(xml.includes(`<loc>https://khutbah.dev${p}</loc>`), p);
  assert.match(await (await get('/robots.txt')).text(), /Sitemap: https:\/\/khutbah.dev\/sitemap.xml/);
});

test('every published khutbah opens at its short link; old links redirect; others are 404', async () => {
  for (const k of khutbahs) {
    const r = await get(`/${k.slug}`);
    assert.equal(r.status, 200, k.slug);
    assert.ok((await r.text()).includes(`<title>${k.title.replace(/&/g, '&amp;')} · Khutbah.dev</title>`), k.slug);
    for (const old of k.old_slugs ?? []) {
      const m = await get(`/${old}`);
      assert.equal(m.status, 301);
      assert.equal(m.headers.get('location'), `/${k.slug}`);
    }
  }
  assert.equal((await get('/no-such-khutbah')).status, 404);
});

test('the old onrender address sends pages to khutbah.dev, but not /api or the upload worker\'s /admin/uploads', async () => {
  const onrender = (method, path) => new Promise((resolve, reject) => request(
    { port: PORT, path, method, headers: { host: 'khutbah-live.onrender.com' } }, r => { r.resume(); resolve(r); },
  ).on('error', reject).end());
  const r = await onrender('GET', '/2026-09-25?ref=wa');
  assert.equal(r.statusCode, 301);
  assert.equal(r.headers.location, 'https://khutbah.dev/2026-09-25?ref=wa');
  assert.equal((await onrender('GET', '/api/results')).statusCode, 200);
  assert.equal((await onrender('GET', '/admin/traffic?key=x')).headers.location, 'https://khutbah.dev/admin/traffic?key=x');
  assert.equal((await onrender('GET', '/admin/uploads')).statusCode, 401);
  assert.equal((await onrender('POST', '/admin/api/khutbahs')).statusCode, 401);
  assert.equal((await get('/2026-09-25')).status, 200);
});

test('/api/results lists the published khutbahs, and each one loads', async () => {
  const list = await (await get('/api/results')).json();
  assert.deepEqual(new Set(list.items.map(i => i.folder)), new Set(khutbahs.map(k => k.folder)));
  // Newest first, by the khutbah's date (its folder's date when it has none), not the order added.
  const day = i => { const k = khutbahs.find(k => k.folder === i.folder); return k.date ? Date.parse(`${k.date} UTC`) : Date.parse(k.folder.slice(0, 10)); };
  list.items.forEach((it, n) => n && assert.ok(day(it) <= day(list.items[n - 1]), `${it.folder} is listed above a newer khutbah`));
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

test('a page reconnecting (?re=1) is live again but not a new view', async () => {
  const counts = url => new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('message', m => { const j = JSON.parse(m); if (j.type === 'viewers') { ws.close(); resolve(j); } });
    ws.on('error', reject);
  });
  const before = await counts(`ws://localhost:${PORT}/?d=test-device-2&p=home`);
  const again = await counts(`ws://localhost:${PORT}/?d=test-device-2&p=home&re=1`);
  assert.equal(again.total, before.total);
});

test('place lookups: each address once, at most 40 a minute', async () => {
  const { placeOf } = await import('../server/viewers.js');
  let calls = 0;
  const lookup = async () => { calls++; return { city: 'Riyadh' }; };
  assert.deepEqual(await placeOf('203.0.113.1', lookup), { city: 'Riyadh' });
  await placeOf('203.0.113.1', lookup);
  assert.equal(calls, 1);
  for (let i = 2; i <= 60; i++) await placeOf(`203.0.113.${i}`, lookup);
  assert.ok(calls <= 40, `${calls} lookups in a minute`);
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

test('/feedback shows only the comments people chose to show, minus hidden ones; bots are dropped', async () => {
  const post = body => get('/api/feedback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await get('/feedback')).status, 200);
  assert.equal((await get('/suggestion')).status, 200);
  await post({ message: 'please add Tamil', name: 'Ahmed', public: true, contact: 'a@b.c' });
  await post({ message: 'a private note', public: false });
  await post({ message: 'spam', public: true, website: 'http://spam' });
  let comments = await (await get('/api/comments')).json();
  assert.deepEqual(comments.map(c => c.message), ['please add Tamil']);
  assert.equal(comments[0].name, 'Ahmed');
  assert.equal(comments[0].contact, undefined); // the email is never shown
  const hide = key => get(`/admin/feedback/hide?key=${key}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: `ts=${encodeURIComponent(comments[0].ts)}` });
  assert.equal((await hide('wrong')).status, 401);
  assert.equal((await hide(KEY)).status, 303);
  comments = await (await get('/api/comments')).json();
  assert.equal(comments.length, 0);
});

test('unknown pages get the 404 page, unknown /api paths a JSON 404', async () => {
  const page = await get('/no-such-page');
  assert.equal(page.status, 404);
  assert.match(await page.text(), /Page not found/);
  const api = await get('/api/no-such-thing');
  assert.equal(api.status, 404);
  assert.deepEqual(await api.json(), { error: 'Not found' });
});

test('upload API: upload, claim once, download, and the recording is removed', async () => {
  const headers = { 'x-admin-key': KEY };
  assert.equal((await get('/admin/upload', { method: 'POST', body: Buffer.alloc(200 * 1024) })).status, 401);
  const job = await (await get('/admin/upload', { method: 'POST', headers: { ...headers, 'x-file-name': 'khutbah.m4a', 'x-masjid': 'Test', 'x-speaker': encodeURIComponent("Sheikh Abdullah al-Bu'ayjan"), 'x-date': '2026-09-25' }, body: Buffer.alloc(200 * 1024) })).json();
  assert.equal(job.status, 'uploaded');
  assert.equal(job.masjid, 'Test');
  assert.equal(job.speaker, "Sheikh Abdullah al-Bu'ayjan");
  assert.equal(job.date, '2026-09-25');
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
  // A copy of a run under a new folder name, as the Mac would have it.
  const src = FIXTURE;
  const tmp = mkdtempSync(join(tmpdir(), 'khutbah-publish-test-'));
  const folderPath = join(tmp, '2026-10-02T12-00-00_khutbah-test-publish');
  mkdirSync(folderPath);
  for (const f of ['result.json', 'reader.txt', 'reader_ur.txt', 'tts_ur.json', 'words_imam.json']) copyFileSync(join(src, f), join(folderPath, f));
  writeFileSync(join(folderPath, 'tts_ur.mp3'), Buffer.alloc(1000, 2));
  const recording = join(tmp, 'khutbah-test-publish.m4a');
  writeFileSync(recording, Buffer.alloc(1000, 1));
  const entry = { slug: 'test-publish', title: 'Test Publish', date: '2 October 2026', featured: true };
  try {
    await assert.rejects(publishToSite({ site: BASE, key: 'wrong-key', folderPath, recording, entry }), /401/);
    const seed = join(tmp, 'seed.json');
    copyFileSync('server/khutbahs.seed.json', seed);
    const published = await publishToSite({ site: BASE, key: KEY, folderPath, recording, entry });
    assert.equal(published.url, `${BASE}/test-publish`);
    recordInSeed(published.entry, seed);

    const page = await get('/test-publish');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Test Publish · Khutbah.dev<\/title>/);
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
    recordInSeed((await publishToSite({ site: BASE, key: KEY, folderPath, recording, entry: { ...entry, slug: 'test-publish-2' } })).entry, seed);
    const moved = await get('/test-publish');
    assert.equal(moved.status, 301);
    assert.equal(moved.headers.get('location'), '/test-publish-2');
    // The repo's copy of the list says what the site's database says.
    const copy = JSON.parse(readFileSync(seed, 'utf8'));
    assert.equal(copy.length, khutbahs.length + 1);
    assert.deepEqual(copy[0], { folder: '2026-10-02T12-00-00_khutbah-test-publish', ...entry, slug: 'test-publish-2', old_slugs: ['test-publish'] });
    assert.deepEqual(copy.filter(k => k.featured).map(k => k.slug), ['test-publish-2']);
    const live = (await (await get('/api/results')).json()).items.find(i => i.folder === copy[0].folder);
    assert.equal(live.slug, copy[0].slug);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('a khutbah whose audio is on R2: its recording and voice links point there', async () => {
  const src = FIXTURE;
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
