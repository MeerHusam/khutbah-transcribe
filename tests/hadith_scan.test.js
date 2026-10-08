// tests/hadith_scan.test.js — Hadith the imam quotes without naming them (scanTranscriptForHadith):
// found in the local collections by shared 4-grams, never the khutbah's liturgy (the opening
// praise, the shahada, the salawat, the takbir), a verse, or a hadith the imam introduced.
// Needs hadith_data/ (node scripts/setup_hadith.js); skipped without it (GitHub Actions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadHadithCorpus, scanTranscriptForHadith } from '../core/hadith.js';

const corpus = loadHadithCorpus();
const skip = corpus.length ? false : 'no hadith_data/';
const scan = (text, opts = {}) => scanTranscriptForHadith(text, opts.claude ?? [], corpus, opts.zones ?? [])
  .map(r => r.link?.split('/').pop());

test('hadith woven into the imam\'s sentences are found (2 Oct 2026 Madinah)', { skip }, () => {
  assert.deepEqual(scan('واعلموا عباد الله أن من خاف أدلج ومن أدلج بلغ المنزل ألا إن سلعة الله غالية ألا إن سلعة الله الجنة فشمروا'), ['tirmidhi:2450']);
  assert.deepEqual(scan('فالمؤمن بين شكر وصبر، عجبا لأمر المؤمن، إن أمره كله خير، وليس ذلك لأحد إلا للمؤمن، إن أصابته سراء شكر فكان خيرا له، وإن أصابته ضراء صبر فكان خيرا له. فاحمدوا الله'), ['muslim:2999']);
});

test('the khutbah\'s liturgy is not a hadith card', { skip }, () => {
  assert.deepEqual(scan('إن الحمد لله نحمده ونستعينه ونستغفره ونعوذ بالله من شرور أنفسنا ومن سيئات أعمالنا، من يهده الله فلا مضل له، ومن يضلل فلا هادي له، وأشهد أن لا إله إلا الله وحده لا شريك له، وأشهد أن محمدا عبده ورسوله أرسله بالحق بشيرا ونذيرا'), []);
  assert.deepEqual(scan('اللهم صل على محمد وعلى آل محمد كما صليت على إبراهيم وعلى آل إبراهيم إنك حميد مجيد ولا حول ولا قوة إلا بالله العلي العظيم'), []);
  // The pillars listed in the imam's own words (Arafah 2026): not a quotation of Tirmidhi 2609.
  assert.deepEqual(scan('وأركان الإسلام شهادة أن لا إله إلا الله وأن محمدا رسول الله وإقام الصلاة وإيتاء الزكاة وصوم رمضان وحج البيت فاحرصوا عليها'), []);
  assert.deepEqual(scan('الله أكبر الله أكبر لا إله إلا الله الله أكبر الله أكبر ولله الحمد الله أكبر كبيرا والحمد لله كثيرا وسبحان الله بكرة وأصيلا'), []);
});

test('a hadith the imam introduced is not found twice, nor one inside a verse', { skip }, () => {
  const text = 'قال صلى الله عليه وسلم من خاف أدلج ومن أدلج بلغ المنزل ألا إن سلعة الله غالية ألا إن سلعة الله الجنة';
  assert.deepEqual(scan(text, { claude: [{ detected_text: 'من خاف أدلج ومن أدلج بلغ المنزل ألا إن سلعة الله غالية' }] }), []);
  assert.deepEqual(scan(text, { zones: [{ start: 0, end: text.split(' ').length }] }), []);
});

// 4 Sep 2026 Makkah: the collection the imam names, before or after the hadith, and a short hadith
// he attributes aloud.
import { imamAttribution, imamCompanion, companionOnChain, findAttributedHadith, deduplicateHadithRefs } from '../core/hadith.js';
const BIRDS = 'كما قال رسول الهدى صلوات الله وسلامه عليه: لو توكلتم على الله حق توكله لرزقكم كما يرزق الطير تغدو خماصاً وتروح بطاناً. أخرجه الترمذي في جامعه بإسناد صحيح.';
const UMMAH = 'التبكير في طلبه، وذلك في الحديث الذي أخرجه الترمذي في جامعه بإسناد صحيح عن صخر الغامدي رضي الله عنه عن رسول الله صلى الله عليه وسلم أنه قال: اللهم بارك لأمتي في بكورها. وكان صخر رجلاً تاجراً';
const DUA = 'سيدخلون جهنم داخرين. وقال رسول الله صلى الله عليه وسلم: الدعاء هو العبادة. أخرجه أبو داود والترمذي وابن ماجه بسند صحيح. والدعاء مقام جامع';

test('the collection the imam names right after the hadith, or before it introducing it', () => {
  assert.equal(imamAttribution(BIRDS, 'لو توكلتم على الله حق توكله لرزقكم كما يرزق الطير تغدو خماصاً وتروح بطاناً')?.slug, 'tirmidhi');
  assert.equal(imamAttribution(UMMAH, 'اللهم بارك لأمتي في بكورها')?.slug, 'tirmidhi');
  // The "رواه مسلم." closing the hadith before is not this one's.
  assert.equal(imamAttribution('إن الله رفيق يحب الرفق. رواه مسلم. وقال صلى الله عليه وسلم: الكلمة الطيبة صدقة. والإحسان', 'الكلمة الطيبة صدقة'), null);
});

// 11 Sep 2026 Makkah (no punctuation in the transcript): "في مسند الإمام أحمد" with a chain opening
// "قال ابن مسعود", carded as Tirmidhi 2454, another hadith.
test('"in the Musnad of Imam Ahmad" introducing a hadith names its collection', () => {
  const LINES = 'فقد حاد وضل عن الصراط المستقيم وفي مسند الإمام أحمد قال ابن عباس قال ابن مسعود رضي الله عنه خط لنا رسول الله صلى الله عليه وسلم خطاً وقال هذا سبيل الله ثم خط خطوطاً';
  assert.equal(imamAttribution(LINES, 'خط لنا رسول الله صلى الله عليه وسلم خطاً وقال هذا سبيل الله')?.slug, 'ahmad');
  // After "رواه" a "قال" opens the next hadith: still no attribution for it.
  assert.equal(imamAttribution('إن الله رفيق يحب الرفق رواه مسلم وقال ابن عمر كنا نقول الكلمة الطيبة صدقة والإحسان', 'كنا نقول الكلمة الطيبة صدقة'), null);
});

test('a short hadith the imam attributes aloud is carded and kept', { skip }, () => {
  const found = findAttributedHadith(DUA, [], corpus);
  assert.deepEqual(found.map(h => `${h.collection} ${h.hadith_number} ${h.detected_text}`), ['Sunan Abu Dawud 1479 الدعاء هو العبادة']);
  assert.equal(deduplicateHadithRefs(found, DUA).length, 1);
  assert.equal(findAttributedHadith(DUA, found, corpus).length, 0); // already carded
});

// 11 Sep 2026 Madinah: "وقد صح عن جرير بن عبد الله رضي الله عنه … بايعنا رسول الله ﷺ على النصح لأهل الإسلام"
// carded as Ibn 'Umar's Bukhari 7202. The Companion he names must be on the card's chain.
test('the Companion the imam names before a hadith is on its card\'s chain', { skip }, () => {
  const JARIR = 'متفق على صحته. وقد صح عن جرير بن عبد الله رضي الله عنه أنه كان إذا أقام سلعة بصر عيوبها ثم خير المشتري فقال له إن شئت فخذ وإن شئت فاترك. فقيل له يرحمك الله إنك إذا فعلت ذلك لم ينفذ لك البيع، فقال: بايعنا رسول الله صلى الله عليه وسلم على النصح لأهل الإسلام. إن كثيراً';
  const said = 'بايعنا رسول الله صلى الله عليه وسلم على النصح لأهل الإسلام';
  assert.equal(imamCompanion(JARIR, said), 'جرير');
  assert.equal(companionOnChain(corpus, 'https://sunnah.com/bukhari:7202', 'جرير'), false);
  assert.equal(companionOnChain(corpus, 'https://sunnah.com/nasai:4156', 'جرير'), true);
  // A verse or another attributed hadith between the name and the quote: the name is not this one's.
  assert.equal(imamCompanion('عن أبي هريرة رضي الله عنه قال النبي كذا رواه مسلم وقال صلى الله عليه وسلم ' + said, said), null);
});
