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
  // The whole sentence of a du'a, however far back its اللهم (28 Aug 2026 Makkah: 7 words, a 2:255 card).
  ['واجزهم خير الجزاء، ونسألك اللهم يا حي يا قيوم، يا من لا تأخذه سنة ولا نوم، أن تعطي السائل سؤله', '2:255'],
];
const QUOTED = [
  ['فإن تساويا في التقوى استويا في الفضيلة. إن أكرمكم عند الله أتقاكم. والصبر والشكر', '49:13'],
  ['وهو لا يتناسب مع مكانته فلا فسوق ولا جدال في الحج. ولا شعارات', '2:197'],
  ['يا ذا الجلال والإكرام اللهم آتنا في الدنيا حسنة وفي الآخرة حسنة وقنا عذاب النار', '2:201'],
  // A Quranic du'a he recites inside his own keeps its card, though it does not reach the ayah's end.
  ['اللهم اغفر لنا ولوالدينا، ربنا اغفر لنا ولإخواننا الذين سبقونا بالإيمان ولا تجعل في قلوبنا غلا. اللهم', '59:10'],
  // A verse he cites inside a du'a sentence is a recitation.
  ['اللهم إنا ندعوك كما أمرتنا وأنت القائل سبحانه ادعوني أستجب لكم إن الذين يستكبرون عن عبادتي', '40:60'],
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

// 4 Sep 2026 Makkah: 35:15 is printed "۞يَـٰٓأَيُّهَا ٱلنَّاسُ", the quarter-hizb mark against its first word, and
// the vocative was not split for it: "يا أيها" stayed in the prose before the card, and the English said
// "O mankind," twice.
test('a vocative behind the quarter-hizb mark is split like any other (35:15)', async () => {
  const { normalizeArabicDeep, quranData, prescanForQuranZones } = await import('../core/arabic.js');
  assert.deepEqual(normalizeArabicDeep(quranData[34].verses[14].text).split(' ').slice(0, 2), normalizeArabicDeep('يا أيها').split(' '));
  const w = 'وهو الغني عنهم وهم الفقراء إليه كما قال سبحانه: يا أيها الناس أنتم الفقراء إلى الله والله هو الغني الحميد. وقال'.split(' ');
  const z = prescanForQuranZones(w).find(z => z.surah_id === 35 && z.ayah_id === 15);
  assert.equal(w[z.start], 'يا');
});

// 8 Oct 2026, the Sudais test khutbah: with every alef dropped "اذهبا" (20:43, Musa and Harun) matched
// "اذهب" (20:24, 79:17) as well, and the first in the mushaf won. A tie goes to the ayah whose written
// alefs agree, then to the one the imam goes on reciting.
test('look-alike ayaat: the real alef, then what follows, decides', async () => {
  const { prescanForQuranZones: scan } = await import('../core/arabic.js');
  const spans = text => { const w = text.split(' '); return scan(w).map(z => z.ayah_spans.map(s => `${s.surah_id}:${s.ayah_id}`).join(',')); };
  assert.deepEqual(spans('وقال لهما اذهبا إلى فرعون إنه طغى فقولا له قولا لينا لعله يتذكر أو يخشى'), ['20:43,20:44']);
  assert.deepEqual(spans('قال له اذهب إلى فرعون إنه طغى قال رب اشرح لي صدري ويسر لي أمري'), ['20:24,20:25,20:26']);
  assert.deepEqual(spans('وقال اذهب إلى فرعون إنه طغى فقل هل لك إلى أن تزكى وأهديك إلى ربك فتخشى'), ['79:17,79:18,79:19']);
});

// 2 Oct 2026 Makkah, rebuilt 9 Oct: Claude and the matcher both named 69:12 for "إنا لما طغى الماء … وتعيها
// أذن واعية", 69:11 and 69:12 recited together, and the range only went forward. The label steps back to the
// ayah the recitation starts in; a passage that starts in the labelled ayah keeps it.
test('two ayaat recited together are labelled from the first: 69:11-12, 33:70-71', async () => {
  const { annotateRefAyahRange } = await import('../core/arabic.js');
  const label = (s, a, text) => {
    const r = annotateRefAyahRange({ matched: true, surah_number: s, ayah_number: a, quran_link: `https://quran.com/${s}/${a}`, detected_text: text });
    return `${r.surah_number}:${r.ayah_number}${r.ayah_number_end ? '-' + r.ayah_number_end : ''} ${r.quran_link}`;
  };
  assert.equal(label(69, 12, 'إنا لما طغى الماء حملناكم في الجارية لنجعلها لكم تذكرة وتعيها أذن واعية'), '69:11-12 https://quran.com/69/11');
  assert.equal(label(33, 71, 'يا أيها الذين آمنوا اتقوا الله وقولوا قولا سديدا يصلح لكم أعمالكم ويغفر لكم ذنوبكم ومن يطع الله ورسوله فقد فاز فوزا عظيما'),
    '33:70-71 https://quran.com/33/70');
  assert.equal(label(69, 12, 'لنجعلها لكم تذكرة وتعيها أذن واعية'), '69:12 https://quran.com/69/12');
  assert.equal(label(69, 11, 'إنا لما طغى الماء حملناكم في الجارية'), '69:11 https://quran.com/69/11');
});

// 9 Oct 2026: "وأنه لا يصيبنا إلا ما كتب الله لنا" — 9:51 has "قل لن يصيبنا"; the zone began at "يصيبنا"
// and the card read without its negation. Arafah's "فلا فسوق ولا جدال" (2:197, "ولا فسوق") the same.
test('a negation said where the verse has one starts the zone', () => {
  for (const [text, first, ref] of [
    ['قريب منا قادر على إجابتنا، وأنه لا يصيبنا إلا ما كتب الله لنا، وأن ما أخطأنا', 'لا', '9:51'],
    ['البيت من كل ما لا يتناسب مع مكانته. فلا فسوق ولا جدال في الحج. ولقد', 'فلا', '2:197'],
  ]) {
    const w = text.split(' ');
    const z = prescanForQuranZones(w).find(z => `${z.surah_id}:${z.ayah_id}` === ref);
    assert.ok(z, `no zone for ${ref}`);
    assert.equal(w[z.start], first, ref);
  }
});
