// tests/review.test.js — The review loop the English and Urdu reviews share (core/review_chunks.js):
// what it applies, what it only logs, and that a corrected chunk is read again. Free, no model call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewRequest, reviewChunks, removesNeighbourText } from '../core/review_chunks.js';

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
