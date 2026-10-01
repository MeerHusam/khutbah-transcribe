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
router.post('/api/feedback', (req, res) => {
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
  const entry = { ts: new Date(now).toISOString(), id: b.id, open_s: secs(b.open_s), played_s: secs(b.played_s),
    max_pos: secs(b.max_pos), dur: secs(b.dur) || null, lang: b.lang === 'ur' ? 'ur' : 'en' };
  try { appendFileSync(ENGAGE_FILE, JSON.stringify(entry) + '\n'); } catch {}
  res.sendStatus(204);
});

export default router;
