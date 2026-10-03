// The JSON the pages load (khutbah list and results, Quran verses), the voice tracks and word
// times, and what the pages send back (feedback, engagement).
import express from 'express';
import { readFileSync, appendFileSync } from 'fs';
import { join } from 'path';
import { ROOT, FEEDBACK_FILE, ENGAGE_FILE } from '../config.js';
import { catalog, TTS_LANGS, entryForFolder, getList, getResult, getWords, ttsPath } from '../khutbahs.js';

const router = express.Router();

// Load Quran data once at startup
const quranData = JSON.parse(readFileSync(join(ROOT, 'node_modules/quran-json/dist/quran.json'), 'utf8'));
// Sahih International, the same translation the pipeline swaps into quoted verses.
const quranEn = JSON.parse(readFileSync(join(ROOT, 'node_modules/quran-json/dist/quran_en.json'), 'utf8'));

// Word times for the page: a voice track's (align_words.py) or the imam's (align_imam.js).
const sendWords = (res, folder, file) => {
  const words = getWords(folder, file);
  if (!words) return res.status(404).end();
  res.type('json').set('Cache-Control', 'public, max-age=3600').send(words);
};
router.get('/tts/:folder/:lang.words.json', (req, res) => {
  const { folder, lang } = req.params;
  if (!catalog().allowed.has(folder) || !TTS_LANGS.includes(lang)) return res.status(404).end();
  sendWords(res, folder, `tts_${lang}.json`);
});
router.get('/words/:folder/imam.json', (req, res) => {
  if (!catalog().allowed.has(req.params.folder)) return res.status(404).end();
  sendWords(res, req.params.folder, 'words_imam.json');
});

router.get('/tts/:folder/:lang.mp3', (req, res) => {
  if (!catalog().allowed.has(req.params.folder) || !TTS_LANGS.includes(req.params.lang)) return res.status(404).end();
  res.sendFile(ttsPath(req.params.folder, req.params.lang), err => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// Curated list of published khutbahs (with friendly titles + summary stats)
router.get('/api/results', (req, res) => res.json(getList()));

// Load a specific published khutbah (allowlist-gated)
router.get('/api/results/:folder', (req, res) => {
  const moved = entryForFolder(req.params.folder);
  if (moved && moved.folder !== req.params.folder) req.params.folder = moved.folder;
  if (!catalog().allowed.has(req.params.folder)) {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    res.json(getResult(req.params.folder));
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// Quran ayah lookup with harakat
router.get('/api/quran/:surah/:ayah', (req, res) => {
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

// Feedback: visitors submit via the box on the page; entries are appended as one JSON object
// per line to data/feedback.jsonl. Read them at /admin/feedback?key=<ADMIN_TOKEN>.
// /feedback posts can be shown there (public: true, name optional); the email never is, and
// nothing sent before 2 Oct 2026 has the flag, so older messages stay private.
const feedbackTimes = new Map(); // ip -> recent post times, for the limit below
router.post('/api/feedback', (req, res) => {
  const message = (req.body?.message || '').toString().trim().slice(0, 2000);
  const contact = (req.body?.contact || '').toString().trim().slice(0, 200);
  if (!message) return res.status(400).json({ error: 'Message is required' });
  if (req.body?.website) return res.json({ ok: true }); // the hidden field only bots fill in
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
  const recent = (feedbackTimes.get(ip) || []).filter(t => Date.now() - t < 10 * 60_000);
  if (recent.length >= 5) return res.status(429).json({ error: 'Too many messages' });
  if (feedbackTimes.size > 5000) feedbackTimes.clear();
  feedbackTimes.set(ip, [...recent, Date.now()]);
  const entry = {
    ts: new Date().toISOString(),
    message,
    name: (req.body?.name || '').toString().trim().slice(0, 60) || null,
    public: req.body?.public === true,
    contact: contact || null,
    khutbah: (req.body?.folder || '').toString().slice(0, 120) || null,
    ua: (req.headers['user-agent'] || '').toString().slice(0, 200),
    ip,
  };
  try {
    appendFileSync(FEEDBACK_FILE, JSON.stringify(entry) + '\n');
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Could not save feedback' });
  }
});

// Engagement snapshots from the reader page (navigator.sendBeacon, text/plain JSON): how long
// the page was on screen and how much of the audio was played, for /admin/traffic. Several
// per view; the dashboard keeps the largest values. Throttled to one per view per 10 s.
const lastEngage = new Map();
router.post('/api/engage', express.text({ type: '*/*', limit: '2kb' }), (req, res) => {
  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch { return res.sendStatus(400); } }
  if (!b || !/^[0-9a-f]{12}$/.test(b.id || '')) return res.sendStatus(400);
  const now = Date.now();
  if (!b.final && now - (lastEngage.get(b.id) || 0) < 10_000) return res.sendStatus(204);
  lastEngage.set(b.id, now);
  if (lastEngage.size > 5000) lastEngage.clear();
  const secs = x => (Number.isFinite(+x) && +x >= 0 ? Math.min(Math.round(+x), 6 * 3600) : 0);
  // Per track (imam, en, ur): seconds played, length, and the minutes heard (since 2 Oct 2026).
  const perVoice = (o, f) => Object.fromEntries(['imam', 'en', 'ur'].filter(v => o?.[v] != null).map(v => [v, f(o[v])]));
  const minutes = a => (Array.isArray(a) ? [...new Set(a.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n < 360))].sort((x, y) => x - y) : []);
  const entry = { ts: new Date(now).toISOString(), id: b.id, open_s: secs(b.open_s), played_s: secs(b.played_s),
    max_pos: secs(b.max_pos), dur: secs(b.dur) || null, lang: b.lang === 'ur' ? 'ur' : 'en',
    voices: perVoice(b.voices, secs), durs: perVoice(b.durs, secs), heard: perVoice(b.heard, minutes),
    depth: Math.min(100, secs(b.depth)), copies: Math.min(50, secs(b.copies)), refs: Math.min(500, secs(b.refs)) };
  try { appendFileSync(ENGAGE_FILE, JSON.stringify(entry) + '\n'); } catch {}
  res.sendStatus(204);
});

// feedback.jsonl holds the messages and, as {hide: <ts>} lines, the ones taken off /feedback.
export function readFeedback() {
  let lines = [];
  try {
    lines = readFileSync(FEEDBACK_FILE, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {}
  const hidden = new Set(lines.filter(l => l.hide).map(l => l.hide));
  return lines.filter(l => l.message).map(l => ({ ...l, hidden: hidden.has(l.ts) })).reverse();
}
router.get('/api/comments', (req, res) => res.json(readFeedback().filter(e => e.public && !e.hidden).slice(0, 200)
  .map(e => ({ ts: e.ts, name: e.name, message: e.message }))));

export default router;
