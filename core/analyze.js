// The Claude analysis (split out of pipeline.js): the prompt for each khutbah type, and where
// the second khutbah starts.

import { normalizeArabic } from './arabic.js';

// ---- Claude prompt ----------------------------------------------------------

// Khutbah types — drive how the analysis prompt frames the sermon and whether the
// two-part (sitting + second khutbah) structure applies. Add new types here.
const KHUTBAH_TYPES = {
  friday: {
    desc: 'a Friday Jummah Khutbah (sermon) transcript',
    ref: "this Friday khutbah",
    twoPart: true,
  },
  arafah: {
    desc: 'the Khutbah of Arafah (the Hajj sermon delivered at Masjid Namirah on the Day of Arafah) transcript',
    ref: "this Khutbah of Arafah",
    twoPart: false,
  },
  eid: {
    desc: 'an Eid Khutbah (the sermon delivered after the Eid prayer) transcript',
    ref: "this Eid khutbah",
    twoPart: false,
  },
};

// Islamic terms the English keeps (4 Oct 2026, as the Haramain's official English does), each glossed
// the first time it appears; core/review_english.js holds the English to the same list.
const GLOSSED_TERMS = 'Iman (faith), Taqwa (mindfulness of Allah), Kufr (disbelief), Shirk (associating partners with Allah), '
  + 'Shaytan (Satan), Jannah (Paradise), Jahannam (Hellfire), Dhikr (remembrance of Allah), Awliya (allies of Allah), '
  + 'Ummah (the Muslim community), Tawhid (the Oneness of Allah), Ihsan (excellence in worship)';
// A kept term stands only for that Arabic word in that sense: الذكر الحكيم (the Qur'an) was
// rendered "Dhikr (remembrance of Allah)" (18 Sep 2026 Madinah). أئمتنا in the du'a for those in
// authority are the rulers, as the Urdu prompt already said: "set right our imams" (4 Sep Makkah).
const TERMS_SENSE = 'Use a kept term only where the Arabic has that word in that sense: «الذكر الحكيم» is "the Wise Reminder" (the Qur\'an), never Dhikr. '
  + '«أئمتنا» / «الأئمة» / «إمامنا» in a du\'a for those in authority («أصلح أئمتنا وولاة أمورنا», «وأيد بالحق إمامنا وولي أمرنا») are the rulers: "our leaders", "our leader", never "imam(s)", which a reader hears as prayer leaders.';

const ANALYSIS_PROMPT_TEMPLATE = `You are an Islamic scholar assistant processing {{KHUTBAH_DESC}}.

Given this Arabic Khutbah transcript, do the following:

IMPORTANT STYLE RULE (applies to ALL English text you produce — chunk_translations, share_summary, summary): Do NOT use em dashes (—) or en dashes (–) anywhere. Use a comma, period, colon, parentheses, or the word "and" instead. Write natural prose without dash-joined clauses.

ATTRIBUTION RULE: When the khatib says «متفق عليه» after a hadith, translate it as "Narrated by al-Bukhari and Muslim" (what the term means), never "Agreed upon".

PROSE-CHUNK RULE: A prose chunk may END with a lead-in to a Quranic verse (e.g. "قال الله تعالى", "وقال سبحانه", or the first words of a verse the khatib is about to recite). Translate ONLY the literal Arabic words present in that chunk. Do NOT complete the sentence with, or paraphrase, the content of the Quranic verse that follows — those verses are displayed separately with their own translation. For example, if a chunk ends with "وكيف يدعو", translate just "And how can he invoke", not the full meaning of the verse.
Quranic words that ARE inside a chunk are part of it: translate them like the rest of the chunk, together with whatever the khatib says about them. Only verses outside the chunks are shown separately.

TERMS RULE: Keep these Islamic terms, as the Haramain's own English does, with a short gloss in parentheses the first time each appears in the khutbah and the term alone after that: {{GLOSSED_TERMS}}. For example "Iman (faith)" the first time, then "Iman". {{TERMS_SENSE}}

RESTART RULE: When the khatib repeats a phrase while speaking (a restart, "ليأمن الناس في بيوتهم ليأمن الناس في بيوتهم"), translate it once, also when the repeat runs on into the next chunk.

1. Translate the full text into natural, readable English. Preserve Islamic terms untranslated: Allah, Salah, Zakat, Ummah, Sunnah, Hadith, Quran, Surah, Ayah (plural Ayaat; never "verse"), Jummah, Khatib, and any Arabic honorifics like صلى الله عليه وسلم or رضي الله عنه. Every other Arabic word is translated, never left in transliteration (مخموم القلب is "a clean heart", not "makhmum").

2. Write two summaries:
   a. "share_summary": A ONE-SENTENCE TL;DR — ABSOLUTE MAXIMUM 30 WORDS. State the khutbah's topic and its single biggest takeaway, nothing more. Simple, friendly English; no academic language; do NOT list multiple points or describe both khutbah parts. This is a one-line hook, not a summary. (The detailed "summary" field below carries the full content.)
   b. "summary": A fuller 3-5 sentence summary covering all main points and themes in detail.
   In BOTH summaries, refer to the sermon as {{KHUTBAH_REF}} — do NOT call it a "Friday khutbah" or "Jummah khutbah" unless that is in fact what it is.

3. Identify every Quranic reference by detecting these signal phrases in the Arabic text:
- قال الله تعالى
- يقول الله تعالى
- قال الله سبحانه وتعالى
- كما قال الله تعالى
- في قوله تعالى
- لقوله تعالى
- قال عز وجل
- وقوله تعالى
For each one found:
- Extract the Arabic text that immediately follows (up to 50 words or until the next sentence break)
- Identify which Surah and Ayah it is using your Quran knowledge. Provide surah_name (transliterated, e.g. "Al-Baqarah"), surah_number (integer), and ayah_number (integer). If you are not certain, set these to null.

4. Identify every Hadith reference by detecting these signal phrases:
- قال رسول الله صلى الله عليه وسلم
- عن النبي صلى الله عليه وسلم
- عن أبي هريرة
- عن ابن عمر
- عن عائشة
- عن أنس بن مالك
- رواه البخاري
- رواه مسلم
- أخرجه البخاري
- أخرجه الشيخان
- خرجه الشيخان
- متفق عليه
- رواه أبو داود
- رواه الترمذي
- أخرجه الترمذي
- ثبت عن النبي
- صح عن النبي
- في الصحيح أن رسول الله
- في الصحيح عن
- ثبت في الصحيح
- في الحديث أن رسول الله
- ففي الحديث
For each one found, extract ONLY the hadith text (the Prophet's actual words or the reported content). Do NOT include the signal phrase itself or the narrator chain (isnad) in the arabic_text field — only the matn (the body of the hadith). Identify the narrator (the Companion who reported it) and the collection from your own knowledge of the hadith, even when they are not spoken aloud in the khutbah. Only use null if you genuinely cannot identify it.

{{SPLIT_INSTRUCTION}}

Return ONLY a valid JSON object with no markdown formatting, no backticks, no preamble. Exactly this structure:
{
  "chunk_translations": {"1": "natural English translation of chunk [1] only", "2": "translation of chunk [2] only", "...": "one key for every chunk number, from 1 to the last, never two chunks under one key"},
  "share_summary": "2-3 sentence simple community-friendly summary",
  "summary": "3-5 sentence detailed summary",
  "quran_references": [
    {
      "signal_phrase": "the signal phrase found",
      "arabic_text": "extracted arabic text after signal phrase",
      "surah_name": "transliterated surah name or null if uncertain",
      "surah_number": 2,
      "ayah_number": 185,
      "position": "early/middle/late in khutbah"
    }
  ],
  "hadith_references": [
    {
      "signal_phrase": "the signal phrase found",
      "arabic_text": "extracted arabic text after signal phrase",
      "narrator": "the Companion (sahabi) who narrated it, from your knowledge — null only if truly unknown",
      "collection": "bukhari/muslim/tirmidhi etc, from your knowledge — null only if truly unknown"
    }
  ],
  "second_khutbah_start": "first 6-10 Arabic words of the second khutbah exactly as in the transcript, or null if there is only one khutbah / no confident split"
}`;

const SPLIT_INSTRUCTION_TWO_PART = `5. A Friday khutbah is delivered in TWO parts: the first khutbah ends with the khatib's closing du'a/istighfar (e.g. "أقول قولي هذا وأستغفر الله لي ولكم" / "...فاستغفروه وتوبوا إليه إنه هو البر الرحيم"), the khatib sits briefly, then stands and begins the SECOND khutbah with a fresh opening praise (a new "الحمد لله..." or "إن الحمد لله نحمده ونستعينه..."). Identify where the SECOND khutbah begins and return its first 6-10 Arabic words EXACTLY as they appear in the transcript (so they can be located by text search). Key off this STRUCTURE — closing istighfar/du'a followed by a renewed opening praise — NOT any single word, since transcription can mishear words. If the transcript contains only one khutbah or you cannot confidently find the split, return null.`;

const SPLIT_INSTRUCTION_SINGLE = `5. This sermon is delivered as ONE continuous khutbah (no sitting, no second khutbah). Always return null for "second_khutbah_start".`;

// Builds the analysis prompt for a given khutbah type (friday | arafah | eid).
// Unknown types fall back to friday.
function buildAnalysisPrompt(khutbahType = 'friday') {
  const t = KHUTBAH_TYPES[khutbahType] || KHUTBAH_TYPES.friday;
  return ANALYSIS_PROMPT_TEMPLATE
    .replace('{{KHUTBAH_DESC}}', t.desc)
    .replace('{{KHUTBAH_REF}}', t.ref)
    .replace('{{SPLIT_INSTRUCTION}}', t.twoPart ? SPLIT_INSTRUCTION_TWO_PART : SPLIT_INSTRUCTION_SINGLE)
    .replace('{{GLOSSED_TERMS}}', GLOSSED_TERMS)
    .replace('{{TERMS_SENSE}}', TERMS_SENSE);
}

// ---- Two-khutbah split ------------------------------------------------------

// Locate the boundary between the first and second khutbah. Primary signal is Claude's
// `second_khutbah_start` marker phrase (located in the transcript by fingerprint); this is
// cross-checked against — or, when the phrase can't be found, replaced by — the largest
// silence gap between Whisper segments (the khatib sitting between the two khutbahs).
// Returns { word_index, time, marker_text, via, validated } or null.
function locateSecondKhutbah(markerText, transcript, segments = [], wordTimes = []) {
  const origWords = transcript.split(/\s+/).filter(Boolean);
  const normWords = normalizeArabic(transcript).split(/\s+/).filter(Boolean);
  const total = origWords.length;
  if (total < 40) return null;
  const timeAt = i => (wordTimes[i] && typeof wordTimes[i].start === 'number') ? wordTimes[i].start : null;

  // Largest silence gap whose boundary falls in the middle 20%–85% of the khutbah.
  let gapWordIndex = -1, gapTime = null, maxGap = 0;
  if (segments.length > 1) {
    const cumAt = []; let cum = 0;
    for (const s of segments) { cumAt.push(cum); cum += (s.text ?? '').trim().split(/\s+/).filter(Boolean).length; }
    for (let i = 0; i < segments.length - 1; i++) {
      const gap = (segments[i + 1].start ?? 0) - (segments[i].end ?? 0);
      const frac = cumAt[i + 1] / Math.max(total, 1);
      if (frac > 0.2 && frac < 0.85 && gap > maxGap) {
        maxGap = gap; gapWordIndex = cumAt[i + 1]; gapTime = segments[i + 1].start ?? null;
      }
    }
  }

  // Locate Claude's marker phrase — take the first occurrence past the first quarter
  // (so it can't match the opening hamd of the FIRST khutbah).
  let markerWordIndex = -1;
  if (markerText) {
    const m = normalizeArabic(markerText).split(/\s+/).filter(Boolean);
    if (m.length >= 3) {
      const normStr = normWords.join(' ');
      for (let fp = Math.min(6, m.length); fp >= 3 && markerWordIndex < 0; fp--) {
        const needle = m.slice(0, fp).join(' ');
        let from = 0;
        while (true) {
          const p = normStr.indexOf(needle, from);
          if (p === -1) break;
          const wi = p === 0 ? 0 : normStr.slice(0, p).split(/\s+/).filter(Boolean).length;
          if (wi / total > 0.25) { markerWordIndex = wi; break; }
          from = p + 1;
        }
      }
    }
  }

  if (markerWordIndex >= 0) {
    const time = timeAt(markerWordIndex) ?? gapTime;
    const validated = gapTime != null && time != null && Math.abs(time - gapTime) <= 30;
    return {
      word_index: markerWordIndex,
      time: time != null ? Math.round(time * 10) / 10 : null,
      marker_text: origWords.slice(markerWordIndex, markerWordIndex + 8).join(' '),
      via: 'claude', validated,
    };
  }
  // Fallback: a clear silence gap (khatib sitting) when the phrase wasn't found.
  if (gapWordIndex >= 0 && maxGap >= 1.2) {
    return {
      word_index: gapWordIndex,
      time: gapTime != null ? Math.round(gapTime * 10) / 10 : null,
      marker_text: origWords.slice(gapWordIndex, gapWordIndex + 8).join(' '),
      via: 'silence_gap', validated: true,
    };
  }
  return null;
}

// If the khutbah-2 boundary falls INSIDE a prose chunk, split that chunk in two at the
// boundary and translate each half with a small dedicated Claude call — so the boundary
// becomes a real chunk edge (clean divider, no mid-chunk bleed) and each side gets a complete
// translation. Mutates proseChunks + chunkTranslations in place and reindexes proseIdx.
// Returns true if it split; no-op (false) when the boundary is already on a chunk edge, lands
// in a Quran zone, the chunk counts are inconsistent, or the Claude call fails (graceful
// fallback to the whole-chunk divider).
async function splitChunkAtKhutbahBoundary(proseChunks, chunkTranslations, splitWordIndex, transcriptWords, anthropic, model) {
  if (splitWordIndex == null || splitWordIndex < 0) return false;
  if (!Array.isArray(chunkTranslations) || chunkTranslations.length !== proseChunks.length) return false;
  const si = proseChunks.findIndex(c => c.wordStart < splitWordIndex && splitWordIndex < c.wordEnd);
  if (si < 0) return false; // boundary already on a chunk edge, or inside a Quran zone

  const chunk = proseChunks[si];
  const arabicA = transcriptWords.slice(chunk.wordStart, splitWordIndex).join(' ');
  const arabicB = transcriptWords.slice(splitWordIndex, chunk.wordEnd).join(' ');
  if (!arabicA || !arabicB) return false;
  const origEnglish = chunkTranslations[si] ?? '';

  const prompt = `The Arabic below is one prose chunk from a Friday khutbah. It spans the boundary between the FIRST and the SECOND khutbah, so it must be split into two parts. Translate each part into natural English in the same style, preserving Islamic terms (Allah, Sunnah, Tawhid, Eid al-Adha, etc.).

PART 1 (end of the first khutbah): ${arabicA}

PART 2 (start of the second khutbah): ${arabicB}

(For reference, the whole chunk was previously translated as: "${origEnglish}")

Return ONLY valid JSON, no markdown: {"part1":"English of PART 1","part2":"English of PART 2"}`;

  try {
    const msg = await anthropic.messages.create({ model, max_tokens: 4000, output_config: { effort: 'low' }, messages: [{ role: 'user', content: prompt }] });
    const raw = (msg.content?.find(b => b.type === 'text')?.text ?? '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const j = JSON.parse(raw);
    if (!j.part1 || !j.part2) return false;
    proseChunks.splice(si, 1,
      { text: arabicA, wordStart: chunk.wordStart, wordEnd: splitWordIndex, proseIdx: si },
      { text: arabicB, wordStart: splitWordIndex, wordEnd: chunk.wordEnd, proseIdx: si + 1 });
    chunkTranslations.splice(si, 1, j.part1, j.part2);
    proseChunks.forEach((c, k) => { c.proseIdx = k; });
    return true;
  } catch {
    return false; // any failure → keep the original single chunk + whole-chunk divider
  }
}

// ---- Chunk translations --------------------------------------------------------

// The analysis returns the English keyed by chunk number ({"1": …, "2": …}), so a chunk it
// skipped or merged leaves a gap at its own number instead of shifting every later block onto
// its neighbour's English (18 Sep 2026, Madinah: 57 translations for 58 chunks, an array).
// Each gap is translated on its own (translateChunk). An array of the wrong length cannot be
// paired at all, so then every chunk is.
async function completeChunkTranslations(anthropic, raw, chunks, transcript, model) {
  const n = chunks.length;
  const list = (Array.isArray(raw) ? (raw.length === n ? raw : []) : Array.from({ length: n }, (_, i) => raw?.[i + 1]))
    .concat(Array(n).fill('')).slice(0, n).map(t => (typeof t === 'string' ? t.trim() : ''));
  const missing = list.map((t, i) => (t ? -1 : i)).filter(i => i >= 0);
  for (const i of missing) {
    list[i] = await translateChunk(anthropic, { transcript, arabic: chunks[i].text, before: list[i - 1] || undefined, after: list[i + 1] || undefined, model });
  }
  return { list, missing };
}

// English for one chunk, with the whole khutbah and the English on either side so it reads on.
// Used for a chunk the analysis left out, and by scripts/reanalyze.js for a chunk whose
// boundaries moved.
async function translateChunk(anthropic, { transcript, arabic, before, after, model = 'claude-sonnet-5-5' }) {
  const msg = await anthropic.messages.create({
    model, max_tokens: 4000, output_config: { effort: 'low' },
    messages: [{ role: 'user', content:
      `The transcript of an Arabic Friday khutbah, for context:\n${transcript}\n\n` +
      'Translate one chunk of it into natural, fluent English: exactly its own words, no more and no less, Quranic words ' +
      'inside it included (verses outside the chunk are shown separately on the page, so never add the words of a verse ' +
      'next to the chunk). Match the style of the English around it (honorifics such as صلى الله عليه وسلم stay in Arabic; ' +
      'every other Arabic word is translated) and make it read on from the English before it; a phrase the khatib repeats ' +
      'is translated once. «متفق عليه» after a hadith is "Narrated by al-Bukhari and Muslim", never "Agreed upon". ' +
      'Do not use em dashes or en dashes. Reply with the English only.\n\n' +
      `English before: ${before ?? '(start of the khutbah)'}\nChunk: ${arabic}\nEnglish after: ${after ?? '(end)'}` }],
  });
  return msg.content.find(b => b.type === 'text')?.text.trim() ?? '';
}

export {
  KHUTBAH_TYPES,
  GLOSSED_TERMS,
  TERMS_SENSE,
  completeChunkTranslations,
  translateChunk,
  buildAnalysisPrompt,
  locateSecondKhutbah,
  splitChunkAtKhutbahBoundary,
};
