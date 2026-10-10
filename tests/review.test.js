// tests/review.test.js — The review loop the English and Urdu reviews share (core/review_chunks.js):
// what it applies, what it only logs, and that a corrected chunk is read again. Free, no model call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewRequest, reviewChunks, removesNeighbourText, repeatsNeighbour, reviewClient } from '../core/review_chunks.js';

test('high and medium issues are applied, low ones and wild rewrites only logged; a correction is read again', async () => {
  const texts = ['one two three', 'four five six', 'seven eight nine', 'ten eleven twelve'];
  const answers = [
    // round 1, chunks 0-3
    { chunks: [
      { chunk: 0, issues: [{ type: 'mistranslation', severity: 'high', problem: 'x' }], corrected_english: 'one two three fixed' },
      { chunk: 1, issues: [{ type: 'unnatural', severity: 'low', problem: 'taste' }], corrected_english: 'four five six maybe' },
      { chunk: 2, issues: [{ type: 'omission', severity: 'medium', problem: 'x' }], corrected_english: 'a much much much longer rewrite than any edit' },
    ] },
    // round 2, chunk 0 again: nothing more
    { chunks: [] },
  ];
  const asked = [];
  const anthropic = { beta: { messages: { create: async p => {
    asked.push(p.messages[0].content.split('\n')[0]);
    return { content: [{ type: 'text', text: JSON.stringify(answers.shift()) }], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' };
  } } } };
  const request = reviewRequest({ system: 's', field: 'corrected_english', types: ['mistranslation', 'unnatural', 'omission'],
    whole: 'All:', texts, show: i => `### Chunk ${i}\nEnglish: ${texts[i]}` });
  const { log } = await reviewChunks({ anthropic, request, field: 'corrected_english', key: 'english', texts, batch: 12, rounds: 2 });
  assert.deepEqual(texts, ['one two three fixed', 'four five six', 'seven eight nine', 'ten eleven twelve']);
  assert.deepEqual(log.map(l => [l.chunk, l.applied]), [[0, true], [1, false], [2, false]]);
  assert.match(log[2].not_applied_because, /length ratio/);
  assert.deepEqual(asked, ['Review chunks 0, 1, 2, 3.', 'Review chunks 0.']);
});

// 11 Sep 2026 Madinah: chunk 12's English carried chunk 13's ayah and hadith; the review's fix took
// them out (35% of the length) and was refused as a wild rewrite.
test('a correction that only takes out the next chunk\'s words is applied, however much shorter', () => {
  const c12 = "Every cheating in a business dealing or otherwise is a denial of people's rights and an injustice that the Truth, glorified be He, does not accept. The Exalted said: \"Woe to those who give less than due,\" and the Prophet, peace and blessings be upon him, said: \"There is no servant whom Allah has placed in charge of a people, who then does not protect them with sincere care, except that he will not smell the fragrance of Paradise.\"";
  const c13 = "The Exalted said: \"Woe to those who give less than due,\" and the Prophet said: \"There is no servant whom Allah has placed in charge of a people, who then does not protect them with sincere care, except that he will not smell the fragrance of Paradise.\"";
  const fixed = "Every act of cheating, in trade or anything else, shortchanges people's rights and is an injustice that the Truth, glorified be He, does not accept.";
  assert.equal(removesNeighbourText(c12, fixed, ['Those who commit this.', c13]), true);
  // A short rewrite that drops the chunk's own meaning is still refused.
  assert.equal(removesNeighbourText(c12, 'Cheating is bad.', ['Those who commit this.', 'Something else entirely here now.']), false);
});

// The reviewer test of 10 Oct 2026 (4 Sep Madinah, blocks 33-34): Gemini added "O Allah" at the start
// of a block whose neighbour already ends with it, so the page said it twice.
test('a correction that repeats the words of the block beside it is refused; a move is not', async () => {
  const b33 = 'Be pleased with them, by Your pardon, O Most Generous of the generous. O Allah,';
  const b34 = 'strengthen Islam and the Muslims. O Allah, strengthen Islam and the Muslims.';
  assert.equal(repeatsNeighbour(b34, `O Allah, ${b34}`, b33, ''), true);
  assert.equal(repeatsNeighbour('اسلام اور مسلمانوں کو عزت عطا فرما،', 'اے اللہ! اسلام اور مسلمانوں کو عزت عطا فرما،', 'اے سب سے بڑھ کر کرم فرمانے والے۔ اے اللہ!', ''), true);
  assert.equal(repeatsNeighbour('and from above them', 'and from above them, O Allah', '', 'O Allah, be for them a helper'), true, 'at the end too');
  assert.equal(repeatsNeighbour(b34, `O Allah, ${b34}`, 'by Your pardon, O Most Generous of the generous.', ''), false, 'the neighbour no longer ends with it');
  assert.equal(repeatsNeighbour('O Allah, forgive us', 'O Allah, forgive us all', 'O Allah, forgive us', ''), false, 'already there before');

  const texts = [b33, b34];
  const anthropic = { beta: { messages: { create: async () => ({ content: [{ type: 'text', text: JSON.stringify({ chunks: [
    { chunk: 1, issues: [{ type: 'omission', severity: 'medium', problem: 'O Allah left out' }], corrected_english: `O Allah, ${b34}` }] }) }],
    usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn' }) } } };
  const request = reviewRequest({ system: 's', field: 'corrected_english', types: ['omission'], whole: 'All:', texts, show: i => texts[i] });
  const { log } = await reviewChunks({ anthropic, request, field: 'corrected_english', key: 'english', texts, batch: 12, rounds: 1 });
  assert.equal(texts[1], b34);
  assert.equal(log[0].not_applied_because, 'repeats the words of the block beside it');
});

test('reviewClient: Gemini answers; a batch it does not answer goes to Opus; both are counted; the cap holds', async () => {
  const texts = ['one two three', 'four five six'];
  const request = reviewRequest({ system: 's', field: 'corrected_urdu', types: ['omission'], whole: 'All:', texts, show: i => texts[i] });
  const answer = { chunks: [{ chunk: 0, issues: [{ type: 'omission', severity: 'high', problem: 'x' }], corrected_urdu: 'one two three four' }] };
  const asked = [];
  const anthropic = { beta: { messages: { create: async p => { asked.push(p.model); return {
    model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify(answer) }], usage: { input_tokens: 1000, output_tokens: 100 }, stop_reason: 'end_turn' }; } } } };
  const gem = ok => async ({ thinkingLevel, schema }) => {
    assert.equal(thinkingLevel, 'LOW');
    assert.ok(schema.properties.chunks);
    const usage = { calls: 1, input_tokens: 2000, output_tokens: 500, thoughts_tokens: 0 };
    return ok ? { ok: true, json: answer, usage, cost_usd: 0.003 } : { ok: false, why: 'blocked (PROHIBITED_CONTENT)', usage, cost_usd: 0.002 };
  };

  let t = [...texts];
  let r = await reviewChunks({ anthropic: reviewClient({ anthropic, model: 'gemini-3.8-flash', gemini: gem(true) }), request: reviewRequest({ system: 's', field: 'corrected_urdu', types: ['omission'], whole: 'All:', texts: t, show: i => t[i] }), field: 'corrected_urdu', key: 'urdu', texts: t, batch: 12, rounds: 1 });
  assert.equal(t[0], 'one two three four');
  assert.deepEqual(Object.keys(r.usage.by_model), ['gemini-3.8-flash']);
  assert.equal(asked.length, 0);

  t = [...texts];
  r = await reviewChunks({ anthropic: reviewClient({ anthropic, model: 'gemini-3.8-flash', gemini: gem(false) }), request: reviewRequest({ system: 's', field: 'corrected_urdu', types: ['omission'], whole: 'All:', texts: t, show: i => t[i] }), field: 'corrected_urdu', key: 'urdu', texts: t, batch: 12, rounds: 1 });
  assert.equal(t[0], 'one two three four', 'Opus answered the batch');
  assert.deepEqual(asked, ['claude-opus-5-5']);
  assert.deepEqual(Object.keys(r.usage.by_model).sort(), ['claude-opus-5-5', 'gemini-3.8-flash']);
  assert.equal(r.usage.cost_usd, Math.round((0.002 + (1000 * 4 + 100 * 20) / 1e6) * 10000) / 10000);

  await assert.rejects(reviewClient({ anthropic, model: 'gemini-3.8-flash', cap: 0.01, gemini: gem(true) }).beta.messages.create(request([0])), /review cap/);
});
