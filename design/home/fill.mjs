// Builds public/home.html from home.template.html: the minbar drawing, the icons, and the example's
// words with their real times. Run from the repo root: node design/home/fill.mjs
// Edit the template, never public/home.html (this overwrites it).
//
// The example (example.json): 9 Oct 2026 at our masjid, reader block 38, the imam's du'a with
// Ghafir 40:60 inside it: his words and times (words_imam.json) and each voice's (tts_<lang>.json).
import { readFileSync, writeFileSync } from 'fs';
import { MINBAR } from './minbar.svg.js';

const here = new URL('.', import.meta.url).pathname;
const ex = JSON.parse(readFileSync(here + 'example.json', 'utf8'));
const iw = ex.imam;
const LAST = 17;                      // "شيء،": the excerpt ends before the du'a turns to retribution
const AYAH = [3, 5];                  // "ادعوني أستجب لكم" in the imam's words
const MUSHAF = ['ٱدۡعُونِيٓ', 'أَسۡتَجِبۡ', 'لَكُمۡ'];   // the same words as the mushaf writes them (40:60)
const words = iw.slice(0, LAST + 1).map(([w, t], i) => {
  const ayah = i >= AYAH[0] && i <= AYAH[1];
  let text = ayah ? MUSHAF[i - AYAH[0]] : w;
  if (i === LAST) text = text.replace(/،$/, '') + '\u00A0…';   // the ellipsis stays with its word
  return [text, t, ayah ? 1 : 0, ayah && i === AYAH[1] ? '،' : ''];
});
// The three voices read the same lines; each recites the ayah in the imam's own voice (recite.js) before its meaning.
const voice = (l, last, [a0, a1]) => {
  const v = ex.voices[l];
  const w = v.words.slice(0, last + 1);
  return { audio: v.url, start: +(w[0][1] - 0.2).toFixed(2), end: +(w.at(-1)[2] + 0.35).toFixed(2),
    words: w.map(([x, t], i) => [x, t, i >= a0 && i <= a1 ? 1 : 0]), ar: v.arabic.map(x => x[1]) };
};
const VOICES = { en: voice('en', 30, [4, 11]), ur: voice('ur', 35, [6, 13]), bn: voice('bn', 28, [3, 10]) };
const DEMO = {
  audio: ex.audio_url,
  start: +(iw[0][1] - 0.25).toFixed(2),
  end: +(iw[LAST][2] + 0.35).toFixed(2),
  words,
  voices: VOICES,
  tr: {
    en: 'O You who said, <q class="ayah">“Call upon Me, I will respond to you,”</q> we ask You, O Allah, Possessor of Majesty and Honor, You are our Lord and the Lord of everything …',
    ur: 'اے وہ ذات جس نے فرمایا: <q class="ayah">“مجھے پکارو، میں تمہاری دعا قبول کروں گا”</q>، اے اللہ! اے جلال اور عزت والے! ہم تجھ سے مانگتے ہیں، تو ہمارا رب ہے اور ہر چیز کا رب ہے …',
    bn: 'হে যিনি বলেছেন, <q class="ayah">“তোমরা আমাকে ডাকো, আমি তোমাদের ডাকে সাড়া দেব”</q>, হে আল্লাহ, হে মহিমা ও সম্মানের অধিকারী, আমরা আপনার কাছে চাই, আপনি আমাদের রব এবং সব কিছুর রব …',
  },
};
const HIZB = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5.2" y="5.2" width="13.6" height="13.6"/><rect x="5.2" y="5.2" width="13.6" height="13.6" transform="rotate(45 12 12)"/><circle cx="12" cy="12" r="2.3"/></svg>';
// Phosphor's check (regular), the same icon family as the rest of the page
const TICK = '<svg viewBox="0 0 256 256" aria-hidden="true"><path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z"/></svg>';
const PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>';

const out = readFileSync(here + 'home.template.html', 'utf8')
  .replaceAll('{{HIZB}}', HIZB)
  .replaceAll('{{PLAY}}', PLAY)
  .replaceAll('{{TICK}}', TICK)
  .replace('{{MINBAR}}', MINBAR.replace('<svg class="minbar"', '<svg class="minbar" aria-hidden="true" focusable="false"').replace(' role="img" aria-label="A minbar, the pulpit the khutbah is given from"', ''))
  .replace('{{DEMO}}', JSON.stringify(DEMO)).replaceAll('stop-color="var(--light)"', 'stop-color="#F8E9BC"');
writeFileSync(here + '../../public/home.html', out);
console.log('public/home.html', out.length, 'bytes; demo', DEMO.start, '→', DEMO.end, 's,', words.length, 'words; voices', Object.entries(VOICES).map(([l, v]) => `${l} ${v.start}–${v.end}`).join(', '));
