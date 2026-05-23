import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load Quran data once at startup
const quranData = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'node_modules/quran-json/dist/quran.json'), 'utf8'));

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json({ limit: '16kb' }));
app.get('/', (req, res) => res.sendFile(join(__dirname, 'public', 'home.html')));
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
    folder: '2026-05-22T11-30-04_khutbah-2026-05-22-masjid',
    title: 'The Day of Arafah & Udhiyah',
    speaker: 'Friday Khutbah',
    masjid: 'Askan AlMaather Mosque',
    masjid_ar: 'جامع إسكان المعذر',
    maps_url: 'https://maps.app.goo.gl/J8ghwSqr3yUyrTQA6',
    date: '22 May 2026',
    featured: true,
  },
  {
    folder: '2026-05-22T21-05-05_makkah_sudais_ramadan_ummah',
    title: 'Ramadan: A Season of Renewal',
    speaker: 'Sheikh Sudais · Makkah',
    date: '22 May 2026',
  },
];
const FEATURED_FOLDER = (PUBLIC_KHUTBAHS.find(k => k.featured) || PUBLIC_KHUTBAHS[0]).folder;
const ALLOWED_FOLDERS = new Set(PUBLIC_KHUTBAHS.map(k => k.folder));

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
try {
  const saved = JSON.parse(readFileSync(VIEWS_FILE, 'utf8'));
  totalViews = saved.total || 0;
  uniqueIps = new Set(saved.unique_ips || []);
} catch { totalViews = 0; }

function persistViews() {
  try { writeFileSync(VIEWS_FILE, JSON.stringify({ total: totalViews, unique_ips: [...uniqueIps] })); } catch {}
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
  liveClients.add(ws);
  totalViews += 1;
  const rawIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (rawIp) uniqueIps.add(hashIp(rawIp));
  persistViews();
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

// Maps each transcript word to the start time of the Whisper segment it belongs to.
function buildWordTimeMap(segments) {
  const wordTimes = [];
  for (const seg of segments) {
    const words = seg.text.trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) wordTimes.push(seg.start);
  }
  return wordTimes;
}

function loadResult(folder) {
  const result = JSON.parse(readFileSync(join(__dirname, folder, 'result.json'), 'utf8'));
  try {
    const readerRaw = readFileSync(join(__dirname, folder, 'reader.txt'), 'utf8');
    // A paragraph is Arabic-dominant if >40% of its word chars are Arabic Unicode
    const isArabicDominant = s => {
      const total = s.replace(/\s/g, '').length;
      if (!total) return false;
      const arChars = (s.match(/[؀-ۿ]/g) || []).length;
      return arChars / total > 0.4;
    };
    const chunks = readerRaw
      .split(/─{20,}/)
      .map(block => {
        return block.replace(/^ANNOTATED READER VIEW\s*=+\s*/i, '').trim();
      })
      .filter(Boolean)
      .map(block => {
        const paras = block.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
        const arabicParas = paras.filter(p => isArabicDominant(p));
        const englishParas = paras.filter(p => !isArabicDominant(p));
        return {
          arabic: arabicParas.join(' '),
          english: englishParas.join('\n\n')
        };
      })
      .filter(c => c.arabic && c.english);

    // Attach start_time by searching for each chunk's leading Arabic words in the transcript.
    // This is more robust than a sequential pcm counter: Hadith overlap and zone-boundary
    // edge cases caused the counter to drift 3-4 entries off, producing timestamps 30-40s late.
    // Prefer word-level timestamps (transcript_words) — each word carries its own real audio
    // time. Fall back to segment start times for older runs that lack word-level data.
    let tWords, wordTimes;
    if (result.transcript_words && result.transcript_words.length) {
      tWords = result.transcript_words.map(w => w.word);
      wordTimes = result.transcript_words.map(w => w.start);
    } else if (result.transcript_segments && result.transcript_segments.length) {
      const segments = result.transcript_segments;
      wordTimes = buildWordTimeMap(segments);
      tWords = [];
      for (const seg of segments) tWords.push(...seg.text.trim().split(/\s+/).filter(Boolean));
    }
    if (tWords && tWords.length) {
      // Normalize to bare Arabic letters so punctuation/parens/diacritics in Quran cards
      // (e.g. "(خير") don't block the match against plain transcript tokens.
      const stripPunct = w => w.replace(/[ً-ْٰـ]/g, '').replace(/[^ء-ي]/g, '');
      const ntWords = tWords.map(stripPunct);

      // First index >= fromWord where `needleWords` (a prefix/suffix slice) matches.
      function findSeq(needleWords, fromWord, maxWord) {
        const n = needleWords.length;
        if (!n) return -1;
        const hi = Math.min(maxWord ?? ntWords.length - n, ntWords.length - n);
        for (let i = fromWord; i <= hi; i++) {
          if (needleWords.every((w, j) => ntWords[i + j] === w)) return i;
        }
        return -1;
      }

      // Match each chunk to its real span in the transcript. start = first occurrence of the
      // leading words (>= cursor). The cursor then advances to where the chunk actually ENDS
      // (located via its trailing words), not by its display word count — Hadith text is
      // duplicated across reader chunks (signal-phrase chunk + Hadith card), so counting its
      // words would push the cursor past the real position and the forward search could never
      // recover. End-anchoring keeps the cursor on the true transcript position.
      let cursor = 0;
      for (const chunk of chunks) {
        const cw = chunk.arabic.split(/\s+/).map(stripPunct).filter(Boolean);
        let ws = -1;
        for (const len of [6, 4, 3]) {
          if (cw.length < len) continue;
          ws = findSeq(cw.slice(0, len), cursor);
          if (ws >= 0) break;
        }
        if (ws < 0) ws = cursor; // safe fallback
        chunk.start_time = Math.round(wordTimes[Math.min(ws, wordTimes.length - 1)] * 10) / 10;

        // Advance cursor to the chunk's trailing words (its end), searched in a bounded window
        // so duplicated text shrinks the span instead of inflating it.
        let we = ws + 1;
        const tail = cw.slice(-3);
        if (tail.length === 3) {
          const te = findSeq(tail, ws, ws + cw.length + 15);
          if (te >= 0) we = te + 3;
        }
        cursor = Math.max(ws + 1, we);
      }
    }

    // Flag the chunk that begins the second khutbah (so the UI can render a divider before it).
    if (result.second_khutbah && chunks.length) {
      const sk = result.second_khutbah;
      const sp = w => w.replace(/[ً-ْٰـ]/g, '').replace(/[^ء-ي]/g, '');
      let target = -1;

      // 1) Prefer the chunk whose Arabic STARTS with the marker phrase. After the straddling
      //    chunk has been split (clean case) the second-khutbah chunk begins exactly with it.
      //    `startsWith` (not `includes`) avoids matching Khutbah 1's chunk that merely contains it.
      if (sk.marker_text) {
        const needle = sp(sk.marker_text.split(/\s+/).slice(0, 6).join('')).slice(0, 14);
        if (needle) target = chunks.findIndex(c => sp(c.arabic.split(/\s+/).slice(0, 8).join('')).startsWith(needle));
      }
      // 2) Fall back to the chunk whose start_time is NEAREST the split time (mid-chunk boundary
      //    when the split didn't happen, or older data). Nearest — not first ≥ — so a chunk that
      //    starts a hair before the boundary isn't picked over the real one.
      if (target < 0 && typeof sk.time === 'number' && chunks.some(c => typeof c.start_time === 'number')) {
        let bestD = Infinity;
        chunks.forEach((c, i) => {
          if (typeof c.start_time === 'number') {
            const d = Math.abs(c.start_time - sk.time);
            if (d < bestD) { bestD = d; target = i; }
          }
        });
      }
      if (target >= 0) chunks[target].second_khutbah_start = true;
    }

    result.reader_chunks = chunks;
  } catch (_) {}
  return result;
}

// Curated list of published khutbahs (with friendly titles + summary stats)
app.get('/api/results', (req, res) => {
  if (listCache) return res.json(listCache);
  const items = PUBLIC_KHUTBAHS.map(k => {
    try {
      const r = JSON.parse(readFileSync(join(__dirname, 'outputs', k.folder, 'result.json'), 'utf8'));
      return {
        folder: k.folder,
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

// Quran ayah lookup with harakat
app.get('/api/quran/:surah/:ayah', (req, res) => {
  const s = parseInt(req.params.surah);
  const a = parseInt(req.params.ayah);
  if (!s || !a || s < 1 || s > 114) return res.status(404).json({ error: 'Not found' });
  const surah = quranData[s - 1];
  if (!surah) return res.status(404).json({ error: 'Not found' });
  const verse = surah.verses.find(v => v.id === a);
  if (!verse) return res.status(404).json({ error: 'Not found' });
  res.json({ surah: s, ayah: a, surah_name: surah.name, text: verse.text });
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
      if (!r) return null;
      return {
        folder: k.folder, title: k.title, speaker: k.speaker || '', featured: !!k.featured,
        summary: (r.share_summary || r.summary || '').slice(0, 160),
        words: r.metadata?.transcript_word_count || 0,
        quran: r.metadata?.quran_references_matched || 0,
        hadith: r.metadata?.hadith_references_found || 0,
        mode: r.metadata?.transcription_mode || '',
      };
    }).filter(Boolean),
  };
  console.log(`Cached ${resultCache.size}/${PUBLIC_KHUTBAHS.length} khutbahs.`);
});
