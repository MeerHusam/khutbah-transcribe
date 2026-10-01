// Hadith (split out of pipeline.js): the local corpus, matching and scanning, sunnah.com links
// and narrators, and the filters that drop duplicate and liturgical refs.

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { normalizeArabic, wordOverlapScore } from './arabic.js';

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
};

// Load and pre-process all downloaded hadith collections.
// Extracts just the matn (main text) from each hadith, stripping the isnad.
function loadHadithCorpus() {
  if (!existsSync(HADITH_DIR)) return [];

  const corpus = [];
  for (const file of readdirSync(HADITH_DIR).filter(f => f.endsWith('.json'))) {
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
      corpus.push({
        collection: collectionName,
        collectionId: id,
        number: h.hadithnumber ?? h.arabicnumber,
        matn,
        matnWords,
        link: `https://sunnah.com/${id.replace('ara-', '')}:${h.hadithnumber}`,
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
  const cacheKey = 'v2::' + (preferredSlug ?? '*') + '::' + norm; // v2: results text-verified
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
      // Prefer the collection the imam or Claude named, best-scoring within it; with no
      // expectation, the best-scoring result. If the expected collection has no verified
      // hit, return null and keep the local link rather than risk a different hadith.
      const inPreferred = preferredSlug ? results.filter(r => r.slug === preferredSlug) : results;
      const pick = inPreferred.reduce((best, r) => (!best || r.score > best.score ? r : best), null);
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
function chooseNarrator(page, claudeNarrator) {
  if (!page?.narrator) return claudeNarrator ?? null;
  if (!page.successor) return page.narrator;
  if (claudeNarrator && (sameName(claudeNarrator, page.companion) || sameName(claudeNarrator, page.narrator))) {
    return claudeNarrator;
  }
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
function imamAttributionSlug(transcript, detectedText) {
  const tNorm = normalizeArabic(transcript);
  const dWords = normalizeArabic(detectedText ?? '').split(/\s+/).filter(Boolean);
  for (const n of [5, 4, 3]) {
    if (dWords.length < n) continue;
    const tail = dWords.slice(-n).join(' ');
    const at = tNorm.indexOf(tail);
    if (at < 0 || tNorm.indexOf(tail, at + 1) >= 0) continue; // absent or ambiguous
    const after = tNorm.slice(at + tail.length).trim().split(/\s+/).slice(0, 6).join(' ');
    const m = after.match(/^(?:\S+\s+){0,2}?(?:رواه|اخرجه|خرجه)\s+(.*)$|^(متفق عليه)/);
    if (!m) return null;
    // "رواه الامام البخاري ومسلم", "أخرجه في الصحيحين": a title or "in" can come before the
    // name (11 Sep's and Sudais's "each of you is a shepherd" were carded as Claude's Abu Dawud).
    const name = (m[1] ?? m[2]).trim().replace(/^(?:الامام|في)\s+/, '');
    for (const [re, slug] of IMAM_ATTRIBUTION) if (re.test(name)) return slug;
    return null;
  }
  return null;
}

async function resolveSunnahLinksForRefs(refs, transcript = null) {
  for (const ref of refs) {
    const claudeSlug = collectionToSlug(ref.collection);
    const imamSlug = transcript ? imamAttributionSlug(transcript, ref.detected_text) : null;
    let sunnah = null;
    if (imamSlug) sunnah = await resolveSunnahLink(ref.detected_text, imamSlug);
    if (!sunnah) sunnah = await resolveSunnahLink(ref.detected_text, claudeSlug);
    // A link confirmed on an earlier run stays when today's search finds nothing: search
    // results drift, and three published links (Ibn Majah 425, 1642, Tirmidhi 3585) no
    // longer come back although their pages carry the imam's words. Their narrator and
    // English are still read from that page.
    const kept = !sunnah && ref.verification === 'sunnah_search'
      && (ref.link ?? '').match(/sunnah\.com\/([a-z]+):(\w+)$/);
    if (kept) sunnah = { collection_slug: kept[1], hadith_number: kept[2], link: ref.link };
    if (!sunnah && SLUG_DISPLAY[(ref.collection ?? '').trim().toLowerCase()]) {
      ref.collection = SLUG_DISPLAY[ref.collection.trim().toLowerCase()];
    }
    if (sunnah) {
      ref.collection = slugToDisplay(sunnah.collection_slug);
      ref.hadith_number = sunnah.hadith_number;
      ref.link = sunnah.link;
      ref.verification = 'sunnah_search';
      ref.note = 'Link verified via sunnah.com search';
      // The resolved page states the narrator of THAT hadith (see chooseNarrator). Claude's
      // own narrator is kept in narrator_claude, so a re-run still has it to compare with
      // after ref.narrator has been overwritten.
      if (!('narrator_claude' in ref)) ref.narrator_claude = ref.narrator ?? null;
      const narr = chooseNarrator(await fetchSunnahNarrator(sunnah.collection_slug, sunnah.hadith_number), ref.narrator_claude);
      if (narr) ref.narrator = narr;
      // Always prefer the published translation over Claude's paraphrase of the prose.
      const page = await fetchSunnahPage(sunnah.collection_slug, sunnah.hadith_number);
      if (page?.english) ref.translation = page.english;
      if (page?.arabic) ref.published_arabic = page.arabic;
    }
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
    /عن\s+(?:النبي|رسول\s+الله)\s+(?:صلى\s+الله\s+عليه\s+وسلم\s+)?(?:انه|أنه)\s+(?:قال\s+)?/,
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

// Slide a window across the transcript and score every chunk against every
// hadith matn. Same O(1)-per-slide algorithm as the Quran scan.
function scanTranscriptForHadith(transcript, claudeHadithRefs, hadithCorpus) {
  if (!hadithCorpus.length) return [];

  const tWords = normalizeArabic(transcript).split(/\s+/).filter(Boolean);
  const tLen = tWords.length;

  const claudeNorm = new Set(
    claudeHadithRefs.map(r => normalizeArabic(r.detected_text ?? ''))
  );

  const candidates = [];

  for (const h of hadithCorpus) {
    const aWords = h.matnWords;
    const aLen = aWords.length;
    // Very short matn entries are too prone to matching common Islamic phrases
    // (e.g. the shahada). Short hadiths are reliably caught by Claude's signal-phrase
    // detection, so skip them in the scan.
    if (aLen < 8 || aLen > tLen) continue;

    const aWordSet = new Set(aWords);
    let freq = {}, uniqueCount = 0, intersect = 0;

    const addW = w => {
      if (!freq[w]) { freq[w] = 0; uniqueCount++; if (aWordSet.has(w)) intersect++; }
      freq[w]++;
    };
    const remW = w => {
      freq[w]--;
      if (freq[w] === 0) { delete freq[w]; uniqueCount--; if (aWordSet.has(w)) intersect--; }
    };
    const score = () => intersect / (uniqueCount + aWordSet.size - intersect);

    for (let j = 0; j < aLen; j++) addW(tWords[j]);

    let bestScore = score(), bestStart = 0;
    for (let i = 1; i <= tLen - aLen; i++) {
      remW(tWords[i - 1]);
      addW(tWords[i + aLen - 1]);
      const s = score();
      if (s > bestScore) { bestScore = s; bestStart = i; }
    }

    if (bestScore < 0.6) continue;

    const detectedText = tWords.slice(bestStart, bestStart + aLen).join(' ');
    if ([...claudeNorm].some(cn => cn.includes(detectedText) || detectedText.includes(cn))) continue;

    // Reject windows that are mostly attribution chain with little actual hadith content.
    // extractMatn strips the isnad; if fewer than 5 words remain, the window landed on
    // an attribution phrase, not a real hadith quote.
    const contentAfterIsnad = extractMatn(detectedText).split(/\s+/).filter(Boolean).length;
    if (contentAfterIsnad < 5) continue;

    candidates.push({
      detected_text: detectedText,
      collection: h.collection,
      hadith_number: h.number,
      link: h.link,
      confidence: Math.round(bestScore * 100) / 100,
      detection_method: 'scan',
      _start: bestStart,
      _end: bestStart + aLen,
    });
  }

  candidates.sort((a, b) => a._start - b._start);
  const deduped = [];
  for (const c of candidates) {
    const prev = deduped[deduped.length - 1];
    if (prev && c._start < prev._end) {
      if (c.confidence > prev.confidence) deduped[deduped.length - 1] = c;
    } else {
      deduped.push(c);
    }
  }

  return deduped.map(({ _start, _end, ...rest }) => rest);
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

function deduplicateHadithRefs(refs) {
  const kept = [];
  for (const ref of refs) {
    // Only hadith the imam introduces become cards. Every hadith found solely by the corpus
    // scan across the seven test khutbahs was wrong: the imam's own sentences matched corpus
    // fragments on "النبي صلى الله عليه وسلم" (21 Aug), his dhikr and Eid takbir matched the
    // hadith containing them (Eid), a verse matched a hadith quoting it (Sudais 2:185 as Abu
    // Dawud 2316), and a paraphrase of the pillars of Islam got an unrelated Bukhari link
    // (Arafah). The scan's finds are kept in result.json as hadith_scan_suggestions.
    if (ref.detection_method === 'scan') continue;

    // Ritual closing formulas are matched correctly by the corpus but are not citations.
    if (isLiturgicalFormula(ref.detected_text)) continue;

    // Content check: strip the prophet attribution and measure what remains.
    // Pure attribution phrases ("الصحيح ان رسول الله صلى الله عليه وسلم") leave
    // < 4 content words; real hadiths (even short ones like "كلكم راع...") leave ≥ 4.
    const contentWords = extractMatn(ref.detected_text ?? '').split(/\s+/).filter(Boolean).length;
    if (contentWords < 4) continue;

    const normText = normalizeArabic(ref.detected_text ?? '');
    const isDuplicate = kept.some(k => {
      const kNorm = normalizeArabic(k.detected_text ?? '');
      return kNorm.includes(normText) || normText.includes(kNorm);
    });
    if (!isDuplicate) kept.push(ref);
  }
  return kept;
}

export {
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
};
