// live/engine.js — Streaming khutbah session engine.
//
// Differs from the chunk-based live.js in one important way: words arrive continuously from
// a streaming transducer, not in 4-12s blocks. So the emit loop is driven by *finalised
// words* rather than by chunk arrival, and English comes from Speechmatics' realtime MT
// (sub-2s) instead of waiting on a Claude round-trip. Claude is demoted to enrichment:
// flagging quoted hadiths and optionally polishing finalised prose.
//
// The Quran/Hadith reference layer is unchanged — it reuses the exact n-gram zone scan and
// corpus matching from pipeline.js, which is the whole differentiator over generic live
// translate. Those functions operate on a plain word array, so they don't care who produced it.

import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import {
  prescanForQuranZones,
  findMatchingHadith,
  loadHadithCorpus,
  resolveSunnahLinksForRefs,
} from '../pipeline.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const quranAr = require('quran-json/dist/quran.json');
const quranEn = require('quran-json/dist/quran_en.json');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || 'not-set',
  timeout: 30_000,
  maxRetries: 1,
});
const CLAUDE_MODEL = 'claude-opus-4-8';

// A Quran zone starting in the last <4 words can't be detected yet (n-gram = 4), so hold the
// tail back until more words land. Same rule as live.js, just applied per finalised batch.
const HOLDBACK = 3;
const MIN_ZONE_WORDS = 5;   // shorter zones are ritual phrases (basmala, isti'adha) → prose

let hadithCorpus = null;    // lazily loaded once (29k entries)

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

export function warmup() {
  if (hadithCorpus === null) {
    try { hadithCorpus = loadHadithCorpus(); } catch { hadithCorpus = []; }
  }
  // Build the Quran n-gram index now so the first ayah isn't slow.
  try { prescanForQuranZones(['بسم', 'الله', 'الرحمن', 'الرحيم']); } catch {}
  return { hadith: hadithCorpus?.length ?? 0 };
}

export class StreamSession {
  constructor(title, broadcast) {
    this.title = title || 'Live Khutbah';
    this.broadcast = broadcast;
    this.startedAt = new Date().toISOString();
    this.status = 'live';

    this.words = [];          // finalised word strings (the transcript)
    this.wordTimes = [];      // start time per finalised word
    this.events = [];         // ordered feed
    this.emittedUpTo = 0;     // first word index not yet turned into an event
    this.partialText = '';    // current interim Arabic (revises itself, never stored)
    this.pendingEnglish = []; // MT segments not yet attached to a prose event
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

  // ── Inbound from Speechmatics ──────────────────────────────────────────────

  /** Interim words — shown live in the ticker, never committed to the transcript. */
  onPartial({ transcript }) {
    this.partialText = transcript;
    this.broadcast({ type: 'partial', text: transcript });
  }

  /** Finalised words — appended to the transcript, then scanned for references. */
  onFinal({ words }) {
    if (!words?.length) return;
    for (const w of words) {
      this.words.push(w.word);
      this.wordTimes.push(w.start);
    }
    this.partialText = '';
    this.broadcast({ type: 'partial', text: '' });
    this.emitPass(false);
  }

  /** Realtime English from Speechmatics MT — attached to the newest pending prose event. */
  onTranslation({ text }) {
    if (!text?.trim()) return;
    const target = [...this.events].reverse().find(e => e.type === 'prose' && e.pending);
    if (target) {
      const merged = (target.english ? target.english + ' ' : '') + text.trim();
      this.patchEvent(target.id, { english: merged, pending: false });
    } else {
      // MT arrived before its prose block was cut — hold it for the next one.
      this.pendingEnglish.push(text.trim());
    }
  }

  // ── Emit pass ──────────────────────────────────────────────────────────────

  emitPass(finalPass) {
    const total = this.words.length;
    if (total === 0) return;
    const zones = prescanForQuranZones(this.words);

    let processUpTo = finalPass ? total : Math.max(this.emittedUpTo, total - HOLDBACK);
    if (!finalPass) {
      // Never cut inside a zone that is still growing at the transcript end.
      for (const z of zones) {
        if (z.end >= total - 1) processUpTo = Math.min(processUpTo, Math.max(z.start, this.emittedUpTo));
      }
    }
    if (processUpTo <= this.emittedUpTo) return;

    const segs = [];
    let cursor = this.emittedUpTo;
    for (const z of zones) {
      if (z.end <= cursor) continue;
      if (z.start >= processUpTo) break;
      if (!finalPass && z.end > processUpTo) break;
      if (z.end - z.start < MIN_ZONE_WORDS) continue;
      const zStart = Math.max(z.start, cursor);
      if (zStart > cursor) segs.push({ type: 'prose', from: cursor, to: zStart });
      segs.push({ type: 'quran', zone: z, from: zStart, to: Math.min(z.end, processUpTo) });
      cursor = Math.min(z.end, processUpTo);
    }
    if (cursor < processUpTo) segs.push({ type: 'prose', from: cursor, to: processUpTo });
    this.emittedUpTo = processUpTo;

    for (const seg of segs) {
      if (seg.type === 'quran') this.emitQuran(seg);
      else this.emitProse(seg);
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
      // Only dedupe against the last few events — imams legitimately repeat refrains.
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

  emitProse(seg) {
    const arabic = this.words.slice(seg.from, seg.to).join(' ');
    if (!arabic.trim()) return;

    // Any MT text that arrived before this block existed belongs to it.
    const carried = this.pendingEnglish.splice(0).join(' ');
    const ev = this.pushEvent({
      type: 'prose',
      arabic,
      english: carried || null,
      pending: !carried,
    });

    // Claude enrichment runs detached — it must never gate the feed.
    this.checkForHadith(ev.id, arabic);
  }

  /**
   * Ask Claude whether this segment quotes a hadith of the Prophet ﷺ. Detached and
   * best-effort: a failure leaves the prose block untouched.
   */
  async checkForHadith(proseId, arabic) {
    // Cheap prefilter — hadith quotations follow a signal phrase. Skips most Claude calls.
    if (!/قال\s+رسول\s+الله|قال\s+النبي|عن\s+النبي|صلى\s+الله\s+عليه\s+وسلم/.test(arabic)) return;

    let flagged;
    try {
      const res = await anthropic.messages.create({
        model: CLAUDE_MODEL,
        max_tokens: 800,
        system: `You identify hadith quotations in Arabic khutbah transcripts. Given a segment, decide whether it quotes a saying of the Prophet Muhammad ﷺ.

Respond with JSON only:
- If it quotes a hadith: {"hadith": {"arabic_text": "<the quoted words only, no intro phrase>", "narrator": "<companion name in English, or \\"\\">", "collection": "<e.g. Sahih al-Bukhari, or \\"\\">"}}
- Otherwise: {"hadith": null}

Sayings of scholars or companions (not the Prophet ﷺ) are NOT hadith.`,
        output_config: {
          format: {
            type: 'json_schema',
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
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
              required: ['hadith'],
            },
          },
        },
        messages: [{ role: 'user', content: `Arabic segment:\n${arabic}` }],
      });
      if (res.stop_reason === 'refusal') return;
      const text = res.content.find(b => b.type === 'text')?.text;
      if (!text) return;
      flagged = JSON.parse(text).hadith;
    } catch (e) {
      console.error('[stream] hadith check failed:', e.message);
      return;
    }

    if (flagged?.arabic_text && flagged.arabic_text.split(/\s+/).length >= 4) {
      this.emitHadith(flagged);
    }
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
      narrator: h.narrator || '',
      collection,
      hadith_number: number,
      link,
      note,
    });

    // Authoritative sunnah.com permalink resolution (network, disk-cached) — patches when ready.
    const ref = {
      detected_text: h.arabic_text,
      narrator: h.narrator || '',
      collection, hadith_number: number, link, note,
    };
    resolveSunnahLinksForRefs([ref])
      .then(() => this.patchEvent(ev.id, {
        narrator: ref.narrator || ev.narrator,
        collection: ref.collection || ev.collection,
        hadith_number: ref.hadith_number || ev.hadith_number,
        link: ref.link || ev.link,
        note: ref.note || ev.note,
      }))
      .catch(() => {});
  }

  // ── Feed plumbing ──────────────────────────────────────────────────────────

  pushEvent(event) {
    event.id = this.events.length;
    this.events.push(event);
    this.broadcast({ type: 'event', event });
    return event;
  }

  patchEvent(id, patch) {
    const ev = this.events[id];
    if (!ev) return;
    Object.assign(ev, patch);
    this.broadcast({ type: 'update', id, patch });
  }

  stop() {
    if (this.status !== 'live') return;
    this.emitPass(true);           // flush the held-back tail
    this.status = 'ended';
    this.broadcast({ type: 'status', status: 'ended' });
    this.save();
  }

  /** Saves in the same shape live.js uses, so reanalyze.js can post-process the session. */
  save() {
    try {
      if (!this.words.length) return;
      const stamp = this.startedAt.replace(/[:.]/g, '-').slice(0, 19);
      const dir = path.join(ROOT, 'outputs', `stream_${stamp}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'transcript.txt'), this.words.join(' ') + '\n');
      writeFileSync(path.join(dir, 'live_session.json'), JSON.stringify({
        title: this.title,
        started_at: this.startedAt,
        source: 'speechmatics-realtime',
        word_count: this.words.length,
        transcript_words: this.words.map((w, i) => ({ word: w, start: this.wordTimes[i] })),
        events: this.events,
      }, null, 2));
      console.log(`[stream] session saved to ${dir}`);
    } catch (e) {
      console.error('[stream] save failed:', e.message);
    }
  }
}
