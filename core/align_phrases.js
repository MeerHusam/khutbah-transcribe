// align_phrases.js — Which words of the imam's Arabic each phrase of a translation translates (12 Oct 2026), so the
// reader can light the Arabic phrase whose translation the voice is reading (and the phrase itself), matched by
// meaning, not position (Meer: "it is doing it by position not meaning, which is making it wrong").
//
// Per passage and language, the Arabic and the translation are split into the same number of consecutive phrases,
// phrase k of the translation translating phrase k of the Arabic; the answer is only where each phrase ends:
// [[arabicEnd, translationEnd], ...] as word numbers in the passage's text (split on spaces), exactly the text the
// reader is built from (core/reader_chunks.js). A passage whose answer does not cover its words in order is left
// out, and the page lights no part of it. Recited ayah cards (📖) are left out: there the voice plays the imam's own
// recitation, whose words light by their times. Gemini 3.8 Flash, thinking LOW, one request per language.
//
// Tested on 9 Oct 2026: $0.088 for English, Urdu and Bengali; 40/41, 41/41 and 36/41 passages usable.
//
//   node core/align_phrases.js outputs/<folder>            writes outputs/<folder>/align.json
//   node core/align_phrases.js outputs/<folder> --count    the size and projected cost only (free)
//   --cap 0.30 (USD, the default) refuses a language that would take the total past it; --langs en,ur,bn
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { GoogleGenAI } from '@google/genai';
import { loadResult } from './reader_chunks.js';
import { LANGS } from './languages.js';

export const ALIGN_MODEL = 'gemini-3.8-flash';
// USD per million tokens, in / out (core/gemini_text.js on the gemini-translate branch); doubles on 1 Jan 2027.
const price = (date = new Date()) => (date < new Date('2027-01-01T00:00:00Z') ? [0.75, 3.75] : [1.5, 7.5]);

const NAMES = { en: 'English', ...Object.fromEntries(LANGS.map(L => [L.code, L.name])) };
const fieldOf = code => (code === 'en' ? 'english' : LANGS.find(L => L.code === code)?.field);
// A passage's translation as the page shows it: its text without the source lines (📖 📑 📚), a hadith's ❝ as text.
export const shownTranslation = t => (t || '').split(/\n\n+/).map(p => p.trim()).filter(p => p && !/^(📖|📑|📚)/u.test(p))
  .map(p => p.replace(/^❝\s*/, '')).join(' ');
export const words = t => String(t || '').split(/\s+/).filter(Boolean);

// The pairs cover both texts in order, ending on their last words.
export function checkPairs(pairs, arCount, trCount) {
  if (!Array.isArray(pairs) || !pairs.length) return false;
  let pa = -1, pt = -1;
  for (const p of pairs) {
    if (!Array.isArray(p) || p.length !== 2 || !Number.isInteger(p[0]) || !Number.isInteger(p[1]) || p[0] <= pa || p[1] <= pt) return false;
    [pa, pt] = p;
  }
  return pa === arCount - 1 && pt === trCount - 1;
}

const system = code => `You align a Friday khutbah's Arabic with its ${NAMES[code]} translation, passage by passage.
Each word is numbered from 0. For each passage, split the Arabic (AR) and the translation (TR) into the SAME number of
consecutive phrases, so that translation phrase k is the translation of Arabic phrase k. Phrases cover every word, in order,
without gaps or overlaps. Make phrases short (about 2 to 7 Arabic words): split wherever the meaning can be split; where the
translation reorders words, keep those words together in one phrase. Answer with each phrase's LAST Arabic word number and
LAST translation word number: [[arabicEnd, translationEnd], ...]; the final pair is the last word of each.`;
const schema = { type: 'object', required: ['passages'], properties: { passages: { type: 'array', items: { type: 'object', required: ['i', 'pairs'],
  properties: { i: { type: 'integer' }, pairs: { type: 'array', items: { type: 'array', items: { type: 'integer' } } } } } } } };

// The passages to align in one language: [{ i, ar: [words], tr: [words] }].
export function passagesFor(chunks, code) {
  const field = fieldOf(code);
  return (chunks || []).map((c, i) => ({ i, c })).filter(({ c }) => c.arabic && c[field] && !/📖/u.test(c.english || ''))
    .map(({ i, c }) => ({ i, ar: words(c.arabic), tr: words(shownTranslation(c[field])) })).filter(p => p.ar.length && p.tr.length);
}
const numbered = ws => ws.map((w, k) => `${k}:${w}`).join(' ');
const contentFor = ps => ps.map(p => `#${p.i}\nAR ${numbered(p.ar)}\nTR ${numbered(p.tr)}`).join('\n\n');
const outEstimate = ps => Math.round(ps.length * 6 * 6 * 1.2) + 2500;

// Aligns a khutbah's passages (the reader's chunks) in each language it has, within `cap` USD in all.
// Returns { model, made, cost_usd, langs: { code: { "<i>": pairs } }, words: { "<i>": { ar, en, ur … } }, notes: [] }.
export async function alignChunks(chunks, { langs = null, cap = 0.30, count = false, apiKey = process.env.GEMINI_API_KEY, log = console.log } = {}) {
  const ai = new GoogleGenAI({ apiKey: apiKey || 'not-set' });
  const [pin, pout] = price();
  const codes = (langs ?? ['en', ...LANGS.map(L => L.code)]).filter(code => fieldOf(code) && chunks.some(c => c[fieldOf(code)]));
  const out = { model: ALIGN_MODEL, made: new Date().toISOString(), cost_usd: 0, langs: {}, words: {}, notes: [] };
  let spent = 0, projected = 0;
  for (const code of codes) {
    const ps = passagesFor(chunks, code);
    if (!ps.length) continue;
    const content = contentFor(ps);
    const inTok = (await ai.models.countTokens({ model: ALIGN_MODEL, contents: system(code) + '\n\n' + content })).totalTokens;
    const proj = inTok * pin / 1e6 + outEstimate(ps) * pout / 1e6;
    projected += proj;
    log(`${code}: ${ps.length} passages, ${inTok} tokens in, projected $${proj.toFixed(4)}`);
    if (count) continue;
    if (spent + proj > cap) { out.notes.push(`${code}: not run, would pass the $${cap} cap`); log(`${code}: not run, would pass the $${cap} cap`); continue; }
    const maxOutputTokens = Math.max(2000, Math.min(16000, Math.floor((cap - spent - inTok * pin / 1e6) / (pout / 1e6)) - 100));
    let res = null;
    for (let attempt = 0; attempt < 2 && !res; attempt++) {
      try {
        res = await ai.models.generateContent({ model: ALIGN_MODEL, contents: content, config: { systemInstruction: system(code),
          maxOutputTokens, responseMimeType: 'application/json', responseJsonSchema: schema, thinkingConfig: { thinkingLevel: 'LOW' } } });
      } catch (e) {
        const busy = /\b(429|500|502|503|504)\b|RESOURCE_EXHAUSTED|UNAVAILABLE/.test(String(e.message));
        if (!busy || attempt) { out.notes.push(`${code}: ${String(e.message).slice(0, 160)}`); log(`${code}: failed: ${String(e.message).slice(0, 160)}`); }
        else await new Promise(r => setTimeout(r, 30_000));
      }
    }
    if (!res) continue;
    const u = res.usageMetadata ?? {};
    const cost = (u.promptTokenCount ?? 0) * pin / 1e6 + ((u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)) * pout / 1e6;
    spent += cost;
    const text = (res.candidates?.[0]?.content?.parts ?? []).filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('');
    let answer = null; try { answer = JSON.parse(text); } catch {}
    const got = new Map((answer?.passages ?? []).map(p => [p.i, p.pairs]));
    const kept = {};
    for (const p of ps) {
      if (checkPairs(got.get(p.i), p.ar.length, p.tr.length)) kept[p.i] = got.get(p.i);
      (out.words[p.i] ??= { ar: p.ar.length })[code] = p.tr.length;
    }
    out.langs[code] = kept;
    log(`${code}: $${cost.toFixed(4)}, ${Object.keys(kept).length} of ${ps.length} passages usable (finish ${res.candidates?.[0]?.finishReason})`);
  }
  out.cost_usd = +spent.toFixed(5);
  if (count) out.projected_usd = +projected.toFixed(4);
  return out;
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const folder = args.find(a => !a.startsWith('--') && !['--cap', '--langs'].includes(args[args.indexOf(a) - 1]));
  if (!folder) { console.error('usage: node core/align_phrases.js outputs/<folder> [--count] [--cap 0.30] [--langs en,ur,bn]'); process.exit(1); }
  const opt = f => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
  const count = args.includes('--count');
  const result = loadResult(folder);
  const out = await alignChunks(result.reader_chunks || [], { count, cap: +(opt('--cap') ?? 0.30), langs: opt('--langs')?.split(',') ?? null });
  if (count) { console.log(`projected $${out.projected_usd} in all`); process.exit(0); }
  if (!Object.keys(out.langs).length) { console.error('nothing aligned'); process.exit(1); }
  writeFileSync(join(folder, 'align.json'), JSON.stringify(out));
  console.log(`${join(folder, 'align.json')}: $${out.cost_usd}`);
}
