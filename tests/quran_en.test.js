// tests/quran_en.test.js — The English under the ayah cards (core/quran_en.js): a khutbah keeps the
// translation it was made with, and the voice says Hilali & Khan without its glosses and notes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { quranEnglish, spokenEnglish, QURAN_EN } from '../core/quran_en.js';

test('an older khutbah keeps Sahih International; a new one gets Hilali & Khan', () => {
  assert.equal(quranEnglish({}).name, 'Sahih International');
  assert.equal(quranEnglish({ quran_en: QURAN_EN }).name, 'Hilali & Khan');
  assert.match(quranEnglish({}).text(8, 46), /^And obey Allah and His Messenger/);
});

test('the card has no ayah number, footnote marks or closing note; the voice has no brackets', () => {
  const hk = quranEnglish({ quran_en: 'hilali-khan' });
  const card = hk.text(2, 190);
  assert.ok(!/^\d|\[\d+\]|This Verse/.test(card), card);
  assert.match(hk.text(1, 7), /\(i\.e\. those who knew the Truth/);
  const said = spokenEnglish(hk.text(1, 7), hk.id);
  assert.equal(said, 'The Way of those on whom You have bestowed Your Grace, not of those who earned Your Anger nor of those who went astray.');
  assert.equal(spokenEnglish('do not dispute and [thus] lose courage', 'sahih-international'), 'do not dispute and thus lose courage');
  assert.ok(!/[âîû]/.test(spokenEnglish(hk.text(8, 46), hk.id)));
});
