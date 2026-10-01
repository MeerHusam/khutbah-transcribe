// check_english.js — Checks on the English the reader shows where a published translation
// (sunnah.com for hadith, Sahih International for verses) was swapped in for Claude's.
//
// Regenerating the May khutbahs with the swap code produced English that no structural check
// noticed: Muslim 1162a's Ashura clause where the imam quoted the Arafah one, Nasa'i 2202's
// Laylat al-Qadr clause that the imam never said, Muslim 1141a without "and remembrance of
// Allah", and a Sa'd hadith that read "The Prophet ﷺ, “The Messenger of Allah passed by Sa'd
// … and he said”:". Each check below fails on one of those.
//
// A swapped quote is found without knowing how it was made: it is a “curly-quoted” run of the
// block's English whose words are a contiguous run of some reference's published text.
// Claude's own wording for the block is recovered from result.chunk_translations.

import { readFileSync } from 'fs';
import { normalizeArabic, publishedVerseEnglish, cachedSunnahPage } from './pipeline.js';

const quran = JSON.parse(readFileSync(new URL('./node_modules/quran-json/dist/quran.json', import.meta.url), 'utf8'));
const verseText = (s, a) => quran.find(x => x.id === s)?.verses?.find(v => v.id === a)?.text ?? '';

const keyOf = t => t.toLowerCase().replace(/[’‘`]/g, "'").replace(/[^a-z0-9']/g, '').replace(/^'+|'+$/g, '');
const keys = s => (s ?? '').split(/\s+/).map(keyOf).filter(Boolean);
const grams = (ks, n = 3) => ks.length < n ? [ks.join(' ')] : ks.slice(n - 1).map((_, i) => ks.slice(i, i + n).join(' '));

// Consonant skeleton of a word, so transliterations compare equal: Tashriq = Tashreeq,
// 'Arafa = Arafah, Mecca = Makkah, Qadr = Kadr.
export const skeleton = w => w.toLowerCase().replace(/^al-/, '').replace(/[^a-z]/g, '')
  .replace(/c/g, 'k').replace(/q/g, 'k').replace(/[aeiouyw]/g, '').replace(/(.)\1+/g, '$1').replace(/h$/, '');

// Capitalised words that are not names of anything a swap could smuggle in.
const CAP_STOP = new Set(`the a an and but or so then he his him she her it its i we our us you your they them their
  o if when whoever who what which that this these those there none no not nor by in on of for to at with from as is are
  was were be do does did have has had say said indeed verily allah allah's messenger prophet prophets apostle lord
  muslims muslim islam paradise fire hell hellfire day book quran qur'an hereafter resurrection judgment judgement
  majestic exalted most high glorified mighty merciful gracious almighty praise peace blessings may one all every each
  whosoever whomever let yes nay amen companion companions`.split(/\s+/));

// Arabic words that say nothing about which words of a hadith the imam quoted.
const AR_STOP = new Set(['قال', 'فقال', 'يقول', 'صلى', 'الله', 'لله', 'بالله', 'والله', 'عليه', 'وسلم', 'رسول',
  'النبي', 'عن', 'ان', 'انه', 'رضي', 'عنه', 'عنها', 'عنهما', 'يا', 'قالوا', 'فقالوا']);
// Alif maqsura and ta marbuta are spelled either way ("علي"/"على", "صلاة"/"صلاه").
const arWords = s => normalizeArabic(s ?? '').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
  .replace(/[^ء-ي\s]/g, ' ').split(/\s+/).filter(Boolean);
const stripClitic = w => w.replace(/^(?:و|ف)?(?:ب|ل|ك)?(?:ال)?/, '') || w;
const within1 = (x, y) => {
  if (Math.abs(x.length - y.length) > 1) return false;
  let i = 0, j = 0, e = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { i++; j++; continue; }
    if (++e > 1) return false;
    if (x.length > y.length) i++; else if (y.length > x.length) j++; else { i++; j++; }
  }
  return e + (x.length - i) + (y.length - j) <= 1;
};
// The imam's words that the published Arabic of a hadith does not contain.
export function wordsMissingFrom(imamArabic, publishedArabic) {
  const pub = arWords(publishedArabic);
  const pubSet = new Set(pub), pubBare = new Set(pub.map(stripClitic));
  const missing = [];
  for (const w of arWords(imamArabic)) {
    if (AR_STOP.has(w) || pubSet.has(w)) continue;
    const b = stripClitic(w);
    if (b.length < 3 || AR_STOP.has(b) || pubBare.has(b)) continue;
    if (b.length >= 4 && [...pubBare].some(p => within1(b, p))) continue;
    missing.push(w);
  }
  return missing;
}

// Is `needle` (keys) a contiguous run of `hay` (keys)?
const runIndex = (hay, needle) => {
  if (!needle.length) return -1;
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
};

const QUOTE_RE = /“([^“”]+)”/g;
const PROPHET = /\b(?:prophet|messenger|rasulullah|apostle)\b/i;
const QUOTE_OPENS_WITH_PROPHET = /^\s*(?:the prophet|the messenger of allah|allah's messenger|allah's apostle|the apostle of allah|rasulullah)\b/i;
const ENDS_ON_FRAMING = /\b(?:said|says|saying|say|is|are|was|that|and|of|to|the|he)\W*$/i;
const FRAMING_INSIDE = /\bsaid:?\s*[“"]\s*(?:the prophet|allah's (?:messenger|apostle)|the messenger of allah|rasulullah|he)\b[^”"]{0,30}?\b(?:said|says)\b/i;

// What is wrong with putting published text `quote` (from source `src`) where Claude's
// translation had its own rendering. `before`: the English right before the quote;
// `claudeSkel`: skeletons of every word of Claude's translation of the block. Shared with
// quote_swaps.js, which refuses a swap that fails any of these.
//   src = { kind: 'hadith'|'verse', ref, keys (of the whole published text), arabic }
export function quoteProblems({ quote, before, claudeSkel, src }) {
  const out = [];
  const qk = keys(quote);

  // 1. No proper noun Claude's translation of this block does not have.
  // Sentence-initial words are capitalised anyway and skipped.
  const added = [];
  const toks = quote.split(/\s+/);
  for (const [i, tok] of toks.entries()) {
    const w = tok.replace(/^[^A-Za-z]+|[^A-Za-z']+$/g, '').replace(/'s$/, '');
    if (!/^[A-Z]/.test(w) || CAP_STOP.has(w.toLowerCase())) continue;
    if (i === 0 || /[.!?:;"'“‘(]$/.test(toks[i - 1]) || /^["'“‘(]/.test(tok)) continue;
    const sk = skeleton(w);
    if (sk.length >= 2 && !claudeSkel.has(sk)) added.push(w);
  }
  if (added.length) out.push(`adds ${added.map(w => `"${w}"`).join(', ')}, not in Claude's translation of the block`);

  // 2. The quote must not repeat the framing around it, nor end on it.
  if (QUOTE_OPENS_WITH_PROPHET.test(quote) && PROPHET.test(before)) {
    out.push(`names the Prophet again right after the imam's own "The Prophet … said"`);
  }
  if (ENDS_ON_FRAMING.test(quote.replace(/[.,;:!?'’\s]+$/, ''))) {
    out.push(`ends mid-sentence on its own framing ("…${quote.trim().split(/\s+/).slice(-3).join(' ')}")`);
  }
  if (/\?\?/.test(quote)) out.push(`carries sunnah.com's "[??]" placeholder`);

  // 3. Nothing the imam said may be dropped: the published hadith must contain his words.
  if (src.kind === 'hadith' && src.arabic) {
    const miss = wordsMissingFrom(src.ref.detected_text, src.arabic);
    if (miss.length) out.push(`comes from a text without the imam's "${miss.join(' ')}"`);
  }
  // 4. A verse quote must cover what was recited, no more: an imam who recites the end of
  // Ibrahim 14:7 must not get its opening "And [remember] when your Lord proclaimed".
  if (src.kind === 'verse') {
    const recited = arWords(src.ref.detected_text).length, verse = arWords(src.arabic).length;
    const arFrac = Math.min(1, recited / Math.max(verse, 1)), enFrac = qk.length / Math.max(src.keys.length, 1);
    if ((enFrac - arFrac > 0.3 && (enFrac - arFrac) * src.keys.length >= 5)
      || (arFrac - enFrac > 0.4 && (arFrac - enFrac) * src.keys.length >= 5)) {
      out.push(`covers ${Math.round(enFrac * 100)}% of the verse's English but the imam recited ${Math.round(arFrac * 100)}% of it`);
    }
  }
  return out;
}

// Words of Claude's rendering that carry content a translator cannot drop — numbers and
// capitalised names/nouns — which the published excerpt lacks. Tirmidhi 1639's excerpt began
// at "An eye that wept…" and lost "There are two eyes that the Fire will never touch".
const NUMBER_WORDS = new Set(`two three four five six seven eight nine ten eleven twelve twenty thirty forty fifty
  sixty seventy eighty ninety hundred thousand twice thrice half third quarter`.split(/\s+/));
const DROP_STOP = new Set(`the a an and but or so then he his him she her it its i me my we our us you your they them
  their o if when whoever who what which that this these those there none no not by in on of for to at with from as
  is are was were be may let allah indeed verily`.split(/\s+/));
export function droppedWords(ours, published) {
  const pubLower = new Set((published ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const pubSkel = skeletonSet(published);
  const toks = (ours ?? '').split(/\s+/), out = [];
  for (const [i, tok] of toks.entries()) {
    const w = tok.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9']+$/g, '').replace(/'s$/, ''), lw = w.toLowerCase();
    if (NUMBER_WORDS.has(lw) || /^\d+$/.test(w)) { if (!pubLower.has(lw)) out.push(w); continue; }
    if (!/^[A-Z]/.test(w) || DROP_STOP.has(lw)) continue;
    if (i === 0 || /[.!?:;"'“‘(]$/.test(toks[i - 1]) || /^["'“‘(]/.test(tok)) continue;
    // Two-consonant skeletons collide ("Fire" and "fear" are both "fr"): compare stems there.
    const sk = skeleton(w);
    const found = sk.length >= 3 ? pubSkel.has(sk) : [...pubLower].some(p => p.slice(0, 4) === lw.slice(0, 4));
    if (!found) out.push(w);
  }
  return out;
}

// Skeletons of every word of a text, for quoteProblems' claudeSkel.
export const skeletonSet = text => new Set((text ?? '').split(/\s+/).map(skeleton).filter(Boolean));
export { keys as englishKeys, verseText };

// `blocks`: parsed reader blocks ({ arabic, englishParas }). Returns { failures, warnings, swaps }.
export function checkEnglish(blocks, result) {
  const failures = [], warnings = [], swaps = [];
  const chunkKeys = (result.chunk_translations ?? []).map(t => keys(t));
  const chunkGrams = chunkKeys.map(k => new Set(grams(k)));

  // Every published text a quote could have come from.
  const sources = [];
  for (const h of result.hadith_references ?? []) {
    if (!h.translation) continue;
    const m = (h.link ?? '').match(/sunnah\.com\/([a-z]+):(\w+)/);
    const arabic = h.published_arabic ?? (m ? cachedSunnahPage(m[1], m[2])?.arabic : null) ?? null;
    sources.push({ kind: 'hadith', ref: h, label: m ? `${m[1]}:${m[2]}` : (h.collection ?? 'hadith'),
      text: h.translation, keys: keys(h.translation), arabic });
  }
  for (const q of result.quran_references ?? []) {
    if (!q.matched) continue;
    const text = publishedVerseEnglish(q);
    if (!text) continue;
    const end = q.ayah_number_end ?? q.ayah_number;
    let ar = '';
    for (let a = q.ayah_number; a <= end; a++) ar += ' ' + verseText(q.surah_number, a);
    sources.push({ kind: 'verse', ref: q, label: `${q.surah_number}:${q.ayah_number}${end !== q.ayah_number ? '-' + end : ''}`,
      text, keys: keys(text), arabic: ar });
  }

  // 0. Each prose chunk must carry its own translation. Translations are paired with chunks by
  // position, so one chunk Claude skipped or merged shifts every later block onto its
  // neighbour's English — the Sudais khutbah showed that from chunk 59 on (90 chunks, 88
  // translations). A chunk whose English is far longer or shorter than its Arabic, against
  // this khutbah's own ratio, is where the pairing slipped.
  const map = result.prose_chunk_map ?? [], trans = result.chunk_translations ?? [];
  if (map.length && trans.length) {
    const rows = map.map((c, i) => {
      const ar = c.wordEnd - c.wordStart;
      const t = trans[c.proseIdx];
      return { i, ar, en: (t ?? '').split(/\s+/).filter(Boolean).length, none: t == null };
    });
    const ratios = rows.filter(r => !r.none && r.ar > 0).map(r => r.en / r.ar).sort((a, b) => a - b);
    const med = ratios[ratios.length >> 1] ?? 1.7;
    const off = rows.filter(r => r.none || (r.en > r.ar * med * 2.2 && r.en - r.ar * med > 8)
      || (r.en < r.ar * med / 2.2 && r.ar * med - r.en > 8));
    if (off.length) {
      const msg = `translation paired with the wrong block? chunk ${off.map(r => `${r.i} (${r.ar} Arabic / ${r.none ? 'no' : r.en} English words)`).join(', ')}`;
      (off.length >= 2 ? failures : warnings).push(msg);
    }
  }

  // A planned swap (quote_swaps.js) must not drop numbers or names Claude's rendering has.
  for (const [kind, refs] of [['hadith', result.hadith_references ?? []], ['verse', result.quran_references ?? []]]) {
    for (const r of refs) {
      const sw = r.english_swap;
      if (sw?.status === 'ours') {
        const tag = kind === 'hadith' ? ((r.link ?? '').split('/').pop() || r.collection || 'hadith') : `${r.surah_number}:${r.ayah_number}`;
        warnings.push(`${kind} ${tag} shows our translation, labelled on the page: ${sw.reason}`);
      }
      if (sw?.status !== 'published') continue;
      const lost = droppedWords(sw.ours, sw.published);
      if (lost.length) failures.push(`swapped ${kind} excerpt “${sw.published.slice(0, 60)}…” drops ${lost.map(w => `"${w}"`).join(', ')} from Claude's rendering`);
    }
  }

  for (const b of blocks) {
    const prose = b.englishParas.filter(p => !/^(📖|📑|📚|❝)/.test(p)).join(' ');
    if (!prose) continue;

    // Claude's English for this block: the chunk translations it was built from.
    const bGrams = new Set(grams(keys(prose)));
    const scored = chunkGrams.map((g, i) => ({ i, s: g.size ? [...g].filter(x => bGrams.has(x)).length / g.size : 0 }));
    const best = Math.max(0, ...scored.map(x => x.s));
    const claude = scored.filter(x => x.s >= 0.3 || (x.s === best && best > 0)).map(x => result.chunk_translations[x.i]).join(' ');
    const claudeSkel = skeletonSet(claude);

    for (const m of prose.matchAll(QUOTE_RE)) {
      const quote = m[1], qk = keys(quote);
      if (qk.length < 3) continue;
      const src = sources.find(s => runIndex(s.keys, qk) >= 0);
      if (!src) continue; // Claude's own quotation, not a swap
      swaps.push({ source: src.label, kind: src.kind, quote });
      const before = prose.slice(Math.max(0, m.index - 140), m.index);
      for (const p of quoteProblems({ quote, before, claudeSkel, src })) {
        failures.push(`swapped ${src.kind} ${src.label}: “${quote.slice(0, 60)}${quote.length > 60 ? '…' : ''}” ${p}`);
      }
    }

    // 5. Framing repeated inside a quote, however it got there.
    const f = prose.match(FRAMING_INSIDE);
    if (f) failures.push(`translation repeats its framing: "…${f[0].slice(0, 70)}"`);
  }
  return { failures, warnings, swaps };
}
