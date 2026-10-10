// tests/retake.test.js — When a voiced passage is voiced again (voice/retake.js; 9 Oct 2026: a
// 5-second passage voiced three times, 82% heard each time).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retake } from '../voice/retake.js';

test('a passage is voiced again only when a retake can help', () => {
  const low = { said: 0.81, extra: 0.83 };
  assert.equal(retake({ take: 1, words: 400, share: { said: 0.9, extra: 1 }, score: 0.9 }), false, 'heard well');
  assert.equal(retake({ take: 1, words: 400, share: null, score: 1 }), false, 'not checked (Bengali)');
  assert.equal(retake({ take: 1, words: 400, share: low, score: 0.81 }), true, 'a long passage heard poorly');
  assert.equal(retake({ take: 1, words: 11, share: { said: 0.82, extra: 0.91 }, score: 0.82 }), false, 'too short to judge');
  assert.equal(retake({ take: 2, words: 400, share: low, score: 0.81, before: 0.81 }), false, 'the retake heard no more');
  assert.equal(retake({ take: 2, words: 400, share: { said: 0.84, extra: 0.9 }, score: 0.84, before: 0.78 }), true, 'better, still short of 85%');
  assert.equal(retake({ take: 3, words: 400, share: low, score: 0.81, before: 0.7 }), false, 'three takes at most');
  assert.equal(retake({ take: 1, words: 400, share: { said: 0.95, extra: 1.4 }, score: 0.7 }), true, 'far more words than written');
});
