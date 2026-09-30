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
// Job (tts_common.py) plus: { model, voice, style, concurrency? }

import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';

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
async function speak(text) {
  const request = { model: job.model, voice: job.voice, style: job.style, text };
  const path = join(CACHE, createHash('sha1').update(JSON.stringify(request)).digest('hex') + '.pcm');
  if (existsSync(path)) { usage.cached++; return readFileSync(path); }
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await ai.interactions.create({
        model: job.model,
        input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style: job.style }] }] }],
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
      writeFileSync(path, pcm);
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

// A few blocks at a time; the track is assembled in order afterwards.
const blocks = job.blocks;
const audio = new Array(blocks.length);
let next = 0, done = 0;
const began = Date.now();
await Promise.all(Array.from({ length: job.concurrency ?? 4 }, async () => {
  while (next < blocks.length) {
    const k = next++;
    audio[k] = await speak(blocks[k].text);
    console.error(`  block ${++done}/${blocks.length}  ${((Date.now() - began) / 60000).toFixed(1)} min`);
  }
}));

const gap = Buffer.alloc(Math.round(SR * (job.block_pause ?? 0.7)) * 2);
const parts = [], times = [];
let t = 0;
blocks.forEach((b, k) => {
  if (b.pause_before) { // silence before a block, e.g. between the two khutbahs
    const pause = Buffer.alloc(Math.round(SR * b.pause_before) * 2);
    parts.push(pause); t += pause.length / 2 / SR;
  }
  const start = t;
  parts.push(audio[k]); t += audio[k].length / 2 / SR;
  times.push({ i: b.i, start: Math.round(start * 100) / 100, end: Math.round(t * 100) / 100 });
  parts.push(gap); t += gap.length / 2 / SR;
});
const pcm = Buffer.concat(parts);
const header = Buffer.alloc(44);
header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
header.writeUInt32LE(SR, 24); header.writeUInt32LE(SR * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
writeFileSync(job.out, Buffer.concat([header, pcm]));

const cost = usage.input * PRICE_IN + usage.output * PRICE_OUT;
console.error(`  ${usage.calls} Gemini call(s), ${usage.cached} block(s) from cache, ${usage.input} in / ${usage.output} out tokens, about $${cost.toFixed(3)}`);
console.log('\n' + JSON.stringify(times));
