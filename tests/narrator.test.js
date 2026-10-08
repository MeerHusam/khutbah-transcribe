// tests/narrator.test.js — The narrator a hadith card shows, from sunnah.com's narrator line.
// The Companion, never the Successor who reports from him (Tirmidhi 2910 and 3585 in Sep 2026,
// Tirmidhi 2305 on 2 Oct 2026: "Al-Hasan" instead of Abu Hurairah).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSunnahNarrator, chooseNarrator } from '../core/hadith.js';

const shown = (narrated, lead = '', claude = null) => chooseNarrator(parseSunnahNarrator(narrated, lead), claude);

test('a Successor narrating from a Companion: the Companion is shown', () => {
  assert.equal(shown('Al-Hasan narrated from Abu Hurairah that the Messenger of Allah (s.a.w) said:'), 'Abu Hurairah');
  assert.equal(shown('Al-Hasan narrated from Abu Hurairah that the Messenger of Allah (s.a.w) said:', '', 'Abu Hurayrah'), 'Abu Hurayrah');
});

test('the forms that already worked still do', () => {
  assert.equal(shown('Narrated Abu Huraira:'), 'Abu Huraira');
  assert.equal(shown("Sa'd b. Abu Waqqas reported Allah's Messenger (ﷺ) as saying:"), "Sa'd b. Abu Waqqas");
  assert.equal(shown('`Amr bin Shu`aib narrated from his father, from his grandfather, that the Prophet (ﷺ) said:'), '`Amr bin Shu`aib from his father, from his grandfather');
  assert.equal(shown("Narrated Muhammad bin Ka'b Al-Qurazi:", "I heard 'Abdullah bin Mas'ud saying"), "Abdullah bin Mas'ud");
});

test('a Successor telling what he saw of a Companion, or heard from the Companions (18 Sep 2026)', () => {
  const b7324 = 'We were with Abu Huraira while he was wearing two linen garments dyed with red clay.';
  assert.equal(shown('Narrated Muhammad:', b7324), 'Abu Huraira');
  assert.equal(shown('Narrated Muhammad:', b7324, 'Abu Hurayrah'), 'Abu Hurayrah');
  const d5004 = 'The Companions of the Prophet (ﷺ) told us that they were travelling with the Prophet (ﷺ).';
  assert.equal(shown('Narrated AbdurRahman ibn AbuLayla:', d5004), 'Companions of the Prophet ﷺ');
  assert.equal(shown('Narrated AbdurRahman ibn AbuLayla:', d5004, "Abd al-Rahman ibn Abi Layla"), 'Companions of the Prophet ﷺ');
  // "We were with the Prophet" is the narrator's own account.
  assert.equal(shown('Narrated Anas:', 'We were with the Prophet (ﷺ) on a journey'), 'Anas');
});

test("sunnah.com naming the father for the son: Claude's fuller name is shown", () => {
  assert.equal(shown("'Amr b. al-'As reported Allah's Messenger (ﷺ) as saying:", '', 'Abdullah ibn Amr ibn al-As'), 'Abdullah ibn Amr ibn al-As');
  // A different person entirely is not overruled.
  assert.equal(shown('Narrated Abu Huraira:', '', 'Abdullah ibn Umar'), 'Abu Huraira');
});

test('a hadith in several collections links to Bukhari, then Muslim, unless the imam named one', async () => {
  const { pickSunnahResult } = await import('../core/hadith.js');
  const results = [{ slug: 'abudawud', number: '4862', score: 1 }, { slug: 'muslim', number: '2998', score: 1 }, { slug: 'bukhari', number: '6133', score: 0.95 }];
  assert.equal(pickSunnahResult(results).slug, 'bukhari');
  assert.equal(pickSunnahResult(results, 'abudawud').number, '4862');
  assert.equal(pickSunnahResult(results, 'tirmidhi'), null);
  assert.equal(pickSunnahResult([{ slug: 'abudawud', number: '1', score: 1 }, { slug: 'bukhari', number: '2', score: 0.6 }]).slug, 'abudawud');
});

test('no narrator line on the page: none shown, never Claude\'s guess (18 Sep 2026 Madinah)', () => {
  assert.equal(chooseNarrator(null, "Sa'd ibn Abi Waqqas"), null);
  assert.equal(chooseNarrator({ narrator: null }, 'Abu Hurayrah'), null);
});

// 11 Sep 2026 Makkah: Muslim 770's header names the asker (and sunnah.com cut him to his father's
// name); the answer is 'A'isha's. Muslim 395b's header is misspelled "naratted".
test('"I asked X … she said": X is the narrator; a misspelled "naratted" header is still read', () => {
  assert.equal(shown("'Abd al-Rahman b. 'Auf reported:", "I asked 'A'isha, the mother of the believers, (to tell me) the words with which the Messenger of Allah (ﷺ) commenced the prayer"), "'A'isha");
  assert.equal(shown('It is naratted on the authority of Abu Huraira that', 'He who observed prayer'), 'Abu Huraira');
  assert.equal(shown('Narrated Abu Huraira:', 'I asked the Prophet (ﷺ) about'), 'Abu Huraira');
});
