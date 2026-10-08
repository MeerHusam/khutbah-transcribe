// review_chunks.js — the review loop the two translation reviews share (urdu/review_urdu.js since
// 30 Sep 2026, core/review_english.js since 4 Oct 2026). An editor model reads each chunk's
// translation against the imam's Arabic, in batches, and returns the whole corrected text of each
// chunk that needs a change. High and medium issues are applied; low ones are only logged. A
// second round re-reads the rewritten chunks with their neighbours, so a fix cannot break a
// sentence that runs on into the next chunk.

export const REVIEW_MODEL = 'claude-opus-5-5';
const PRICE_IN = 4 / 1e6, PRICE_OUT = 20 / 1e6; // USD per token, claude-opus-5-5
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

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
  const usage = { calls: 0, input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
  const log = [];
  let toReview = only ?? texts.map((_, i) => i);
  for (let round = 1; round <= rounds && toReview.length; round++) {
    const changed = new Set();
    for (let k = 0; k < toReview.length; k += batch) {
      const indices = toReview.slice(k, k + batch);
      const response = await anthropic.beta.messages.create(request(indices));
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
        const apply = serious && text && text !== texts[c.chunk] && ((ratio > 0.5 && ratio < 1.8) || dropsNeighbour);
        log.push({ round, chunk: c.chunk, issues: c.issues, applied: apply, [`${key}_before`]: texts[c.chunk], [`${key}_after`]: apply ? text : null,
          ...(serious && !apply && text ? { not_applied_because: `length ratio ${ratio.toFixed(2)}` } : {}) });
        if (apply) { texts[c.chunk] = text; changed.add(c.chunk); applied++; }
      }
      console.log(`  round ${round}, chunks ${indices[0]}-${indices.at(-1)}: ${out.chunks.length} flagged, ${applied} corrected`);
    }
    toReview = [...changed].sort((a, b) => a - b);
  }

  usage.input_usd = Math.round((usage.input_tokens * PRICE_IN + usage.cache_read_input_tokens * PRICE_IN * 0.1) * 10000) / 10000;
  usage.output_usd = Math.round(usage.output_tokens * PRICE_OUT * 10000) / 10000;
  usage.cost_usd = Math.round((usage.input_usd + usage.output_usd) * 10000) / 10000;
  return { log, usage };
}
