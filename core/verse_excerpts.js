#!/usr/bin/env node
// verse_excerpts.js — For a verse card where the imam recited only part of a verse, find the
// matching part of each published translation, so the card can show just what he recited
// (the full verse stays one tap away).
//
// The Arabic part is exact: the recited words are located in the mushaf text by the same
// alignment the page uses for its bolding (public/recited.js). No published translation
// exists for part of a verse, so one model call per khutbah copies out the part of Sahih
// International (and of each other language's translation the khutbah has, core/languages.js) that renders those
// words. A part is kept only when it is a verbatim piece of the published text that starts and
// ends near where the recited words start and end in the Arabic; otherwise the card keeps
// the full verse with the recited part in bold, as before.
//
// Stored as result.verse_excerpts: [{ arabic, surah, ayah, ayah_end, verses: {
//   "<n>": { span: [first, last], en, ur, bn } } }], keyed by the card block's Arabic.
// Answers are cached by request hash (hadith_data/.verse_excerpt_answers.json).
//
// Usage: node core/verse_excerpts.js outputs/<folder>   (also run by reanalyze.js)

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { parseReaderBlocks } from './verify_reader.js';
import { publishedVerseEnglish } from './reader.js';
import { LANGS } from './languages.js';
import '../public/recited.js';

const { recitedSpans } = globalThis.KTRecited;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL = 'claude-sonnet-5-5';
const PRICE_IN = 2 / 1e6, PRICE_OUT = 10 / 1e6; // USD per token, claude-sonnet-5-5
const quran = JSON.parse(readFileSync(join(ROOT, 'node_modules/quran-json/dist/quran.json'), 'utf8'));
const verseAr = (s, a) => quran[s - 1]?.verses?.find(v => v.id === a)?.text ?? '';

const CACHE = join(ROOT, 'hadith_data', '.verse_excerpt_answers.json');
let _cache = null;
const cache = () => (_cache ??= (() => { try { return JSON.parse(readFileSync(CACHE, 'utf8')); } catch { return {}; } })());
const saveCache = () => { try { writeFileSync(CACHE, JSON.stringify(_cache, null, 1)); } catch {} };

// The answer: for each item the English part and the part of each other language the khutbah has.
const schema = codes => ({
  type: 'object',
  properties: {
    excerpts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'integer' }, en: { type: 'string' }, ...Object.fromEntries(codes.map(c => [c, { type: 'string' }])) },
        required: ['id', 'en', ...codes],
        additionalProperties: false,
      },
    },
  },
  required: ['excerpts'],
  additionalProperties: false,
});

const words = t => (t ?? '').split(/\s+/).filter(Boolean);
const trimQuotes = t => (t ?? '').trim().replace(/^["'‘“]+|["'’”]+$/g, '').trim();

// A kept excerpt: a verbatim piece of the published text that starts and ends near where the
// recited words start and end in the Arabic (translations keep the verse's order closely
// enough). Its length alone is not enough: on 2 Oct, for 9:100 recited from its first word,
// the answer was the verse's middle clause ("Allah is pleased with them…"), of a similar length.
function accept(excerpt, full, [from, to]) {
  const x = trimQuotes(excerpt);
  if (!x || !full.includes(x)) return null;
  const n = Math.max(words(full).length, 1);
  const start = words(full.slice(0, full.indexOf(x))).length / n;
  const end = start + words(x).length / n;
  return Math.abs(start - from) <= 0.25 && Math.abs(end - to) <= 0.25 ? x : null;
}

export async function planVerseExcerpts(result, readerRaw, { log = console.log } = {}) {
  const usage = { calls: 0, cached: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 };
  const langs = LANGS.filter(L => result[L.field]?.verses);
  const cards = [];
  for (const b of parseReaderBlocks(readerRaw)) {
    const badge = b.englishParas.map(p => p.match(/^📖\s+.+?\s+(\d+):(\d+)(?:-(\d+))?\s+—/)).find(Boolean);
    if (!badge) continue;
    const s = +badge[1], a = +badge[2], e = +(badge[3] ?? badge[2]);
    const nums = []; for (let n = a; n <= e && nums.length < 25; n++) nums.push(n);
    const texts = nums.map(n => verseAr(s, n));
    if (texts.some(t => !t)) continue;
    const spans = recitedSpans(b.arabic, texts);
    const lens = texts.map(t => words(t).length);
    const whole = spans.map((sp, i) => sp && sp[0] <= 1 && sp[1] >= lens[i] - 2);
    if (!spans.some(Boolean) || whole.every(Boolean)) continue; // nothing to cut
    cards.push({ arabic: b.arabic, s, a, e, nums, texts, spans, lens, whole });
  }

  // The partial verses, one item each, for a single call.
  const items = [];
  for (const c of cards) c.nums.forEach((n, i) => {
    if (!c.spans[i] || c.whole[i]) return;
    const [f, l] = c.spans[i];
    items.push({
      card: c, n, i,
      id: items.length,
      ref: `${c.s}:${n}`,
      arabic: c.texts[i],
      recited: words(c.texts[i]).slice(f, l + 1).join(' '),
      share: (l - f + 1) / c.lens[i],
      at: [f / c.lens[i], (l + 1) / c.lens[i]],
      en: publishedVerseEnglish({ surah_number: c.s, ayah_number: n }, result),
      ...Object.fromEntries(langs.map(L => [L.code, result[L.field].verses[`${c.s}:${n}`] ?? ''])),
    });
  });

  let answers = {};
  if (items.length) {
    const content = [
      'Each item is a Quran verse of which the imam recited only part. Copy out, character for character, the part of the English translation ("en")'
        + langs.map(L => ` and of the ${L.name} translation ("${L.code}", when given)`).join('')
        + ' that translates exactly the recited words: no more, no less. Keep the translator\'s brackets that fall inside that part. If no part fits, give "".',
      JSON.stringify(items.map(it => ({ id: it.id, ref: it.ref, verse: it.arabic, recited: it.recited, en: it.en,
        ...Object.fromEntries(langs.filter(L => it[L.code]).map(L => [L.code, it[L.code]])) })), null, 1),
    ].join('\n\n');
    const hash = createHash('sha1').update(JSON.stringify([MODEL, content])).digest('hex').slice(0, 16);
    let out = cache()[hash];
    if (out) usage.cached++;
    else {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 300_000, maxRetries: 3 });
      const response = await anthropic.messages.create({
        model: MODEL, max_tokens: 16000,
        system: 'You match parts of Quran verses to the same parts of their published translations. Reply with JSON only.',
        output_config: { effort: 'medium', format: { type: 'json_schema', schema: schema(langs.map(L => L.code)) } },
        messages: [{ role: 'user', content }],
      });
      usage.calls++;
      usage.input_tokens += response.usage.input_tokens;
      usage.output_tokens += response.usage.output_tokens;
      try { out = JSON.parse(response.content.find(x => x.type === 'text')?.text ?? ''); } catch { out = null; }
      if (out) { cache()[hash] = out; saveCache(); }
    }
    for (const x of out?.excerpts ?? []) answers[x.id] = x;
  }

  result.verse_excerpts = cards.map(c => {
    const verses = {};
    c.nums.forEach((n, i) => {
      if (!c.spans[i]) return; // not recited
      if (c.whole[i]) { verses[n] = { span: c.spans[i], whole: true }; return; }
      const it = items.find(x => x.card === c && x.n === n);
      const ans = answers[it.id] ?? {};
      verses[n] = {
        span: c.spans[i],
        en: accept(ans.en, it.en, it.at),
        ...Object.fromEntries(langs.map(L => [L.code, it[L.code] ? accept(ans[L.code], it[L.code], it.at) : null])),
      };
      log(`  ${c.s}:${n} recited ${Math.round(it.share * 100)}%: ${verses[n].en ? `“${verses[n].en}”` : 'full verse kept (English)'}` +
        langs.filter(L => it[L.code]).map(L => ` | ${verses[n][L.code] ? `${L.name} part found` : `full verse kept (${L.name})`}`).join(''));
    });
    return { arabic: c.arabic, surah: c.s, ayah: c.a, ayah_end: c.e, verses };
  });
  usage.cost_usd = Math.round((usage.input_tokens * PRICE_IN + usage.output_tokens * PRICE_OUT) * 10000) / 10000;
  return usage;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  const folder = process.argv[2];
  if (!folder || !existsSync(join(folder, 'result.json'))) {
    console.error('Usage: node core/verse_excerpts.js outputs/<folder>');
    process.exit(1);
  }
  const result = JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8'));
  const usage = await planVerseExcerpts(result, readFileSync(join(folder, 'reader.txt'), 'utf8'));
  writeFileSync(join(folder, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log(`✓ ${result.verse_excerpts.length} card(s) with a partly recited verse — ${usage.calls} ${MODEL} call(s), $${usage.cost_usd}`);
}
