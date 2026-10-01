#!/usr/bin/env node
// review_blocks.js — A second model reads every block of a khutbah's reader and flags what a
// careful bilingual reader would: meaning Claude's translation dropped or added (the 21 Aug
// block "يا أيها الذين آمنوا اتقوا الله" lost "fear Allah"), a verse or hadith card that does
// not match the words it sits on, a swapped-in published quote that reads wrong.
//
// It only reports. Nothing in the output folder is changed except review.json, which lists
// the flags for a person to check.
//
// Usage: node core/review_blocks.js outputs/<folder> [--batch 10] [--effort medium|high] [--dry-run]
//   --dry-run   print the first request and the token estimate, make no call

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parseReaderBlocks } from './verify_reader.js';
import { publishedVerseEnglish } from './reader.js';

const MODEL = 'claude-sonnet-5';
const PRICE_IN = 2 / 1e6, PRICE_OUT = 10 / 1e6; // USD per token, claude-sonnet-5

const args = process.argv.slice(2);
const folder = args[0];
if (!folder || !existsSync(join(folder, 'reader.txt'))) {
  console.error('Usage: node core/review_blocks.js outputs/<folder> [--batch 10] [--dry-run]');
  process.exit(1);
}
const BATCH = args.includes('--batch') ? +args[args.indexOf('--batch') + 1] : 10;
const dryRun = args.includes('--dry-run');
const effort = args.includes('--effort') ? args[args.indexOf('--effort') + 1] : 'high';

const result = JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8'));
const blocks = parseReaderBlocks(readFileSync(join(folder, 'reader.txt'), 'utf8'));
const quran = JSON.parse(readFileSync(new URL('../node_modules/quran-json/dist/quran.json', import.meta.url), 'utf8'));
const verseAr = (s, a) => quran.find(x => x.id === s)?.verses?.find(v => v.id === a)?.text ?? '';

const badgeRe = /^(📖|📑)\s+(.+?)\s+(\d+):(\d+)(?:-(\d+))?\s+—/;
const hadithRe = /^📚\s+Hadith\s+[·•]\s*Narrator:\s*(.*?)\s+[·•]\s+Collection:\s*(.*)$/;

// What the page shows for one block, written out for the reviewer.
function describe(b, i) {
  const prose = b.englishParas.filter(p => !/^(📖|📑|📚|❝)/.test(p)).join(' ');
  const lines = [`### Block ${i}`, `Arabic (as the imam said it): ${b.arabic}`];
  const cards = [];
  for (const p of b.englishParas) {
    const q = p.match(badgeRe);
    if (q) {
      const [, mark, name, s, a, e] = q;
      const ref = { surah_number: +s, ayah_number: +a, ayah_number_end: e ? +e : undefined };
      let ar = '';
      for (let k = +a; k <= +(e ?? a); k++) ar += ' ' + verseAr(+s, k);
      cards.push(`${mark === '📖' ? 'Verse card (the block IS the recitation; the page shows the verse text below instead of the imam\'s words)' : 'Inline verse badge (a verse quoted inside the imam\'s sentence)'}: ${name} ${s}:${a}${e ? '-' + e : ''}\n  Verse Arabic: ${ar.trim()}\n  Sahih International: ${publishedVerseEnglish(ref)}`);
      continue;
    }
    const h = p.match(hadithRe);
    if (h) {
      const ref = (result.hadith_references ?? []).find(r => String(r.narrator ?? 'unknown').trim() === h[1].trim()
        && String(r.collection ?? 'unknown').trim() === h[2].trim());
      cards.push(`Hadith badge: narrator ${h[1]}, ${h[2]}${ref?.link ? ` (${ref.link})` : ''}` +
        (ref?.detected_text ? `\n  The imam's quoted words: ${ref.detected_text}` : '') +
        (ref?.published_arabic ? `\n  Published Arabic: ${ref.published_arabic.slice(0, 700)}` : '') +
        (ref?.translation ? `\n  Published English (sunnah.com): ${ref.translation.slice(0, 700)}` : '') +
        (ref?.english_swap ? `\n  The quote's English in the block is ${ref.english_swap.status === 'published' ? 'the published excerpt' : 'our own translation (labelled on the page)'}` : ''));
    }
  }
  lines.push(`English shown: ${prose || '(none: the card supplies it)'}`);
  if (cards.length) lines.push(...cards);
  return lines.join('\n');
}

const SYSTEM = `You review the bilingual reader of an Arabic Friday khutbah (sermon) for errors before it is shown to worshippers who do not read Arabic. Each block is the imam's Arabic, the English shown under it, and any Quran or hadith card attached to it. Blocks can start or end mid-sentence; the previous block is given for context.

Flag only real problems a careful bilingual scholar would correct:
- omission: meaning in the Arabic that the English leaves out (a phrase, a command such as "fear Allah", a name, a condition). Not stylistic compression, repeated words the imam restarted, or honorifics rendered once.
- addition: meaning in the English that the Arabic does not have.
- mistranslation: English that says something different from the Arabic.
- wrong_card: a verse card or badge whose verse is not what the imam recited or quoted there; a hadith badge whose hadith does not match the imam's quoted words, or whose narrator/collection contradicts what the imam said.
- broken_quote: a quotation that reads wrongly in its sentence (doubled "said", cut mid-sentence, framing inside the quote).
The transcript may contain speech-recognition slips; do not flag those unless the English follows a slip into a wrong meaning. Verse cards replace the imam's words with the canonical verse on the page, so a card block's English is the Sahih International translation, not a translation of the block. Judge meaning, not wording. When in doubt, do not flag. Most blocks have no problem: an empty list is the usual answer.`;

const SCHEMA = {
  type: 'object',
  properties: {
    flags: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          block: { type: 'integer' },
          type: { type: 'string', enum: ['omission', 'addition', 'mistranslation', 'wrong_card', 'broken_quote', 'other'] },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          arabic: { type: 'string' },
          english: { type: 'string' },
          problem: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['block', 'type', 'severity', 'arabic', 'english', 'problem', 'fix'],
        additionalProperties: false,
      },
    },
  },
  required: ['flags'],
  additionalProperties: false,
};

function request(from, to) {
  const ctx = from > 0 ? `Previous block, for context only (do not review it):\n${describe(blocks[from - 1], from - 1)}\n\n` : '';
  const body = blocks.slice(from, to).map((b, k) => describe(b, from + k)).join('\n\n');
  return {
    model: MODEL,
    max_tokens: 16000,
    system: SYSTEM,
    output_config: { effort, format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: `${ctx}Review blocks ${from} to ${to - 1}. For each flag, quote the exact Arabic words ("arabic") and the English words ("english") concerned, say what is wrong ("problem") and what the English or card should be ("fix").\n\n${body}` }],
  };
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 300_000, maxRetries: 3 });
if (dryRun) {
  const r = request(0, Math.min(BATCH, blocks.length));
  const chars = blocks.reduce((n, b, i) => n + describe(b, i).length, 0);
  console.log(r.messages[0].content.slice(0, 3000));
  console.log(`\n${blocks.length} blocks, ~${Math.round(chars / 3)} tokens of block text, ${Math.ceil(blocks.length / BATCH)} calls`);
  process.exit(0);
}

const flags = [];
const usage = { calls: 0, input_tokens: 0, output_tokens: 0 };
for (let from = 0; from < blocks.length; from += BATCH) {
  const to = Math.min(from + BATCH, blocks.length);
  const response = await anthropic.messages.create(request(from, to));
  usage.calls++;
  usage.input_tokens += response.usage.input_tokens;
  usage.output_tokens += response.usage.output_tokens;
  if (response.stop_reason === 'refusal') { console.log(`  blocks ${from}-${to - 1}: refused`); continue; }
  let out = null;
  try { out = JSON.parse(response.content.find(b => b.type === 'text')?.text ?? ''); } catch { /* below */ }
  if (!out) { console.log(`  blocks ${from}-${to - 1}: no usable answer (${response.stop_reason})`); continue; }
  const mine = out.flags.filter(f => f.block >= from && f.block < to);
  flags.push(...mine);
  console.log(`  blocks ${from}-${to - 1}: ${mine.length} flag(s)`);
}
usage.cost_usd = Math.round((usage.input_tokens * PRICE_IN + usage.output_tokens * PRICE_OUT) * 10000) / 10000;

const order = { high: 0, medium: 1, low: 2 };
flags.sort((a, b) => order[a.severity] - order[b.severity] || a.block - b.block);
writeFileSync(join(folder, 'review.json'), JSON.stringify({ model: MODEL, effort, reviewed_at: new Date().toISOString(), blocks: blocks.length, usage, flags }, null, 2));
console.log(`\n${flags.length} flag(s) over ${blocks.length} blocks — ${usage.calls} ${MODEL} call(s), ${usage.input_tokens} in / ${usage.output_tokens} out tokens, $${usage.cost_usd}`);
for (const f of flags) console.log(`\n[${f.severity}] block ${f.block} · ${f.type}\n  AR: ${f.arabic}\n  EN: ${f.english}\n  ${f.problem}\n  fix: ${f.fix}`);
console.log(`\nWritten to ${join(folder, 'review.json')}`);
