#!/usr/bin/env node
// review_urdu.js — Stage C for the Urdu reading (30 Sep 2026). A second pass reads every Urdu
// block against the imam's Arabic, with the English as a second reference, and corrects what a
// careful bilingual editor would: meaning dropped or added, a sentence broken where the imam's
// pause cut it into two blocks, the wrong register for Allah or the Prophet ﷺ, wording an Urdu
// reader would find odd, a bookish word where people say an everyday one (ایمانی بھائیو for
// ایمان والے بھائیو), a term spelled two ways.
//
// Unlike review_blocks.js, which only reports, this stage applies its corrections, so the Urdu
// stays autonomous — no person edits it. High and medium issues are rewritten; low ones are
// reported only. A second round re-reads the rewritten blocks with their neighbours, so a fix
// cannot break a sentence that runs on into the next block.
//
// Writes the corrected result.urdu.chunk_translations, review_ur.json (every issue, with each
// block's Urdu before and after), then rebuilds reader_ur.txt with translate_urdu.js (which
// makes no model call when the translations are already there).
//
// Usage: node urdu/review_urdu.js outputs/<folder> [--batch 12] [--rounds 2] [--chunks 13,14] [--dry-run]
//   Run after translate_urdu.js. --dry-run prints the first request and makes no call.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { REVIEW_MODEL as MODEL, reviewRequest, reviewChunks } from '../core/review_chunks.js';

// Opus 5.5 at high (core/review_chunks.js): on the hard parts of 25 Sep (1 Oct 2026) its first
// draft needed the fewest fixes; Sonnet 5.5 cost the same in practice (twice the output, more
// review rounds) and slipped.

const args = process.argv.slice(2);
const folder = args[0];
if (!folder || !existsSync(join(folder, 'result.json'))) {
  console.error('Usage: node urdu/review_urdu.js outputs/<folder> [--batch 12] [--rounds 2] [--dry-run]');
  process.exit(1);
}
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? +args[i + 1] : dflt; };
const BATCH = opt('--batch', 12);
const ROUNDS = opt('--rounds', 2);
const dryRun = args.includes('--dry-run');
// --chunks 13,14: review only these (translated again after a fix moved their boundaries); the
// earlier review of the other chunks stays in review_ur.json.
const only = args.includes('--chunks') ? args[args.indexOf('--chunks') + 1].split(',').map(Number) : null;

const result = JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8'));
const words = readFileSync(join(folder, 'transcript.txt'), 'utf8').trim().split(/\s+/).filter(Boolean);
const arabic = (result.prose_chunk_map ?? []).map(c => words.slice(c.wordStart, c.wordEnd).join(' '));
const english = result.chunk_translations ?? [];
const urdu = [...(result.urdu?.chunk_translations ?? [])];
if (!urdu.length || urdu.length !== arabic.length) {
  console.error(`No Urdu to review in ${folder} (run translate_urdu.js first)`);
  process.exit(1);
}

const SYSTEM = `You are the editor of the Urdu reading of an Arabic Friday khutbah (sermon), checking it before it is published for Urdu-speaking worshippers in Pakistan and India who do not read Arabic. The Urdu was translated from the imam's Arabic chunk by chunk; the chunks are cut at the imam's pauses, so one sentence can run across two chunks. For each chunk you have the imam's Arabic, the English translation (a second, reviewed reference; when it and the Arabic differ, the Arabic wins) and the Urdu.

Correct what a careful bilingual scholar-editor would:
- omission: meaning in the Arabic that the Urdu leaves out (a word such as "their honour", a phrase, a command, a name).
- addition: meaning in the Urdu that the Arabic does not have. صلی اللہ علیہ وسلم after the Prophet's name and رضی اللہ عنہ / عنہما / عنہم after the Companions (عنہما for two) are Urdu convention, not additions: keep them, and add them where the Urdu names the Prophet ﷺ or a Companion without them.
- mistranslation: Urdu that says something different from the Arabic.
- boundary: read in order, the Urdu of neighbouring chunks does not join into one grammatical sentence with natural word order where the Arabic sentence runs on (a full stop too early, a lost "جس نے", a question split so that it loses its question mark, a sentence left without its verb).
- register: the wrong tone for Allah (He is spoken of in the singular: "جو بادشاہ ہے"; His favour is "احسان فرمایا", never "احسان جتلایا"), for the Prophet ﷺ or the Companions, an honorific doubled, or عنہم for two Companions (the dual is عنہما).
- unnatural: wording an educated Urdu reader would find odd, obscure or misleading (a rare Arabic loan where an everyday word exists; جرأت, courage, for an audacious crime, which is جسارت).
- inconsistent: one word or name spelled or rendered two ways in the khutbah.
- bookish: a literary Arabic or Persian word or construction where a khateeb speaking to ordinary worshippers in Pakistan would use an everyday one (ایمانی بھائیو where people say ایمان والے بھائیو; املاک for جائیداد; مصلحتیں where people say دین و دنیا کے کام). The religious terms and honorifics everyone knows (اللہ تعالیٰ، تقویٰ، نماز، صلی اللہ علیہ وسلم) stay. Do not make it casual: a khutbah stays dignified, never slang, and no English word where an Urdu one is common.
Leave the translator's wording alone where it is correct and natural: change only what is wrong. The transcript can contain speech-recognition slips; do not flag them unless the Urdu follows a slip into a wrong meaning. When the imam repeats a phrase while speaking, rendering it once is correct. Keep quoted verses and hadith in “…”.

Severity: high, the meaning is wrong or missing; medium, a broken sentence, the wrong register, wording a reader would stumble on, or a bookish word a listener would not use; low, a matter of taste.

For each chunk that needs a change, return the chunk number, its issues, and "corrected_urdu": the whole corrected Urdu of that chunk. A correction stays within its chunk, except that it may move the few words needed to make a sentence that runs across two chunks read correctly (then correct both chunks). Most chunks need no change: return only those that do.`;

const show = i => `### Chunk ${i}\nArabic: ${arabic[i]}\nEnglish: ${english[i] ?? ''}\nUrdu: ${urdu[i]}`;

const TYPES = ['omission', 'addition', 'mistranslation', 'boundary', 'register', 'unnatural', 'bookish', 'inconsistent', 'other'];
const request = reviewRequest({ system: SYSTEM, field: 'corrected_urdu', types: TYPES, texts: urdu, show,
  whole: 'The whole Urdu reading, for consistency of terms and spelling:' });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 600_000, maxRetries: 3 });
if (dryRun) {
  const r = request(Array.from({ length: Math.min(BATCH, urdu.length) }, (_, k) => k));
  console.log(r.messages[0].content.slice(0, 3000));
  console.log(`\n${urdu.length} chunks, ${Math.ceil(urdu.length / BATCH)} call(s) in round 1`);
  process.exit(0);
}

const before = [...urdu];
const { log, usage } = await reviewChunks({ anthropic, request, field: 'corrected_urdu', key: 'urdu', texts: urdu, batch: BATCH, rounds: ROUNDS, only });

const earlier = only && existsSync(join(folder, 'review_ur.json'))
  ? JSON.parse(readFileSync(join(folder, 'review_ur.json'), 'utf8')).log.filter(l => !only.includes(l.chunk)) : [];
log.unshift(...earlier);
const corrected = only ? new Set(log.filter(l => l.applied).map(l => l.chunk)).size : urdu.filter((u, i) => u !== before[i]).length;
result.urdu.chunk_translations = urdu;
result.urdu.review = { model: MODEL, reviewed_at: new Date().toISOString(), rounds: ROUNDS, chunks_corrected: corrected, cost_usd: usage.cost_usd };
writeFileSync(join(folder, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
writeFileSync(join(folder, 'review_ur.json'), JSON.stringify({ model: MODEL, reviewed_at: result.urdu.review.reviewed_at, chunks: urdu.length, corrected, usage, log }, null, 2), 'utf8');

const count = s => log.flatMap(l => l.issues).filter(x => x.severity === s).length;
console.log(`\n${corrected} of ${urdu.length} chunks corrected (${count('high')} high, ${count('medium')} medium, ${count('low')} low issue(s)) — ` +
  `${usage.calls} ${MODEL} call(s), $${usage.cost_usd}. Written to ${join(folder, 'review_ur.json')}`);

// The reader shows reader_ur.txt: rebuild it from the corrected blocks (no model call).
const rebuild = spawnSync(process.execPath, ['urdu/translate_urdu.js', folder], { stdio: 'inherit' });
process.exit(rebuild.status ?? 1);
