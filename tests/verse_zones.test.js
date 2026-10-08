// tests/verse_zones.test.js — Where a recited verse starts and ends in the transcript
// (prescanForQuranZones), at the edges where the mushaf's spelling differs from the imam's:
// on 2 Oct 2026 (Makkah) three verses stopped short and their last words stayed in the prose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prescanForQuranZones, dropBorrowedPhrases } from '../core/arabic.js';

// [transcript, first word of the verse, first word after it, verse]
const EDGES = [
  ['وقال تعالى عن بني النضير وقذف في قلوبهم الرعب يخربون بيوتهم بأيديهم وأيدي المؤمنين فاعتبروا يا أولي الأبصار. والمنتفعون بالمواعظ هم أهل التقوى',
    'وقذف', 'والمنتفعون', '59:2'], // the mushaf joins the vocative: يَٰٓأُو۟لِى
  ['وكلا نقص عليك من أنباء الرسل ما نثبت به فؤادك وجاءك في هذه الحق وموعظة وذكرى للمؤمنين وقال سبحانه',
    'وكلا', 'وقال', '11:120'], // ذِكْرَىٰ with a small alef
  ['وقال تعالى إن في ذلك لذكرى لمن كان له قلب أو ألقى السمع وهو شهيد. اللهم اجعلنا',
    'إن', 'اللهم', '50:37'], // ذَٰلِكَ with a small alef
  ['خلق الإنسان فسواه فعدله وجعله سميعا بصيرا وجعل الليل والنهار خلفة لمن أراد أن يذكر أو أراد شكورا وأشهد',
    'وجعل', 'وأشهد', '25:62'], // ٱلَّيْل with one lam
  ['إذ لا يمنحها الله إلا لمن يحب، بل الله يمن عليكم أن هداكم للإيمان. وأعظم خسارة',
    'بل', 'وأعظم', '49:17'], // هَدَىٰكُمْ: ى with a small alef inside the word
];

for (const [text, first, after, ref] of EDGES) {
  test(`${ref}: the zone runs from "${first}" up to "${after}"`, () => {
    const w = text.split(' ');
    const z = prescanForQuranZones(w).find(z => `${z.surah_id}:${z.ayah_id}` === ref);
    assert.ok(z, `no zone for ${ref}`);
    assert.equal(w[z.start], first);
    assert.equal(w[z.end], after);
  });
}

test('the shahada is not a verse zone long enough to leave the prose', () => {
  const w = 'وأشهد أن لا إله إلا الله وحده لا شريك له وأشهد أن محمدا عبده ورسوله'.split(' ');
  for (const z of prescanForQuranZones(w)) assert.ok(z.end - z.start < 5, `${z.surah_id}:${z.ayah_id} spans ${z.end - z.start} words`);
});

// The imam's own words in Quranic phrasing get no card (18 Sep 2026); short quotations do.
const zonesOf = text => { const w = text.split(' '); return dropBorrowedPhrases(prescanForQuranZones(w), w).filter(z => z.end - z.start >= 5).map(z => `${z.surah_id}:${z.ayah_id}`); };
const BORROWED = [
  ['فوض أمرك إلى العزيز الغفار من له ملك السماوات والأرض وما بينهما العظيم الجبار، يكفيك', '43:85'],
  ['يا قوي يا متين. اللهم جنبنا الفتن ما ظهر منها وما بطن، عن بلدنا هذا', '6:151'],
  ['خلقه حكمة يحبها ويرضاها، وما من ذرة في السماوات والأرض إلا وهي شاهدة لله', '19:93'],
  // Any length inside a du'a (4 Sep 2026 Makkah, for Palestine): 7:17 is Iblis's words.
  ['اللهم احفظ المسلمين في فلسطين، اللهم احفظهم من بين أيديهم ومن خلفهم وعن أيمانهم وعن شمائلهم ومن فوقهم', '7:17'],
];
const QUOTED = [
  ['فإن تساويا في التقوى استويا في الفضيلة. إن أكرمكم عند الله أتقاكم. والصبر والشكر', '49:13'],
  ['وهو لا يتناسب مع مكانته فلا فسوق ولا جدال في الحج. ولا شعارات', '2:197'],
  ['يا ذا الجلال والإكرام اللهم آتنا في الدنيا حسنة وفي الآخرة حسنة وقنا عذاب النار', '2:201'],
  // A Quranic du'a he recites inside his own keeps its card, though it does not reach the ayah's end.
  ['اللهم اغفر لنا ولوالدينا، ربنا اغفر لنا ولإخواننا الذين سبقونا بالإيمان ولا تجعل في قلوبنا غلا. اللهم', '59:10'],
];
for (const [text, ref] of BORROWED) test(`no ${ref} card for the imam's own phrase`, () => assert.ok(!zonesOf(text).includes(ref)));
for (const [text, ref] of QUOTED) test(`${ref} quoted briefly keeps its card`, () => assert.ok(zonesOf(text).includes(ref), zonesOf(text).join()));

// 18 Sep 2026 (Madinah): the imam's own "من حيث لا يحتسب" and his "قال تعالى" were inside 65:3's
// zone, so 65:3's card came before 65:2's; the isti'adha joined 17:21's, leaving "أعوذ" alone.
const zoneAt = text => { const w = text.split(' '); return prescanForQuranZones(w).filter(z => z.end - z.start >= 5).map(z => [w[z.start], z.ayah_spans.map(s => `${s.surah_id}:${s.ayah_id}`).join(',')]); };
test('a citing phrase inside a zone splits it: 65:2–3 starts after "قال تعالى"', () => {
  assert.deepEqual(zoneAt('بما ييسره له من رزق الدنيا ورزق الآخرة من حيث لا يحتسب، قال تعالى: ومن يتق الله يجعل له مخرجاً ويرزقه من حيث لا يحتسب. وفتنة الغنى أعظم'),
    [['ومن', '65:2,65:3']]);
});
test("the isti'adha stays in the prose: 17:21 starts at its first word", () => {
  assert.deepEqual(zoneAt('والمنعم عليه حقاً من يموت على الإيمان. أعوذ بالله من الشيطان الرجيم: انظر كيف فضلنا بعضهم على بعض وللآخرة أكبر درجات وأكبر تفضيلاً. بارك الله لي ولكم'),
    [['انظر', '17:21']]);
});
