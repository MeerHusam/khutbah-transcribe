// tests/restarts.test.js — Where the imam restarted (findRestarts), so each translator is told to
// translate it once: on 18 Sep 2026 sentences he broke off or said twice across a chunk edge were
// translated twice in the English. What he repeats on purpose (a du'a, the salawat, a refrain)
// must not be found: a translator told to say it once would drop it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRestarts, restartNotes } from '../core/arabic.js';

test('a sentence broken off at a chunk edge and said again in full (18 Sep Madinah)', () => {
  const r = findRestarts([
    'والكاملون يقومون بالشكر والصبر على التمام، كنبينا صلى الله عليه وسلم، فهو سيد الأغنياء الشاكر...',
    'فهو سيد الأغنياء الشاكرين وسيد الفقراء الصابرين، فحصل له من الصبر على الفقر ما لم يحصل لأحد سواه،',
  ]);
  assert.deepEqual(r.map(x => [x.kind, x.from, x.chunk]), [['broken', 0, 1]]);
  assert.match(restartNotes(r, i => i + 1), /Chunk 1 ends where he broke off .* chunk 2 says that sentence again/);
});

test('a passage said again across a chunk edge (18 Sep Makkah)', () => {
  const r = findRestarts([
    'وإياك أن تسلبك خيانة الخائنين نبل خلقك',
    'أن تسلبك خيانة الخائنين نبل خلقك، فالكريم يبقى كريماً',
  ]);
  assert.deepEqual(r.map(x => [x.kind, x.from, x.chunk, x.words]), [['repeat', 0, 1, 'أن تسلبك خيانة الخائنين نبل خلقك،']]);
});

test('words said twice at once inside a chunk (18 Sep Madinah)', () => {
  const r = findRestarts(['فلو ساوى بين الخلائق جميعاً لم يعرف قدر فضله ونعمته ورحمته، لم يعرف قدر فضله ونعمته ورحمته، ولتعطلت عبوديات الصدقة']);
  assert.deepEqual(r.map(x => [x.from, x.chunk]), [[0, 0]]);
});

test('what the imam repeats on purpose is not a restart', () => {
  assert.deepEqual(findRestarts([
    'اللهم صل على محمد وعلى آل محمد كما صليت على إبراهيم وعلى آل إبراهيم إنك حميد مجيد، وبارك على محمد وعلى آل محمد كما باركت على إبراهيم وعلى آل إبراهيم إنك حميد مجيد',
    'اللهم احفظ الإسلام والمسلمين وبلاد المسلمين، اللهم احفظ الإسلام والمسلمين وبلاد المسلمين',
    'الله أكبر الله أكبر الله أكبر الله أكبر الله أكبر الله أكبر الله أكبر',
    'فعلو الهمة يا عباد الله سبيل الفلاح، فعلو الهمة يا عباد الله سبيل النجاح',
    // Parallel sentences: a short run with other words between.
    'ويظهر الوفاء كذلك في نبذ الخلاف بين المسلمين، ويظهر الوفاء كذلك في نبذ الفرقة والتنازع',
    'عن أبي هريرة رضي الله عنه قال: قال رسول الله صلى الله عليه وسلم: من كان يؤمن',
    'وعن ابن عمر رضي الله عنه قال: قال رسول الله صلى الله عليه وسلم: إذا',
  ]), []);
});
