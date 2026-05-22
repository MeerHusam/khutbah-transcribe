import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load Quran data once at startup
const quranData = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'node_modules/quran-json/dist/quran.json'), 'utf8'));

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(join(__dirname, 'public')));
app.use('/audio_files', express.static(join(__dirname, 'audio_files')));

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
    speaker: 'Local Masjid · Friday Khutbah',
    featured: true,
  },
  {
    folder: '2026-05-15T17-45-24_makkah_sudais_ramadan_ummah',
    title: 'Ramadan: A Season of Renewal',
    speaker: 'Sheikh Sudais · Makkah',
  },
];
const FEATURED_FOLDER = (PUBLIC_KHUTBAHS.find(k => k.featured) || PUBLIC_KHUTBAHS[0]).folder;
const ALLOWED_FOLDERS = new Set(PUBLIC_KHUTBAHS.map(k => k.folder));

// ────────────────────────────────────────────────────────────────────────────
// Viewer counts. Live = concurrent open WebSocket connections. Total = cumulative
// page loads, persisted to disk so it survives restarts/redeploys.
// ────────────────────────────────────────────────────────────────────────────
const DATA_DIR = join(__dirname, 'data');
const VIEWS_FILE = join(DATA_DIR, 'views.json');
mkdirSync(DATA_DIR, { recursive: true });

let totalViews = 0;
try {
  totalViews = JSON.parse(readFileSync(VIEWS_FILE, 'utf8')).total || 0;
} catch { totalViews = 0; }

function persistViews() {
  try { writeFileSync(VIEWS_FILE, JSON.stringify({ total: totalViews })); } catch {}
}

const liveClients = new Set();

function broadcastViewers() {
  const payload = JSON.stringify({ type: 'viewers', live: liveClients.size, total: totalViews });
  for (const ws of liveClients) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

wss.on('connection', (ws) => {
  liveClients.add(ws);
  totalViews += 1;
  persistViews();
  // Send the new client its current numbers immediately, then tell everyone.
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'viewers', live: liveClients.size, total: totalViews }));
  broadcastViewers();
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

    result.reader_chunks = chunks;
  } catch (_) {}
  return result;
}

// Curated list of published khutbahs (with friendly titles + summary stats)
app.get('/api/results', (req, res) => {
  const items = PUBLIC_KHUTBAHS.map(k => {
    try {
      const r = JSON.parse(readFileSync(join(__dirname, 'outputs', k.folder, 'result.json'), 'utf8'));
      return {
        folder: k.folder,
        title: k.title,
        speaker: k.speaker || '',
        featured: !!k.featured,
        summary: (r.share_summary || r.summary || '').slice(0, 160),
        words: r.metadata?.transcript_word_count || 0,
        quran: r.metadata?.quran_references_matched || 0,
        hadith: r.metadata?.hadith_references_found || 0,
        mode: r.metadata?.transcription_mode || '',
      };
    } catch { return null; }
  }).filter(Boolean);
  res.json({ featured: FEATURED_FOLDER, items });
});

// Load a specific published khutbah (allowlist-gated)
app.get('/api/results/:folder', (req, res) => {
  if (!ALLOWED_FOLDERS.has(req.params.folder)) {
    return res.status(404).json({ error: 'Not found' });
  }
  try {
    const folder = `outputs/${req.params.folder}`;
    const result = loadResult(folder);
    result.audio_url = findAudioUrl(req.params.folder);
    const meta = PUBLIC_KHUTBAHS.find(k => k.folder === req.params.folder);
    result.title = meta?.title || '';
    result.speaker = meta?.speaker || '';
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`KhutbahTranscribe (public read-only) running at http://localhost:${PORT}`);
});
