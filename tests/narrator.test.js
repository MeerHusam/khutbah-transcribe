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
