// tests/languages.test.js — Every language file (core/langs/) has what the scripts, the voice and the
// page read from it, so a new language cannot be half there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LANGS, forPage } from '../core/languages.js';

test('every language file is complete', () => {
  for (const L of LANGS) {
    for (const k of ['code', 'name', 'native', 'field', 'dir', 'digits', 'sentenceEnd', 'comma', 'clause', 'untranslated', 'bothSahihs', 'surahNames'])
      assert.ok(L[k], `${L.code}: ${k}`);
    for (const k of ['family', 'size', 'lineHeight', 'shareLineHeight', 'citeLineHeight', 'inlineSize', 'switchSize', 'phoneSwitchSize'])
      assert.ok(L.font[k], `${L.code}: font.${k}`);
    for (const k of ['In Short', 'Summary', 'Full Translation', 'Copy for WhatsApp', 'Copied', 'Show full ayah', 'Show recited part'])
      assert.ok(L.ui[k], `${L.code}: ui ${k}`);
    assert.equal(L.digits.length, 10, `${L.code}: ten digits`);
    assert.ok(L.quran.edition && L.quran.name && L.hadith.edition && L.hadith.end instanceof RegExp, `${L.code}: sources`);
    assert.equal(typeof L.verseText, 'function'); assert.equal(typeof L.hadithText, 'function');
    assert.ok(L.voice.name && L.voice.style && L.voice.base && L.voice.intro && L.voice.iso && L.voice.whisper, `${L.code}: voice`);
    assert.ok(L.translate.system && L.translate.extras.system && L.translate.extras.ask('a', 'b').includes('b') && L.translate.extras.hadith, `${L.code}: prompts`);
    if (L.surahNames === 'model') assert.ok(L.translate.extras.surahs, `${L.code}: surah names asked for`);
    assert.ok(L.review.system && L.review.types.length && L.review.whole, `${L.code}: review`);
    new RegExp(L.clause); // compiles
  }
  assert.equal(new Set(LANGS.map(L => L.code)).size, LANGS.length);
  assert.equal(new Set(LANGS.map(L => L.field)).size, LANGS.length);
});

test('the page gets data only, no prompts', () => {
  for (const L of LANGS) {
    const p = JSON.parse(JSON.stringify(forPage(L)));
    assert.deepEqual(p, forPage(L), `${L.code}: nothing lost in JSON (no functions)`);
    assert.ok(!('translate' in p) && !('review' in p));
  }
});

test('Bengali clean-up: footnote marks, Assamese ra, a hadith edition\'s notes', () => {
  const bn = LANGS.find(L => L.code === 'bn');
  assert.equal(bn.verseText('বলুন [১] , ‘তিনি আল্লাহ্, এক-অদ্বিতীয় [২]'), 'বলুন , ‘তিনি আল্লাহ্, এক-অদ্বিতীয়');
  assert.equal(bn.verseText('শ্ৰেষ্ঠ'), 'শ্রেষ্ঠ');
  const t = bn.hadithText('। আবূ হুরাইরাহ (রাঃ) সূত্রে বর্ণিত। নবী সাল্লাল্লাহু আলাইহি ওয়াসাল্লাম বলেছেনঃ মু‘মিন ব্যক্তি একই গর্তে দু’ বার দংশিত হয় না।[1] সহীহ। ');
  assert.equal(t.slice(0, t.search(bn.hadith.end)), 'আবূ হুরাইরাহ (রাঃ) সূত্রে বর্ণিত। নবী সাল্লাল্লাহু আলাইহি ওয়াসাল্লাম বলেছেনঃ মু‘মিন ব্যক্তি একই গর্তে দু’ বার দংশিত হয় না।');
});
