#!/usr/bin/env node
// check_keys.js — Does every model and key the pipeline needs answer today? (3 Oct 2026: a model
// closed to a new key, gemini-2.5-flash, was found only when a khutbah's run stopped on it.)
// Run before Friday (npm run check); upload_worker.js runs it when it starts.
//
// One tiny request each, a fraction of a cent in all. The Gemini voice is never asked: each
// request counts toward its 100 a day, so its keys are checked by the model's listing and by the
// spent-key record in .tts_cache/gemini/limits.json; the Agent Platform voice is asked (no cap).
// Exit 1 if anything the pipeline cannot do without is down.
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const rows = [];
const check = async (name, fn, { needed = true } = {}) => {
  const t = Date.now();
  try { rows.push({ name, ok: true, note: (await fn()) ?? '', ms: Date.now() - t, needed }); } catch (e) {
    rows.push({ name, ok: false, note: String(e.message ?? e).replace(/\s+/g, ' ').slice(0, 160), ms: Date.now() - t, needed });
  }
};
const post = async (url, headers, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status} ${j.error?.message ?? JSON.stringify(j).slice(0, 120)}`);
  return j;
};
const get = async (url, headers = {}) => {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`${r.status}`);
  return r;
};

const geminiKeys = Object.keys(process.env).filter(n => /^GEMINI_API_KEY\d*$/.test(n) && process.env[n]).sort();
let spent = {};
try { spent = JSON.parse(readFileSync('.tts_cache/gemini/limits.json', 'utf8')); } catch { /* none */ }
const G = 'https://generativelanguage.googleapis.com/v1beta/models';

// The transcription models, in the order core/transcribe.js tries them (with GEMINI_API_KEY).
for (const [i, model] of ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3.6-flash'].entries()) {
  await check(`transcription ${model}${i ? ' (fallback)' : ''}`, async () => {
    await post(`${G}/${model}:generateContent`, { 'x-goog-api-key': process.env.GEMINI_API_KEY }, { contents: [{ parts: [{ text: 'Reply: ok' }] }], generationConfig: { maxOutputTokens: 5 } });
  }, { needed: i === 0 });
}
for (const name of geminiKeys) {
  const key = process.env[name];
  await check(`${name}: voice model listed`, async () => {
    await get(`${G}/gemini-3.8-flash-tts`, { 'x-goog-api-key': key });
    const until = spent[createHash('sha1').update(key).digest('hex').slice(0, 12)];
    return until > Date.now() ? `daily limit spent until ${new Date(until).toISOString()}` : 'daily limit not known to be spent';
  }, { needed: false });
}
if (!geminiKeys.length) rows.push({ name: 'GEMINI_API_KEY', ok: false, note: 'not set', ms: 0, needed: true });

await check('Agent Platform voice (VERTEX_API_KEY)', async () => {
  if (!process.env.VERTEX_API_KEY) throw new Error('not set: no voice once the Gemini keys have used their day');
  const j = await post('https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash-tts:generateContent',
    { 'x-goog-api-key': process.env.VERTEX_API_KEY },
    { contents: [{ role: 'user', parts: [{ text: 'سلام' }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Orus' } } } } });
  if (!j.candidates?.[0]?.content?.parts?.some(p => p.inlineData)) throw new Error('no audio in the answer');
}, { needed: false });

for (const model of ['claude-opus-5-5', 'claude-sonnet-5-5']) {
  await check(`Claude ${model}`, async () => {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
    await post('https://api.anthropic.com/v1/messages', { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      { model, max_tokens: 5, messages: [{ role: 'user', content: 'Reply: ok' }] });
  });
}

await check('Groq Whisper (timing)', async () => {
  if (!process.env.GROQ_API_KEY) throw new Error('GROQ_API_KEY not set');
  const j = await (await get('https://api.groq.com/openai/v1/models', { Authorization: `Bearer ${process.env.GROQ_API_KEY}` })).json();
  if (!j.data?.some(m => m.id === 'whisper-large-v3')) throw new Error('whisper-large-v3 is not listed');
});

await check('sunnah.com (hadith links)', async () => { await get('https://sunnah.com/bukhari:1', { 'user-agent': 'Mozilla/5.0' }); },
  { needed: false });
await check(`site (${process.env.SITE_URL || 'https://khutbah.dev'})`, async () => { await get(`${process.env.SITE_URL || 'https://khutbah.dev'}/api/results`); });

const width = Math.max(...rows.map(r => r.name.length));
for (const r of rows) console.log(`${r.ok ? '✓' : r.needed ? '✗' : '⚠'} ${r.name.padEnd(width)}  ${String(r.ms).padStart(5)} ms  ${r.note}`);
const down = rows.filter(r => !r.ok && r.needed);
console.log(down.length ? `\n${down.length} needed service(s) down.` : '\nEverything the pipeline needs answers.');
process.exit(down.length ? 1 : 0);
