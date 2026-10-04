// tests/verse_zones.test.js — Where a recited verse starts and ends in the transcript
// (prescanForQuranZones), at the edges where the mushaf's spelling differs from the imam's:
// on 2 Oct 2026 (Makkah) three verses stopped short and their last words stayed in the prose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prescanForQuranZones } from '../core/arabic.js';

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
