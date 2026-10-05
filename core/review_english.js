#!/usr/bin/env node
// review_english.js — Stage C for the English (4 Oct 2026), as review_urdu.js is for the Urdu: a
// second pass reads every English chunk against the imam's Arabic (with the Urdu as a second
// reference when it is there) and applies its corrections. review_blocks.js only reported, so an
// English error stayed on the page: on 2 Oct (Makkah) "بما حل بهم ولا بما جرى لغيرهم" became "what
// befell others, nor what happened to those around them", where the reviewed Urdu had it right.
// It also keeps the Islamic terms the analysis keeps (Iman, Taqwa, Shaytan …), each glossed once.
//
// Writes the corrected result.chunk_translations and review_en.json (every issue, with each
// chunk's English before and after), then rebuilds reader.txt with scripts/reanalyze.js
// --keep-chunks (published quotes re-planned only where the English changed).
//
// Usage: node core/review_english.js outputs/<folder> [--batch 12] [--rounds 2] [--dry-run]
//   Run after pipeline.js, before translate_urdu.js. --dry-run prints the first request.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { REVIEW_MODEL as MODEL, reviewRequest, reviewChunks } from './review_chunks.js';
import { GLOSSED_TERMS, TERMS_SENSE } from './analyze.js';
import { findRestarts, restartNotes } from './arabic.js';

const args = process.argv.slice(2);
const folder = args[0];
if (!folder || !existsSync(join(folder, 'result.json'))) {
  console.error('Usage: node core/review_english.js outputs/<folder> [--batch 12] [--rounds 2] [--dry-run]');
  process.exit(1);
}
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? +args[i + 1] : dflt; };
const BATCH = opt('--batch', 12);
const ROUNDS = opt('--rounds', 2);
const dryRun = args.includes('--dry-run');

const result = JSON.parse(readFileSync(join(folder, 'result.json'), 'utf8'));
const words = readFileSync(join(folder, 'transcript.txt'), 'utf8').trim().split(/\s+/).filter(Boolean);
const arabic = (result.prose_chunk_map ?? []).map(c => words.slice(c.wordStart, c.wordEnd).join(' '));
const english = [...(result.chunk_translations ?? [])];
const urdu = result.urdu?.chunk_translations ?? [];
if (!english.length || english.length !== arabic.length) {
  console.error(`No English to review in ${folder}`);
  process.exit(1);
}

const SYSTEM = `You are the editor of the English reading of an Arabic Friday khutbah (sermon), checking it before it is published for English-speaking worshippers who do not read Arabic. The English was translated from the imam's Arabic chunk by chunk; the chunks are cut at the imam's pauses, so one sentence can run across two chunks. For each chunk you have the imam's Arabic${urdu.length ? ', the Urdu translation (a second, reviewed reference; when it and the Arabic differ, the Arabic wins)' : ''} and the English.

Correct what a careful bilingual scholar-editor would:
- omission: meaning in the Arabic that the English leaves out (a word, a phrase, a command, a name, Quranic words the imam says inside the chunk and what he says about them).
- addition: meaning in the English that the Arabic does not have. Honorifics such as صلى الله عليه وسلم and رضي الله عنه stay in Arabic where the English has them.
- mistranslation: English that says something different from the Arabic, including who did what to whom swapped ("بما حل بهم ولا بما جرى لغيرهم" is "from what befell them, nor from what befell others", not the reverse).
- boundary: read in order, the English of neighbouring chunks does not join into one grammatical sentence where the Arabic runs on (a full stop too early, a sentence left without its verb).
- register: the wrong tone for Allah, the Prophet ﷺ or the Companions.
- unnatural: wording a fluent English reader would find odd or misleading.
- transliteration: an Arabic word left in Latin letters that is not one of the kept terms (مخموم القلب is "a clean heart", not "makhmum").
- terms: these Islamic terms are kept, as the Haramain's own English keeps them, each with its short gloss in parentheses the first time it appears in the khutbah and alone after that: ${GLOSSED_TERMS}. Allah, Quran, Surah, Ayah (plural Ayaat; never "verse"), Hadith, Sunnah, Salah, Zakat, Du'a and Khatib need no gloss. ${TERMS_SENSE}
- inconsistent: one word or name spelled or rendered two ways in the khutbah.
Leave the translator's wording alone where it is correct and natural: change only what is wrong. The transcript can contain speech-recognition slips; do not flag them unless the English follows a slip into a wrong meaning. When the imam repeats a phrase while speaking, rendering it once is correct. Keep quoted verses and hadith in quotation marks. «متفق عليه» after a hadith is "Narrated by al-Bukhari and Muslim". No em dashes or en dashes.

Severity: high, the meaning is wrong or missing; medium, a broken sentence, the wrong register, a transliterated word or a term without its gloss; low, a matter of taste.

For each chunk that needs a change, return the chunk number, its issues, and "corrected_english": the whole corrected English of that chunk. A correction stays within its chunk, except that it may move the few words needed to make a sentence that runs across two chunks read correctly (then correct both chunks). Most chunks need no change: return only those that do.`;

const TYPES = ['omission', 'addition', 'mistranslation', 'boundary', 'register', 'unnatural', 'transliteration', 'terms', 'inconsistent', 'other'];
const show = i => `### Chunk ${i}\nArabic: ${arabic[i]}${urdu.length ? `\nUrdu: ${urdu[i] ?? ''}` : ''}\nEnglish: ${english[i]}`;
const restarts = restartNotes(findRestarts(arabic));
const request = reviewRequest({ system: SYSTEM + (restarts ? `\n\n${restarts}` : ''), field: 'corrected_english', types: TYPES, texts: english, show,
  whole: 'The whole English reading, for consistency of terms and spelling:' });

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 600_000, maxRetries: 3 });
if (dryRun) {
  const r = request(Array.from({ length: Math.min(BATCH, english.length) }, (_, k) => k));
  console.log(r.messages[0].content.slice(0, 3000));
  console.log(`\n${english.length} chunks, ${Math.ceil(english.length / BATCH)} call(s) in round 1`);
  process.exit(0);
}

const before = [...english];
const { log, usage } = await reviewChunks({ anthropic, request, field: 'corrected_english', key: 'english', texts: english, batch: BATCH, rounds: ROUNDS });
const corrected = english.filter((t, i) => t !== before[i]).length;
result.chunk_translations = english;
result.english_review = { model: MODEL, reviewed_at: new Date().toISOString(), rounds: ROUNDS, chunks_corrected: corrected, cost_usd: usage.cost_usd };
writeFileSync(join(folder, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
writeFileSync(join(folder, 'review_en.json'), JSON.stringify({ model: MODEL, reviewed_at: result.english_review.reviewed_at, chunks: english.length, corrected, usage, log }, null, 2), 'utf8');

const count = s => log.flatMap(l => l.issues).filter(x => x.severity === s).length;
console.log(`\n${corrected} of ${english.length} chunks corrected (${count('high')} high, ${count('medium')} medium, ${count('low')} low issue(s)) — ` +
  `${usage.calls} ${MODEL} call(s), $${usage.cost_usd}. Written to ${join(folder, 'review_en.json')}`);

// The reader shows reader.txt: rebuild it from the corrected chunks (the same chunks and cards).
if (!corrected) process.exit(0);
const rebuild = spawnSync(process.execPath, ['scripts/reanalyze.js', folder, '--keep-chunks'], { stdio: 'inherit' });
process.exit(rebuild.status ?? 1);
