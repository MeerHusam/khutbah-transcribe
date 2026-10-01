// quote_swaps.js — Plan which published translation replaces Claude's rendering of each verse
// or hadith the imam quotes inside his prose.
//
// The reader shows a quoted hadith in sunnah.com's English and a quoted verse in Sahih
// International's, so the wording matches the cards beside it. Finding "the same words" by
// English word overlap went wrong in both directions: Muslim 1162a's Ashura clause replaced
// the Arafah clause the imam quoted, Nasa'i 2202 added the Laylat al-Qadr clause he never
// said, Muslim 1141a dropped "and remembrance of Allah". Here each quote gets one model
// call (SWAP_MODEL) that copies out (a) Claude's rendering of the quote and (b) the part
// of the published English that says exactly what the imam said. Both must be verbatim
// substrings of their texts, the model must find no difference in meaning from the imam's
// Arabic (`added` / `left_out` empty), the excerpt must keep every number and name of
// Claude's rendering, and the result must pass
// the same checks the publish gate runs (check_english.js). Otherwise Claude's wording stays
// and the ref is marked `english_swap.status = 'ours'`, which the page labels.
//
// The plan is stored on each ref (`english_swap`) with a hash of its inputs, so re-running
// costs nothing unless the texts changed; buildReaderView only applies it.

import Anthropic from '@anthropic-ai/sdk';
import { createHash } from 'crypto';
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { buildReaderView, publishedVerseEnglish, cachedSunnahPage, applyQuoteSwaps } from './pipeline.js';
import { quoteProblems, droppedWords, skeletonSet, englishKeys, verseText } from './check_english.js';

// Sonnet 5, not Haiku: on the 7 test khutbahs Haiku (at temperature 0) refused 5 correct
// swaps over wording (it called "in the morning" an addition to "من أصبح") and accepted
// Tirmidhi 1639 without its "two eyes" clause; Sonnet 5 got those right. Neither let a
// wrong swap through the checks.
// About $0.02 a khutbah. KT_SWAP_MODEL=claude-haiku-4-5 switches back.
export const SWAP_MODEL = process.env.KT_SWAP_MODEL || 'claude-sonnet-5';
const PRICES = { 'claude-haiku-4-5': [1, 5], 'claude-sonnet-5': [2, 10] }; // USD per 1M tokens in / out
const [PRICE_IN, PRICE_OUT] = (PRICES[SWAP_MODEL] ?? [5, 25]).map(p => p / 1e6);

// Every answer the model gave, by a hash of the exact request, so a rerun on the same texts
// (a copy of the folder, a code change to the checks) never pays again. The checks in
// judgeSwap always run afresh on the stored answer.
const ANSWER_CACHE = join(dirname(fileURLToPath(import.meta.url)), 'hadith_data', '.swap_answers.json');
let _answers = null;
const answers = () => (_answers ??= (() => { try { return JSON.parse(readFileSync(ANSWER_CACHE, 'utf8')); } catch { return {}; } })());
const saveAnswers = () => { try { writeFileSync(ANSWER_CACHE, JSON.stringify(_answers, null, 1), 'utf8'); } catch {} };

const SCHEMA = {
  type: 'object',
  properties: {
    ours: { type: 'string' },
    published: { type: 'string' },
    added: { type: 'array', items: { type: 'string' } },
    left_out: { type: 'array', items: { type: 'string' } },
  },
  required: ['ours', 'published', 'added', 'left_out'],
  additionalProperties: false,
};

const SYSTEM = `You line up two English translations of a quotation from an Arabic Friday sermon (khutbah): our own translation of the imam's words, and a published translation of the hadith or Quran verse he quoted. Reply with JSON only.`;

function prompt({ kind, blockArabic, quoted, english, published, publishedArabic, source }) {
  const what = kind === 'hadith' ? 'a hadith' : 'a Quran verse';
  return [
    `The imam's Arabic (one block of the sermon):\n${blockArabic}`,
    `The words in it that quote ${what}:\n${quoted}`,
    `Our English translation of the whole block:\n${english}`,
    `The published English of that ${kind === 'hadith' ? 'hadith' : 'verse'} (${source}):\n${published}`,
    publishedArabic ? `The published Arabic of that hadith:\n${publishedArabic}` : '',
    `Fill in:
- "ours": copied character for character from our English translation, the part that translates the quoted words. Only the quotation: leave out the framing around it ("The Prophet ﷺ said:", "Allah says:", "Reported by Muslim") and any quote marks around it.
- "published": copied character for character from the published English, the part that translates exactly the words the imam quoted, the same words "ours" covers: it starts where his quote starts and ends where it ends. Leave out the narrator's framing ("Narrated X:", "The Prophet (ﷺ) said", "I heard ... say") and everything the imam did not quote. Empty if no part fits.
Then compare your excerpt "published" (only the excerpt, not the rest of the published text) with the imam's ARABIC words (not with our English):
- "added": each piece of meaning the excerpt has that the imam did not say: a clause, name, number, time, place, condition or person. [] if none.
- "left_out": each piece of meaning the imam said that the excerpt lacks. [] if none.
The two English translations are by different translators, so wording, word order and grammar differ and that is fine: "atone" / "expiate", "invoke a blessing" / "send prayers", "efface" / "dissolve", singular / dual, "There is no god but Allah" / "None has the right to be worshipped but Allah". Words in [square brackets] or (parentheses) are the translator's clarifications: ignore them. List only real differences in meaning; if nothing fits, set "published" to "" and explain in "left_out".
Both excerpts are checked by exact string search, so keep spelling, punctuation and brackets exactly as given.`,
  ].filter(Boolean).join('\n\n');
}

const trimQuotes = s => (s ?? '').trim().replace(/^["'‘“]+|["'’”]+$/g, '').trim();
const countOf = (hay, needle) => { let n = 0, i = -1; while ((i = hay.indexOf(needle, i + 1)) >= 0) n++; return n; };

// Where a ref's published English and Arabic come from.
function sourceOf(kind, ref) {
  if (kind === 'hadith') {
    const m = (ref.link ?? '').match(/sunnah\.com\/([a-z]+):(\w+)/);
    return {
      published: ref.translation ?? '',
      arabic: ref.published_arabic ?? (m ? cachedSunnahPage(m[1], m[2])?.arabic : null) ?? null,
      label: m ? `sunnah.com ${m[1]}:${m[2]}` : 'sunnah.com',
    };
  }
  const end = ref.ayah_number_end ?? ref.ayah_number;
  let arabic = '';
  for (let a = ref.ayah_number; a <= end; a++) arabic += ' ' + verseText(ref.surah_number, a);
  return { published: publishedVerseEnglish(ref), arabic: arabic.trim(), label: `Sahih International ${ref.surah_number}:${ref.ayah_number}${end !== ref.ayah_number ? '-' + end : ''}` };
}

// Decide from the model's answer whether the swap is safe; returns the english_swap record.
export function judgeSwap({ kind, ref, english, published, arabic }, out) {
  const ours = trimQuotes(out.ours), pub = trimQuotes(out.published);
  const no = reason => ({ status: 'ours', reason, ours: ours || null, published: pub || null });
  if (!ours || countOf(english, ours) !== 1) return no('our rendering of the quote was not found exactly once in the block');
  const diffs = [...(out.added ?? []).map(x => `adds ${x}`), ...(out.left_out ?? []).map(x => `lacks ${x}`)];
  if (diffs.length) return no(`the published translation ${diffs.join('; ')}`);
  if (!pub || !published.includes(pub)) return no('the published excerpt is not a verbatim part of the published text');
  const lost = droppedWords(ours, pub);
  if (lost.length) return no(`the excerpt drops ${lost.map(w => `"${w}"`).join(', ')} from our rendering`);
  const swap = { status: 'published', ours, published: pub };
  const after = applyQuoteSwaps(english, [{ english_swap: swap }]);
  const at = after.indexOf('“' + pub.replace(/^["'‘“]+|["'’”]+$/g, '').replace(/[,;:]+$/, ''));
  const quote = after.slice(at + 1, after.indexOf('”', at));
  const problems = quoteProblems({
    quote, before: after.slice(Math.max(0, at - 140), at), claudeSkel: skeletonSet(english),
    src: { kind, ref, keys: englishKeys(published), arabic },
  });
  if (problems.length) return no(`the excerpt ${problems.join('; ')}`);
  return swap;
}

// Plan swaps for every quote in `result` (mutates its refs). Returns usage and cost.
export async function planQuoteSwaps(transcript, result, { client = null, log = console.log } = {}) {
  const quotes = [];
  buildReaderView(transcript, result, { quotes });
  const anthropic = client ?? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 60_000, maxRetries: 3 });
  const usage = { calls: 0, cached: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0, published: 0, ours: 0 };
  const seen = new Set();

  for (const q of quotes) {
    for (const [kind, refs] of [['verse', q.quranRefs], ['hadith', q.hadithRefs]]) {
      for (const ref of refs) {
        const key = `${kind}:${ref.refIndex}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const target = (kind === 'hadith' ? result.hadith_references : result.quran_references)[ref.refIndex];
        const src = sourceOf(kind, ref);
        let swap, hash = null;
        if (!src.published) {
          swap = { status: 'ours', reason: 'no published English for this reference' };
        } else {
          const content = prompt({
            kind, blockArabic: q.arabic, quoted: ref.detected_text, english: q.english,
            published: src.published, publishedArabic: kind === 'hadith' ? src.arabic : null, source: src.label,
          });
          hash = createHash('sha1').update(JSON.stringify([SWAP_MODEL, SYSTEM, content])).digest('hex').slice(0, 16);
          let answer = answers()[hash];
          if (answer) usage.cached++;
          else {
            // Haiku takes temperature 0 for repeatable answers; Sonnet 5 rejects sampling
            // parameters and gets low effort instead.
            const haiku = SWAP_MODEL.includes('haiku');
            const response = await anthropic.messages.create({
              model: SWAP_MODEL,
              max_tokens: 4000,
              ...(haiku ? { temperature: 0 } : {}),
              system: SYSTEM,
              output_config: { ...(haiku ? {} : { effort: 'low' }), format: { type: 'json_schema', schema: SCHEMA } },
              messages: [{ role: 'user', content }],
            });
            usage.calls++;
            usage.input_tokens += response.usage.input_tokens;
            usage.output_tokens += response.usage.output_tokens;
            let out = null;
            try { out = JSON.parse(response.content.find(b => b.type === 'text')?.text); } catch { /* below */ }
            answer = { out, stop_reason: response.stop_reason };
            if (out) { answers()[hash] = answer; saveAnswers(); }
          }
          swap = answer.stop_reason === 'refusal' || !answer.out
            ? { status: 'ours', reason: `no usable answer (${answer.stop_reason})` }
            : judgeSwap({ kind, ref, english: q.english, published: src.published, arabic: src.arabic }, answer.out);
        }
        swap.hash = hash;
        swap.model = SWAP_MODEL;
        target.english_swap = swap;
        usage[swap.status === 'published' ? 'published' : 'ours']++;
        log(`  ${swap.status === 'published' ? '✓' : '·'} ${src.label}: ${swap.status === 'published'
          ? `“${swap.published.slice(0, 70)}${swap.published.length > 70 ? '…' : ''}”`
          : `our wording kept — ${swap.reason}`}`);
      }
    }
  }
  usage.model = SWAP_MODEL;
  usage.cost_usd = usage.input_tokens * PRICE_IN + usage.output_tokens * PRICE_OUT;
  return usage;
}
