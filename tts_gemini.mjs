#!/usr/bin/env node
// tts_gemini.mjs — Speak a khutbah's blocks with Gemini TTS (gemini-3.8-flash-tts). Called by
// tts.js --engine gemini; the same job protocol as tts_common.py (JSON job on stdin, one WAV
// written to job.out with the blocks in order, [{ i, start, end }] as the last stdout line).
//
// Gemini reads the text word for word — an instruction placed in the text is spoken aloud —
// so the delivery goes in a speech_metadata "style" annotation. It pronounces Allah, Muhammad,
// taqwa and the like the Arabic way on its own; no lexicon is needed.
// Each block's audio is kept in .tts_cache/gemini/ by a hash of what was asked, so a re-run
// (another tempo, one block's text fixed) pays only for what changed.
// Cost (Dec 2026): $0.50 per 1M text tokens in, $9 per 1M audio tokens out (25 per second of
// audio) — about $0.35 for a 15-minute khutbah.
//
// Passages (tts.js --direct, 1 Oct 2026): each block can carry parts: [{ text, style }], one
// direction per sentence, and with job.passages (characters) the blocks are voiced a few minutes
// at a time, every sentence a text part with its own style note, so the voice carries its tone
// and pace from one block into the next (blocks voiced alone each start afresh). Each passage is
// heard back with Groq Whisper (free) and voiced again, up to three takes, if words are missing
// or added; then the word aligner (align_words.py, .venv-align) finds where each block starts.
//
// Job (tts_common.py) plus: { model, voice, style, concurrency?, passages?, lang? }

import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { spawnSync } from 'child_process';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CACHE = join(ROOT, '.tts_cache', 'gemini');
const PRICE_IN = 0.5 / 1e6, PRICE_OUT = 9 / 1e6; // USD per token, gemini-3.8-flash-tts, through 2026
const SR = 24000;

const job = JSON.parse(readFileSync(0, 'utf8'));
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
mkdirSync(CACHE, { recursive: true });

// The PCM samples of a WAV file (Gemini returns 24 kHz mono 16-bit with a RIFF header).
function pcmOf(wav) {
  if (wav.toString('ascii', 0, 4) !== 'RIFF') return wav; // already headerless
  let at = 12;
  while (at + 8 <= wav.length) {
    const id = wav.toString('ascii', at, at + 4), size = wav.readUInt32LE(at + 4);
    if (id === 'fmt ' && wav.readUInt32LE(at + 12) !== SR) throw new Error(`unexpected sample rate ${wav.readUInt32LE(at + 12)}`);
    if (id === 'data') return wav.subarray(at + 8, at + 8 + size);
    at += 8 + size + (size % 2);
  }
  throw new Error('no audio data in the WAV');
}

const usage = { calls: 0, cached: 0, input: 0, output: 0 };
const cachePath = request => join(CACHE, createHash('sha1').update(JSON.stringify(request)).digest('hex') + '.pcm');
const annotate = (text, style) => ({ type: 'text', text, annotations: [{ type: 'speech_metadata', style }] });

async function speak(text) {
  const request = { model: job.model, voice: job.voice, style: job.style, text };
  const path = cachePath(request);
  if (existsSync(path)) { usage.cached++; return readFileSync(path); }
  const pcm = await ask([annotate(text, job.style)]);
  writeFileSync(path, pcm);
  return pcm;
}

// One Gemini request: text parts, each with its style note -> the PCM samples.
async function ask(content) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await ai.interactions.create({
        model: job.model,
        input: [{ type: 'user_input', content }],
        response_format: { type: 'audio' },
        generation_config: { speech_config: [{ voice: job.voice }] },
      });
      const find = o => {
        if (!o || typeof o !== 'object') return null;
        if (typeof o.data === 'string' && o.data.length > 1000) return o.data;
        for (const v of Object.values(o)) { const f = find(v); if (f) return f; }
        return null;
      };
      const b64 = find(r);
      if (!b64) throw new Error(`no audio in the answer: ${JSON.stringify(r).slice(0, 300)}`);
      const pcm = pcmOf(Buffer.from(b64, 'base64'));
      const u = r.usage ?? {};
      usage.calls++; usage.input += u.total_input_tokens ?? 0; usage.output += u.total_output_tokens ?? 0;
      return pcm;
    } catch (e) {
      if (attempt >= 4) throw e;
      console.error(`  retry ${attempt}: ${String(e.message ?? e).slice(0, 160)}`);
      await new Promise(r => setTimeout(r, 4000 * attempt));
    }
  }
}

const wavOf = pcm => {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SR, 24); header.writeUInt32LE(SR * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
};
const secs = pcm => pcm.length / 2 / SR;
const round2 = t => Math.round(t * 100) / 100;

// Up to `concurrency` jobs at a time, results in order.
async function inTurn(items, work) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: job.concurrency ?? 4 }, async () => {
    while (next < items.length) { const k = next++; out[k] = await work(items[k], k); }
  }));
  return out;
}

// ── Passages ─────────────────────────────────────────────────────────────────
// Blocks in passages of about job.passages characters, each ending where a sentence ends (a
// block often stops mid-sentence at the imam's pause), never across the break between the
// two khutbahs.
const endsSentence = t => /[۔.!?؟]["”’)]?\s*$/u.test(t);
function passagesOf(blocks, size) {
  const out = [];
  let cur = [], chars = 0;
  for (const b of blocks) {
    if (b.pause_before && cur.length) { out.push(cur); cur = []; chars = 0; }
    cur.push(b); chars += b.text.length;
    if ((chars >= 0.6 * size && endsSentence(b.text)) || chars >= 1.5 * size) { out.push(cur); cur = []; chars = 0; }
  }
  if (cur.length) out.push(cur);
  return out;
}

// Words compared loosely: Whisper writes Urdu its own way (مسلمانوں for مسلمانو, ي for ی).
const looseWords = t => t.normalize('NFC').replace(/[ً-ٰٟٔں]/g, '')
  .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[ةه]/g, 'ہ')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ').toLowerCase().split(/\s+/).filter(Boolean);
function heardShare(text, heard) {
  const a = looseWords(text), b = looseWords(heard);
  let prev = new Array(b.length + 1).fill(0);
  for (const x of a) {
    const row = [0];
    for (let j = 1; j <= b.length; j++) row[j] = x === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    prev = row;
  }
  return { said: prev[b.length] / Math.max(1, a.length), extra: b.length / Math.max(1, a.length) };
}

// The passage as Whisper hears it (Groq, free); null when it cannot be checked.
async function hear(pcm) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  const form = new FormData();
  form.append('file', new Blob([wavOf(pcm)], { type: 'audio/wav' }), 'passage.wav');
  form.append('model', 'whisper-large-v3');
  form.append('language', job.lang ?? 'ur');
  form.append('response_format', 'text');
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
      if (r.ok) return await r.text();
      if (r.status !== 429 && r.status < 500) { console.error(`  Whisper check skipped (${r.status})`); return null; }
    } catch { /* network: try again */ }
    await new Promise(r => setTimeout(r, 5000 * attempt));
  }
  return null;
}

const checks = [];
async function speakPassage(blocks, n) {
  const parts = blocks.flatMap(b => (b.parts?.length ? b.parts : [{ text: b.text, style: null }]));
  const request = { model: job.model, voice: job.voice, style: job.style, parts };
  const path = cachePath(request);
  if (existsSync(path)) { usage.cached++; return readFileSync(path); }
  const content = parts.map((p, k) => annotate(p.text + (k < parts.length - 1 ? ' ' : ''),
    p.style ? `${job.style}. For this sentence: ${p.style}` : job.style));
  const text = blocks.map(b => b.text).join(' ');
  let best = null;
  for (let take = 1; take <= 3; take++) {
    const pcm = await ask(content);
    const heard = await hear(pcm);
    const share = heard == null ? null : heardShare(text, heard);
    const score = share ? share.said - Math.max(0, share.extra - 1.15) : 1;
    if (!best || score > best.score) best = { pcm, share, score };
    console.error(`  passage ${n + 1} (blocks ${blocks[0].i}-${blocks.at(-1).i}), take ${take}: ${secs(pcm).toFixed(0)} s` +
      (share ? `, ${Math.round(share.said * 100)}% of the words heard, ${Math.round(share.extra * 100)}% as many words` : ', not checked'));
    if (!share || (share.said >= 0.85 && share.extra <= 1.25)) break;
  }
  checks.push({ passage: n + 1, blocks: [blocks[0].i, blocks.at(-1).i], ...(best.share ?? {}) });
  writeFileSync(path, best.pcm);
  return best.pcm;
}

// Where each block starts inside its passage: the aligner finds every word of the passage, and
// a block starts just before its first word (at most 0.2 s, or half the pause, before it).
function splitPassages(spans) {
  const counts = spans.map(s => s.blocks.map(b => b.text.split(/\s+/).filter(Boolean).length));
  let words = null;
  const py = join(ROOT, '.venv-align', 'bin', 'python');
  if (existsSync(py)) {
    const r = spawnSync(py, [join(ROOT, 'align_words.py'), '-'], {
      input: JSON.stringify({ audio: job.out, lang: job.lang ?? 'ur', blocks: spans.map((s, k) => ({ i: k, start: s.start, end: s.end, text: s.blocks.map(b => b.text).join(' ') })) }),
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'],
    });
    if (r.status === 0) words = JSON.parse(r.stdout.trim().split('\n').at(-1)).map(x => x.words);
  }
  if (!words) console.error('  the aligner did not run: blocks split by their share of the characters');
  const times = [];
  spans.forEach((s, k) => {
    const w = words?.[k];
    const ok = w && w.length === counts[k].reduce((x, y) => x + y, 0);
    const total = s.blocks.reduce((x, b) => x + b.text.length, 0);
    let at = s.start, seen = 0, chars = 0;
    s.blocks.forEach((b, j) => {
      let end = s.end;
      if (j < s.blocks.length - 1) {
        seen += counts[k][j]; chars += b.text.length;
        if (ok) {
          const [prevEnd, nextStart] = [w[seen - 1][2], w[seen][1]];
          const gap = nextStart - prevEnd;
          end = gap > 0 ? nextStart - Math.min(0.2, gap / 2) : nextStart;
        } else end = s.start + (s.end - s.start) * chars / total;
      }
      times.push({ i: b.i, start: round2(at), end: round2(end) });
      at = end;
    });
  });
  return times;
}

const blocks = job.blocks;
const gap = Buffer.alloc(Math.round(SR * (job.block_pause ?? 0.7)) * 2);
const began = Date.now();
const parts = [];
let times = [], t = 0;
if (job.passages) {
  const groups = passagesOf(blocks, job.passages);
  console.error(`  ${blocks.length} blocks in ${groups.length} passages`);
  const audio = await inTurn(groups, (g, n) => speakPassage(g, n));
  const spans = [];
  groups.forEach((g, n) => {
    if (g[0].pause_before) { const pause = Buffer.alloc(Math.round(SR * g[0].pause_before) * 2); parts.push(pause); t += secs(pause); }
    spans.push({ blocks: g, start: t, end: t + secs(audio[n]) });
    parts.push(audio[n]); t += secs(audio[n]);
    parts.push(gap); t += secs(gap);
  });
  writeFileSync(job.out, wavOf(Buffer.concat(parts)));
  times = splitPassages(spans);
  const worst = checks.filter(c => c.said != null).sort((a, b) => a.said - b.said)[0];
  if (worst) console.error(`  Whisper check: every passage ${Math.round(worst.said * 100)}% or more of its words heard (lowest: passage ${worst.passage})`);
} else {
  // A few blocks at a time; the track is assembled in order afterwards.
  let done = 0;
  const audio = await inTurn(blocks, async b => {
    const pcm = await speak(b.text);
    console.error(`  block ${++done}/${blocks.length}  ${((Date.now() - began) / 60000).toFixed(1)} min`);
    return pcm;
  });
  blocks.forEach((b, k) => {
    if (b.pause_before) { // silence before a block, e.g. between the two khutbahs
      const pause = Buffer.alloc(Math.round(SR * b.pause_before) * 2);
      parts.push(pause); t += secs(pause);
    }
    const start = t;
    parts.push(audio[k]); t += secs(audio[k]);
    times.push({ i: b.i, start: round2(start), end: round2(t) });
    parts.push(gap); t += secs(gap);
  });
  writeFileSync(job.out, wavOf(Buffer.concat(parts)));
}

const cost = usage.input * PRICE_IN + usage.output * PRICE_OUT;
console.error(`  ${usage.calls} Gemini call(s), ${usage.cached} block(s) from cache, ${usage.input} in / ${usage.output} out tokens, about $${cost.toFixed(3)}`);
console.log('\n' + JSON.stringify(times));
