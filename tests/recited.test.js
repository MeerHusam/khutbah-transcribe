// tests/recited.test.js — Which words of a verse the imam recited (public/recited.js), on the
// cards it got wrong: a common word matched far before what he said made the card mark nearly
// the whole verse as recited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import '../public/recited.js';

const { recitedSpans } = globalThis.KTRecited;
const quran = JSON.parse(readFileSync('node_modules/quran-json/dist/quran.json', 'utf8'));
const verse = (s, a) => quran[s - 1].verses[a - 1].text;

test('a lone common word far before the recited words is not part of the span', () => {
  // 2 Oct 2026, Madinah: "من" was matched to 65:4's "من المحيض" (word 2), 18 words early.
  assert.deepEqual(recitedSpans('من يتق الله يجعل له من أمره يسراً، ويكفر عنه سيئاته ويعظم له أجراً.', [verse(65, 4), verse(65, 5)]),
    [[21, 27], [9, 13]]);
  // Arafah: "اليوم" was matched to 5:3's first "اليوم" (word 30), not the one he recited (word 39);
  // until 9 Oct 2026 the span then began a word late, at "أكملت".
  assert.deepEqual(recitedSpans('اليوم اكملت لكم دينكم واتممت عليكم نعمتي ورضيت لكم الاسلام دينا.', [verse(5, 3)]), [[39, 49]]);
});

test('a verse recited whole, and a short verse, keep their spans', () => {
  const ikhlas = verse(112, 1);
  assert.deepEqual(recitedSpans(ikhlas, [ikhlas]), [[0, ikhlas.split(/\s+/).length - 1]]);
  assert.deepEqual(recitedSpans('متاعا لكم ولأنعامكم', [verse(80, 32)]), [[0, 2]]);
});

test('a recited word paired elsewhere in the verse still counts when it stands beside the rest', () => {
  // 9 Oct 2026: "لا" was paired with 9:40's opening "إلا" (word 0), and the card began at "تحزن" (word 19).
  assert.deepEqual(recitedSpans('لا تحزن إن الله معنا.', [verse(9, 40)]), [[18, 22]]);
});

test('a negation said where the verse has one belongs to the recited part', () => {
  // 9 Oct 2026: "وأنه لا يصيبنا إلا ما كتب الله لنا" for 9:51's "قل لن يصيبنا…": the card began at "يصيبنا".
  assert.deepEqual(recitedSpans('لا يصيبنا إلا ما كتب الله لنا،', [verse(9, 51)]), [[1, 7]]);
  // "إلا" is not a negation: 9:40's opening "إلا" stays out of "لا تحزن إن الله معنا".
  assert.deepEqual(recitedSpans('لا تحزن إن الله معنا.', [verse(9, 40)]), [[18, 22]]);
});
