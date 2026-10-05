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
