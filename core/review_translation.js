#!/usr/bin/env node
// review_translation.js — Stage C for a translated reading (Urdu since 30 Sep 2026 as review_urdu.js,
// any language in core/languages.js since 5 Oct). A second pass reads every block against the imam's
// Arabic, with the English as a second reference, and corrects what a careful bilingual editor
// would: meaning dropped or added, a sentence broken where the imam's pause cut it into two blocks,
// the wrong register for Allah or the Prophet ﷺ, wording a reader would find odd, a bookish word
// where people say an everyday one, a term spelled two ways. What to look for in each language is in
// its file in core/langs/.
//
// Unlike review_blocks.js, which only reports, this stage applies its corrections, so the reading
// stays autonomous — no person edits it. High and medium issues are rewritten; low ones are
// reported only. A second round re-reads the rewritten blocks with their neighbours, so a fix
// cannot break a sentence that runs on into the next block.
//
// Writes the corrected result.<field>.chunk_translations, review_<code>.json (every issue, with each
// block's text before and after), then rebuilds reader_<code>.txt with translate.js (which makes no
// model call when the translations are already there).
//
// Usage: node core/review_translation.js outputs/<folder> --lang ur|bn [--batch 12] [--rounds 2] [--chunks 13,14] [--dry-run]
//   Run after translate.js. --dry-run prints the first request and makes no call.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { REVIEW_MODEL as MODEL, reviewRequest, reviewChunks } from './review_chunks.js';
import { LANGS, langOf, cliArgs } from './languages.js';

// Opus 5.5 at high (core/review_chunks.js): on the hard parts of 25 Sep (1 Oct 2026) its first
// draft needed the fewest fixes; Sonnet 5.5 cost the same in practice (twice the output, more
// review rounds) and slipped.

const args = process.argv.slice(2);
const { opt, folder } = cliArgs(args);
const L = langOf(opt('--lang'));
if (!folder || !existsSync(join(folder, 'result.json')) || !L) {
  console.error(`Usage: node core/review_translation.js outputs/<folder> --lang ${LANGS.map(l => l.code).join('|')} [--batch 12] [--rounds 2] [--dry-run]`);
  process.exit(1);
}
const F = L.field;
const BATCH = args.includes('--batch') ? +opt('--batch') : 12;
const ROUNDS = args.includes('--rounds') ? +opt('--rounds') : 2;
const dryRun = args.includes('--dry-run');
// --chunks 13,14: review only these (translated again after a fix moved their boundaries); the
// earlier review of the other chunks stays in review_<code>.json.
const only = args.includes('--chunks') ? opt('--chunks').split(',').map(Number) : null;

const result = JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8'));
const words = readFileSync(join(folder, 'transcript.txt'), 'utf8').trim().split(/\s+/).filter(Boolean);
const arabic = (result.prose_chunk_map ?? []).map(c => words.slice(c.wordStart, c.wordEnd).join(' '));
const english = result.chunk_translations ?? [];
const texts = [...(result[F]?.chunk_translations ?? [])];
if (!texts.length || texts.length !== arabic.length) {
  console.error(`No ${L.name} to review in ${folder} (run translate.js --lang ${L.code} first)`);
  process.exit(1);
}

const show = i => `### Chunk ${i}\nArabic: ${arabic[i]}\nEnglish: ${english[i] ?? ''}\n${L.name}: ${texts[i]}`;
const field = `corrected_${F}`;
const request = reviewRequest({ system: L.review.system, field, types: L.review.types, texts, show, whole: L.review.whole });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 600_000, maxRetries: 3 });
if (dryRun) {
  const r = request(Array.from({ length: Math.min(BATCH, texts.length) }, (_, k) => k));
  console.log(r.messages[0].content.slice(0, 3000));
  console.log(`\n${texts.length} chunks, ${Math.ceil(texts.length / BATCH)} call(s) in round 1`);
  process.exit(0);
}

const before = [...texts];
const { log, usage } = await reviewChunks({ anthropic, request, field, key: F, texts, batch: BATCH, rounds: ROUNDS, only });

const reviewFile = join(folder, `review_${L.code}.json`);
const earlier = only && existsSync(reviewFile) ? JSON.parse(readFileSync(reviewFile, 'utf8')).log.filter(l => !only.includes(l.chunk)) : [];
log.unshift(...earlier);
const corrected = only ? new Set(log.filter(l => l.applied).map(l => l.chunk)).size : texts.filter((u, i) => u !== before[i]).length;
result[F].chunk_translations = texts;
result[F].review = { model: MODEL, reviewed_at: new Date().toISOString(), rounds: ROUNDS, chunks_corrected: corrected, cost_usd: usage.cost_usd };
writeFileSync(join(folder, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
writeFileSync(reviewFile, JSON.stringify({ model: MODEL, reviewed_at: result[F].review.reviewed_at, chunks: texts.length, corrected, usage, log }, null, 2), 'utf8');

const count = s => log.flatMap(l => l.issues).filter(x => x.severity === s).length;
console.log(`\n${corrected} of ${texts.length} chunks corrected (${count('high')} high, ${count('medium')} medium, ${count('low')} low issue(s)) — ` +
  `${usage.calls} ${MODEL} call(s), $${usage.cost_usd}. Written to ${reviewFile}`);

// The reader shows reader_<code>.txt: rebuild it from the corrected blocks (no model call).
const rebuild = spawnSync(process.execPath, ['core/translate.js', folder, '--lang', L.code], { stdio: 'inherit' });
process.exit(rebuild.status ?? 1);
