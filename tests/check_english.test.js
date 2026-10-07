// tests/check_english.test.js — English checks that refuse a quote swap and fail the publish gate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { personShift } from '../core/check_english.js';

test('a published excerpt saying "me" where the imam said "us" is caught (4 Sep 2026 Makkah)', () => {
  // His du'a "وأن تغفر لنا وترحمنا"; Tirmidhi 3235's published English has the Prophet's "forgive me".
  assert.deepEqual(personShift('to do good deeds, to leave evil deeds, and to love the poor, and that You forgive us',
    'the doing of the good deeds, avoiding the evil deeds, loving the poor, and that You forgive me'), ['me']);
  // The hadith itself in the first person, as our rendering has it: nothing to catch.
  assert.deepEqual(personShift('O Allah, forgive me', 'O Allah, forgive me'), []);
  assert.deepEqual(personShift('Take what is lawful', 'I take what is lawful'), []);
});
