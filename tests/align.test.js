// The phrase matching (core/align_phrases.js): what is matched, and which answers are kept. Offline: no request is made.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkPairs, passagesFor, shownTranslation } from '../core/align_phrases.js';

test('a matching is kept only when its phrases cover both texts in order, ending on their last words', () => {
  assert.equal(checkPairs([[1, 2], [4, 6]], 5, 7), true);
  assert.equal(checkPairs([[1, 2], [3, 6]], 5, 7), false);   // the Arabic's last word left out
  assert.equal(checkPairs([[1, 2], [1, 6]], 2, 7), false);   // a phrase with no Arabic word
  assert.equal(checkPairs([[2, 4], [1, 6]], 5, 7), false);   // out of order
  assert.equal(checkPairs([], 5, 7), false);
  assert.equal(checkPairs([[1.5, 2], [4, 6]], 5, 7), false);
});

test('the translation matched is the text the page shows: no source lines, a hadith\'s ❝ as text', () => {
  const english = 'He said: “Strange are the ways of a believer.”\n\n❝ The whole hadith.\n\n📚 Hadith  ·  Narrator: Suhaib  ·  Collection: Sahih Muslim';
  assert.equal(shownTranslation(english), 'He said: “Strange are the ways of a believer.” The whole hadith.');
});

test('recited ayah cards (📖) are not matched; each language uses its own field', () => {
  const chunks = [
    { arabic: 'الحمد لله رب العالمين', english: 'All praise is for Allah, Lord of the worlds.', urdu: 'تمام تعریفیں اللہ کے لیے ہیں' },
    { arabic: 'قال كلا إن معي ربي سيهدين', english: '“No! My Lord is with me.”\n\n📖 Ash-Shu\'ara 26:62  —  https://quran.com/26/62' },
    { arabic: 'أما بعد', english: '' },
  ];
  assert.deepEqual(passagesFor(chunks, 'en').map(p => p.i), [0]);
  assert.deepEqual(passagesFor(chunks, 'ur').map(p => [p.i, p.tr.length]), [[0, 6]]);
  assert.deepEqual(passagesFor(chunks, 'bn'), []);
});
