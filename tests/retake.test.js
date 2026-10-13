// tests/retake.test.js — When a voiced passage is voiced again (voice/retake.js; 9 Oct 2026: a
// 5-second passage voiced three times, 82% heard each time).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retake, madeUpSpeech, MADE_UP_SECONDS } from '../voice/retake.js';

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

// 13 Oct 2026: the 2 Oct English voice said an Arabic sentence (5 s) its text did not have. A stretch of voice between
// two timed words, longer than a breath, is speech the text does not have (madeUpSpeech).
const SR = 24000;
// a track of [seconds, voiced?] pieces: voiced is noise at speech level, the rest silence
function track(pieces) {
  const pcm = new Int16Array(Math.round(pieces.reduce((s, [d]) => s + d, 0) * SR));
  let at = 0, seed = 7;
  for (const [d, voiced] of pieces) {
    const n = Math.round(d * SR);
    if (voiced) for (let i = 0; i < n; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; pcm[at + i] = (seed % 16000) - 8000; }
    at += n;
  }
  return pcm;
}
test('a pause between two words is not speech; a stretch of voice no written word was given is', () => {
  // words at 0-1, 2-3 and 4.5-5.5 s; a 1 s pause, then a 1.5 s pause holding a 0.3 s breath
  const words = [['one', 0, 1], ['two', 2, 3], ['three', 4.5, 5.5]];
  const calm = track([[1, true], [1, false], [1, true], [0.6, false], [0.3, true], [0.6, false], [1, true]]);
  assert.equal(madeUpSpeech(calm, SR, words, 0, 5.5), null, 'pauses and a breath');
  // 3 s of voice between "two" and "three" that the aligner gave to no word
  const words2 = [['one', 0, 1], ['two', 2, 3], ['three', 6.5, 7.5]];
  const added = track([[1, true], [1, false], [1, true], [0.25, false], [3, true], [0.25, false], [1, true]]);
  const f = madeUpSpeech(added, SR, words2, 0, 7.5);
  assert.ok(f && f.seconds >= MADE_UP_SECONDS && f.seconds <= 3.05, JSON.stringify(f));
  assert.deepEqual([f.after, f.before], ['two', 'three']);
  // voice before a passage's first word counts too; a Buffer of 16-bit samples works as well
  const lead = track([[2.5, true], [0.3, false], [1, true]]);
  assert.equal(madeUpSpeech(Buffer.from(lead.buffer), SR, [['one', 2.8, 3.8]], 0, 3.8)?.before, 'one');
});
