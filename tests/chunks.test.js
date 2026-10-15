// tests/chunks.test.js — Where the reader's blocks break (buildProseChunks) when Gemini writes the transcript with
// no sentence punctuation, one phrase to a line (9 Oct 2026 Makkah): the blocks broke at Whisper's pauses, all 56
// mid-sentence ("Brothers and sisters in / Iman (faith), social media…"). Now where a line ends and the imam paused
// too, else at line ends; a punctuated transcript breaks as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildProseChunks } from '../core/arabic.js';

const LINES = [
  'وإن من أهم ما تميز به عصرنا الحاضر تلكم التقانة الحديثة',
  'والتقدم المتسارع في تطويرها واستثمارها في مختلف وسائل الحياة',
  'فوسائل التواصل الاجتماعي لا يخلو منها بيت',
  'بل لا يخلو منها إنسان في حله وترحاله وفي جميع أحواله',
  'مما يستوجب التذكير بالضوابط والأخلاقيات عند استخدامها',
  'إخوة الإيمان وسائل التواصل الاجتماعي وتقانات الذكاء الاصطناعي',
  'من النعم التي أنعم الله بها على عباده',
];
const words = text => text.split(/\s+/);
const lineEnds = lines => lines.reduce((a, l) => [...a, (a.at(-1) ?? 0) + words(l).length], []);
// Whisper's segments, cut after these word counts.
const segmentsAt = (w, cuts) => cuts.map((e, i) => ({ text: w.slice(i ? cuts[i - 1] : 0, e).join(' ') }));
const lastWords = (w, chunks) => chunks.map(c => w[c.wordEnd - 1]);

const transcript = LINES.join('\n'), w = words(transcript), ends = lineEnds(LINES);
// He paused after "الحياة" (a line's end) and after "إخوة" (inside a line).
const segments = segmentsAt(w, [ends[1], ends[4] + 1, w.length]);

test('no punctuation, a phrase to a line: blocks end where a line ends and the imam paused', () => {
  assert.deepEqual(lastWords(w, buildProseChunks(w, [], 30, segments, transcript)), ['الحياة', 'عباده']);
  // Before (no line ends given): at his pauses, "… عند استخدامها إخوة | الإيمان …".
  assert.deepEqual(lastWords(w, buildProseChunks(w, [], 30, segments)), ['الحياة', 'إخوة', 'عباده']);
});

test('too few pauses at line ends: every line end, about 20 words a block', () => {
  const chunks = buildProseChunks(w, [], 30, [{ text: transcript }], transcript);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(ends.includes(c.wordEnd), `block ends at a line end (${w[c.wordEnd - 1]})`);
  for (const c of chunks) assert.ok(c.wordEnd - c.wordStart >= 20);
});

test('a punctuated transcript breaks at its sentence ends, as before', () => {
  const punctuated = LINES.map((l, i) => (i === 1 || i === 4 ? `${l}.` : l)).join('\n'), pw = words(punctuated);
  assert.deepEqual(lastWords(pw, buildProseChunks(pw, [], 30, segments, punctuated)), ['الحياة.', 'استخدامها.', 'عباده']);
});

test('a hadith attribution on its own line stays with the hadith', () => {
  const lines = ['قال رسول الله صلى الله عليه وسلم إن العبد ليتكلم بالكلمة من سخط الله لا يلقي لها بالا يهوي بها في جهنم',
    'أخرجه البخاري', 'فما يكتبه الإنسان أو تخطه أنامله أو يقوله أو يعيد نشره داخل فيما سيسأل عنه'];
  const t = lines.join('\n'), tw = words(t);
  const chunks = buildProseChunks(tw, [], 30, segmentsAt(tw, lineEnds(lines)), t);
  assert.deepEqual(lastWords(tw, chunks), ['البخاري', 'عنه'], 'no block starts with "أخرجه البخاري"');
});
