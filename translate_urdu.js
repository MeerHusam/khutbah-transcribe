#!/usr/bin/env node
// translate_urdu.js — Add an Urdu reading of a khutbah alongside its English (groundwork,
// 21 Aug 2026 first). Nothing English is changed.
//
//  - Blocks: Claude translates each prose chunk from the imam's Arabic directly into Urdu,
//    on the same chunk boundaries as the English, so the page can switch language block by
//    block. Chunks are sent in batches with the previous chunks as context and must come back
//    one translation per chunk, by index: the English of the Sudais khutbah slipped onto its
//    neighbouring blocks when two translations were missing.
//  - Verses: a published Urdu translation. Which one is Meer's decision; until then Muhammad
//    Junagarhi's (tanzil.net, via fawazahmed0/quran-api), marked as a placeholder.
//  - Hadith: the Urdu of fawazahmed0/hadith-api (urd-* editions). Its numbering is the local
//    ara-* corpus's, not sunnah.com's (Sahih Muslim differs), so the hadith is found by its
//    Arabic text.
// Writes result.urdu and reader_ur.txt (the reader with Urdu in place of English).
//
// Usage: node translate_urdu.js outputs/<folder> [--batch 12] [--retranslate] [--dry-run]
//   Block translations already in result.urdu are kept unless --retranslate; verses and hadith
//   are always fetched again (free).

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { buildReaderView, normalizeArabic } from './pipeline.js';

const MODEL = 'claude-sonnet-5';
const PRICE_IN = 2 / 1e6, PRICE_OUT = 10 / 1e6; // USD per token, claude-sonnet-5
export const QURAN_UR = {
  edition: 'urd-muhammadjunagar', // editions.json lists it as urd_muhammadjunagar; paths use '-'
  name: 'Muhammad Junagarhi',
  placeholder: true, // not chosen yet: Junagarhi, Jalandhry or Maududi is Meer's call
};

const args = process.argv.slice(2);
const folder = args[0];
if (!folder || !existsSync(join(folder, 'result.json'))) {
  console.error('Usage: node translate_urdu.js outputs/<folder> [--batch 12] [--dry-run]');
  process.exit(1);
}
const BATCH = args.includes('--batch') ? +args[args.indexOf('--batch') + 1] : 12;
const dryRun = args.includes('--dry-run');

const result = JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8'));
const transcript = readFileSync(join(folder, 'transcript.txt'), 'utf8').trim();
const words = transcript.split(/\s+/).filter(Boolean);
const chunks = (result.prose_chunk_map ?? []).map(c => words.slice(c.wordStart, c.wordEnd).join(' '));

const SYSTEM = `You translate an Arabic Friday khutbah (sermon) into Urdu for worshippers in Pakistan and India who do not understand Arabic. The text comes in numbered chunks, cut at pauses, so a chunk can start or end in the middle of a sentence.

- Translate every chunk completely and faithfully: every command, phrase, name and condition the imam says ("اتقوا الله" must appear as its Urdu). Do not summarise, explain or add.
- Translate exactly the words of each chunk, so that the chunks read on from one another; never move words into a neighbouring chunk.
- Use the formal religious Urdu of Urdu khutbahs and translations: اللہ تعالیٰ، نبی کریم صلی اللہ علیہ وسلم، رضی اللہ عنہ، تقویٰ، نماز، زکوٰۃ.
- Put a Quran verse or a hadith that the imam quotes in quotation marks “…”, translated faithfully.
- The transcript may have speech-recognition slips; translate the evident meaning.
Return one Urdu translation per chunk number given, and nothing for the context chunks.`;

const SCHEMA = {
  type: 'object',
  properties: {
    translations: {
      type: 'array',
      items: {
        type: 'object',
        properties: { i: { type: 'integer' }, urdu: { type: 'string' } },
        required: ['i', 'urdu'],
        additionalProperties: false,
      },
    },
  },
  required: ['translations'],
  additionalProperties: false,
};

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 300_000, maxRetries: 3 });
const usage = { calls: 0, input_tokens: 0, output_tokens: 0 };

async function translate(indices, urdu) {
  const first = indices[0];
  const context = [first - 2, first - 1].filter(i => i >= 0)
    .map(i => `(${i}, context only) ${chunks[i]}${urdu[i] ? `\n   Urdu: ${urdu[i]}` : ''}`).join('\n');
  const content = (context ? `Context, already translated:\n${context}\n\n` : '') +
    `Translate chunks ${indices.join(', ')}:\n` + indices.map(i => `(${i}) ${chunks[i]}`).join('\n');
  if (dryRun) { console.log(content.slice(0, 1500)); return {}; }
  const response = await anthropic.messages.create({
    model: MODEL, max_tokens: 16000, system: SYSTEM,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content }],
  });
  usage.calls++;
  usage.input_tokens += response.usage.input_tokens;
  usage.output_tokens += response.usage.output_tokens;
  if (response.stop_reason === 'refusal') return {};
  try {
    const out = JSON.parse(response.content.find(b => b.type === 'text')?.text ?? '');
    return Object.fromEntries(out.translations.filter(t => indices.includes(t.i) && t.urdu.trim()).map(t => [t.i, t.urdu.trim()]));
  } catch { return {}; }
}

// ── Blocks ───────────────────────────────────────────────────────────────────
const kept = result.urdu?.chunk_translations;
const reuse = !args.includes('--retranslate') && kept?.length === chunks.length && kept.every(Boolean);
const urdu = reuse ? [...kept] : new Array(chunks.length).fill(null);
if (reuse) console.log(`  keeping the ${kept.length} Urdu block translations already in result.json`);
for (let from = reuse ? chunks.length : 0; from < chunks.length; from += BATCH) {
  const idx = Array.from({ length: Math.min(BATCH, chunks.length - from) }, (_, k) => from + k);
  Object.assign(urdu, await translate(idx, urdu));
  if (dryRun) process.exit(0);
  // Anything missing is asked for again on its own, never left for a neighbour to fill.
  for (const i of idx) if (!urdu[i]) Object.assign(urdu, await translate([i], urdu));
  console.log(`  chunks ${from}-${idx.at(-1)}: ${idx.filter(i => urdu[i]).length}/${idx.length}`);
}
const missing = urdu.map((t, i) => (t ? null : i)).filter(i => i !== null);
if (missing.length) { console.error(`✗ no Urdu for chunk(s) ${missing.join(', ')}; nothing written`); process.exit(1); }

// ── Verses (published Urdu, placeholder edition) ─────────────────────────────
const getJson = async url => { const r = await fetch(url); if (!r.ok) throw new Error(`${r.status} ${url}`); return r.json(); };
const verses = {};
for (const q of result.quran_references ?? []) {
  if (!q.matched) continue;
  for (let a = q.ayah_number; a <= (q.ayah_number_end ?? q.ayah_number); a++) {
    const key = `${q.surah_number}:${a}`;
    if (verses[key]) continue;
    try {
      // NFKC: the tanzil text carries Arabic presentation forms (ﻻ, ﻇ) that Nastaliq fonts
      // do not join like ordinary letters.
      verses[key] = (await getJson(`https://cdn.jsdelivr.net/gh/fawazahmed0/quran-api@1/editions/${QURAN_UR.edition}/${q.surah_number}/${a}.json`)).text.normalize('NFKC');
    } catch (e) { console.log(`  ⚠ verse ${key}: ${e.message}`); }
  }
}

// ── Hadith (fawazahmed0 Urdu, found by Arabic text) ──────────────────────────
const pairs = t => { const w = normalizeArabic(t ?? '').split(/\s+/).filter(Boolean); return new Set(w.slice(1).map((x, i) => w[i] + ' ' + x)); };
const corpora = {};
const hadith = {};
for (const h of result.hadith_references ?? []) {
  const m = (h.link ?? '').match(/sunnah\.com\/([a-z]+):(\d+)/);
  if (!m || !existsSync(join('hadith_data', `ara-${m[1]}.json`))) continue;
  const [, slug, num] = m;
  corpora[slug] ??= JSON.parse(readFileSync(join('hadith_data', `ara-${slug}.json`), 'utf8')).hadiths;
  // Candidates: the same number in either numbering; otherwise the whole collection.
  let cands = corpora[slug].filter(x => String(x.hadithnumber) === num || String(x.arabicnumber ?? '').split('.')[0] === num);
  if (!cands.length) cands = corpora[slug];
  const want = pairs(h.published_arabic || h.detected_text);
  let best = null;
  for (const c of cands) {
    const have = pairs(c.text);
    const score = [...want].filter(p => have.has(p)).length / Math.max(want.size, 1);
    if (!best || score > best.score) best = { c, score };
  }
  if (!best || best.score < 0.5) { console.log(`  ⚠ ${slug}:${num}: no Arabic match in ara-${slug} (${best?.score.toFixed(2)})`); continue; }
  try {
    const d = await getJson(`https://cdn.jsdelivr.net/gh/fawazahmed0/hadith-api@1/editions/urd-${slug}/${best.c.hadithnumber}.json`);
    hadith[`${slug}:${num}`] = { text: d.hadiths?.[0]?.text?.normalize('NFKC') ?? null, edition: `urd-${slug}`, number: best.c.hadithnumber, match: +best.score.toFixed(2) };
  } catch (e) { console.log(`  ⚠ ${slug}:${num}: ${e.message}`); }
}

result.urdu = {
  model: MODEL, created_at: reuse ? result.urdu.created_at : new Date().toISOString(),
  chunk_translations: urdu,
  verses, verse_source: QURAN_UR,
  hadith, hadith_source: 'fawazahmed0/hadith-api (urd-*)',
  usage: reuse ? result.urdu.usage : { ...usage, cost_usd: Math.round((usage.input_tokens * PRICE_IN + usage.output_tokens * PRICE_OUT) * 10000) / 10000 },
};

// The Urdu reader: the same blocks, Urdu in place of English. Published English excerpts
// are not carried over; a hadith card shows its Urdu edition's text.
const urResult = {
  ...result,
  chunk_translations: urdu,
  quran_references: (result.quran_references ?? []).map(({ english_swap, ...r }) => r),
  hadith_references: (result.hadith_references ?? []).map(({ english_swap, ...r }) => {
    const m = (r.link ?? '').match(/sunnah\.com\/([a-z]+):(\d+)/);
    return { ...r, translation: (m && hadith[`${m[1]}:${m[2]}`]?.text) || null };
  }),
};
writeFileSync(join(folder, 'reader_ur.txt'), buildReaderView(transcript, urResult, { untranslated: '(ترجمہ دستیاب نہیں)' }), 'utf8');
writeFileSync(join(folder, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
console.log(`✓ ${urdu.length} blocks, ${Object.keys(verses).length} verses, ${Object.keys(hadith).length} hadith in Urdu — ` +
  `${usage.calls} ${MODEL} call(s), ${usage.input_tokens} in / ${usage.output_tokens} out tokens, $${result.urdu.usage.cost_usd}`);
