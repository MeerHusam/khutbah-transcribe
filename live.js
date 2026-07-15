// live.js — Live khutbah engine.
//
// Receives mic audio chunks (~12s) over a WebSocket from the host page, transcribes
// each chunk with Groq Whisper (passing the rolling transcript tail as the prompt so
// chunk boundaries keep context), runs the same n-gram Quran zone pre-scan the offline
// pipeline uses, translates the prose live with Claude (which also flags quoted
// hadiths), and broadcasts an ordered event feed to every connected listener.
//
// Event feed types sent to clients:
//   {type:'snapshot', active, title, startedAt, status, events[]}
//   {type:'event',  event}                    — new feed block (prose | quran | hadith)
//   {type:'update', id, patch}                — later enrichment of an earlier event
//   {type:'live_text', text}                  — raw Arabic of the newest chunk (ticker)
//   {type:'status', status}                   — 'live' | 'ended'
//   {type:'error',  message}
//
// Feed event shapes:
//   prose : {id, type, arabic, english|null, pending}
//   quran : {id, type, surah_number, ayah_number, surah_name, arabic, english, link, detected_text}
//   hadith: {id, type, arabic, english, narrator, collection, hadith_number, link, note}

import 'dotenv/config';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
import Anthropic from '@anthropic-ai/sdk';
import Groq from 'groq-sdk';
import {
  prescanForQuranZones,
  findMatchingHadith,
  loadHadithCorpus,
  resolveSunnahLinksForRefs,
} from './pipeline.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const quranAr = require('quran-json/dist/quran.json');
const quranEn = require('quran-json/dist/quran_en.json');

// Live mode prefers failing fast over stalling the feed: losing one 12s chunk is
// better than blocking the serialized queue for minutes of retries.
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || 'not-set', timeout: 45_000, maxRetries: 1 });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY || 'not-set', timeout: 25_000, maxRetries: 1 });

const CLAUDE_MODEL = 'claude-opus-4-8';
const HOLDBACK = 3;        // trailing words withheld from prose until next chunk (a Quran
                           // zone starting in the last <4 words is only detectable next chunk)
const MIN_ZONE_WORDS = 5;  // zones shorter than this are ritual phrases (basmala etc) → prose

// ---- Quran lookup -----------------------------------------------------------

function ayahLookup(surah, ayah) {
  const sAr = quranAr[surah - 1];
  const sEn = quranEn[surah - 1];
  if (!sAr) return null;
  const vAr = sAr.verses.find(v => v.id === ayah);
  const vEn = sEn?.verses.find(v => v.id === ayah);
  if (!vAr) return null;
  return {
    surah_name: sAr.transliteration ?? sAr.name,
    arabic: vAr.text,
    english: vEn?.translation ?? '',
  };
}

// ---- Groq transcription with rolling context prompt -------------------------

const MIME_EXT = { 'audio/webm': 'webm', 'audio/mp4': 'mp4', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' };

async function transcribeChunk(buffer, mime, contextTail) {
  const baseMime = (mime || 'audio/webm').split(';')[0];
  const ext = MIME_EXT[baseMime] ?? 'webm';
  const tmp = path.join(os.tmpdir(), `khutbah_live_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
  writeFileSync(tmp, buffer);
  try {
    const file = new File([buffer], `chunk.${ext}`, { type: baseMime });
    const response = await groq.audio.transcriptions.create({
      file,
      model: 'whisper-large-v3',
      language: 'ar',
      response_format: 'verbose_json',
      timestamp_granularities: ['word', 'segment'],
      temperature: 0,
      // Rolling tail keeps Whisper's decoder in context across chunk boundaries.
      prompt: contextTail || 'بسم الله الرحمن الرحيم، الحمد لله رب العالمين، والصلاة والسلام على رسول الله',
    });
    const text = typeof response === 'string' ? response : response.text;
    const words = (response.words ?? []).map(w => ({ word: w.word, start: w.start, end: w.end }));
    const segments = (response.segments ?? []).map(s => ({ start: s.start, end: s.end, text: s.text }));
    return { text: (text || '').trim(), words, segments };
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

// ---- Claude live translation ------------------------------------------------

const LIVE_SYSTEM = `You are the live translation engine for KhutbahLive. An Arabic Friday khutbah (Islamic sermon) is being transcribed live in ~15-second segments and you translate it for English-speaking listeners in real time.

You receive recent context (already translated — do NOT re-translate it) and one NEW Arabic segment. Respond with JSON only.

Rules for "translation":
- A faithful, natural English translation of ONLY the new segment.
- The text is raw speech-recognition output: it may start or cut off mid-sentence and contain small transcription errors. Translate the apparent meaning smoothly; never add commentary, brackets, or notes about errors.
- Keep well-known Islamic terms natural: Allah, iman, taqwa, dua, Jannah, etc. Render صلى الله عليه وسلم as ﷺ.
- Full Quranic verses are detected and removed before you see the segment; if a stray few verse words remain, just translate them inline.

Rules for "hadith":
- If the new segment quotes a hadith of the Prophet ﷺ (usually after a phrase like قال رسول الله صلى الله عليه وسلم or قال النبي), set hadith to an object:
    arabic_text: the quoted hadith words exactly as they appear in the segment (Arabic only, no intro phrase)
    narrator:   the companion who narrated it, in English, if you know it — otherwise ""
    collection: the most likely collection (e.g. "Sahih al-Bukhari", "Sahih Muslim"), if you know it — otherwise ""
- The hadith's meaning must still be included in "translation".
- Sayings of scholars or companions (not the Prophet) are NOT hadith → hadith: null.
- If there is no quoted hadith in the new segment: hadith: null.`;

const LIVE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    translation: { type: 'string' },
    hadith: {
      anyOf: [
        { type: 'null' },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            arabic_text: { type: 'string' },
            narrator: { type: 'string' },
            collection: { type: 'string' },
          },
          required: ['arabic_text', 'narrator', 'collection'],
        },
      ],
    },
  },
  required: ['translation', 'hadith'],
};

async function translateSegment(arabic, prevAr, prevEn) {
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1500,
    system: LIVE_SYSTEM,
    output_config: { format: { type: 'json_schema', schema: LIVE_SCHEMA } },
    messages: [{
      role: 'user',
      content:
        `Recent Arabic context (already translated, do not re-translate):\n${prevAr || '(start of khutbah)'}\n\n` +
        `Recent English translation (context):\n${prevEn || '(start of khutbah)'}\n\n` +
        `NEW Arabic segment to translate:\n${arabic}`,
    }],
  });
  if (response.stop_reason === 'refusal') throw new Error('translation refused');
  const text = response.content.find(b => b.type === 'text')?.text;
  if (!text) throw new Error('empty translation response');
  return JSON.parse(text);
}

// ---- Live session -----------------------------------------------------------

let hadithCorpus = null;   // lazy — loaded once at first session start
let session = null;
const listeners = new Set();

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const ws of listeners) {
    if (ws.readyState === 1) { try { ws.send(payload); } catch {} }
  }
}

class LiveSession {
  constructor(title, mime) {
    this.title = title || 'Live Khutbah';
    this.mime = mime || 'audio/webm';
    this.startedAt = new Date().toISOString();
    this.status = 'live';
    this.words = [];        // transcript word strings
    this.wordTimes = [];    // absolute start time per word (seconds into session)
    this.events = [];       // ordered feed
    this.emittedUpTo = 0;   // first word index not yet emitted as prose/quran
    this.timeOffset = 0;    // cumulative audio seconds consumed
    this.chunkCount = 0;
    this.queue = Promise.resolve();   // serializes chunk processing → feed stays ordered
  }

  snapshot() {
    return {
      type: 'snapshot',
      active: this.status === 'live',
      title: this.title,
      startedAt: this.startedAt,
      status: this.status,
      events: this.events,
    };
  }

  enqueueAudio(buffer) {
    if (this.status !== 'live') return;
    this.queue = this.queue
      .then(() => this.processChunk(buffer))
      .catch(e => {
        console.error('[live] chunk failed:', e.message);
        broadcast({ type: 'error', message: `chunk failed: ${e.message}` });
      });
  }

  async processChunk(buffer) {
    if (buffer.length < 1000) return; // empty/near-empty recorder flush
    this.chunkCount++;
    const contextTail = this.words.slice(-25).join(' ');
    const tr = await transcribeChunk(buffer, this.mime, contextTail);
    if (!tr.text) return;

    // Append words with absolute times.
    const newWords = tr.words.length
      ? tr.words
      : tr.text.split(/\s+/).filter(Boolean).map(w => ({ word: w, start: 0, end: 0 }));
    for (const w of newWords) {
      const token = (w.word || '').trim();
      if (!token) continue;
      this.words.push(token);
      this.wordTimes.push(Math.round((this.timeOffset + (w.start || 0)) * 10) / 10);
    }
    const chunkDur =
      tr.segments.length ? tr.segments[tr.segments.length - 1].end
      : tr.words.length ? tr.words[tr.words.length - 1].end
      : 12;
    this.timeOffset += chunkDur;

    broadcast({ type: 'live_text', text: tr.text });
    await this.emitPass(false);
  }

  // Scan the full transcript for Quran zones and emit everything that is now stable.
  async emitPass(finalPass) {
    const total = this.words.length;
    if (total === 0) return;
    const zones = prescanForQuranZones(this.words);

    // Words that are safe to emit: hold back the tail (a zone may still grow into it),
    // and hold back any zone that touches the end of the transcript.
    let processUpTo = finalPass ? total : Math.max(this.emittedUpTo, total - HOLDBACK);
    if (!finalPass) {
      for (const z of zones) {
        if (z.end >= total - 1) processUpTo = Math.min(processUpTo, Math.max(z.start, this.emittedUpTo));
      }
    }
    if (processUpTo <= this.emittedUpTo) return;

    // Build ordered segments: quran zones interleaved with prose gaps.
    const segs = [];
    let cursor = this.emittedUpTo;
    for (const z of zones) {
      if (z.end <= cursor) continue;
      if (z.start >= processUpTo) break;
      if (!finalPass && z.end > processUpTo) break; // partially-held zone: stop before it
      const zStart = Math.max(z.start, cursor);
      if (z.end - z.start < MIN_ZONE_WORDS) continue; // ritual phrase → leave in prose
      if (zStart > cursor) segs.push({ type: 'prose', from: cursor, to: zStart });
      segs.push({ type: 'quran', zone: z, from: zStart, to: Math.min(z.end, processUpTo) });
      cursor = Math.min(z.end, processUpTo);
    }
    if (cursor < processUpTo) segs.push({ type: 'prose', from: cursor, to: processUpTo });
    this.emittedUpTo = processUpTo;

    for (const seg of segs) {
      if (seg.type === 'quran') this.emitQuran(seg);
      else await this.emitProse(seg);
    }
  }

  emitQuran(seg) {
    const z = seg.zone;
    const ayahs = [
      { surah_id: z.surah_id, ayah_id: z.ayah_id, surah_name: z.surah_name },
      ...(z.extra_ayahs ?? []),
    ];
    for (const a of ayahs) {
      if (!a.surah_id || !a.ayah_id) continue;
      const key = `${a.surah_id}:${a.ayah_id}`;
      // Skip only if the very same ayah was just shown (imams do repeat refrains later).
      const recent = this.events.slice(-4).some(e => e.type === 'quran' && `${e.surah_number}:${e.ayah_number}` === key);
      if (recent) continue;
      const info = ayahLookup(a.surah_id, a.ayah_id);
      if (!info) continue;
      this.pushEvent({
        type: 'quran',
        surah_number: a.surah_id,
        ayah_number: a.ayah_id,
        surah_name: info.surah_name,
        arabic: info.arabic,
        english: info.english,
        link: `https://quran.com/${a.surah_id}/${a.ayah_id}`,
        detected_text: this.words.slice(seg.from, seg.to).join(' '),
      });
    }
  }

  async emitProse(seg) {
    const arabic = this.words.slice(seg.from, seg.to).join(' ');
    if (!arabic.trim()) return;

    // Emit immediately with the Arabic so listeners see the transcript right away;
    // the English is patched in when Claude answers.
    const ev = this.pushEvent({ type: 'prose', arabic, english: null, pending: true });

    const prevAr = this.words.slice(Math.max(0, seg.from - 40), seg.from).join(' ');
    const prevEn = this.events
      .filter(e => e.type === 'prose' && e.english)
      .slice(-2).map(e => e.english).join(' ')
      .split(/\s+/).slice(-60).join(' ');

    let result;
    try {
      result = await translateSegment(arabic, prevAr, prevEn);
    } catch (e) {
      console.error('[live] translation failed:', e.message);
      this.patchEvent(ev.id, { english: null, pending: false, error: 'translation unavailable' });
      return;
    }
    this.patchEvent(ev.id, { english: result.translation || '', pending: false });

    // Hadith flagged by Claude → dedicated card, verified against the local corpus
    // when available, then upgraded with the authoritative sunnah.com permalink.
    const h = result.hadith;
    if (h && h.arabic_text && h.arabic_text.split(/\s+/).length >= 4) this.emitHadith(h);
  }

  emitHadith(h) {
    let collection = h.collection || '';
    let number = '';
    let link = '';
    let note = 'Identified live — verification pending';
    try {
      const match = hadithCorpus?.length ? findMatchingHadith(h.arabic_text, hadithCorpus) : null;
      if (match && match.confidence >= 0.5) {
        collection = match.collection;
        number = String(match.number ?? '');
        link = match.link;
        note = 'Matched against local corpus';
      }
    } catch {}

    const ev = this.pushEvent({
      type: 'hadith',
      arabic: h.arabic_text,
      english: '',            // meaning already included in the surrounding prose translation
      narrator: h.narrator || '',
      collection,
      hadith_number: number,
      link,
      note,
    });

    // Authoritative permalink resolution (network, cached) — patch when it lands.
    const ref = {
      detected_text: h.arabic_text,
      narrator: h.narrator || '',
      collection,
      hadith_number: number,
      link,
      note,
    };
    resolveSunnahLinksForRefs([ref])
      .then(() => {
        this.patchEvent(ev.id, {
          narrator: ref.narrator || ev.narrator,
          collection: ref.collection || ev.collection,
          hadith_number: ref.hadith_number || ev.hadith_number,
          link: ref.link || ev.link,
          note: ref.note || ev.note,
        });
      })
      .catch(() => {});
  }

  pushEvent(event) {
    event.id = this.events.length;
    event.t = this.timeOffset;
    this.events.push(event);
    broadcast({ type: 'event', event });
    return event;
  }

  patchEvent(id, patch) {
    const ev = this.events[id];
    if (!ev) return;
    Object.assign(ev, patch);
    broadcast({ type: 'update', id, patch });
  }

  async stop() {
    if (this.status !== 'live') return;
    // Flush anything still queued, then a final pass with no hold-back.
    this.queue = this.queue.then(() => this.emitPass(true)).catch(() => {});
    await this.queue;
    this.status = 'ended';
    broadcast({ type: 'status', status: 'ended' });
    this.save();
  }

  save() {
    try {
      if (!this.words.length) return;
      const stamp = this.startedAt.replace(/[:.]/g, '-').slice(0, 19);
      const dir = path.join(__dirname, 'outputs', `live_${stamp}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'transcript.txt'), this.words.join(' ') + '\n');
      writeFileSync(path.join(dir, 'live_session.json'), JSON.stringify({
        title: this.title,
        started_at: this.startedAt,
        chunk_count: this.chunkCount,
        word_count: this.words.length,
        transcript_words: this.words.map((w, i) => ({ word: w, start: this.wordTimes[i] })),
        events: this.events,
      }, null, 2));
      console.log(`[live] session saved to ${dir}`);
    } catch (e) {
      console.error('[live] save failed:', e.message);
    }
  }
}

// ---- WebSocket wiring ---------------------------------------------------------

export function liveStatus() {
  return {
    active: !!session && session.status === 'live',
    title: session?.title ?? null,
    startedAt: session?.startedAt ?? null,
    listeners: listeners.size,
  };
}

export function handleLiveConnection(ws, req) {
  listeners.add(ws);
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(session ? session.snapshot() : { type: 'snapshot', active: false, events: [] }));
  }

  ws.on('message', async (data, isBinary) => {
    if (isBinary) {
      session?.enqueueAudio(data);
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'start') {
      // Broadcaster auth: required only when ADMIN_TOKEN is configured (production).
      const token = process.env.ADMIN_TOKEN || '';
      if (token && msg.key !== token) {
        ws.send(JSON.stringify({ type: 'error', message: 'unauthorized' }));
        return;
      }
      if (session && session.status === 'live') await session.stop();
      if (hadithCorpus === null) {
        try { hadithCorpus = loadHadithCorpus(); } catch { hadithCorpus = []; }
        console.log(`[live] hadith corpus: ${hadithCorpus.length} entries`);
      }
      // Pre-warm the Quran n-gram index so the first chunk isn't slow.
      try { prescanForQuranZones(['بسم', 'الله', 'الرحمن', 'الرحيم']); } catch {}
      session = new LiveSession(msg.title, msg.mime);
      console.log(`[live] session started: "${session.title}" (${session.mime})`);
      broadcast(session.snapshot());
    } else if (msg.type === 'stop') {
      if (session) {
        console.log('[live] session stopping');
        await session.stop();
      }
    }
  });

  const drop = () => listeners.delete(ws);
  ws.on('close', drop);
  ws.on('error', drop);
}
