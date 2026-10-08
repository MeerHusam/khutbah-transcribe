// Hadith (split out of pipeline.js): the local corpus, matching and scanning, sunnah.com links
// and narrators, and the filters that drop duplicate and liturgical refs.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { normalizeArabic, wordOverlapScore, MIN_ZONE_WORDS } from './arabic.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Search the hadith corpus for the best match to a detected hadith text.
// Used to fill in collection + number for Claude's signal-phrase finds.
function findMatchingHadith(detectedText, hadithCorpus) {
  if (!hadithCorpus?.length || !detectedText) return null;

  // Strip khatib commentary patterns inserted into the hadith text:
  //   أي ...     (i.e. / meaning ...)
  //   يعني ...   (meaning ...)
  //   parenthetical clauses wrapped in brackets
  const cleaned = detectedText
    .replace(/\s+أي\s+\S+(?:\s+\S+){0,3}/g, ' ')   // strip "أي X Y Z" (max 4 words)
    .replace(/\s+يعني\s+\S+(?:\s+\S+){0,3}/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const normDetected = normalizeArabic(cleaned);
  const detectedWords = normDetected.split(/\s+/).filter(Boolean);
  const detectedWordSet = new Set(detectedWords);
  const isShort = detectedWords.length < 6;

  let best = null;
  let bestScore = 0;

  for (const h of hadithCorpus) {
    const aWordSet = new Set(h.matnWords);
    const matchedCount = detectedWords.filter(w => aWordSet.has(w)).length;

    let score;
    if (isShort) {
      // For short phrases: require ALL words to appear in the matn (containment).
      // Score = fraction of matn words that are detected words (avoids Jaccard dilution).
      if (matchedCount < detectedWords.length) continue;
      score = matchedCount / h.matnWords.length;
    } else {
      const stringContained = normDetected.includes(h.matn) || h.matn.includes(normDetected);
      const wordMajority = matchedCount / Math.max(detectedWords.length, 1) >= 0.75;
      const overlap = wordOverlapScore(normDetected, h.matn);
      score = stringContained ? Math.max(overlap, 0.8) : wordMajority ? Math.max(overlap, 0.65) : overlap;
    }

    if (score > bestScore) { bestScore = score; best = h; }
  }

  const minScore = isShort ? 0.08 : 0.5;
  if (bestScore < minScore) return null;
  return { ...best, confidence: Math.round(bestScore * 100) / 100 };
}

// ---- Hadith corpus ----------------------------------------------------------

const HADITH_DIR = path.join(__dirname, '..', 'hadith_data');
const COLLECTION_NAMES = {
  'ara-bukhari':  'Sahih al-Bukhari',
  'ara-muslim':   'Sahih Muslim',
  'ara-abudawud': 'Sunan Abu Dawud',
  'ara-nasai':    "Sunan an-Nasa'i",
  'ara-ibnmajah': 'Sunan Ibn Majah',
  'ara-tirmidhi': 'Jami` at-Tirmidhi',
};

// The number sunnah.com gives a corpus hadith. Sahih Muslim's hadithnumber counts sequentially
// (4938 would link a different hadith); its arabicnumber "1913.01", "1913.02" is sunnah.com's
// 1913a, 1913b. Checked 2 Oct 2026 against the saved sunnah.com pages: Bukhari, Abu Dawud,
// Tirmidhi, Nasa'i and Ibn Majah agree number for number; Muslim this way 6 of 7 (one a number
// off), which is why a link only from the corpus is flagged as unconfirmed (verify_reader).
function sunnahNumber(id, h) {
  if (id !== 'ara-muslim') return h.hadithnumber ?? h.arabicnumber;
  if (h.arabicnumber == null) return null;
  const [whole, frac] = String(h.arabicnumber).split('.');
  return frac ? whole + String.fromCharCode(96 + Number(frac)) : whole;
}

// Load and pre-process all downloaded hadith collections.
// Extracts just the matn (main text) from each hadith, stripping the isnad.
function loadHadithCorpus() {
  if (!existsSync(HADITH_DIR)) return [];

  const corpus = [];
  // The Arabic collections only: hadith_data/ also holds the Urdu and Bengali editions (urd-*, ben-*)
  // and the Quran translations since 7 Oct 2026 (scripts/setup_hadith.js).
  for (const file of readdirSync(HADITH_DIR).filter(f => COLLECTION_NAMES[f.replace('.json', '')])) {
    const id = file.replace('.json', '');
    const collectionName = COLLECTION_NAMES[id] ?? id;
    let data;
    try {
      data = JSON.parse(readFileSync(path.join(HADITH_DIR, file), 'utf8'));
    } catch { continue; }

    for (const h of (data.hadiths ?? [])) {
      const matn = extractMatn(h.text ?? '');
      const matnWords = matn.split(/\s+/).filter(Boolean);
      if (matnWords.length < 5) continue;
      const number = sunnahNumber(id, h);
      corpus.push({
        collection: collectionName,
        collectionId: id,
        number,
        matn,
        matnWords,
        link: number ? `https://sunnah.com/${id.replace('ara-', '')}:${number}` : null,
      });
    }
  }
  return corpus;
}

// ---- Authoritative sunnah.com link resolution ------------------------------
//
// The local corpus matches the hadith *text* correctly but stores a sequential
// hadith number, while sunnah.com URLs use a different numbering for some
// collections (notably Sahih Muslim uses Abdul-Baqi numbering — the Arafah-fasting
// hadith is sequential 2746 in the corpus but muslim:1162a on sunnah.com). There is
// no free Abdul-Baqi<->sequential mapping, so instead of *constructing* a URL from a
// number we ask sunnah.com directly: search its site for the matn text and read back
// the real permalink it returns. The number/link then come from sunnah.com itself and
// cannot disagree with the page they point to.

// sunnah.com collection slugs we recognise (local corpus ids minus the "ara-" prefix
// already match these; extras cover collections Claude may name without a corpus match).
const SUNNAH_SLUGS = new Set([
  'bukhari', 'muslim', 'abudawud', 'nasai', 'ibnmajah', 'tirmidhi',
  'malik', 'ahmad', 'darimi', 'nawawi40', 'riyadussalihin', 'adab', 'mishkat',
]);

// Which search result a card links to. The collection the imam or Claude named comes first,
// best-scoring within it (none there: null, so the local link stays). With none named, the
// best-ranked collection among results scoring within 0.1 of the best: "لا يلدغ المؤمن من جحر
// واحد مرتين" is in Bukhari 6133, Muslim 2998 and Abu Dawud 4862 alike, and the card named
// Abu Dawud only because sunnah.com listed it first (2 Oct 2026 Makkah).
const COLLECTION_RANK = ['bukhari', 'muslim', 'abudawud', 'tirmidhi', 'nasai', 'ibnmajah', 'malik', 'ahmad', 'darimi', 'riyadussalihin', 'mishkat', 'nawawi40', 'adab'];
function pickSunnahResult(results, preferredSlug = null) {
  const pool = preferredSlug ? results.filter(r => r.slug === preferredSlug) : results;
  if (!pool.length) return null;
  const best = Math.max(...pool.map(r => r.score));
  const rank = r => (preferredSlug ? 0 : COLLECTION_RANK.indexOf(r.slug) + 1 || COLLECTION_RANK.length + 1);
  return pool.filter(r => r.score >= best - (preferredSlug ? 0 : 0.1))
    .sort((a, b) => rank(a) - rank(b) || b.score - a.score)[0];
}

const SLUG_DISPLAY = {
  bukhari: 'Sahih al-Bukhari', muslim: 'Sahih Muslim', abudawud: 'Sunan Abu Dawud',
  nasai: "Sunan an-Nasa'i", ibnmajah: 'Sunan Ibn Majah', tirmidhi: 'Jami` at-Tirmidhi',
  malik: 'Muwatta Malik', ahmad: 'Musnad Ahmad',
  // Not on sunnah.com: named by the imam ("أخرجه الطبراني", "رواه الحاكم") and returned by
  // Claude as a bare slug, which the badge showed as-is ("Collection: tabarani").
  tabarani: 'At-Tabarani', hakim: 'Al-Mustadrak (al-Hakim)', bayhaqi: 'Al-Bayhaqi',
  darimi: 'Sunan ad-Darimi', ibnhibban: 'Sahih Ibn Hibban',
};
const slugToDisplay = slug => SLUG_DISPLAY[slug] ?? slug;

// Map a collection display name (from Claude or the corpus) to a sunnah.com slug.
function collectionToSlug(name) {
  if (!name) return null;
  const n = name.toLowerCase();
  if (n.includes('bukhari')) return 'bukhari';
  if (n.includes('muslim')) return 'muslim';
  if (n.includes('tirmidhi') || n.includes('tirmizi') || n.includes('tirmidzi')) return 'tirmidhi';
  if (n.includes('abu dawud') || n.includes('abu dawood') || n.includes('abudawud') || n.includes('abi dawud')) return 'abudawud';
  if (n.includes('nasa')) return 'nasai';
  if (n.includes('ibn majah') || n.includes('ibn-e-majah') || n.includes('ibnmajah') || n.includes('ibn maja')) return 'ibnmajah';
  if (n.includes('muwatta') || n.includes('malik')) return 'malik';
  if (n.includes('ahmad')) return 'ahmad';
  return null;
}

// On-disk cache so repeat hadiths / re-runs cost no network requests.
const SUNNAH_CACHE_FILE = path.join(HADITH_DIR, '.sunnah_link_cache.json');
let _sunnahCache = null;
function loadSunnahCache() {
  if (_sunnahCache) return _sunnahCache;
  try { _sunnahCache = JSON.parse(readFileSync(SUNNAH_CACHE_FILE, 'utf8')); }
  catch { _sunnahCache = {}; }
  return _sunnahCache;
}

// Resolve the canonical sunnah.com permalink for a hadith by searching sunnah.com for
// its (un-diacritized) matn text. Returns {collection_slug, hadith_number, link} or null.
// Resilient: any network/timeout error returns null and is NOT cached (so it retries);
// a definitive "no result" IS cached. Callers fall back to the local-corpus link on null.
async function resolveSunnahLink(detectedText, preferredSlug = null) {
  const norm = normalizeArabic(detectedText ?? '').trim();
  const words = norm.split(/\s+/).filter(Boolean);
  if (words.length < 4) return null; // too short to search reliably

  const cache = loadSunnahCache();
  // v2: results text-verified; v3 (4 Oct 2026): with no collection named, ranked by collection
  const cacheKey = (preferredSlug ? 'v2::' : 'v3::') + (preferredSlug ?? '*') + '::' + norm;
  if (Object.prototype.hasOwnProperty.call(cache, cacheKey)) return cache[cacheKey];

  let resolved = null;
  let gotResponse = false;
  try {
    // A focused query (first ~12 content words) keeps sunnah.com's search specific.
    const q = words.slice(0, 12).join(' ');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    const res = await fetch('https://sunnah.com/search?q=' + encodeURIComponent(q), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 'Accept': 'text/html' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      gotResponse = true;
      const html = await res.text();
      // sunnah.com search matches words loosely, so a result is only a candidate if its
      // Arabic actually carries the quoted matn. Taking the first hit in the expected
      // collection linked "من صلى علي صلاة واحدة…" to Abu Dawud 5085 — Aisha describing the
      // night prayer — which merely shares common words. Score each result by the share of
      // the query's word PAIRS found in its Arabic: word order separates the real hadith
      // from one that happens to use the same vocabulary.
      const pairs = ws => ws.slice(1).map((w, i) => ws[i] + ' ' + w);
      const qPairs = pairs(q.split(' '));
      const results = [];
      for (const part of html.split('actualHadithContainer').slice(1)) {
        const m = part.match(/href="\/([a-z]+):(\d+[a-z]?)"/); // permalink, e.g. /muslim:1162a
        if (!m || !SUNNAH_SLUGS.has(m[1])) continue;
        const ar = part.match(/arabic_text_details[^>]*>([\s\S]*?)<\/span>\s*<\/div>/)?.[1] ?? '';
        const have = new Set(pairs(normalizeArabic(ar.replace(/<[^>]+>/g, ' ')).split(/\s+/).filter(Boolean)));
        const score = qPairs.filter(p => have.has(p)).length / Math.max(qPairs.length, 1);
        if (score >= 0.5) results.push({ slug: m[1], number: m[2], score });
      }
      const pick = pickSunnahResult(results, preferredSlug);
      if (pick) {
        resolved = {
          collection_slug: pick.slug,
          hadith_number: pick.number,
          link: `https://sunnah.com/${pick.slug}:${pick.number}`,
        };
      }
    }
  } catch { /* network/timeout — leave resolved null, do not cache */ }

  if (gotResponse) { cache[cacheKey] = resolved; try { writeFileSync(SUNNAH_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8'); } catch {} }
  return resolved;
}

// Fetch a resolved hadith's sunnah.com page once and keep what the pipeline reads from it:
// the narrator line, the published English and the Arabic matn (cached as `page::`).
//  - English: without it the English under a Hadith card is whatever Claude produced while
//    translating the surrounding prose — a paraphrase of the imam's recitation rather than
//    the published translation of the hadith itself.
//  - Arabic: tells which of the imam's words the published hadith actually contains, so a
//    swap never replaces his words with a version that lacks some of them (Muslim 1141a has
//    no "وذكر لله", which the imam said).
//
// Page shape:
//   <div class="english_hadith_full">
//     <div class=hadith_narrated><p>Anas said:</div>
//     <div class=text_details>The Apostle of Allah (ﷺ) performed ablution ...</div>
//   </div> … <span class="arabic_text_details arabic">…</span>
// The `english_hadith_full` block is isolated first because `arabic_text_details` would
// otherwise match the same `text_details` suffix and return the Arabic.
const decodeEntities = t => t
  .replace(/<[^>]+>/g, '')        // drop stray inline tags (<b>, <a>, unclosed </b>)
  .replace(/&quot;/g, '"').replace(/&#039;|&apos;/g, "'")
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();
async function fetchSunnahPage(slug, number) {
  if (!slug || !number) return null;
  const cache = loadSunnahCache();
  const key = `page::${slug}:${number}`;
  if (Object.prototype.hasOwnProperty.call(cache, key)) return cache[key];

  let page = null, gotResponse = false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12_000);
    const res = await fetch(`https://sunnah.com/${slug}:${number}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', 'Accept': 'text/html' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      gotResponse = true;
      const html = await res.text();
      const scope = html.match(/class=["']?english_hadith_full["']?[^>]*>([\s\S]*?)<div class=["']?clear/i)?.[1] ?? '';
      const narrated = scope.match(/class=["']?hadith_narrated[^>]*>\s*(?:<p>)?\s*([^<]+)/i)?.[1];
      const english = scope.match(/class=["']?text_details["']?[^>]*>([\s\S]*?)<\/div>/i)?.[1];
      const arabic = html.match(/class=["']?arabic_text_details[^>]*>([\s\S]*?)<\/span>\s*<\/div>/i)?.[1];
      page = {
        narrated: narrated ? decodeEntities(narrated) : null,
        english: english ? decodeEntities(english) || null : null,
        // The span can run on into the page's grade and reference lines; the matn ends at
        // the first Latin word.
        arabic: arabic ? decodeEntities(arabic).replace(/[\u200f\u200e]/g, '').split(/[A-Za-z]{3,}/)[0].trim() || null : null,
      };
    }
  } catch { /* network/timeout — leave null, do not cache */ }

  if (gotResponse) { cache[key] = page; try { writeFileSync(SUNNAH_CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8'); } catch {} }
  return page;
}

// The cached page only, for offline checks (check_english.js); null when never fetched.
function cachedSunnahPage(slug, number) {
  return loadSunnahCache()[`page::${slug}:${number}`] ?? null;
}

async function fetchSunnahTranslation(slug, number) {
  return (await fetchSunnahPage(slug, number))?.english ?? null;
}

// Fetch the narrator from a resolved sunnah.com hadith page (cached). Scan-detected
// hadiths have no narrator (only Claude's signal-phrase path fills one); sunnah.com
// states it on the page ("Narrated Abu Bakr:"), so we can backfill it from the lookup.
//
// Parse sunnah.com's narrator line ("Narrated X:", "X reported …") and the start of the
// English text into the name to show. Pure, so the rules can change without refetching.
// Returns { narrator, companion, successor }: `successor` is true when the first-named
// narrator is a later link in the chain who reports FROM a Companion — Tirmidhi 2910 is
// "Narrated Muhammad bin Ka'b Al-Qurazi: I heard 'Abdullah bin Mas'ud saying…" (a Tabi'i
// hearing Ibn Mas'ud), and Tirmidhi 3585 is "`Amr bin Shu`aib narrated from his father, from
// his grandfather". Showing the first name made the card credit the successor.
function parseSunnahNarrator(narrated, lead = '') {
  let txt = (narrated ?? '').replace(/\s+/g, ' ').trim();
  if (!txt) return { narrator: null, companion: null, successor: false };
  // Strip leading narration framing: "Narrated X:", "It was narrated that X said:",
  // "It has been narrated on the authority of X who …", "On the authority of X ...".
  txt = txt.replace(/^it (?:is|was|has been) narrated(?: on the authority of| from)?(?: that)?\s*/i, '');
  txt = txt.replace(/^(?:it was )?narrated\s*/i, '');
  txt = txt.replace(/^on the authority of\s*/i, '');
  const cut = s => s.split(/\s+(?:who|reported|narrated|said|says|relates|relating|that|as saying)\b|\s*[:(]/i)[0]
    .replace(/[\s,:]+$/, '').trim();
  // "`Amr bin Shu`aib narrated from his father, from his grandfather" — the family isnad is
  // known by that whole phrase; the Companion is the grandfather, whom the page never names.
  const chain = txt.match(/^(.+?) (?:narrated|reported) from his father,? (?:from|on the authority of) his grandfather/i);
  if (chain) {
    const name = cut(chain[1]);
    return { narrator: `${name} from his father, from his grandfather`, companion: null, successor: true };
  }
  // "Salamah bin 'Ubaidullah … narrated from his father -and he was a Companion-" — the
  // Companion is the father, named inside the son's name.
  const fromFather = txt.match(/^\S+ (?:bin|ibn|b\.) (.+?) (?:narrated|reported) from his father/i);
  if (fromFather) return { narrator: cut(fromFather[1]), companion: cut(fromFather[1]), successor: false };
  // "Al-Hasan narrated from Abu Hurairah that the Messenger of Allah (s.a.w) said:" (Tirmidhi 2305):
  // the first name is a Successor, the Companion is the one he narrates from. The card showed
  // "Al-Hasan" (2 Oct 2026 Madinah), though the imam named Abu Hurairah himself.
  const from = txt.match(/^(.+?) (?:narrated|reported) (?:from|on the authority of) (?!his )(.+?)(?: that\b| who\b| saying\b|:|,)/i);
  if (from) return { narrator: cut(from[1]), companion: cut(from[2]), successor: true };
  // Cut at the reporting clause: "Sa'd b. Abu Waqqas reported Allah's Messenger (ﷺ) as
  // saying" and "Salman who" were shown whole as the narrator's name.
  const first = cut(txt) || null;
  // "Narrated Thabit: that he heard Anas saying" / "Narrated X: I heard Y saying" — Y is the
  // Companion, unless Y is the Prophet himself.
  const heard = (lead ?? '').replace(/<[^>]+>/g, '').replace(/^[\s"'“‘]+/, '')
    .match(/^(?:that )?(?:he |she )?(?:I )?heard (.+?) (?:saying|say|said|narrate|narrating|reporting)\b/i);
  if (heard && !/messenger|prophet|apostle|allah\b/i.test(heard[1])) {
    return { narrator: first, companion: cut(heard[1].replace(/^[\s"'“‘]+/, '')), successor: true };
  }
  // The Successor tells what he saw of a Companion or heard from them (18 Sep 2026): Bukhari 7324
  // "Narrated Muhammad: We were with Abu Huraira …" is Abu Hurairah's own account, and Abu Dawud
  // 5004 "Narrated AbdurRahman ibn AbuLayla: The Companions of the Prophet (ﷺ) told us …" is theirs.
  const text = (lead ?? '').replace(/<[^>]+>/g, '').replace(/^[\s"'“‘]+/, '');
  if (/^the companions of the prophet\b[^.]{0,12} (?:told|informed|narrated to) us/i.test(text)) {
    return { narrator: first, companion: 'Companions of the Prophet ﷺ', successor: true };
  }
  const withC = text.match(/^(?:we|i) (?:were|was) (?:sitting )?with (.+?)(?: while| when| in| at|,|\.| and)/i);
  if (withC && !/messenger|prophet|apostle|allah\b/i.test(withC[1])) {
    return { narrator: first, companion: cut(withC[1]), successor: true };
  }
  return { narrator: first, companion: first, successor: false };
}

// Distinctive name tokens, reduced to consonants so transliterations compare equal
// ("Shu`aib" = "Shu'ayb", "Mas'ud" = "Masud", "Hurayrah" = "Huraira"). Kinship words and the ubiquitous
// "Abdullah" are ignored: they say nothing about which person is meant.
const NAME_STOP = new Set(['bin', 'ibn', 'b', 'bint', 'abu', 'abi', 'al', 'from', 'his', 'her', 'father',
  'grandfather', 'and', 'abd', 'abdullah', 'abdallah', 'allah', 'umm', 'the', 'ummul', 'muminin']);
const nameKeys = s => new Set((s ?? '').toLowerCase().replace(/[^a-z\s-]/g, '').split(/[\s-]+/)
  .filter(w => w && !NAME_STOP.has(w))
  .map(w => w.replace(/^al/, '').replace(/o/g, 'u').replace(/e/g, 'i'))
  // A leading vowel is kept: 'Umar and 'Amr differ only there.
  .map(w => w[0] + w.slice(1).replace(/[aeiouyw]/g, '').replace(/(.)\1+/g, '$1').replace(/(.)h$/, '$1'))
  .filter(k => k.length >= 2));
const sameName = (a, b) => { const B = nameKeys(b); return [...nameKeys(a)].some(k => B.has(k)); };

// Which narrator a card shows, given the page's parse and Claude's narrator (from memory,
// which the imam usually says aloud: "عن ابن مسعود"). The page is the authority for who
// narrated THAT hadith — Claude named Salman for Bukhari's ribat hadith, which is Sahl ibn
// Sa'd's. But when the page's first name is a successor, Claude's Companion is the right
// name to show, as long as it is one of the people on that chain.
// "'Amr b. al-'As" → "amr ibn al-as": names compared without quote marks, with b./bin as ibn.
const plainName = s => (s ?? '').toLowerCase().replace(/[`'’ʿʾ]/g, '').replace(/\b(?:b\.|bin)\s/g, 'ibn ').replace(/\s+/g, ' ').trim();

// No narrator line on the page: none at all, rather than Claude's guess (see resolveSunnahLinksForRefs).
function chooseNarrator(page, claudeNarrator) {
  if (!page?.narrator) return null;
  // sunnah.com can name the father for the son: "'Amr b. al-'As reported" on Muslim 1054, whose
  // chain ends عن عبد الله بن عمرو (2 Oct 2026 Madinah). When Claude's narrator is
  // "<name> ibn <the page's name>", the page dropped the first name: Claude's is shown.
  if (claudeNarrator && plainName(claudeNarrator).endsWith(` ibn ${plainName(page.narrator)}`)) return claudeNarrator;
  if (!page.successor) return page.narrator;
  if (claudeNarrator && sameName(claudeNarrator, page.companion)) return claudeNarrator;
  // Claude naming the Successor too is no reason to show him when the page names the Companion.
  if (claudeNarrator && !page.companion && sameName(claudeNarrator, page.narrator)) return claudeNarrator;
  return page.companion ?? page.narrator;
}

async function fetchSunnahNarrator(slug, number) {
  const page = await fetchSunnahPage(slug, number);
  return page?.narrated ? parseSunnahNarrator(page.narrated, (page.english ?? '').slice(0, 200)) : null;
}

// Replace each hadith ref's collection/number/link with the canonical sunnah.com
// permalink resolved from the matn. Mutates refs in place; leaves the existing
// local-corpus number/link untouched when sunnah.com returns no matching result.
// Also backfills a narrator from the resolved page when the ref lacks one.
// The collection the imam names right after quoting a hadith ("… رواه مسلم"). Imams almost
// always say where a hadith is from, and that is more reliable than Claude's recollection:
// a matn found in several collections was carded as Ibn Majah while the imam said Muslim.
const IMAM_ATTRIBUTION = [
  // "الشيخان" (the two Shaykhs) and "الصحيحين" (the two Sahihs) mean Bukhari and Muslim.
  [/^البخاري|^متفق عليه|^الشيخان|^الصحيحين/, 'bukhari'], [/^مسلم/, 'muslim'], [/^الترمذي/, 'tirmidhi'],
  [/^ابو داود/, 'abudawud'], [/^النسائي/, 'nasai'], [/^ابن ماج/, 'ibnmajah'],
  [/^الامام احمد|^احمد/, 'ahmad'], [/^مالك/, 'malik'],
];
// "متفق عليه", "الشيخان", "الصحيحين", "البخاري ومسلم": in both Bukhari and Muslim.
const BOTH_SAHIHS = /^متفق عليه|^الشيخان|^الصحيحين|^البخاري ومسلم/;
// "رواه الامام البخاري ومسلم", "أخرجه في الصحيحين", "في صحيح الامام البخاري": a title, "in" or
// "the Sahih of" can come before the name (11 Sep's and Sudais's "each of you is a shepherd" were
// carded as Claude's Abu Dawud).
function collectionNamed(text) {
  const name = text.trim().replace(/^(?:في\s+)?(?:(?:صحيح|مسند|سنن|جامع|موطا)\s+)?(?:الامام\s+)?/, '');
  for (const [re, slug] of IMAM_ATTRIBUTION) if (re.test(name)) return { slug, both: BOTH_SAHIHS.test(name) };
  return null;
}
const unique = (hay, needle) => { const at = hay.indexOf(needle); return at >= 0 && hay.indexOf(needle, at + 1) < 0 ? at : -1; };
function imamAttribution(transcript, detectedText) {
  const tNorm = normalizeArabic(transcript);
  const dWords = normalizeArabic(detectedText ?? '').split(/\s+/).filter(Boolean);
  // Right after the hadith: "… رواه مسلم".
  for (const n of [5, 4, 3]) {
    if (dWords.length < n) continue;
    const tail = dWords.slice(-n).join(' ');
    const at = unique(tNorm, tail);
    if (at < 0) continue; // absent or ambiguous
    const after = tNorm.slice(at + tail.length).trim().split(/\s+/).slice(0, 6).join(' ');
    const m = after.match(/^(?:\S+\s+){0,2}?(?:رواه|اخرجه|خرجه)\s+(.*)$|^(متفق عليه)/);
    if (m) return collectionNamed(m[1] ?? m[2]);
    break;
  }
  // Or before it, introducing it: "الحديث الذي أخرجه الترمذي في جامعه … عن صخر الغامدي … أنه قال:"
  // (4 Sep 2026 Makkah, carded as Abu Dawud). Only when the chain ("عن …") follows the name with no
  // sentence ending between, so the "رواه مسلم." closing the hadith before is not taken.
  for (const n of [5, 4, 3]) {
    if (dWords.length < n) continue;
    const at = unique(tNorm, dWords.slice(0, n).join(' '));
    if (at < 0) continue;
    const before = tNorm.slice(0, at).split(/\s+/).slice(-30).join(' ');
    // "في مسند الإمام أحمد قال ابن مسعود: خط لنا…" (11 Sep 2026 Makkah, carded as Tirmidhi 2454, another
    // hadith): "in the Musnad / Sunan / Jami' of" introduces the next hadith, and its chain may start
    // with "قال X" as well as "عن X"; after "رواه" a "قال" is more often the next hadith's opening.
    const m = [...before.matchAll(/(?:رواه|اخرجه|خرجه)\s+|في\s+(?=(?:صحيح|مسند|سنن|جامع|موطا)\s|الصحيحين)/g)].at(-1);
    if (!m) return null;
    const rest = before.slice(m.index + m[0].length);
    const chain = m[0].startsWith('في') ? /(^|\s)(?:عن|قال)\s/ : /(^|\s)عن\s/;
    if (/[.!؟?]/.test(rest) || !chain.test(rest)) return null;
    return collectionNamed(rest);
  }
  return null;
}

// corpus: loadHadithCorpus(), for the number of a hadith in the collection the imam named when
// sunnah.com's search does not return it there.
async function resolveSunnahLinksForRefs(refs, transcript = null, corpus = null) {
  for (const ref of refs) {
    const claudeSlug = collectionToSlug(ref.collection);
    const imam = transcript ? imamAttribution(transcript, ref.detected_text) : null;
    const imamSlug = imam?.slug ?? null;
    let sunnah = null;
    if (imamSlug) sunnah = await resolveSunnahLink(ref.detected_text, imamSlug);
    if (!sunnah && imam?.both) sunnah = await resolveSunnahLink(ref.detected_text, 'muslim');
    // The imam named a collection: a search that misses it there never falls back to another
    // one (4 Sep 2026 Makkah: the birds hadith, "أخرجه الترمذي", carded as Claude's Ibn Majah,
    // the search not returning Tirmidhi's wording). Our copy of his collection gives the number
    // (Bukhari, Abu Dawud, Tirmidhi, Nasa'i and Ibn Majah number as sunnah.com does; sunnahNumber).
    if (!sunnah && imamSlug && corpus) {
      const h = findMatchingHadith(ref.detected_text, corpus.filter(h => h.collectionId === `ara-${imamSlug}`));
      if (h?.link) sunnah = { collection_slug: imamSlug, hadith_number: h.number, link: h.link, corpus: true };
    }
    // The imam named none: the best-ranked collection holding his words (Bukhari, then
    // Muslim, …; pickSunnahResult) before Claude's own guess of a collection.
    if (!sunnah && !imamSlug) sunnah = await resolveSunnahLink(ref.detected_text, null);
    if (!sunnah && !imamSlug) sunnah = await resolveSunnahLink(ref.detected_text, claudeSlug);
    // A link confirmed on an earlier run stays when today's search finds nothing: search
    // results drift, and three published links (Ibn Majah 425, 1642, Tirmidhi 3585) no
    // longer come back although their pages carry the imam's words. Their narrator and
    // English are still read from that page.
    const kept = !sunnah && ref.verification === 'sunnah_search'
      && (ref.link ?? '').match(/sunnah\.com\/([a-z]+):(\w+)$/);
    if (kept && (!imamSlug || kept[1] === imamSlug)) sunnah = { collection_slug: kept[1], hadith_number: kept[2], link: ref.link };
    if (!sunnah && imamSlug) {
      ref.collection = slugToDisplay(imamSlug);
      // A number, link and published text from another collection belong to another hadith: the
      // card names the imam's collection with no link rather than them (11 Sep 2026 Makkah).
      if (!(ref.link ?? '').includes(`sunnah.com/${imamSlug}:`)) {
        for (const k of ['hadith_number', 'link', 'translation', 'published_arabic']) ref[k] = null;
        ref.verification = 'imam_collection_unlinked';
        ref.note = 'The collection the imam named; not found there on sunnah.com or in the local corpus';
      }
    }
    // No sunnah.com page to confirm a narrator: the card names none rather than Claude's guess
    // (18 Sep 2026 Madinah: Sa'd ibn Abi Waqqas for an-Nasa'i's "whoever terrifies the people of
    // Madinah", which is as-Sa'ib ibn Khallad's). Claude's stays in narrator_claude.
    if (!sunnah) {
      if (!('narrator_claude' in ref)) ref.narrator_claude = ref.narrator ?? null;
      ref.narrator = null;
    }
    if (!sunnah && SLUG_DISPLAY[(ref.collection ?? '').trim().toLowerCase()]) {
      ref.collection = SLUG_DISPLAY[ref.collection.trim().toLowerCase()];
    }
    if (sunnah) {
      ref.collection = slugToDisplay(sunnah.collection_slug);
      ref.hadith_number = sunnah.hadith_number;
      ref.link = sunnah.link;
      ref.verification = sunnah.corpus ? 'imam_collection' : 'sunnah_search';
      ref.note = sunnah.corpus ? 'The collection the imam named; number from the local corpus' : 'Link verified via sunnah.com search';
      // The resolved page states the narrator of THAT hadith (see chooseNarrator). Claude's
      // own narrator is kept in narrator_claude, so a re-run still has it to compare with
      // after ref.narrator has been overwritten.
      if (!('narrator_claude' in ref)) ref.narrator_claude = ref.narrator ?? null;
      ref.narrator = chooseNarrator(await fetchSunnahNarrator(sunnah.collection_slug, sunnah.hadith_number), ref.narrator_claude);
      // Always prefer the published translation over Claude's paraphrase of the prose.
      const page = await fetchSunnahPage(sunnah.collection_slug, sunnah.hadith_number);
      if (page?.english) ref.translation = page.english;
      if (page?.arabic) ref.published_arabic = page.arabic;
    }
    // The imam said it is in both (متفق عليه): the card names both Sahihs, linked to one.
    if (imam?.both && /^(?:bukhari|muslim)$/.test(sunnah?.collection_slug ?? '')) ref.in_both_sahihs = true;
    else delete ref.in_both_sahihs;
  }
  return refs;
}

// Extract just the matn from a full hadith text (strips the isnad).
// Returns text AFTER the prophet attribution, not including it — so the corpus
// matn contains only the actual speech, not "قال رسول الله صلى الله عليه وسلم".
// This prevents attribution phrases in the transcript from scoring against corpus hadiths.
function extractMatn(text) {
  const norm = normalizeArabic(text);

  // Each pattern matches the attribution chain. We return text from AFTER the match.
  // The trailing `(?:قال\s+|يقول\s+)?` skips the reporting verb before the actual words.
  const patterns = [
    /(?:قال|يقول)\s+(?:رسول\s+الله|النبي|المصطفى)\s+(?:صلى\s+الله\s+عليه\s+وسلم\s+)?(?:قال\s+|يقول\s+)?/,
    /(?:ان|إن)\s+(?:رسول\s+الله|النبي)\s+(?:صلى\s+الله\s+عليه\s+وسلم\s+)?(?:قال\s+|يقول\s+)?/,
    /سمعت\s+(?:رسول\s+الله|النبي)\s+(?:صلى\s+الله\s+عليه\s+وسلم\s+)?(?:يقول\s+|قال\s+)?/,
    // "عن النبي ﷺ قال" too: without it Abu Dawud 1479's matn was the ayah it quotes, after its last قال
    /عن\s+(?:النبي|رسول\s+الله)\s+(?:صلى\s+الله\s+عليه\s+وسلم\s+)?(?:(?:انه|أنه)\s+(?:قال\s+)?|(?:قال|يقول)\s+)/,
    /(?:ان|إن)\s+الله\s+(?:قال|يقول)\s+/,    // Hadith Qudsi
  ];

  for (const pat of patterns) {
    const m = norm.match(pat);
    if (m) {
      const after = norm.slice(m.index + m[0].length).trim();
      if (after.split(/\s+/).filter(Boolean).length >= 3) return after;
    }
  }

  // Fallback: take text after the last قال if it's deep enough in the text
  const lastQala = norm.lastIndexOf('قال');
  if (lastQala > norm.length * 0.4) return norm.slice(lastQala + 4).trim();
  return norm;
}

// ---- Hadith the imam does not name -----------------------------------------
//
// Imams weave hadith into their own sentences without "قال رسول الله ﷺ", and those got no card
// (about 16 in Madinah's 25 Sep khutbah: Muslim 2834, Bukhari 3327, Tirmidhi 2526 …). Runs of
// 4-grams shared with one hadith of the local collections find them, as the Quran pre-scan finds
// ayaat. This replaced (5 Oct 2026) a sliding Jaccard window whose finds were wrong in all seven
// test khutbahs; each filter answers one of those:
//  - a 4-gram found in more than HADITH_COMMON hadith says nothing about which one ("صلى الله
//    عليه وسلم", "قال رسول الله"), and a find needs HADITH_MIN_WORDS matched words besides the
//    formula words (21 Aug: the imam's own sentences matched pieces of "النبي ﷺ");
//  - ritual formulas (isLiturgicalFormula) and the Eid takbir;
//  - words in a Quran zone (a verse a hadith also quotes: 2:201, 37:180, Sudais's 2:185 as Abu
//    Dawud 2316);
//  - a span a hadith the imam introduced already covers.
// transcript: the transcript as pipeline.js splits it into words (quranZones index those words).
const HADITH_GRAM = 4, HADITH_MIN_WORDS = 8, HADITH_COMMON = 150;
const HADITH_FORMULA = new Set(['صلي', 'الله', 'عليه', 'وسلم', 'رسول', 'النبي', 'قال', 'يقول', 'عن', 'رضي', 'عنه',
  'عنها', 'اكبر', 'سبحانه', 'تعالي', 'وتعالي', 'عز', 'وجل']);
const hadithKey = w => normalizeArabic(w).replace(/[^\u0621-\u064A]/g, '').replace(/ى/g, 'ي').replace(/ة/g, 'ه');

function scanTranscriptForHadith(transcript, claudeHadithRefs, hadithCorpus, quranZones = []) {
  if (!hadithCorpus.length) return [];
  const words = transcript.split(/\s+/).filter(Boolean);
  const keys = words.map(hadithKey);
  const inZone = new Uint8Array(words.length);
  for (const z of quranZones) if (z.end - z.start >= MIN_ZONE_WORDS) inZone.fill(1, z.start, z.end);
  // The words of the hadith the imam introduced (Claude's): every transcript 4-gram its text has,
  // so a word Claude cleaned up ("عينان لا تمس لا تمسهما") does not hide it.
  const claimed = new Uint8Array(words.length);
  const claudeGrams = new Set();
  for (const r of claudeHadithRefs) {
    const k = (r.detected_text ?? '').split(/\s+/).map(hadithKey).filter(Boolean);
    for (let p = 0; p + HADITH_GRAM <= k.length; p++) claudeGrams.add(k.slice(p, p + HADITH_GRAM).join(' '));
  }
  for (let i = 0; i + HADITH_GRAM <= keys.length; i++) {
    if (claudeGrams.has(keys.slice(i, i + HADITH_GRAM).join(' '))) claimed.fill(1, i, i + HADITH_GRAM);
  }

  const tGrams = new Map();
  for (let i = 0; i + HADITH_GRAM <= keys.length; i++) {
    if (inZone.subarray(i, i + HADITH_GRAM).some(Boolean)) continue;
    const g = keys.slice(i, i + HADITH_GRAM).join(' ');
    if (!keys[i]) continue;
    (tGrams.get(g) ?? tGrams.set(g, []).get(g)).push(i);
  }
  // One pass over the corpus: which hadith share which transcript 4-grams, and how many hadith
  // carry each of them.
  const df = new Map(), hits = new Map(); // hit: [transcript position, position in the hadith]
  hadithCorpus.forEach((h, hi) => {
    const k = h._keys ??= h.matnWords.map(hadithKey);
    const seen = new Set();
    for (let p = 0; p + HADITH_GRAM <= k.length; p++) {
      const g = k.slice(p, p + HADITH_GRAM).join(' ');
      const at = tGrams.get(g);
      if (!at) continue;
      if (!seen.has(g)) { seen.add(g); df.set(g, (df.get(g) ?? 0) + 1); }
      for (const i of at) (hits.get(hi) ?? hits.set(hi, []).get(hi)).push([i, p, g]);
    }
  });

  const candidates = [];
  for (const [hi, list] of hits) {
    const useful = list.filter(([, , g]) => df.get(g) <= HADITH_COMMON).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    // Runs: hits close together in the transcript and in the same order in the hadith (the
    // imam may add or drop a word or two).
    let run = null;
    const close = () => {
      if (!run) return;
      const matched = [...run.words].filter(i => !HADITH_FORMULA.has(keys[i]));
      if (matched.length >= HADITH_MIN_WORDS) candidates.push({ hi, start: run.start, end: run.end, matched: matched.length });
      run = null;
    };
    for (const [i, p] of useful) {
      if (run && i - run.lastI <= 6 && Math.abs((i - p) - (run.lastI - run.lastP)) <= 2 && p >= run.lastP) {
        run.end = Math.max(run.end, i + HADITH_GRAM);
      } else { close(); run = { start: i, end: i + HADITH_GRAM, words: new Set() }; }
      for (let w = i; w < i + HADITH_GRAM; w++) run.words.add(w);
      run.lastI = i; run.lastP = p;
    }
    close();
  }

  // The longest find wins a stretch of transcript; a tie goes to Bukhari, then Muslim, …
  const rank = h => { const r = COLLECTION_RANK.indexOf(h.collectionId.replace('ara-', '')); return r < 0 ? 99 : r; };
  candidates.sort((a, b) => b.matched - a.matched || rank(hadithCorpus[a.hi]) - rank(hadithCorpus[b.hi]));
  const taken = new Uint8Array(words.length), found = [];
  for (const c of candidates) {
    if (taken.subarray(c.start, c.end).some(Boolean)) continue;
    const span = c.end - c.start;
    if (claimed.subarray(c.start, c.end).filter(Boolean).length > span * 0.3) continue;
    const text = words.slice(c.start, c.end).join(' ');
    if (isLiturgicalPart(text)) continue;
    taken.fill(1, c.start, c.end);
    const h = hadithCorpus[c.hi];
    found.push({
      detected_text: text,
      narrator: null,
      collection: h.collection,
      hadith_number: h.number,
      link: h.link,
      confidence: Math.round((c.matched / span) * 100) / 100,
      detection_method: 'ngram',
      note: 'Found in the local corpus: the imam did not name it',
      _start: c.start,
    });
  }
  return found.sort((a, b) => a._start - b._start).map(({ _start, ...r }) => r);
}

// ---- Hadith the imam quotes and attributes aloud ------------------------------
//
// "وقال رسول الله صلى الله عليه وسلم: الدعاء هو العبادة. أخرجه أبو داود والترمذي وابن ماجه" (4 Sep 2026
// Makkah) got no card: three words are too few for the scan, and the analysis did not list it.
// What he quotes after "قال رسول الله ﷺ" and before "رواه / أخرجه <collection>" is a hadith when that
// collection (our copy) has those words in that order; a quote an earlier step found is skipped.
const SAID = /(?:^|\s)(?:قال|وقال|فقال|يقول|ويقول)\s+(?:رسول\s+الله|النبي|المصطفى)(?:\s+صلى\s+الله\s+عليه\s+وسلم)?\s*:?\s*/g;
function findAttributedHadith(transcript, refs, corpus) {
  if (!corpus?.length) return [];
  const words = transcript.split(/\s+/).filter(Boolean);
  const norm = words.map(w => normalizeArabic(w));
  const keysOf = text => (text ?? '').split(/\s+/).map(hadithKey).filter(Boolean).join(' ');
  const claimed = refs.map(r => keysOf(r.detected_text)).filter(Boolean);
  const found = [];
  for (let i = 0; i < words.length; i++) {
    if (!/^(?:رواه|اخرجه|خرجه)$/.test(norm[i].replace(/[^\u0621-\u064A]/g, ''))) continue;
    const named = collectionNamed(norm.slice(i + 1, i + 5).join(' '));
    if (!named) continue;
    const from = Math.max(0, i - 40), before = norm.slice(from, i).join(' ');
    const m = [...before.matchAll(SAID)].at(-1);
    if (!m) continue;
    const start = from + before.slice(0, m.index + m[0].length).split(/\s+/).filter(Boolean).length;
    const quote = words.slice(start, i).join(' ').replace(/[.،,:؛!؟?]+$/, ''), qk = keysOf(quote);
    const n = qk.split(' ').length;
    if (!qk || n < 2 || n > 40 || claimed.some(c => c.includes(qk) || qk.includes(c))) continue;
    const slugs = named.both ? ['bukhari', 'muslim'] : [named.slug];
    const h = corpus.filter(h => slugs.includes(h.collectionId.replace('ara-', '')))
      .filter(h => (h._keys ??= h.matnWords.map(hadithKey)).join(' ').includes(qk))
      .sort((a, b) => a.matnWords.length - b.matnWords.length)[0];
    if (!h) continue;
    found.push({ detected_text: quote, narrator: null, collection: h.collection, hadith_number: h.number, link: h.link,
      confidence: 1, detection_method: 'attribution', verification: 'imam_collection', note: 'Quoted and attributed by the imam; number from the local corpus' });
    claimed.push(qk);
  }
  return found;
}

// ---- Hadith deduplication ---------------------------------------------------

// Removes duplicate or near-duplicate hadith refs that arise when Claude detects
// the same hadith through multiple overlapping signal phrases. Keeps the entry with
// the most complete matn; drops any whose text is a subset of one already kept.
// Also drops entries with fewer than 8 words — those are pure signal phrases with
// no actual hadith content, not real references.
// Liturgy the khatib *performs* rather than *cites*. Every one of these is a genuine
// narrated hadith, so the corpus matches them correctly — but in a khutbah they are the
// closing ritual, not a quotation, and tagging them as cited hadiths puts a citation card
// on the imam's own du'a. This is the hadith-side counterpart to the minimum-word gate
// that keeps the basmala and isti'adha out of Quran zone refs.
//
// Deliberately a small curated set, not a general rule: the closing formulas of a khutbah
// are a genuinely closed class, and every entry here has to be a phrase that is always
// liturgy and never evidence. Matching is Jaccard, not substring, so wording and
// transcription variants still land. Add to it only with that test in mind.
const LITURGICAL_FORMULAS = [
  // Salawat Ibrahimiyyah — both halves, which the khatib recites as one unit
  'اللهم صل على محمد وعلى آل محمد كما صليت على إبراهيم وعلى آل إبراهيم إنك حميد مجيد',
  'وبارك على محمد وعلى آل محمد كما باركت على إبراهيم وعلى آل إبراهيم إنك حميد مجيد',
  // Closing du'a of essentially every khutbah (itself Quran 2:201, which the Quran
  // layer surfaces separately — suppressing the hadith card is what lets that card show)
  'ربنا آتنا في الدنيا حسنة وفي الآخرة حسنة وقنا عذاب النار',
  // Standard closing supplications
  'اللهم اغفر للمسلمين والمسلمات والمؤمنين والمؤمنات الأحياء منهم والأموات',
  // The khutbah's opening: the praise (khutbat al-haja), the shahada, and the hawqala and
  // istiftah the imam says as dhikr; each is a hadith's text too (Ibn Majah 1892, Muslim 868,
  // Nasa'i 3278, Ibn Majah 3878 and 1355), which the scan for hadith the imam doesn't name
  // would card (5 Oct 2026).
  'إن الحمد لله نحمده ونستعينه ونستغفره ونعوذ بالله من شرور أنفسنا ومن سيئات أعمالنا من يهده الله فلا مضل له ومن يضلل فلا هادي له',
  'وأشهد أن لا إله إلا الله وحده لا شريك له وأشهد أن محمدا عبده ورسوله',
  'وأشهد أن محمدا عبده ورسوله أرسله بالحق بشيرا ونذيرا بين يدي الساعة',
  'ولا حول ولا قوة إلا بالله العلي العظيم',
  'سبحانك اللهم وبحمدك وتبارك اسمك وتعالى جدك ولا إله غيرك ولا حول ولا قوة إلا بك',
  'سبحان ربك رب العزة عما يصفون وسلام على المرسلين والحمد لله رب العالمين',
].map(f => new Set(normalizeArabic(f).split(/\s+/).filter(Boolean)));

const LITURGICAL_MATCH_THRESHOLD = 0.55;

function isLiturgicalFormula(text) {
  const words = new Set(normalizeArabic(text ?? '').split(/\s+/).filter(Boolean));
  if (!words.size) return false;
  return LITURGICAL_FORMULAS.some(formula => {
    let intersect = 0;
    for (const w of words) if (formula.has(w)) intersect++;
    return intersect / (words.size + formula.size - intersect) >= LITURGICAL_MATCH_THRESHOLD;
  });
}

// A piece of one of them, or of two said one after the other: the scan finds parts ("من يهده الله
// فلا مضل له، ومن يضلل فلا هادي له") and runs ("… فلا هادي له، وأشهد أن لا إله إلا الله وحده").
// Also, for the scan only, the five pillars said as a list in the imam's own words (Arafah 2026):
// the content of "بني الإسلام على خمس" (Tirmidhi 2609), not a quotation of it (Meer, 5 Oct 2026).
// A hadith the imam introduces keeps its card: this is not in LITURGICAL_FORMULAS.
const foldKey = w => normalizeArabic(w).replace(/[^\u0621-\u064A]/g, '').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
const foldSet = text => new Set(text.split(/\s+/).map(foldKey).filter(Boolean));
const OWN_WORDS = [...LITURGICAL_FORMULAS.map(f => new Set([...f].map(foldKey))),
  foldSet('شهادة أن لا إله إلا الله وأن محمدا رسول الله وإقام الصلاة وإيتاء الزكاة وصوم رمضان وحج البيت من استطاع إليه سبيلا')];
const LITURGICAL_WORDS = new Set(OWN_WORDS.slice(0, -1).flatMap(f => [...f]));
function isLiturgicalPart(text) {
  const words = [...foldSet(text ?? '')];
  if (!words.length) return false;
  return OWN_WORDS.some(f => words.filter(w => f.has(w)).length >= words.length * 0.75)
    || words.filter(w => LITURGICAL_WORDS.has(w)).length >= words.length * 0.85;
}

// transcript: lets a short hadith the imam attributes aloud through the content-word gate below.
function deduplicateHadithRefs(refs, transcript = null) {
  const kept = [];
  for (const ref of refs) {
    // Only hadith the imam introduces become cards. Every hadith found solely by the corpus
    // scan across the seven test khutbahs was wrong: the imam's own sentences matched corpus
    // fragments on "النبي صلى الله عليه وسلم" (21 Aug), his dhikr and Eid takbir matched the
    // hadith containing them (Eid), a verse matched a hadith quoting it (Sudais 2:185 as Abu
    // Dawud 2316), and a paraphrase of the pillars of Islam got an unrelated Bukhari link
    // (Arafah). Old results keep those finds as detection_method 'scan'; the scan that replaced it
    // (5 Oct 2026, scanTranscriptForHadith) marks its finds 'ngram'.
    if (ref.detection_method === 'scan') continue;

    // Ritual closing formulas are matched correctly by the corpus but are not citations.
    if (isLiturgicalFormula(ref.detected_text)) continue;

    // Content check: strip the prophet attribution and measure what remains.
    // Pure attribution phrases ("الصحيح ان رسول الله صلى الله عليه وسلم") leave
    // < 4 content words; real hadiths (even short ones like "كلكم راع...") leave ≥ 4.
    // A short hadith he attributes aloud is a hadith: "الدعاء هو العبادة. أخرجه أبو داود والترمذي
    // وابن ماجه" (4 Sep 2026 Makkah) has three.
    const contentWords = extractMatn(ref.detected_text ?? '').split(/\s+/).filter(Boolean).length;
    if (contentWords < 4 && !(contentWords >= 2 && transcript && imamAttribution(transcript, ref.detected_text))) continue;

    const normText = normalizeArabic(ref.detected_text ?? '');
    const isDuplicate = kept.some(k => {
      const kNorm = normalizeArabic(k.detected_text ?? '');
      return kNorm.includes(normText) || normText.includes(kNorm);
    });
    if (!isDuplicate) kept.push(ref);
  }
  return kept;
}

// A hadith Claude named, with its collection and number from the local corpus when the text
// matches one there.
function matchClaudeHadithRef(ref, hadithCorpus) {
  const match = findMatchingHadith(ref.arabic_text ?? '', hadithCorpus);
  return {
    detected_text: ref.arabic_text,
    narrator: ref.narrator ?? null,
    collection: match ? match.collection : (ref.collection ?? null),
    hadith_number: match ? match.number : null,
    link: match ? match.link : null,
    confidence: match ? match.confidence : null,
    detection_method: 'signal_phrase',
    note: match ? 'Matched against local corpus' : 'Manual verification recommended',
  };
}

export {
  pickSunnahResult,
  matchClaudeHadithRef,
  loadHadithCorpus,
  deduplicateHadithRefs,
  findMatchingHadith,
  scanTranscriptForHadith,
  resolveSunnahLinksForRefs,
  isLiturgicalFormula,
  parseSunnahNarrator,
  chooseNarrator,
  nameKeys,
  fetchSunnahPage,
  cachedSunnahPage,
  extractMatn,
  imamAttribution,
  findAttributedHadith,
  slugToDisplay,
};
