// fetch_hilali_khan.js — Downloads Hilali & Khan's English (the King Fahd Complex's translation)
// from QuranEnc and writes core/quran_en_hilali_khan.json, the text the ayah cards show
// (core/quran_en.js): as printed, without the ayah number, the footnote markers ([4]) and a note
// in square brackets after the ayah's last sentence ("[This Verse is the first one…]", "[Tafsir
// At-Tabari]"). The footnotes themselves are not kept.
//   node scripts/fetch_hilali_khan.js
import { writeFileSync } from 'node:fs';

const KEY = 'english_hilali_khan';
export const cardText = t => t
  .replace(/^\d+\.\s*/, '')
  .replace(/\s*\[\d+\](?:\s*,\s*\[\d+\])*/g, '')
  // ponytail: a bracket after the last sentence is taken for a note; a few such are glosses (18:7, 19:65) and go too
  .replace(/([.!?"”’)])\s*\[[^\[\]]*\]\s*\.?\s*$/, '$1')
  .replace(/\s+([,.;:!?)])/g, '$1').replace(/,\s*$/, '').replace(/\s{2,}/g, ' ').trim();

if (import.meta.url === `file://${process.argv[1]}`) {
  const verses = {};
  let version;
  for (let s = 1; s <= 114; s++) {
    const r = await fetch(`https://quranenc.com/api/v1/translation/sura/${KEY}/${s}`);
    if (!r.ok) throw new Error(`${r.status} for surah ${s}`);
    for (const v of (await r.json()).result) verses[`${v.sura}:${v.aya}`] = cardText(v.translation);
  }
  const list = await (await fetch('https://quranenc.com/api/v1/translations/list/en')).json();
  version = list.translations.find(t => t.key === KEY)?.version;
  if (Object.keys(verses).length !== 6236) throw new Error(`${Object.keys(verses).length} ayaat, expected 6236`);
  writeFileSync(new URL('../core/quran_en_hilali_khan.json', import.meta.url),
    JSON.stringify({ name: 'Hilali & Khan', source: `quranenc.com ${KEY} ${version}`, fetched: new Date().toISOString().slice(0, 10), verses }, null, 0));
  console.log(`✓ 6236 ayaat, ${KEY} ${version}`);
}
