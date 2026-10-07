// quran_en.js — The English under each ayah card, which the English voice also reads. A khutbah
// keeps the translation it was made with (result.quran_en): from 7 Oct 2026 new ones get Hilali &
// Khan, the King Fahd Complex's translation (quran_en_hilali_khan.json, made by
// scripts/fetch_hilali_khan.js); older ones (no quran_en) keep Sahih International, which their
// voices, quote swaps and ayah parts came from.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export const QURAN_EN = 'hilali-khan'; // for new khutbahs (pipeline.js)

const SOURCES = {
  'sahih-international': () => {
    const q = require('quran-json/dist/quran_en.json');
    return { name: 'Sahih International', text: (s, a) => q[s - 1]?.verses?.find(v => v.id === a)?.translation?.trim() ?? '' };
  },
  'hilali-khan': () => {
    const d = require('./quran_en_hilali_khan.json');
    return { name: d.name, text: (s, a) => d.verses[`${s}:${a}`] ?? '' };
  },
};
const loaded = {};

// The khutbah's English translation: { id, name, text(surah, ayah) }.
export function quranEnglish(result) {
  const id = SOURCES[result?.quran_en] ? result.quran_en : 'sahih-international';
  return (loaded[id] ??= { id, ...SOURCES[id]() });
}

// What the voice says for it. Hilali & Khan's brackets hold glosses and notes for the reader
// ("(i.e. those who knew the Truth…)"), so the voice says the ayah without them, in plain letters
// for â, î, û. Sahih International's [added words] belong to the sentence: only the brackets go.
export function spokenEnglish(text, id) {
  if (id !== 'hilali-khan') return text.replace(/[[\]]/g, '');
  // ponytail: a few brackets carry a needed word (29:38 "(their destruction) is clearly apparent"); the voice loses it
  let t = text, before;
  do { before = t; t = t.replace(/\s*\([^()]*\)/g, '').replace(/\s*\[[^[\]]*\]/g, ''); } while (t !== before);
  return t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC')
    .replace(/\s+([,.;:!?])/g, '$1').replace(/\s{2,}/g, ' ').trim();
}
