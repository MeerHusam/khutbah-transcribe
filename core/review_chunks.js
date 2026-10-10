// review_chunks.js — the review loop the translation reviews share (core/review_translation.js since
// 30 Sep 2026, core/review_english.js since 4 Oct 2026). An editor model reads each chunk's
// translation against the imam's Arabic, in batches, and returns the whole corrected text of each
// chunk that needs a change. High and medium issues are applied; low ones are only logged. A
// second round re-reads the rewritten chunks with their neighbours, so a fix cannot break a
// sentence that runs on into the next chunk.

import { geminiJSON, geminiPrice } from './gemini_text.js';

export const REVIEW_MODEL = 'claude-opus-5-5';
const PRICE_IN = 4 / 1e6, PRICE_OUT = 20 / 1e6; // USD per token, claude-opus-5-5
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

// The Urdu and Bengali reviews on Gemini 3.8 Flash at LOW thinking since 11 Oct 2026
// (reports/reviewer-test-2026-10-10, four khutbahs judged blind): 32 corrections that helped against
// Opus's 20, and 7 small slips, mostly "O Allah" repeated across a block boundary, which
// repeatsNeighbour now refuses; about $0.03 a review against Opus's $0.35. The English review stays
// on Opus (REVIEW_MODEL): it made no slip there, and the other languages and the voices are made from
// the English. A batch Gemini does not answer goes to Opus. KT_REVIEW_MODEL=claude-opus-5-5 switches back.
export const TRANSLATION_REVIEW_MODEL = process.env.KT_REVIEW_MODEL || 'gemini-3.8-flash';
// At LOW thinking a review call wrote 400 to 2,000 tokens in the test.
const GEMINI_MAX_OUT = 16384;
const opusCost = u => ((u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)) * PRICE_IN
  + (u.cache_read_input_tokens ?? 0) * PRICE_IN * 0.1 + (u.output_tokens ?? 0) * PRICE_OUT;
const chars = p => p.system.map(b => b.text).join('').length + p.messages[0].content.length;

// A client for reviewChunks that sends each request to `model`, Gemini first and Opus for a batch it
// does not answer. A hard cap per run (KT_REVIEW_CAP, default $2): a call whose worst case (a token a
// character in, all of its output limit out, Gemini's twice) would pass it throws.
export function reviewClient({ anthropic, model, cap = +(process.env.KT_REVIEW_CAP || 2), gemini = geminiJSON }) {
  let spent = 0;
  const guard = worst => {
    if (spent + worst > cap) throw new Error(`review cap: $${spent.toFixed(3)} spent, one call could cost $${worst.toFixed(3)}, the cap is $${cap} (KT_REVIEW_CAP)`);
  };
  return { beta: { messages: { create: async params => {
    let prior = null;
    if (model !== REVIEW_MODEL) {
      const [pin, pout] = geminiPrice(model);
      guard((chars(params) * pin + 2 * GEMINI_MAX_OUT * pout) / 1e6);
      const g = await gemini({ model, system: params.system.map(b => b.text).join('\n\n'), content: params.messages[0].content,
        schema: params.output_config.format.schema, maxOutputTokens: GEMINI_MAX_OUT, thinkingLevel: 'LOW' });
      spent += g.cost_usd;
      if (g.ok) return { model, content: [{ type: 'text', text: JSON.stringify(g.json) }], cost_usd: g.cost_usd, stop_reason: 'end_turn',
        usage: { input_tokens: g.usage.input_tokens, output_tokens: g.usage.output_tokens } };
      prior = { model, calls: g.usage.calls, input_tokens: g.usage.input_tokens, output_tokens: g.usage.output_tokens, cost_usd: g.cost_usd };
      console.log(`  ${model}: ${g.why}; asking ${REVIEW_MODEL}`);
    }
    guard(chars(params) * PRICE_IN + params.max_tokens * PRICE_OUT);
    const r = await anthropic.beta.messages.create(params);
    spent += opusCost(r.usage);
    return prior ? { ...r, prior } : r;
  } } } };
}

// Whether a correction adds, at its start, words the chunk before ends with, or at its end words the
// chunk after starts with, that the text did not have: the page would show them twice (the reviewer
// test: Gemini added "O Allah" after a block ending in it, four times in four khutbahs). A move, where
// the neighbour's copy was taken out first, passes.
const tokens = t => (t ?? '').toLowerCase().normalize('NFKC').match(/[\p{L}\p{M}\p{N}]+/gu) ?? [];
export function repeatsNeighbour(before, after, prev, next) {
  const a = tokens(after), b = tokens(before), p = tokens(prev), n = tokens(next);
  for (let k = Math.min(8, a.length); k >= 2; k--) {
    const head = a.slice(0, k).join(' '), tail = a.slice(-k).join(' ');
    if (p.length >= k && p.slice(-k).join(' ') === head && b.slice(0, k).join(' ') !== head) return true;
    if (n.length >= k && n.slice(0, k).join(' ') === tail && b.slice(-k).join(' ') !== tail) return true;
  }
  return false;
}

// The answer: for each chunk that needs a change, its issues and `field` (its corrected text).
export function reviewSchema(field, types) {
  return {
    type: 'object',
    properties: {
      chunks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            chunk: { type: 'integer' },
            issues: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: types },
                  severity: { type: 'string', enum: ['high', 'medium', 'low'] },
                  problem: { type: 'string' },
                },
                required: ['type', 'severity', 'problem'],
                additionalProperties: false,
              },
            },
            [field]: { type: 'string' },
          },
          required: ['chunk', 'issues', field],
          additionalProperties: false,
        },
      },
    },
    required: ['chunks'],
    additionalProperties: false,
  };
}

// One request for chunks `indices`: the whole translation for consistency (the same for every
// batch, so it is cached), then those chunks in full, with a neighbour on each side for sentences
// that run across. texts: the translation, one string per chunk (corrected in place by
// reviewChunks); show(i): chunk i as the editor sees it, read from `texts`, so a later round sees
// the corrections; whole: the label above the whole translation.
export function reviewRequest({ system, field, types, whole, texts, show }) {
  const schema = reviewSchema(field, types);
  return indices => {
    const set = new Set(indices);
    const before = indices[0] - 1, after = indices.at(-1) + 1;
    const ctx = i => (i >= 0 && i < texts.length && !set.has(i) ? `${show(i)}\n(context only: do not review)` : '');
    const body = [ctx(before), ...indices.map(show), ctx(after)].filter(Boolean).join('\n\n');
    return {
      model: REVIEW_MODEL, max_tokens: 32000, ...FALLBACK,
      system: [
        { type: 'text', text: system },
        { type: 'text', text: `${whole}\n${texts.map((u, i) => `(${i}) ${u}`).join('\n')}`, cache_control: { type: 'ephemeral' } },
      ],
      output_config: { effort: 'high', format: { type: 'json_schema', schema } },
      messages: [{ role: 'user', content: `Review chunks ${indices.join(', ')}.\n\n${body}` }],
    };
  };
}

// The words `after` no longer has (at least 5) are, all but a fifth, words of a neighbouring
// chunk's text: a duplicate taken out (the rest of the chunk may be reworded as well).
const wordsOf = t => (t ?? '').toLowerCase().normalize('NFKC').match(/[\p{L}\p{N}]{3,}/gu) ?? [];
export function removesNeighbourText(before, after, neighbours) {
  const kept = wordsOf(after);
  if (!kept.length) return false;
  const left = new Map();
  for (const w of kept) left.set(w, (left.get(w) ?? 0) + 1);
  const cut = wordsOf(before).filter(w => (left.get(w) ?? 0) > 0 ? (left.set(w, left.get(w) - 1), false) : true);
  if (cut.length < 5) return false;
  return neighbours.some(n => { const there = new Set(wordsOf(n)); return cut.filter(w => there.has(w)).length >= 0.8 * cut.length; });
}

// Review `texts` (see reviewRequest) in batches and rounds. Returns { log, usage }; each log entry
// has `${key}_before` and `${key}_after` (null when not applied).
export async function reviewChunks({ anthropic, request, field, key, texts, batch, rounds, only }) {
  const usage = { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cost_usd: 0, by_model: {} };
  const count = (model, u, cost) => {
    const t = (usage.by_model[model] ??= { calls: 0, input_tokens: 0, output_tokens: 0, cost_usd: 0 });
    t.calls += u.calls ?? 1;
    t.input_tokens += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    t.output_tokens += u.output_tokens ?? 0;
    t.cost_usd += cost;
    usage.cost_usd += cost;
  };
  const log = [];
  let toReview = only ?? texts.map((_, i) => i);
  for (let round = 1; round <= rounds && toReview.length; round++) {
    const changed = new Set();
    for (let k = 0; k < toReview.length; k += batch) {
      const indices = toReview.slice(k, k + batch);
      const response = await anthropic.beta.messages.create(request(indices));
      // Which model answered (a Gemini answer says so; an Anthropic one names its model), and a Gemini
      // call that went unanswered before Opus took the batch (`prior`).
      if (response.prior) count(response.prior.model, response.prior, response.prior.cost_usd);
      count(response.model ?? REVIEW_MODEL, response.usage, response.cost_usd ?? opusCost(response.usage));
      usage.calls++;
      usage.input_tokens += response.usage.input_tokens + (response.usage.cache_creation_input_tokens ?? 0);
      usage.cache_read_input_tokens += response.usage.cache_read_input_tokens ?? 0;
      usage.output_tokens += response.usage.output_tokens;
      if (response.stop_reason === 'refusal') { console.log(`  round ${round}, chunks ${indices[0]}-${indices.at(-1)}: refused`); continue; }
      let out = null;
      try { out = JSON.parse(response.content.find(b => b.type === 'text')?.text ?? ''); } catch { /* below */ }
      if (!out) { console.log(`  round ${round}, chunks ${indices[0]}-${indices.at(-1)}: no usable answer (${response.stop_reason})`); continue; }
      let applied = 0;
      for (const c of out.chunks) {
        if (!(c.chunk >= 0 && c.chunk < texts.length) || !c.issues.length) continue;
        const serious = c.issues.some(x => x.severity !== 'low');
        const text = c[field].trim();
        // A correction that changes the length wildly is more likely a slip than an edit, unless all
        // it takes out is what the next or previous chunk already says (11 Sep 2026 Madinah: chunk 12
        // carried chunk 13's ayah and hadith, and the review's fix, 35% of the length, was refused).
        const ratio = text.length / Math.max(texts[c.chunk].length, 1);
        const dropsNeighbour = ratio <= 0.5 && removesNeighbourText(texts[c.chunk], text, [texts[c.chunk - 1], texts[c.chunk + 1]]);
        const repeats = repeatsNeighbour(texts[c.chunk], text, texts[c.chunk - 1], texts[c.chunk + 1]);
        const apply = serious && text && text !== texts[c.chunk] && !repeats && ((ratio > 0.5 && ratio < 1.8) || dropsNeighbour);
        log.push({ round, chunk: c.chunk, issues: c.issues, applied: apply, [`${key}_before`]: texts[c.chunk], [`${key}_after`]: apply ? text : null,
          ...(serious && !apply && text ? { not_applied_because: repeats ? 'repeats the words of the block beside it' : `length ratio ${ratio.toFixed(2)}` } : {}) });
        if (apply) { texts[c.chunk] = text; changed.add(c.chunk); applied++; }
      }
      console.log(`  round ${round}, chunks ${indices[0]}-${indices.at(-1)}: ${out.chunks.length} flagged, ${applied} corrected`);
    }
    toReview = [...changed].sort((a, b) => a - b);
  }

  const round4 = x => Math.round(x * 10000) / 10000;
  usage.cost_usd = round4(usage.cost_usd);
  for (const t of Object.values(usage.by_model)) t.cost_usd = round4(t.cost_usd);
  return { log, usage };
}
