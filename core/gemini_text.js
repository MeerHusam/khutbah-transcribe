// gemini_text.js — One Gemini request that answers in JSON, for text work moved off Claude (10 Oct 2026:
// the Urdu and Bengali block translations, core/translate.js, after a blind test against Opus).
// It never throws: a caller falls back to Claude on anything but a usable answer, so it says why
// there was none (an error, a blocked or cut answer, no text, text that is not JSON).
//
// The text is the answer's non-thought parts only: a thought part can come first (the transcript
// of 9 Oct 2026 was Gemini's own notes). Usage: promptTokenCount in; candidatesTokenCount and
// thoughtsTokenCount out (thinking is billed as output).

import { GoogleGenAI } from '@google/genai';

// USD per million tokens, in / out. Gemini 3.8 Flash doubles on 1 Jan 2027.
const PRICES = {
  'gemini-3.8-flash': date => (date < new Date('2027-01-01T00:00:00Z') ? [0.75, 3.75] : [1.5, 7.5]),
};
export const geminiPrice = (model, date = new Date()) => PRICES[model]?.(date) ?? null;

// Finishes that leave no answer or half of one.
const BAD_FINISH = new Set(['MAX_TOKENS', 'SAFETY', 'RECITATION', 'LANGUAGE', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'OTHER']);

let client = null, lastCall = 0;
const sleep = ms => new Promise(res => setTimeout(res, ms));

// { ok: true, json, usage, cost_usd } or { ok: false, why, usage, cost_usd }.
// A busy model (429, 5xx) is asked again `retries` times, `waitMs` apart; calls are at least `gapMs` apart.
export async function geminiJSON({ model, system, content, schema, maxOutputTokens = 16000, thinkingLevel = 'HIGH',
  client: given, retries = 1, waitMs = 15_000, gapMs = +(process.env.KT_GEMINI_GAP_MS ?? 2_000) }) {
  const ai = given ?? (client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || 'not-set' }));
  const usage = { calls: 0, input_tokens: 0, output_tokens: 0, thoughts_tokens: 0 };
  const done = (fields) => {
    const [pin, pout] = geminiPrice(model) ?? [0, 0];
    return { ...fields, usage, cost_usd: (usage.input_tokens * pin + usage.output_tokens * pout) / 1e6 };
  };
  let r;
  for (let attempt = 0; ; attempt++) {
    const wait = lastCall + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    try {
      r = await ai.models.generateContent({
        model, contents: content,
        config: { systemInstruction: system, maxOutputTokens, responseMimeType: 'application/json',
          responseJsonSchema: schema, thinkingConfig: { thinkingLevel } },
      });
      break;
    } catch (e) {
      const code = +(e.status ?? e.code ?? String(e.message).match(/"code":\s*(\d{3})/)?.[1] ?? 0);
      if (attempt < retries && (code === 429 || code >= 500)) { await sleep(waitMs); continue; }
      return done({ ok: false, why: `error ${code || ''}: ${String(e.message).slice(0, 160)}` });
    }
  }
  const u = r.usageMetadata ?? {};
  usage.calls = 1;
  usage.input_tokens = u.promptTokenCount ?? 0;
  usage.thoughts_tokens = u.thoughtsTokenCount ?? 0;
  usage.output_tokens = (u.candidatesTokenCount ?? 0) + usage.thoughts_tokens;
  if (r.promptFeedback?.blockReason) return done({ ok: false, why: `blocked (${r.promptFeedback.blockReason})` });
  const cand = r.candidates?.[0];
  if (BAD_FINISH.has(cand?.finishReason)) return done({ ok: false, why: `finished ${cand.finishReason}` });
  const text = (cand?.content?.parts ?? []).filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('').trim();
  if (!text) return done({ ok: false, why: 'no text' });
  try { return done({ ok: true, json: JSON.parse(text) }); } catch { return done({ ok: false, why: 'not JSON' }); }
}
