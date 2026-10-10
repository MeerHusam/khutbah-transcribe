#!/usr/bin/env node
// translate.js — Add a reading of a khutbah in another language alongside its English: Urdu (21 Aug
// 2026 first, as translate_urdu.js), Bengali (5 Oct), any language in core/languages.js. What
// differs per language (prompts, editions, clean-up) is its file in core/langs/. Nothing English
// is changed.
//
//  - Blocks: Gemini 3.8 Flash (Opus until 10 Oct 2026) translates each prose chunk from the imam's
//    Arabic directly, on the same chunk boundaries as the English, so the page can switch language
//    block by block. Chunks are sent in batches with the previous chunks as context and must come
//    back one translation per chunk, by index: the English of the Sudais khutbah slipped onto its
//    neighbouring blocks when two translations were missing. A batch Gemini does not answer goes
//    to Opus.
//  - Verses: the language's published Quran translation (fawazahmed0/quran-api).
//  - Hadith: fawazahmed0/hadith-api's editions in the language. Their numbering is the local ara-*
//    corpus's, not sunnah.com's (Sahih Muslim differs), so the hadith is found by its Arabic text.
//  - In Short, Summary, the narrators' names (and the surah names, where the language needs them
//    asked for), and each hadith cut to start at the Companion (a published text can open with the
//    whole chain of narrators); one call.
// Writes result.<field> (result.urdu, result.bengali) and reader_<code>.txt (the reader with the
// language in place of English).
//
// Usage: node core/translate.js outputs/<folder> --lang ur|bn [--batch 12] [--retranslate] [--chunks 13,14] [--dry-run]
//   Block translations already in result.<field> are kept unless --retranslate (all) or --chunks
//   (those); verses and hadith are always read again (free, from hadith_data/).
//   KT_TRANSLATE_MODEL=claude-opus-5-5: the blocks on Opus, as before 10 Oct 2026.
//   KT_TRANSLATE_CAP: the most a run may spend, in USD (default 2).

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { buildReaderView } from './reader.js';
import { normalizeArabic, findRestarts, restartNotes } from './arabic.js';
import { LANGS, langOf, cliArgs } from './languages.js';
import { geminiJSON, geminiPrice } from './gemini_text.js';


// The blocks: Gemini 3.8 Flash since 10 Oct 2026. In a blind test on the 9 Oct khutbah (41 blocks,
// these prompts) it made no serious error in Urdu or Bengali, like Opus's first drafts, and was as
// good or better on 93% and 92% of the blocks, for $0.13 a language against Opus's $0.57 and $0.63.
// A batch it does not answer (an error, a blocked answer, no text, not JSON) goes to Opus.
// The extras call below (summaries, narrators, surah names, hadith cuts) stays on Opus: it was not
// part of the test.
const OPUS = 'claude-opus-5-5';
const MODEL = process.env.KT_TRANSLATE_MODEL || 'gemini-3.8-flash';
// Opus 5.5 at high: on the hard parts of 25 Sep (1 Oct 2026) its first draft needed the fewest
// fixes; Sonnet 5.5 cost the same in practice (twice the output, more review rounds) and slipped.
const price = model => (model === OPUS ? [4, 20] : geminiPrice(model)); // USD per million tokens, in / out
// The most a call may write. Gemini's thinking counts toward it (Google: maxOutputTokens caps
// thinking and answer together): at HIGH it used 4,300 to 12,700 tokens a batch on 9 Oct's blocks,
// and on 10 Oct a 12-chunk Urdu batch ran past 16,000 and was cut. Gemini 3 Flash models also get
// caught in a thinking loop now and then (Google's forum, 2026) and run to the limit; such a cut
// batch is asked once more at MEDIUM thinking (Google's advice: think less rather than squeeze the
// limit), then goes to Opus. One user saw 3.8 Flash bill up to twice maxOutputTokens, so the cap
// reckons a Gemini call at twice its limit.
const maxOut = model => (model === OPUS ? 16000 : 32768);
const billedOut = model => (model === OPUS ? 1 : 2) * maxOut(model);
// A request the model declines (the du'a names enemies: Houthis, Zionists) is re-run on the
// fallback model the API picks for that kind of refusal, instead of leaving blocks untranslated.
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
// A hard cap per run: a call that could take the run past it is refused. A language costs about
// $0.15 on Gemini, $0.65 all on Opus.
const CAP = +(process.env.KT_TRANSLATE_CAP || 2);

const args = process.argv.slice(2);
const { opt, folder } = cliArgs(args);
const L = langOf(opt('--lang'));
if (!folder || !existsSync(join(folder, 'result.json')) || !L) {
  console.error(`Usage: node core/translate.js outputs/<folder> --lang ${LANGS.map(l => l.code).join('|')} [--batch 12] [--retranslate] [--chunks 13,14] [--dry-run]`);
  process.exit(1);
}
if (!price(MODEL)) { console.error(`✗ KT_TRANSLATE_MODEL=${MODEL}: no price for it here (${OPUS} or gemini-3.8-flash)`); process.exit(1); }
const F = L.field;
const BATCH = args.includes('--batch') ? +opt('--batch') : 12;
const dryRun = args.includes('--dry-run');

const result = JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8'));
const transcript = readFileSync(join(folder, 'transcript.txt'), 'utf8').trim();
const words = transcript.split(/\s+/).filter(Boolean);
const chunks = (result.prose_chunk_map ?? []).map(c => words.slice(c.wordStart, c.wordEnd).join(' '));
const quran = JSON.parse(readFileSync(new URL('../node_modules/quran-json/dist/quran.json', import.meta.url), 'utf8'));
const restarts = findRestarts(chunks);

const SCHEMA = {
  type: 'object',
  properties: {
    translations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { i: { type: 'integer' }, [F]: { type: 'string' } },
        required: ['i', F],
        additionalProperties: false,
      },
    },
  },
  required: ['translations'],
  additionalProperties: false,
};

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 300_000, maxRetries: 3 });
// This run's calls, tokens and cost, by model.
const usage = {};
let spent = 0;
function record(model, u, cost) {
  const t = (usage[model] ??= { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 });
  for (const k of ['calls', 'input_tokens', 'output_tokens', 'thoughts_tokens']) if (u[k]) t[k] = (t[k] ?? 0) + u[k];
  t.cost_usd += cost;
  spent += cost;
}
// A call of `chars` characters (prompt and system) must fit under the cap at its worst: a token per
// character in, all it may be billed for out. One that might not ends the run, with nothing written.
function withinCap(model, chars) {
  const [pin, pout] = price(model);
  const worst = (chars * pin + billedOut(model) * pout) / 1e6;
  if (spent + worst <= CAP) return;
  console.error(`✗ ${model} call refused: $${spent.toFixed(3)} spent this run, one call could cost $${worst.toFixed(3)}, the cap is $${CAP} (KT_TRANSLATE_CAP); nothing written`);
  process.exit(1);
}

async function opus(params) {
  const response = await anthropic.beta.messages.create({ model: OPUS, max_tokens: maxOut(OPUS), ...FALLBACK, ...params });
  const { input_tokens, output_tokens } = response.usage;
  const [pin, pout] = price(OPUS);
  record(OPUS, { calls: 1, input_tokens, output_tokens }, (input_tokens * pin + output_tokens * pout) / 1e6);
  return response;
}

// The chunks of `indices` translated: { got: { i: text }, model }.
async function translate(indices, done) {
  const first = indices[0];
  const context = [first - 2, first - 1].filter(i => i >= 0)
    .map(i => `(${i}, context only) ${chunks[i]}${done[i] ? `\n   ${L.name}: ${done[i]}` : ''}`).join('\n');
  // What comes next, so a sentence cut at the last chunk's pause is not closed too early.
  const last = indices.at(-1);
  const after = [last + 1, last + 2].filter(i => i < chunks.length)
    .map(i => `(${i}, context only) ${chunks[i]}`).join('\n');
  let content = (context ? `Context, already translated:\n${context}\n\n` : '') +
    `Translate chunks ${indices.join(', ')}:\n` + indices.map(i => `(${i}) ${chunks[i]}`).join('\n') +
    (after ? `\n\nWhat follows, for context only (do not translate):\n${after}` : '');
  const notes = restartNotes(restarts.filter(r => indices.includes(r.chunk) || indices.includes(r.from)));
  if (notes) content += `\n\n${notes}`;
  if (dryRun) { console.log(content.slice(0, 1500)); return { got: {} }; }
  const pick = out => Object.fromEntries((Array.isArray(out?.translations) ? out.translations : [])
    .filter(t => indices.includes(t.i) && typeof t[F] === 'string' && t[F].trim()).map(t => [t.i, t[F].trim()]));
  const chars = content.length + L.translate.system.length;
  // HIGH thinking, as in the blind test; an answer cut at the limit is asked once more at MEDIUM.
  for (const thinkingLevel of MODEL === OPUS ? [] : ['HIGH', 'MEDIUM']) {
    withinCap(MODEL, chars);
    const g = await geminiJSON({ model: MODEL, system: L.translate.system, content, schema: SCHEMA, maxOutputTokens: maxOut(MODEL), thinkingLevel });
    record(MODEL, g.usage, g.cost_usd);
    const got = g.ok ? pick(g.json) : {};
    if (Object.keys(got).length) return { got, model: MODEL };
    const cut = !g.ok && /MAX_TOKENS/.test(g.why) && thinkingLevel === 'HIGH';
    console.log(`  ${MODEL} (${thinkingLevel}), chunks ${indices[0]}-${indices.at(-1)}: ${g.ok ? 'none of them in its answer' : g.why}${g.ok ? '' : ` after ${g.usage.output_tokens} tokens`}; ${cut ? 'asking again at MEDIUM thinking' : `asking ${OPUS}`}`);
    if (!cut) break;
  }
  withinCap(OPUS, chars);
  const response = await opus({
    system: L.translate.system,
    output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content }],
  });
  if (response.stop_reason === 'refusal') return { got: {} };
  try { return { got: pick(JSON.parse(response.content.find(b => b.type === 'text')?.text ?? '')), model: OPUS }; } catch { return { got: {} }; }
}

// ── Blocks ───────────────────────────────────────────────────────────────────
// Only the chunks without a translation are translated (all of them on a first run, or with
// --retranslate); --chunks 13,14 translates those again, after a fix moved their boundaries.
const only = args.includes('--chunks') ? opt('--chunks').split(',').map(Number) : [];
const prev = result[F];
const kept = prev?.chunk_translations;
const reuse = !args.includes('--retranslate') && kept?.length === chunks.length;
const blocks = reuse ? kept.map((t, i) => (only.includes(i) ? null : t || null)) : new Array(chunks.length).fill(null);
// Which model made each block (a result from before 10 Oct 2026 names one model for all).
const models = blocks.map((t, i) => (t ? prev.block_models?.[i] ?? prev.model ?? OPUS : null));
const todo = blocks.map((t, i) => (t ? null : i)).filter(i => i !== null);
if (reuse) console.log(`  keeping ${chunks.length - todo.length} of the ${chunks.length} ${L.name} block translations already in result.json`);
const put = ({ got, model }) => { for (const [i, t] of Object.entries(got)) { blocks[i] = t; models[i] = model; } };
for (let k = 0; k < todo.length;) {
  // A batch: up to BATCH chunks in a row, so the chunks around it are the context.
  const idx = [todo[k++]];
  while (k < todo.length && idx.length < BATCH && todo[k] === idx.at(-1) + 1) idx.push(todo[k++]);
  put(await translate(idx, blocks));
  if (dryRun) process.exit(0);
  // Anything missing is asked for again on its own, never left for a neighbour to fill.
  for (const i of idx) if (!blocks[i]) put(await translate([i], blocks));
  const by = [...new Set(idx.map(i => models[i]).filter(Boolean))].join(', ');
  console.log(`  chunks ${idx[0]}-${idx.at(-1)}: ${idx.filter(i => blocks[i]).length}/${idx.length}${by ? ` (${by})` : ''}`);
}
const missing = blocks.map((t, i) => (t ? null : i)).filter(i => i !== null);
if (missing.length) { console.error(`✗ no ${L.name} for chunk(s) ${missing.join(', ')}; nothing written`); process.exit(1); }

// ── Verses and hadith (the language's published translations) ────────────────
// From the editions' files in hadith_data/ (scripts/setup_hadith.js), never the network: on
// 7 Oct 2026 a moment's refusal from the CDN dropped an ayah and a hadith from a page. Whatever has
// no translation goes in `gaps` with the reason, so the publish check can tell a gap the edition
// really has from one this run made.
const data = name => join('hadith_data', `${name}.json`);
const local = name => {
  if (!existsSync(data(name))) { console.error(`✗ ${data(name)} is missing: run node scripts/setup_hadith.js`); process.exit(1); }
  return JSON.parse(readFileSync(data(name), 'utf8'));
};
const quranTr = new Map(local(`quran-${L.quran.edition}`).quran.map(v => [`${v.chapter}:${v.verse}`, v.text]));
const verses = {}, gaps = {};
for (const q of result.quran_references ?? []) {
  if (!q.matched) continue;
  for (let a = q.ayah_number; a <= (q.ayah_number_end ?? q.ayah_number); a++) {
    const key = `${q.surah_number}:${a}`;
    if (quranTr.get(key)) verses[key] = L.verseText(quranTr.get(key));
    else { gaps[key] = `not in ${L.quran.edition}`; console.log(`  ⚠ verse ${key}: ${gaps[key]}`); }
  }
}

// Hadith: found by Arabic text in the local ara-* corpus (same numbering as the other editions),
// then read from the language's edition of that collection.
const pairs = t => { const w = normalizeArabic(t ?? '').split(/\s+/).filter(Boolean); return new Set(w.slice(1).map((x, i) => w[i] + ' ' + x)); };
const overlap = (want, text) => { const have = pairs(text); return [...want].filter(p => have.has(p)).length / Math.max(want.size, 1); };
const corpora = {}, editions = {};
const hadith = {};
for (const h of result.hadith_references ?? []) {
  const m = (h.link ?? '').match(/sunnah\.com\/([a-z]+):(\d+)/);
  if (!m) continue;
  const [, slug, num] = m;
  const key = `${slug}:${num}`;
  const gap = why => { gaps[key] = why; console.log(`  ⚠ ${key}: ${why}`); };
  // A collection setup_hadith.js does not download (Riyad as-Salihin, Ahmad …) has no edition here.
  if (!existsSync(data(`ara-${slug}`))) { gap(`no ara-${slug} in hadith_data`); continue; }
  corpora[slug] ??= local(`ara-${slug}`).hadiths;
  // Candidates: the same number in either numbering; otherwise the whole collection.
  const want = pairs(h.published_arabic || h.detected_text);
  let cands = corpora[slug].filter(x => String(x.hadithnumber) === num || String(x.arabicnumber ?? '').split('.')[0] === num);
  if (!cands.length) cands = corpora[slug];
  let best = null;
  for (const c of cands) {
    const score = overlap(want, c.text);
    if (!best || score > best.score) best = { number: c.hadithnumber, score };
  }
  if (!best || best.score < 0.5) { gap(`no Arabic match (${best?.score.toFixed(2)})`); continue; }
  const edition = `${L.hadith.edition}-${slug}`;
  editions[edition] ??= new Map(local(edition).hadiths.map(x => [String(x.hadithnumber), x.text]));
  const text = editions[edition].get(String(best.number)) || null;
  hadith[key] = { text: text != null ? L.hadithText(text, best.number) : null, edition, number: best.number, match: +best.score.toFixed(2) };
  if (!text) gap(`${edition} has no text for ${best.number}`);
}

// ── In Short, Summary, narrator names, and each hadith without its chain ──────
// One call. A published hadith can open with the whole chain of narrators ("ہمیں حدیث بیان کی
// یعقوب بن ابراہیم نے، ان کو…"); the card starts at the Companion instead, cut from the published
// text itself: accepted only as an exact substring, else the full text stays.
const askSurahs = L.surahNames === 'model';
const surahNums = [...new Set((result.quran_references ?? []).filter(q => q.matched).map(q => q.surah_number))].sort((a, b) => a - b);
const EXTRAS_SCHEMA = {
  type: 'object',
  properties: {
    share_summary: { type: 'string' },
    summary: { type: 'string' },
    hadith: {
      type: 'array',
      items: {
        type: 'object',
        properties: { key: { type: 'string' }, narrator: { type: 'string' }, from_companion: { type: 'string' } },
        required: ['key', 'narrator', 'from_companion'],
        additionalProperties: false,
      },
    },
    ...(askSurahs ? { surahs: { type: 'array', items: {
      type: 'object', properties: { n: { type: 'integer' }, name: { type: 'string' } }, required: ['n', 'name'], additionalProperties: false,
    } } } : {}),
  },
  required: ['share_summary', 'summary', 'hadith', ...(askSurahs ? ['surahs'] : [])],
  additionalProperties: false,
};
let extras = !args.includes('--retranslate') && result[F]?.summary ? {
  share_summary: result[F].share_summary, summary: result[F].summary,
  narrators: result[F].narrators ?? {}, surahs: result[F].surahs ?? {},
} : null;
if (!extras) {
  const hadithList = (result.hadith_references ?? []).map(h => {
    const m = (h.link ?? '').match(/sunnah\.com\/([a-z]+):(\d+)/);
    const key = m ? `${m[1]}:${m[2]}` : null;
    return { key, narrator: h.narrator, collection: h.collection, [F]: key && hadith[key]?.text };
  }).filter(h => h.key);
  const content = [
    L.translate.extras.ask(result.share_summary ?? '', result.summary ?? ''),
    L.translate.extras.hadith,
    JSON.stringify(hadithList, null, 1),
    ...(askSurahs ? [L.translate.extras.surahs, surahNums.map(n => `${n}: ${quran[n - 1]?.transliteration} (${quran[n - 1]?.name})`).join('\n')] : []),
  ].join('\n\n');
  withinCap(OPUS, content.length + L.translate.extras.system.length);
  const response = await opus({
    system: L.translate.extras.system,
    output_config: { effort: 'high', format: { type: 'json_schema', schema: EXTRAS_SCHEMA } },
    messages: [{ role: 'user', content }],
  });
  const out = JSON.parse(response.content.find(b => b.type === 'text')?.text ?? '{}') ?? {};
  extras = { share_summary: out.share_summary, summary: out.summary, narrators: {},
    surahs: Object.fromEntries((out.surahs ?? []).filter(s => s.name?.trim()).map(s => [s.n, s.name.trim()])) };
  for (const x of out.hadith ?? []) {
    // A hadith whose card names no narrator (core/hadith.js) gets none in this language either.
    if (hadithList.find(h => h.key === x.key)?.narrator) extras.narrators[x.key] = x.narrator;
    const full = hadith[x.key]?.text;
    const cut = (x.from_companion ?? '').trim();
    if (full && cut && full.includes(cut) && cut.length > 20) hadith[x.key].from_companion = cut;
  }
}
for (const [key, h] of Object.entries(hadith)) { // a re-read keeps the earlier cut when it still fits
  const old = result[F]?.hadith?.[key]?.from_companion;
  if (!h.from_companion && old && h.text?.includes(old)) h.from_companion = old;
  // The card shows the hadith only, not the notes an edition puts after it (core/langs/<code>.js).
  // The cut stays an exact prefix of the published text.
  const shown = h.from_companion || h.text;
  const end = shown?.search(L.hadith.end) ?? -1;
  if (end > 20) h.from_companion = shown.slice(0, end);
}

// Surah names for the badges: the Arabic names (Urdu), or the names asked for above.
const surahs = {};
for (const q of result.quran_references ?? []) {
  if (q.matched) surahs[q.surah_number] = askSurahs ? extras.surahs[q.surah_number] ?? quran[q.surah_number - 1]?.transliteration : quran[q.surah_number - 1]?.name;
}

// Usage by model, this run's added to the earlier runs' when blocks were kept (a result from before
// 10 Oct 2026 has no by_model: its calls were all one model's).
const round = x => Math.round(x * 10000) / 10000;
const was = reuse ? prev.usage : null;
const byModel = structuredClone(was?.by_model ?? (was?.calls ? { [prev.model ?? OPUS]:
  { calls: was.calls, input_tokens: was.input_tokens, output_tokens: was.output_tokens, cost_usd: was.cost_usd ?? 0 } } : {}));
for (const [m, u] of Object.entries(usage)) {
  const t = (byModel[m] ??= {});
  for (const [k, v] of Object.entries(u)) t[k] = round((t[k] ?? 0) + v);
}
const total = k => Object.values(byModel).reduce((s, u) => s + (u[k] ?? 0), 0);
const blockCount = Object.entries(models.reduce((n, m) => ({ ...n, [m]: (n[m] ?? 0) + 1 }), {}));
result[F] = {
  model: blockCount.map(([m]) => m).join(' + '), block_models: models,
  created_at: reuse ? prev.created_at : new Date().toISOString(),
  chunk_translations: blocks,
  share_summary: extras.share_summary, summary: extras.summary, narrators: extras.narrators, surahs,
  verses, verse_source: L.quran,
  hadith, hadith_source: `fawazahmed0/hadith-api (${L.hadith.edition}-*)`, gaps,
  usage: { calls: total('calls'), input_tokens: total('input_tokens'), output_tokens: total('output_tokens'),
    cost_usd: round(total('cost_usd')), by_model: byModel },
  ...(reuse && prev.review ? { review: prev.review } : {}),
};

// The language's reader: the same blocks, the language in place of English. Published English
// excerpts are not carried over; a hadith card shows its edition's text.
const trResult = {
  ...result,
  chunk_translations: blocks,
  quran_references: (result.quran_references ?? []).map(({ english_swap, ...r }) => r),
  hadith_references: (result.hadith_references ?? []).map(({ english_swap, ...r }) => {
    const m = (r.link ?? '').match(/sunnah\.com\/([a-z]+):(\d+)/);
    const tr = m && hadith[`${m[1]}:${m[2]}`];
    return { ...r, translation: (tr && (tr.from_companion || tr.text)) || null };
  }),
};
writeFileSync(join(folder, `reader_${L.code}.txt`), buildReaderView(transcript, trResult, { untranslated: L.untranslated }), 'utf8');
writeFileSync(join(folder, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
const thisRun = Object.entries(usage).map(([m, u]) =>
  `${m}: ${u.calls} call(s), ${u.input_tokens} in / ${u.output_tokens} out tokens, $${round(u.cost_usd)}`).join('; ');
console.log(`✓ ${blocks.length} blocks (${blockCount.map(([m, n]) => `${n} ${m}`).join(', ')}), ` +
  `${Object.keys(verses).length} verses, ${Object.keys(hadith).length} hadith in ${L.name} — ` +
  `this run: ${thisRun || 'no calls'}; $${round(spent)} (total $${result[F].usage.cost_usd})`);
