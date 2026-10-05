#!/usr/bin/env node
// translate.js — Add a reading of a khutbah in another language alongside its English: Urdu (21 Aug
// 2026 first, as translate_urdu.js), Bengali (5 Oct), any language in core/languages.js. What
// differs per language (prompts, editions, clean-up) is its file in core/langs/. Nothing English
// is changed.
//
//  - Blocks: Claude translates each prose chunk from the imam's Arabic directly, on the same chunk
//    boundaries as the English, so the page can switch language block by block. Chunks are sent in
//    batches with the previous chunks as context and must come back one translation per chunk, by
//    index: the English of the Sudais khutbah slipped onto its neighbouring blocks when two
//    translations were missing.
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
//   (those); verses and hadith are always fetched again (free).

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { buildReaderView } from './reader.js';
import { normalizeArabic, findRestarts, restartNotes } from './arabic.js';
import { LANGS, langOf, cliArgs } from './languages.js';


// Opus 5.5 at high: on the hard parts of 25 Sep (1 Oct 2026) its first draft needed the fewest
// fixes; Sonnet 5.5 cost the same in practice (twice the output, more review rounds) and slipped.
const MODEL = 'claude-opus-5-5';
const PRICE_IN = 4 / 1e6, PRICE_OUT = 20 / 1e6; // USD per token, claude-opus-5-5
// A request the model declines (the du'a names enemies: Houthis, Zionists) is re-run on the
// fallback model the API picks for that kind of refusal, instead of leaving blocks untranslated.
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

const args = process.argv.slice(2);
const { opt, folder } = cliArgs(args);
const L = langOf(opt('--lang'));
if (!folder || !existsSync(join(folder, 'result.json')) || !L) {
  console.error(`Usage: node core/translate.js outputs/<folder> --lang ${LANGS.map(l => l.code).join('|')} [--batch 12] [--retranslate] [--chunks 13,14] [--dry-run]`);
  process.exit(1);
}
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
const usage = { calls: 0, input_tokens: 0, output_tokens: 0 };

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
  if (dryRun) { console.log(content.slice(0, 1500)); return {}; }
  const response = await anthropic.beta.messages.create({
    model: MODEL, max_tokens: 16000, system: L.translate.system, ...FALLBACK,
    output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content }],
  });
  usage.calls++;
  usage.input_tokens += response.usage.input_tokens;
  usage.output_tokens += response.usage.output_tokens;
  if (response.stop_reason === 'refusal') return {};
  try {
    const out = JSON.parse(response.content.find(b => b.type === 'text')?.text ?? '');
    return Object.fromEntries(out.translations.filter(t => indices.includes(t.i) && t[F].trim()).map(t => [t.i, t[F].trim()]));
  } catch { return {}; }
}

// ── Blocks ───────────────────────────────────────────────────────────────────
// Only the chunks without a translation are translated (all of them on a first run, or with
// --retranslate); --chunks 13,14 translates those again, after a fix moved their boundaries.
const only = args.includes('--chunks') ? opt('--chunks').split(',').map(Number) : [];
const kept = result[F]?.chunk_translations;
const reuse = !args.includes('--retranslate') && kept?.length === chunks.length;
const blocks = reuse ? kept.map((t, i) => (only.includes(i) ? null : t || null)) : new Array(chunks.length).fill(null);
const todo = blocks.map((t, i) => (t ? null : i)).filter(i => i !== null);
if (reuse) console.log(`  keeping ${chunks.length - todo.length} of the ${chunks.length} ${L.name} block translations already in result.json`);
for (let k = 0; k < todo.length;) {
  // A batch: up to BATCH chunks in a row, so the chunks around it are the context.
  const idx = [todo[k++]];
  while (k < todo.length && idx.length < BATCH && todo[k] === idx.at(-1) + 1) idx.push(todo[k++]);
  Object.assign(blocks, await translate(idx, blocks));
  if (dryRun) process.exit(0);
  // Anything missing is asked for again on its own, never left for a neighbour to fill.
  for (const i of idx) if (!blocks[i]) Object.assign(blocks, await translate([i], blocks));
  console.log(`  chunks ${idx[0]}-${idx.at(-1)}: ${idx.filter(i => blocks[i]).length}/${idx.length}`);
}
const missing = blocks.map((t, i) => (t ? null : i)).filter(i => i !== null);
if (missing.length) { console.error(`✗ no ${L.name} for chunk(s) ${missing.join(', ')}; nothing written`); process.exit(1); }

// ── Verses (the language's published translation) ────────────────────────────
const getJson = async url => { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); };
const verses = {};
for (const q of result.quran_references ?? []) {
  if (!q.matched) continue;
  for (let a = q.ayah_number; a <= (q.ayah_number_end ?? q.ayah_number); a++) {
    const key = `${q.surah_number}:${a}`;
    if (verses[key]) continue;
    try {
      verses[key] = L.verseText((await getJson(`https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions/${L.quran.edition}/${q.surah_number}/${a}.json`)).text);
    } catch (e) { console.log(`  ⚠ verse ${key}: ${e.message}`); }
  }
}

// ── Hadith (fawazahmed0, found by Arabic text) ───────────────────────────────
// Candidates come from the local ara-* corpus (same numbering as the other editions). A collection
// that is not downloaded (Tirmidhi) is tried by number on the same CDN: the number and its
// neighbours, since the two numberings rarely differ by much there.
const pairs = t => { const w = normalizeArabic(t ?? '').split(/\s+/).filter(Boolean); return new Set(w.slice(1).map((x, i) => w[i] + ' ' + x)); };
const overlap = (want, text) => { const have = pairs(text); return [...want].filter(p => have.has(p)).length / Math.max(want.size, 1); };
const corpora = {};
const hadith = {};
for (const h of result.hadith_references ?? []) {
  const m = (h.link ?? '').match(/sunnah\.com\/([a-z]+):(\d+)/);
  if (!m) continue;
  const [, slug, num] = m;
  const want = pairs(h.published_arabic || h.detected_text);
  let best = null;
  if (existsSync(join('hadith_data', `ara-${slug}.json`))) {
    corpora[slug] ??= JSON.parse(readFileSync(join('hadith_data', `ara-${slug}.json`), 'utf8')).hadiths;
    // Candidates: the same number in either numbering; otherwise the whole collection.
    let cands = corpora[slug].filter(x => String(x.hadithnumber) === num || String(x.arabicnumber ?? '').split('.')[0] === num);
    if (!cands.length) cands = corpora[slug];
    for (const c of cands) {
      const score = overlap(want, c.text);
      if (!best || score > best.score) best = { number: c.hadithnumber, score };
    }
  } else {
    for (const n of [0, 1, -1, 2, -2, 3, -3].map(d => +num + d).filter(n => n > 0)) {
      try {
        const d = await getJson(`https://cdn.jsdelivr.net/gh/fawazahmed0/hadith-api@1/editions/ara-${slug}/${n}.json`);
        const score = overlap(want, d.hadiths?.[0]?.text);
        if (!best || score > best.score) best = { number: n, score };
        if (score >= 0.5) break;
      } catch { /* no such number */ }
    }
  }
  if (!best || best.score < 0.5) { console.log(`  ⚠ ${slug}:${num}: no Arabic match (${best?.score.toFixed(2)})`); continue; }
  try {
    const d = await getJson(`https://cdn.jsdelivr.net/gh/fawazahmed0/hadith-api@1/editions/${L.hadith.edition}-${slug}/${best.number}.json`);
    const text = d.hadiths?.[0]?.text;
    hadith[`${slug}:${num}`] = { text: text != null ? L.hadithText(text, best.number) : null, edition: `${L.hadith.edition}-${slug}`, number: best.number, match: +best.score.toFixed(2) };
  } catch (e) { console.log(`  ⚠ ${slug}:${num}: ${e.message}`); }
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
  const response = await anthropic.beta.messages.create({
    model: MODEL, max_tokens: 16000, ...FALLBACK,
    system: L.translate.extras.system,
    output_config: { effort: 'high', format: { type: 'json_schema', schema: EXTRAS_SCHEMA } },
    messages: [{ role: 'user', content: [
      L.translate.extras.ask(result.share_summary ?? '', result.summary ?? ''),
      L.translate.extras.hadith,
      JSON.stringify(hadithList, null, 1),
      ...(askSurahs ? [L.translate.extras.surahs, surahNums.map(n => `${n}: ${quran[n - 1]?.transliteration} (${quran[n - 1]?.name})`).join('\n')] : []),
    ].join('\n\n') }],
  });
  usage.calls++;
  usage.input_tokens += response.usage.input_tokens;
  usage.output_tokens += response.usage.output_tokens;
  const out = JSON.parse(response.content.find(b => b.type === 'text')?.text ?? '{}');
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
for (const [key, h] of Object.entries(hadith)) { // a re-fetch keeps the earlier cut when it still fits
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

const prev = result[F];
const prevCost = reuse ? (prev.usage?.cost_usd ?? 0) : 0;
result[F] = {
  model: MODEL, created_at: reuse ? prev.created_at : new Date().toISOString(),
  chunk_translations: blocks,
  share_summary: extras.share_summary, summary: extras.summary, narrators: extras.narrators, surahs,
  verses, verse_source: L.quran,
  hadith, hadith_source: `fawazahmed0/hadith-api (${L.hadith.edition}-*)`,
  usage: { calls: usage.calls + (reuse ? prev.usage?.calls ?? 0 : 0),
    input_tokens: usage.input_tokens + (reuse ? prev.usage?.input_tokens ?? 0 : 0),
    output_tokens: usage.output_tokens + (reuse ? prev.usage?.output_tokens ?? 0 : 0),
    input_usd: Math.round(usage.input_tokens * PRICE_IN * 10000) / 10000,
    output_usd: Math.round(usage.output_tokens * PRICE_OUT * 10000) / 10000,
    cost_usd: Math.round((prevCost + usage.input_tokens * PRICE_IN + usage.output_tokens * PRICE_OUT) * 10000) / 10000 },
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
console.log(`✓ ${blocks.length} blocks, ${Object.keys(verses).length} verses, ${Object.keys(hadith).length} hadith in ${L.name} — ` +
  `${usage.calls} ${MODEL} call(s) this run, ${usage.input_tokens} in / ${usage.output_tokens} out tokens, ` +
  `$${Math.round((usage.input_tokens * PRICE_IN + usage.output_tokens * PRICE_OUT) * 10000) / 10000} (total $${result[F].usage.cost_usd})`);
