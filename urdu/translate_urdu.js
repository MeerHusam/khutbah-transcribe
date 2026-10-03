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
//  - In Short, Summary, and the narrators' names in Urdu, and each Urdu hadith cut to start at
//    the Companion (its published text opens with the whole chain of narrators); one call.
// Writes result.urdu and reader_ur.txt (the reader with Urdu in place of English).
//
// Usage: node urdu/translate_urdu.js outputs/<folder> [--batch 12] [--retranslate] [--chunks 13,14] [--dry-run]
//   Block translations already in result.urdu are kept unless --retranslate (all) or --chunks
//   (those); verses and hadith are always fetched again (free).

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { buildReaderView } from '../core/reader.js';
import { normalizeArabic } from '../core/arabic.js';


// Opus 5.5 at high: on the hard parts of 25 Sep (1 Oct 2026) its first draft needed the fewest
// fixes; Sonnet 5.5 cost the same in practice (twice the output, more review rounds) and slipped.
const MODEL = 'claude-opus-5-5';
const PRICE_IN = 4 / 1e6, PRICE_OUT = 20 / 1e6; // USD per token, claude-opus-5-5
// A request the model declines (the du'a names enemies: Houthis, Zionists) is re-run on the
// fallback model the API picks for that kind of refusal, instead of leaving blocks untranslated.
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
export const QURAN_UR = {
  edition: 'urd-muhammadjunagar', // editions.json lists it as urd_muhammadjunagar; paths use '-'
  name: 'Muhammad Junagarhi',
  placeholder: true, // not chosen yet: Junagarhi, Jalandhry or Maududi is Meer's call
};

const args = process.argv.slice(2);
const folder = args[0];
if (!folder || !existsSync(join(folder, 'result.json'))) {
  console.error('Usage: node urdu/translate_urdu.js outputs/<folder> [--batch 12] [--dry-run]');
  process.exit(1);
}
const BATCH = args.includes('--batch') ? +args[args.indexOf('--batch') + 1] : 12;
const dryRun = args.includes('--dry-run');

const result = JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8'));
const transcript = readFileSync(join(folder, 'transcript.txt'), 'utf8').trim();
const words = transcript.split(/\s+/).filter(Boolean);
const chunks = (result.prose_chunk_map ?? []).map(c => words.slice(c.wordStart, c.wordEnd).join(' '));
const quran = JSON.parse(readFileSync(new URL('../node_modules/quran-json/dist/quran.json', import.meta.url), 'utf8'));

const SYSTEM = `You translate an Arabic Friday khutbah (sermon) into Urdu for worshippers in Pakistan and India who do not understand Arabic. The text comes in numbered chunks, cut at pauses, so a chunk can start or end in the middle of a sentence.

- Translate every chunk completely and faithfully: every command, phrase, name and condition the imam says ("اتقوا الله" must appear as its Urdu). Do not summarise, explain or add.
- Translate exactly the words of each chunk, so that the chunks read on from one another; never move words into a neighbouring chunk.
- Write the Urdu a good khateeb in Pakistan speaks from the minbar: respectful and religious, but in the words ordinary worshippers use at home and in the bazaar, so that someone with no schooling in Arabic or Persian follows every sentence when it is read aloud. Keep the religious terms and honorifics everyone knows (اللہ تعالیٰ، نبی کریم صلی اللہ علیہ وسلم، رضی اللہ عنہ، تقویٰ، نماز، زکوٰۃ). For everything else choose the everyday word over the bookish Arabic or Persian one: ایمان والے بھائیو (not ایمانی بھائیو) for إخوة الإيمان, جائیداد (not املاک) for property, دین و دنیا کے کام (not مصلحتیں) for مصالح الدين والدنيا. It stays a khutbah: dignified, never slang, and no English word where an Urdu one is common.
- Put a Quran verse or a hadith that the imam quotes in quotation marks “…”, translated faithfully.
- «متفق عليه» after a hadith is always «اسے بخاری اور مسلم نے روایت کیا ہے».
- The transcript may have speech-recognition slips; translate the evident meaning.

Chunks are cut at the imam's pauses, so one sentence often runs across two chunks. You are shown the chunks before and after as context: read them to see where each sentence really ends, and make the Urdu of neighbouring chunks join into one grammatical sentence when read in order. Never end a chunk with a full stop (۔) or begin it as a new sentence when the Arabic sentence carries on into the next chunk; a question that spans chunks keeps its question mark at its true end. Keep natural Urdu word order across the join: never invert a clause to fit the cut ("اور چونکہ یہ / نعمت بہت عظیم ہے", not "اور چونکہ بہت بڑی ہے / یہ عظیم نعمت").

Register and wording, as in a published Urdu khutbah:
- Allah is spoken of in the singular: "جو بادشاہ ہے، احسان فرمانے والا ہے" (not "ہیں"). His favours are "احسان فرمایا" (never "احسان جتلایا", which sounds like taunting).
- The Prophet ﷺ, Companions and scholars in the respectful plural, with the honorific once: do not add رضی اللہ عنہم where a du'a already asks Allah to be pleased with them ("…سے راضی ہو جا").
- Prefer words an ordinary Urdu reader knows over rare Arabic loans: حکمران for ولاة الأمر, عمرہ کرنے والے for المعتمرون, جسارت for an audacious crime (جرأت is courage), مقدس مقامات for المقدسات.
- Keep one spelling for a word throughout (e.g. سیکیورٹی).
- When the imam repeats a phrase while speaking (a restart, "ليأمن الناس في بيوتهم ليأمن الناس في بيوتهم"), translate it once.
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
  // What comes next, so a sentence cut at the last chunk's pause is not closed too early.
  const last = indices.at(-1);
  const after = [last + 1, last + 2].filter(i => i < chunks.length)
    .map(i => `(${i}, context only) ${chunks[i]}`).join('\n');
  const content = (context ? `Context, already translated:\n${context}\n\n` : '') +
    `Translate chunks ${indices.join(', ')}:\n` + indices.map(i => `(${i}) ${chunks[i]}`).join('\n') +
    (after ? `\n\nWhat follows, for context only (do not translate):\n${after}` : '');
  if (dryRun) { console.log(content.slice(0, 1500)); return {}; }
  const response = await anthropic.beta.messages.create({
    model: MODEL, max_tokens: 16000, system: SYSTEM, ...FALLBACK,
    output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
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
// Only the chunks without an Urdu translation are translated (all of them on a first run, or
// with --retranslate); --chunks 13,14 translates those again, after a fix moved their boundaries.
const only = args.includes('--chunks') ? args[args.indexOf('--chunks') + 1].split(',').map(Number) : [];
const kept = result.urdu?.chunk_translations;
const reuse = !args.includes('--retranslate') && kept?.length === chunks.length;
const urdu = reuse ? kept.map((t, i) => (only.includes(i) ? null : t || null)) : new Array(chunks.length).fill(null);
const todo = urdu.map((t, i) => (t ? null : i)).filter(i => i !== null);
if (reuse) console.log(`  keeping ${chunks.length - todo.length} of the ${chunks.length} Urdu block translations already in result.json`);
for (let k = 0; k < todo.length;) {
  // A batch: up to BATCH chunks in a row, so the chunks around it are the context.
  const idx = [todo[k++]];
  while (k < todo.length && idx.length < BATCH && todo[k] === idx.at(-1) + 1) idx.push(todo[k++]);
  Object.assign(urdu, await translate(idx, urdu));
  if (dryRun) process.exit(0);
  // Anything missing is asked for again on its own, never left for a neighbour to fill.
  for (const i of idx) if (!urdu[i]) Object.assign(urdu, await translate([i], urdu));
  console.log(`  chunks ${idx[0]}-${idx.at(-1)}: ${idx.filter(i => urdu[i]).length}/${idx.length}`);
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
// Candidates come from the local ara-* corpus (same numbering as urd-*). A collection that is
// not downloaded (Tirmidhi) is tried by number on the same CDN: the number and its
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
    const d = await getJson(`https://cdn.jsdelivr.net/gh/fawazahmed0/hadith-api@1/editions/urd-${slug}/${best.number}.json`);
    hadith[`${slug}:${num}`] = { text: d.hadiths?.[0]?.text?.normalize('NFKC') ?? null, edition: `urd-${slug}`, number: best.number, match: +best.score.toFixed(2) };
  } catch (e) { console.log(`  ⚠ ${slug}:${num}: ${e.message}`); }
}

// ── In Short, Summary, narrator names, and each hadith without its chain ──────
// One call. The published Urdu hadith opens with the whole chain of narrators ("ہمیں حدیث
// بیان کی یعقوب بن ابراہیم نے، ان کو…"); the card starts at the Companion instead, cut from the
// published text itself: accepted only as an exact substring, else the full text stays.
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
  },
  required: ['share_summary', 'summary', 'hadith'],
  additionalProperties: false,
};
let extras = !args.includes('--retranslate') && result.urdu?.summary ? {
  share_summary: result.urdu.share_summary, summary: result.urdu.summary,
  narrators: result.urdu.narrators ?? {},
} : null;
if (!extras) {
  const hadithList = (result.hadith_references ?? []).map(h => {
    const m = (h.link ?? '').match(/sunnah\.com\/([a-z]+):(\d+)/);
    const key = m ? `${m[1]}:${m[2]}` : null;
    return { key, narrator: h.narrator, collection: h.collection, urdu: key && hadith[key]?.text };
  }).filter(h => h.key);
  const response = await anthropic.beta.messages.create({
    model: MODEL, max_tokens: 16000, ...FALLBACK,
    system: 'You prepare the Urdu edition of a khutbah reader for worshippers in Pakistan and India. Reply with JSON only.',
    output_config: { effort: 'high', format: { type: 'json_schema', schema: EXTRAS_SCHEMA } },
    messages: [{ role: 'user', content: [
      `Translate into the everyday, respectful Urdu a khateeb in Pakistan speaks: the religious terms and honorifics everyone knows (اللہ تعالیٰ، نبی کریم صلی اللہ علیہ وسلم، رضی اللہ عنہ), otherwise the words ordinary worshippers use, not bookish Urdu:\n"share_summary" (a two-sentence WhatsApp message): ${result.share_summary ?? ''}\n"summary": ${result.summary ?? ''}`,
      `For each hadith below, give "narrator": the Companion's name as Urdu readers know it, with رضی اللہ عنہ / عنہا (for a family chain such as "Amr ibn Shu'ayb from his father from his grandfather", write that chain in Urdu). And give "from_companion": copied character for character from its Urdu text, the part that starts where the Companion (or the Prophet ﷺ, if the Companion is not named) is first mentioned, leaving out the chain of narrators before; the whole text if it already starts there, "" if it has no Urdu text.`,
      JSON.stringify(hadithList, null, 1),
    ].join('\n\n') }],
  });
  usage.calls++;
  usage.input_tokens += response.usage.input_tokens;
  usage.output_tokens += response.usage.output_tokens;
  const out = JSON.parse(response.content.find(b => b.type === 'text')?.text ?? '{}');
  extras = { share_summary: out.share_summary, summary: out.summary, narrators: {} };
  for (const x of out.hadith ?? []) {
    extras.narrators[x.key] = x.narrator;
    const full = hadith[x.key]?.text;
    const cut = (x.from_companion ?? '').trim();
    if (full && cut && full.includes(cut) && cut.length > 20) hadith[x.key].from_companion = cut;
  }
}
for (const [key, h] of Object.entries(hadith)) { // a re-fetch keeps the earlier cut when it still fits
  const old = result.urdu?.hadith?.[key]?.from_companion;
  if (!h.from_companion && old && h.text?.includes(old)) h.from_companion = old;
  // Jami' at-Tirmidhi's Urdu edition follows each hadith with the Imam's grading and notes
  // ("۱؎ … امام ترمذی کہتے ہیں: یہ حدیث حسن غریب ہے"); the card shows the hadith only. The cut
  // stays an exact prefix of the published text.
  const shown = h.from_companion || h.text;
  const end = shown?.search(/\s*۱؎|\s*امام ترمذی کہتے ہیں/) ?? -1;
  if (end > 20) h.from_companion = shown.slice(0, end);
}

// Surah names for the Urdu verse badges (the Arabic names Urdu readers use).
const surahs = {};
for (const q of result.quran_references ?? []) if (q.matched) surahs[q.surah_number] = quran[q.surah_number - 1]?.name;

const prevCost = reuse ? (result.urdu.usage?.cost_usd ?? 0) : 0;
result.urdu = {
  model: MODEL, created_at: reuse ? result.urdu.created_at : new Date().toISOString(),
  chunk_translations: urdu,
  share_summary: extras.share_summary, summary: extras.summary, narrators: extras.narrators, surahs,
  verses, verse_source: QURAN_UR,
  hadith, hadith_source: 'fawazahmed0/hadith-api (urd-*)',
  usage: { calls: usage.calls + (reuse ? result.urdu.usage?.calls ?? 0 : 0),
    input_tokens: usage.input_tokens + (reuse ? result.urdu.usage?.input_tokens ?? 0 : 0),
    output_tokens: usage.output_tokens + (reuse ? result.urdu.usage?.output_tokens ?? 0 : 0),
    input_usd: Math.round(usage.input_tokens * PRICE_IN * 10000) / 10000,
    output_usd: Math.round(usage.output_tokens * PRICE_OUT * 10000) / 10000,
    cost_usd: Math.round((prevCost + usage.input_tokens * PRICE_IN + usage.output_tokens * PRICE_OUT) * 10000) / 10000 },
};

// The Urdu reader: the same blocks, Urdu in place of English. Published English excerpts
// are not carried over; a hadith card shows its Urdu edition's text.
const urResult = {
  ...result,
  chunk_translations: urdu,
  quran_references: (result.quran_references ?? []).map(({ english_swap, ...r }) => r),
  hadith_references: (result.hadith_references ?? []).map(({ english_swap, ...r }) => {
    const m = (r.link ?? '').match(/sunnah\.com\/([a-z]+):(\d+)/);
    const ur = m && hadith[`${m[1]}:${m[2]}`];
    return { ...r, translation: (ur && (ur.from_companion || ur.text)) || null };
  }),
};
writeFileSync(join(folder, 'reader_ur.txt'), buildReaderView(transcript, urResult, { untranslated: '(ترجمہ دستیاب نہیں)' }), 'utf8');
writeFileSync(join(folder, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
console.log(`✓ ${urdu.length} blocks, ${Object.keys(verses).length} verses, ${Object.keys(hadith).length} hadith in Urdu — ` +
  `${usage.calls} ${MODEL} call(s) this run, ${usage.input_tokens} in / ${usage.output_tokens} out tokens, ` +
  `$${Math.round((usage.input_tokens * PRICE_IN + usage.output_tokens * PRICE_OUT) * 10000) / 10000} (total $${result.urdu.usage.cost_usd})`);
