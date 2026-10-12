// Meaning-based phrase alignment, test on 9 Oct 2026 only (Meer, 12 Oct: cap 5 cents, then 10 cents for all three). For each passage, the
// imam's Arabic and each translation (English, Urdu, Bengali) are split into the same number of consecutive phrases,
// phrase k of the translation translating phrase k of the Arabic; the answer is only where each phrase ends.
// The reader then lights the Arabic phrase whose translation the voice is reading.
//   node design/reader/align/align_test.mjs --count   free: token count and projected cost, nothing billed
//   node design/reader/align/align_test.mjs --run     one request, refused when the projection passes the cap
import { readFileSync, writeFileSync } from 'fs';
import { GoogleGenAI } from '@google/genai';

const here = new URL('.', import.meta.url).pathname;
const CAP_USD = 0.10, MODEL = 'gemini-3.8-flash', PRICE_IN = 0.75e-6, PRICE_OUT = 3.75e-6;   // core/gemini_text.js (gemini branch)
const env = readFileSync(here + '../../../../KhutbahTranscribe/.env', 'utf8');
const KEY = env.match(/^GEMINI_API_KEY=(.+)$/m)?.[1]?.trim();
if (!KEY) throw new Error('no GEMINI_API_KEY in the main folder .env');

const r = JSON.parse(readFileSync(here + '../../../design-mock/data/all/2026-10-09.json', 'utf8'));
const LANGS = [['en', 'english'], ['ur', 'urdu'], ['bn', 'bengali']];
// the translation as the page shows it: the passage's text without its source lines (📖 📑 📚), a hadith's ❝ kept as text
const tr = t => (t || '').split(/\n\n+/).map(p => p.trim()).filter(p => p && !/^(📖|📑|📚)/u.test(p)).map(p => p.replace(/^❝\s*/, '')).join(' ');
const words = t => t.split(/\s+/).filter(Boolean);
const passages = r.reader_chunks.map((c, i) => ({ i, c })).filter(({ c }) => !/📖/u.test(c.english || ''))
  .map(({ i, c }) => ({ i, ar: words(c.arabic), ...Object.fromEntries(LANGS.map(([l, f]) => [l, words(tr(c[f]))])) }));
const num = ws => ws.map((w, k) => `${k}:${w}`).join(' ');
const contentFor = l => passages.map(p => `#${p.i}\nAR ${num(p.ar)}\n${l.toUpperCase()} ${num(p[l])}`).join('\n\n');
const system = l => `You align a Friday khutbah's Arabic with its ${{ en: 'English', ur: 'Urdu', bn: 'Bengali' }[l]} translation, passage by passage.
Each word is numbered from 0. For each passage, split the Arabic (AR) and the translation (${l.toUpperCase()}) into the SAME number of
consecutive phrases, so that translation phrase k is the translation of Arabic phrase k. Phrases cover every word, in order,
without gaps or overlaps. Make phrases short (about 2 to 7 Arabic words): split wherever the meaning can be split; where the
translation reorders words, keep those words together in one phrase. Answer with each phrase's LAST Arabic word number and
LAST translation word number: [[arabicEnd, translationEnd], ...]; the final pair is the last word of each.`;
const schema = { type: 'object', properties: { passages: { type: 'array', items: { type: 'object', properties: {
  i: { type: 'integer' }, pairs: { type: 'array', items: { type: 'array', items: { type: 'integer' } } } }, required: ['i', 'pairs'] } } }, required: ['passages'] };

const ai = new GoogleGenAI({ apiKey: KEY });
const run = process.argv.includes('--run');
const out = { model: MODEL, made: new Date().toISOString(), cap_usd: CAP_USD, cost_usd: 0, langs: {},
  words: Object.fromEntries(passages.map(p => [p.i, { ar: p.ar.length, en: p.en.length, ur: p.ur.length, bn: p.bn.length }])) };
let spent = 0;
// a language already aligned is kept, its cost counted
try { const prev = JSON.parse(readFileSync(here + 'align-2026-10-09.json', 'utf8')); for (const [l, v] of Object.entries(prev.langs || {})) if (v.passages) { out.langs[l] = v; spent += v.cost_usd; } } catch {}
out.cost_usd = +spent.toFixed(5);
for (const [l] of LANGS) {
  if (out.langs[l]) { console.log(l + ": kept ($" + out.langs[l].cost_usd + ")"); continue; }
  const content = contentFor(l);
  const inTok = (await ai.models.countTokens({ model: MODEL, contents: system(l) + '\n\n' + content })).totalTokens;
  const outEst = Math.round(passages.length * 6 * 6 * 1.2) + 2500;
  const proj = inTok * PRICE_IN + outEst * PRICE_OUT;
  console.log(`${l}: input ${inTok} tokens; projected $${proj.toFixed(4)}; spent so far $${spent.toFixed(4)}`);
  if (!run) { spent += proj; continue; }
  if (spent + proj > CAP_USD) { console.log(`${l}: STOPPED, would pass the $${CAP_USD} cap`); break; }
  const maxOut = Math.min(9000, Math.floor((CAP_USD - spent - inTok * PRICE_IN) / PRICE_OUT) - 100);
  const t0 = Date.now();
  let res;
  try {
    res = await ai.models.generateContent({ model: MODEL, contents: content,
      config: { systemInstruction: system(l), maxOutputTokens: maxOut, responseMimeType: 'application/json', responseJsonSchema: schema, thinkingConfig: { thinkingLevel: 'LOW' } } });
  } catch (e) { console.log(`${l}: error ${String(e.message).slice(0, 160)}`); break; }
  const u = res.usageMetadata ?? {};
  const cost = (u.promptTokenCount ?? 0) * PRICE_IN + ((u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)) * PRICE_OUT;
  spent += cost;
  const text = (res.candidates?.[0]?.content?.parts ?? []).filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('');
  let json = null; try { json = JSON.parse(text); } catch {}
  console.log(`${l}: finish ${res.candidates?.[0]?.finishReason}; in ${u.promptTokenCount} out ${u.candidatesTokenCount} thoughts ${u.thoughtsTokenCount}; $${cost.toFixed(4)}; ${((Date.now() - t0) / 1000).toFixed(1)} s; ${json ? json.passages.length + ' passages' : 'NOT JSON'}`);
  out.langs[l] = { usage: u, cost_usd: +cost.toFixed(5), passages: json?.passages ?? null };
  out.cost_usd = +spent.toFixed(5);
  writeFileSync(here + 'align-2026-10-09.json', JSON.stringify(out, null, 1));
}
console.log(run ? `total spent $${spent.toFixed(4)}` : `all three projected $${spent.toFixed(4)}`);
