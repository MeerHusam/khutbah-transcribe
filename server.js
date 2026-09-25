import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadResult } from './reader_chunks.js';
import { handleLiveConnection, liveStatus } from './live.js';
import { handleStreamConnection, streamStatus } from './live/index.js';

// Load Quran data once at startup
const quranData = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'node_modules/quran-json/dist/quran.json'), 'utf8'));
// Sahih International, the same translation the pipeline swaps into quoted verses.
const quranEn = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'node_modules/quran-json/dist/quran_en.json'), 'utf8'));

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '16kb' }));
app.get('/', (req, res) => res.sendFile(join(__dirname, 'public', 'home.html')));
app.get('/:slug', (req, res, next) => {
  if (!SLUG_TO_FOLDER.has(req.params.slug)) return next();
  res.sendFile(join(__dirname, 'public', 'index.html'));
});
app.use(express.static(join(__dirname, 'public')));
app.use('/audio_files', express.static(join(__dirname, 'audio_files')));

// Secret for viewing submitted feedback at /admin/feedback?key=… (set in env on deploy)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// ────────────────────────────────────────────────────────────────────────────
// Curated public khutbah list. This is a READ-ONLY listening site, so instead of
// exposing every folder in outputs/ (50+ dev/test runs) we publish a hand-picked
// allowlist with friendly titles. The first entry (featured) is the home view.
// To publish another khutbah: add its outputs/ folder here and ensure its audio is
// in audio_files/<basename>.<ext> (basename = folder name after the timestamp).
// ────────────────────────────────────────────────────────────────────────────
const PUBLIC_KHUTBAHS = [
  {
    folder: '2026-09-25T10-04-57_khutbah-2026-09-25-masjid',
    slug: '2026-09-25',
    title: 'The Blessing of Security',
    speaker: 'Friday Khutbah',
    masjid: 'Askan AlMaather Mosque',
    masjid_ar: 'جامع إسكان المعذر',
    maps_url: 'https://maps.app.goo.gl/J8ghwSqr3yUyrTQA6',
    date: '25 September 2026',
    featured: true,
  },
  // ── Arafah khutbah (single continuous khutbah — processed with `--single`) ──
  {
    folder: '2026-09-11T15-48-51_arafah_khutbah_2026',
    slug: 'arafah-2026',
    title: 'The Khutbah of Arafah',
    speaker: 'Sheikh Ali al-Hudhayfi',
    masjid: 'Masjid Namirah, Arafat',
    masjid_ar: 'مسجد نمرة',
    maps_url: 'https://www.google.com/maps/search/?api=1&query=Masjid+Namirah+Arafat',
    date: '26 May 2026',
  },
  // ── Eid al-Adha khutbah (single khutbah — processed with `--type eid`) ──
  {
    folder: '2026-05-27T03-50-41_eid_khutbah_2026',
    slug: 'eid-al-adha-2026',
    title: 'Eid al-Adha Khutbah',
    speaker: 'Eid Khutbah',
    masjid: 'Askan AlMaather Mosque',
    masjid_ar: 'جامع إسكان المعذر',
    maps_url: 'https://maps.app.goo.gl/J8ghwSqr3yUyrTQA6',
    date: '27 May 2026',
  },
  {
    folder: '2026-05-22T11-30-04_khutbah-2026-05-22-masjid',
    slug: '2026-05-22',
    title: 'The Day of Arafah & Udhiyah',
    speaker: 'Friday Khutbah',
    masjid: 'Askan AlMaather Mosque',
    masjid_ar: 'جامع إسكان المعذر',
    maps_url: 'https://maps.app.goo.gl/J8ghwSqr3yUyrTQA6',
    date: '22 May 2026',
  },
  {
    folder: '2026-09-11T13-55-21_khutbah-2026-09-11-masjid',
    slug: '2026-09-11',
    title: 'The Blessing of Water',
    speaker: 'Friday Khutbah',
    masjid: 'Askan AlMaather Mosque',
    masjid_ar: 'جامع إسكان المعذر',
    maps_url: 'https://maps.app.goo.gl/J8ghwSqr3yUyrTQA6',
    date: '11 September 2026',
  },
  {
    folder: '2026-05-22T21-05-05_makkah_sudais_ramadan_ummah',
    slug: 'sudais-ramadan',
    title: 'Ramadan: A Season of Renewal',
    speaker: 'Sheikh Abdul Rahman al-Sudais',
    masjid: 'Masjid al-Haram, Makkah',
    masjid_ar: 'المسجد الحرام',
    maps_url: 'https://www.google.com/maps/search/?api=1&query=Masjid+al-Haram+Makkah',
  },
];
const FEATURED_FOLDER = (PUBLIC_KHUTBAHS.find(k => k.featured) || PUBLIC_KHUTBAHS[0]).folder;
const ALLOWED_FOLDERS = new Set(PUBLIC_KHUTBAHS.map(k => k.folder));
// Short share links: /2026-09-25 instead of /index.html?folder=<run folder>.
const SLUG_TO_FOLDER = new Map(PUBLIC_KHUTBAHS.filter(k => k.slug).map(k => [k.slug, k.folder]));

// Parsed results are immutable at runtime (files never change), so cache indefinitely.
const resultCache = new Map();
let listCache = null;

// ────────────────────────────────────────────────────────────────────────────
// Viewer counts. Live = concurrent open WebSocket connections. Total = cumulative
// page loads, persisted to disk so it survives restarts/redeploys.
// ────────────────────────────────────────────────────────────────────────────
const DATA_DIR = join(__dirname, 'data');
const VIEWS_FILE = join(DATA_DIR, 'views.json');
const FEEDBACK_FILE = join(DATA_DIR, 'feedback.jsonl');
const GEO_FILE = join(DATA_DIR, 'geo_views.jsonl');
const VISITS_FILE = join(DATA_DIR, 'visits.jsonl');
mkdirSync(DATA_DIR, { recursive: true });

async function lookupGeo(ip) {
  if (!ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.')) return null;
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=city,regionName,country,countryCode,status`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    if (data.status !== 'success') return null;
    return { city: data.city, region: data.regionName, country: data.country, countryCode: data.countryCode };
  } catch { return null; }
}

import { createHash } from 'crypto';

let totalViews = 0;
let uniqueIps = new Set();
// Hashed IP -> ISO timestamp of that visitor's first ever visit. Hashes recorded before
// this map existed have no entry; /admin/traffic reports those as "before tracking".
let firstSeen = {};
try {
  const saved = JSON.parse(readFileSync(VIEWS_FILE, 'utf8'));
  totalViews = saved.total || 0;
  uniqueIps = new Set(saved.unique_ips || []);
  firstSeen = saved.first_seen || {};
} catch { totalViews = 0; }

function persistViews() {
  try { writeFileSync(VIEWS_FILE, JSON.stringify({ total: totalViews, unique_ips: [...uniqueIps], first_seen: firstSeen })); } catch {}
}

function hashIp(ip) {
  return createHash('sha256').update(ip).digest('hex').slice(0, 16);
}

const liveClients = new Set();

function broadcastViewers() {
  const payload = JSON.stringify({ type: 'viewers', live: liveClients.size, total: totalViews, unique: uniqueIps.size });
  for (const ws of liveClients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

wss.on('connection', (ws, req) => {
  // Live khutbah sockets (host + listeners) — separate protocols, not page-views.
  const wsPath = (req.url || '').split('?')[0];
  if (wsPath === '/ws/live') return handleLiveConnection(ws, req);
  if (wsPath === '/ws/stream') return handleStreamConnection(ws, req);
  liveClients.add(ws);
  totalViews += 1;
  const rawIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const visitTs = new Date().toISOString();
  let isNewVisitor = false;
  if (rawIp) {
    const h = hashIp(rawIp);
    isNewVisitor = !uniqueIps.has(h);
    uniqueIps.add(h);
    if (isNewVisitor) firstSeen[h] = visitTs;
  }
  persistViews();
  // Per-visit log so traffic can be charted over time (views.json only holds running totals).
  try { appendFileSync(VISITS_FILE, JSON.stringify({ ts: visitTs, new: isNewVisitor }) + '\n'); } catch {}
  // Send the new client its current numbers immediately, then tell everyone.
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'viewers', live: liveClients.size, total: totalViews, unique: uniqueIps.size }));
  broadcastViewers();
  lookupGeo(rawIp).then(geo => {
    if (!geo) return;
    const entry = { ts: new Date().toISOString(), ...geo };
    try { appendFileSync(GEO_FILE, JSON.stringify(entry) + '\n'); } catch {}
  });
  ws.on('close', () => {
    liveClients.delete(ws);
    broadcastViewers();
  });
  ws.on('error', () => {
    liveClients.delete(ws);
  });
});

function findAudioUrl(folder) {
  const exts = ['mp3', 'm4a', 'wav', 'mp4', 'ogg', 'flac'];
  // CLI run: basename after timestamp prefix matches audio_files/ filename
  const baseMatch = folder.match(/^\d{4}-\d{2}-\d{2}T[\d-]+_(.+)$/);
  if (baseMatch) {
    const basename = baseMatch[1];
    for (const ext of exts) {
      if (existsSync(join(__dirname, 'audio_files', `${basename}.${ext}`))) {
        return `/audio_files/${basename}.${ext}`;
      }
    }
  }
  return null;
}


// One home-page card. Shared by the route and the startup cache warm-up: they were two
// copies, and the warm-up one lost masjid and date, so the cards never showed them.
function listItem(k, r) {
  return {
    folder: k.folder,
    slug: k.slug || '',
    title: k.title,
    speaker: k.speaker || '',
    masjid: k.masjid || '',
    maps_url: k.maps_url || '',
    date: k.date || '',
    featured: !!k.featured,
    summary: (r.share_summary || r.summary || '').slice(0, 200),
    words: r.metadata?.transcript_word_count || 0,
    quran: r.metadata?.quran_references_matched || 0,
    hadith: r.metadata?.hadith_references_found || 0,
    mode: r.metadata?.transcription_mode || '',
  };
}

// Curated list of published khutbahs (with friendly titles + summary stats)
app.get('/api/results', (req, res) => {
  if (listCache) return res.json(listCache);
  const items = PUBLIC_KHUTBAHS.map(k => {
    try {
      return listItem(k, JSON.parse(readFileSync(join(__dirname, 'outputs', k.folder, 'result.json'), 'utf8')));
    } catch { return null; }
  }).filter(Boolean);
  listCache = { featured: FEATURED_FOLDER, items };
  res.json(listCache);
});

// Load a specific published khutbah (allowlist-gated)
app.get('/api/results/:folder', (req, res) => {
  if (!ALLOWED_FOLDERS.has(req.params.folder)) {
    return res.status(404).json({ error: 'Not found' });
  }
  if (resultCache.has(req.params.folder)) return res.json(resultCache.get(req.params.folder));
  try {
    const folder = `outputs/${req.params.folder}`;
    const result = loadResult(folder);
    result.audio_url = findAudioUrl(req.params.folder);
    const meta = PUBLIC_KHUTBAHS.find(k => k.folder === req.params.folder);
    result.title = meta?.title || '';
    result.speaker = meta?.speaker || '';
    result.masjid = meta?.masjid || '';
    result.masjid_ar = meta?.masjid_ar || '';
    result.maps_url = meta?.maps_url || '';
    result.date = meta?.date || '';
    resultCache.set(req.params.folder, result);
    res.json(result);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// Live khutbah mode (test): /live page + status endpoint
app.get('/live', (req, res) => res.sendFile(join(__dirname, 'public', 'live.html')));
app.get('/api/live/status', (req, res) => res.json(liveStatus()));

// Streaming live mode (Speechmatics realtime) — separate from /live and from the
// offline upload pipeline; both continue to work untouched.
app.get('/stream', (req, res) => res.sendFile(join(__dirname, 'public', 'stream.html')));
app.get('/api/stream/status', (req, res) => res.json(streamStatus()));

// Quran ayah lookup with harakat
app.get('/api/quran/:surah/:ayah', (req, res) => {
  const s = parseInt(req.params.surah);
  const a = parseInt(req.params.ayah);
  if (!s || !a || s < 1 || s > 114) return res.status(404).json({ error: 'Not found' });
  const surah = quranData[s - 1];
  if (!surah) return res.status(404).json({ error: 'Not found' });
  const verse = surah.verses.find(v => v.id === a);
  if (!verse) return res.status(404).json({ error: 'Not found' });
  const translation = quranEn[s - 1]?.verses.find(v => v.id === a)?.translation?.trim() || '';
  res.json({ surah: s, ayah: a, surah_name: surah.name, text: verse.text, translation });
});

// ────────────────────────────────────────────────────────────────────────────
// Feedback: visitors submit via the box on the page; entries are appended as
// one JSON object per line to data/feedback.jsonl. Read them at
// /admin/feedback?key=<ADMIN_TOKEN>. (data/ is ephemeral on Render's free plan —
// use the persistent disk in render.yaml to keep submissions across redeploys.)
// ────────────────────────────────────────────────────────────────────────────
app.post('/api/feedback', (req, res) => {
  const message = (req.body?.message || '').toString().trim().slice(0, 2000);
  const contact = (req.body?.contact || '').toString().trim().slice(0, 200);
  if (!message) return res.status(400).json({ error: 'Message is required' });
  const entry = {
    ts: new Date().toISOString(),
    message,
    contact: contact || null,
    khutbah: (req.body?.folder || '').toString().slice(0, 120) || null,
    ua: (req.headers['user-agent'] || '').toString().slice(0, 200),
    ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim(),
  };
  try {
    appendFileSync(FEEDBACK_FILE, JSON.stringify(entry) + '\n');
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Could not save feedback' });
  }
});

app.get('/admin/feedback', (req, res) => {
  if (!ADMIN_TOKEN) return res.status(503).send('Set the ADMIN_TOKEN env var to view feedback.');
  if (req.query.key !== ADMIN_TOKEN) return res.status(401).send('Unauthorized');
  let entries = [];
  try {
    entries = readFileSync(FEEDBACK_FILE, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean).reverse();
  } catch {}
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cards = entries.length
    ? entries.map(e => `<div class="f"><div class="msg">${esc(e.message)}</div>
        <div class="meta">${esc(e.ts)}${e.contact ? ' · ' + esc(e.contact) : ''}${e.khutbah ? ' · ' + esc(e.khutbah) : ''}</div></div>`).join('')
    : '<p>No feedback yet.</p>';
  res.send(`<!doctype html><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Feedback (${entries.length})</title>
    <style>body{font-family:system-ui,-apple-system,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#1a1a1a}
    h1{font-size:18px;margin-bottom:16px}.f{border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin-bottom:12px}
    .msg{white-space:pre-wrap;line-height:1.55}.meta{font-size:12px;color:#6b7280;margin-top:8px}</style>
    <h1>Feedback (${entries.length})</h1>${cards}`);
});

app.get('/admin/geo', (req, res) => {
  if (!ADMIN_TOKEN) return res.status(503).send('Set the ADMIN_TOKEN env var to view geo data.');
  if (req.query.key !== ADMIN_TOKEN) return res.status(401).send('Unauthorized');
  let entries = [];
  try {
    entries = readFileSync(GEO_FILE, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean).reverse();
  } catch {}

  // Summarise by country then city
  const byCountry = {};
  for (const e of entries) {
    const key = `${e.countryCode} ${e.country}`;
    if (!byCountry[key]) byCountry[key] = { country: e.country, countryCode: e.countryCode, count: 0, cities: {} };
    byCountry[key].count++;
    const city = e.city || 'Unknown';
    byCountry[key].cities[city] = (byCountry[key].cities[city] || 0) + 1;
  }
  const rows = Object.values(byCountry).sort((a, b) => b.count - a.count).map(c => {
    const cities = Object.entries(c.cities).sort((a, b) => b[1] - a[1])
      .map(([city, n]) => `<span class="city">${city} (${n})</span>`).join(' ');
    return `<tr><td>${c.countryCode}</td><td>${c.country}</td><td class="n">${c.count}</td><td>${cities}</td></tr>`;
  }).join('');

  res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Viewers by Location (${entries.length})</title>
    <style>body{font-family:system-ui,sans-serif;max-width:900px;margin:24px auto;padding:0 16px;color:#1a1a1a}
    h1{font-size:18px;margin-bottom:16px}table{border-collapse:collapse;width:100%}
    th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:14px}
    th{background:#f9fafb;font-weight:600}.n{font-weight:700;color:#059669}
    .city{display:inline-block;background:#f0fdf4;border:1px solid #d1fae5;border-radius:4px;padding:1px 7px;margin:2px;font-size:12px;color:#065f46}</style>
    <h1>Viewers by Location (${entries.length} total)</h1>
    <table><thead><tr><th>Code</th><th>Country</th><th>Views</th><th>Cities</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4">No geo data yet.</td></tr>'}</tbody></table>`);
});

// Traffic over time: visits + first-time visitors bucketed by UTC day, built from
// data/visits.jsonl (one line per page view). Answers "when did unique go up?".
app.get('/admin/traffic', (req, res) => {
  if (!ADMIN_TOKEN) return res.status(503).send('Set the ADMIN_TOKEN env var to view traffic data.');
  if (req.query.key !== ADMIN_TOKEN) return res.status(401).send('Unauthorized');

  const byDay = new Map(); // 'YYYY-MM-DD' -> { visits, newVisitors }
  const bump = (day, isNew) => {
    if (!byDay.has(day)) byDay.set(day, { visits: 0, newVisitors: 0 });
    const d = byDay.get(day);
    d.visits++;
    if (isNew) d.newVisitors++;
  };
  try {
    for (const line of readFileSync(VISITS_FILE, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const e = JSON.parse(line);
        if (e.ts) bump(e.ts.slice(0, 10), !!e.new);
      } catch {}
    }
  } catch {}

  const untracked = uniqueIps.size - Object.keys(firstSeen).length;
  const days = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  const peak = Math.max(1, ...days.map(([, d]) => d.visits));
  const rows = days.map(([day, d]) => `<tr><td>${day}</td><td class="n">${d.visits}</td>
    <td class="u">${d.newVisitors || ''}</td>
    <td><span class="bar" style="width:${Math.round((d.visits / peak) * 100)}%"></span></td></tr>`).join('');

  res.send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Traffic over time</title>
    <style>body{font-family:system-ui,sans-serif;max-width:900px;margin:24px auto;padding:0 16px;color:#1a1a1a}
    h1{font-size:18px;margin-bottom:4px}p.sub{color:#6b7280;font-size:13px;margin-top:0}
    table{border-collapse:collapse;width:100%}
    th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e5e7eb;font-size:14px}
    th{background:#f9fafb;font-weight:600}.n{font-weight:700;color:#059669}
    .u{font-weight:700;color:#b45309}
    .bar{display:block;height:10px;background:#34d399;border-radius:3px;min-width:2px}</style>
    <h1>Traffic over time</h1>
    <p class="sub">${totalViews} total views &middot; ${uniqueIps.size} unique visitors${untracked > 0 ? ` (${untracked} first seen before per-day tracking started)` : ''}. Days are UTC.</p>
    <table><thead><tr><th>Day (UTC)</th><th>Views</th><th>New visitors</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4">No visits logged yet &mdash; data/visits.jsonl starts filling on the next page view.</td></tr>'}</tbody></table>`);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`KhutbahTranscribe (public read-only) running at http://localhost:${PORT}`);
  // Pre-warm cache so the very first visitor never waits on file I/O.
  for (const k of PUBLIC_KHUTBAHS) {
    try {
      const result = loadResult(`outputs/${k.folder}`);
      result.audio_url = findAudioUrl(k.folder);
      result.title = k.title;
      result.speaker = k.speaker || '';
      result.masjid = k.masjid || '';
      result.masjid_ar = k.masjid_ar || '';
      result.maps_url = k.maps_url || '';
      result.date = k.date || '';
      resultCache.set(k.folder, result);
    } catch (e) {
      console.warn(`Cache warm failed for ${k.folder}:`, e.message);
    }
  }
  listCache = {
    featured: FEATURED_FOLDER,
    items: PUBLIC_KHUTBAHS.map(k => {
      const r = resultCache.get(k.folder);
      return r ? listItem(k, r) : null;
    }).filter(Boolean),
  };
  console.log(`Cached ${resultCache.size}/${PUBLIC_KHUTBAHS.length} khutbahs.`);
});
