// core/langs/bn.js — Bengali (বাংলা), 5 Oct 2026: what the translation, its review, the voice and the
// page do differently for Bengali. Choices (Meer, 5 Oct: the report's recommendations): the standard
// colloquial Bengali of Bangladesh (চলিত), everyday Islamic words (নামাজ, রোজা) in the Bangla Academy
// spelling with জ, honorifics in full (the page shows ﷺ ﵁), Allah addressed as আপনি in a du'a (as the
// ayah cards' translation does), Bengali digits, Abu Bakr Zakaria's Quran translation.

export default {
  code: 'bn', name: 'Bengali', native: 'বাংলা', field: 'bengali', dir: 'ltr',
  font: { family: "'Noto Serif Bengali', serif", google: 'Noto+Serif+Bengali:wght@400;600', size: '17px', lineHeight: 1.9,
    shareLineHeight: 1.85, citeLineHeight: 1.6, inlineSize: '13px', switchSize: '12px', phoneSwitchSize: '14px' },
  digits: '০১২৩৪৫৬৭৮৯',
  localBadgeDigits: true, // ayah badges in Bengali digits (Urdu's stay as they were)
  sentenceEnd: '।!?',
  comma: ', ',
  clause: '(?<=[,;:।!?])\\s+|\\s+(?=এবং\\s)', clauseMinWords: 3,
  untranslated: '(অনুবাদ পাওয়া যায়নি)',
  ui: {
    'In Short': 'সংক্ষেপে', 'Summary': 'সারসংক্ষেপ', 'Full Translation': 'সম্পূর্ণ অনুবাদ',
    'Copy for WhatsApp': 'হোয়াটসঅ্যাপের জন্য কপি করুন', 'Copied': '✓ কপি হয়েছে',
    'Show full ayah': 'পুরো আয়াত দেখুন', 'Show recited part': 'শুধু তিলাওয়াত করা অংশ',
  },
  collections: {
    'Sahih al-Bukhari': 'সহীহ বুখারী', 'Sahih Muslim': 'সহীহ মুসলিম', 'Jami` at-Tirmidhi': 'জামে তিরমিযী',
    'Sunan Abu Dawud': 'সুনানে আবু দাউদ', "Sunan an-Nasa'i": 'সুনানে নাসাঈ', 'Sunan Ibn Majah': 'সুনানে ইবনে মাজাহ',
    'ahmad': 'মুসনাদে আহমাদ', 'Musnad Ahmad': 'মুসনাদে আহমাদ', 'Muwatta Malik': 'মুয়াত্তা মালিক',
  },
  bothSahihs: 'সহীহ বুখারী ও সহীহ মুসলিম',
  honorifics: {
    'ﷺ': 'সাল্লাল্লাহু আলাইহি ওয়াসাল্লাম', '﵇': 'আলাইহিস সালাম',
    '﵄': 'রাদিয়াল্লাহু আনহুমা', '﵃': 'রাদিয়াল্লাহু আনহুম', '﵂': 'রাদিয়াল্লাহু আনহা', '﵁': 'রাদিয়াল্লাহু আনহু',
    '﵀': 'রাহিমাহুল্লাহ',
  },
  // Free checks (verify_reader.js): words of another religion for Islamic things, and the old
  // literary forms (সাধু), neither of which a khateeb in Bangladesh uses.
  checks: { script: 'Bengali', forbid: ['ঈশ্বর', 'ভগবান', 'স্বর্গ', 'নরক', 'ধর্মভীরু'], sadhu: 'িয়াছ|িতেছ|তাহাদের|াদিগ',
    // A form this reading does not use, and the one it does (test run 1, 5 Oct 2026).
    avoid: { 'তায়ালা': 'তাআলা', 'সর্দার': 'নেতা' } },

  // Ayah cards: Abu Bakr Zakaria (King Fahd Complex; QuranEnc), via fawazahmed0/quran-api. Its
  // footnote marks ([১], 5,301 of them) are left out, as the footnotes are not shown, and the
  // Assamese ra (ৰ, 433 conjuncts such as শ্ৰেষ্ঠ) is the Bengali one.
  quran: { edition: 'ben-abubakrzakaria', name: 'Abu Bakr Zakaria' },
  verseText: t => t.replace(/\s*\[[০-৯]+\]/g, '').replace(/ৰ/g, 'র').trim(),
  // Hadith cards: fawazahmed0/hadith-api's ben-* editions. They mostly start at the Companion but
  // open with a stray dari and end with notes the card does not show: a footnote mark ([1]), the
  // other printed editions' numbers ("(আধুনিক প্রকাশনী- ৫৯৯৬, ইসলামিক ফাউন্ডেশন)"), a grading
  // ("সহীহ।") and, in Tirmidhi, the Imam's notes ("আবূ ঈসা বলেন…"). 26 of 26 cards clean (4 Oct).
  // Bukhari's can open with the chapter heading (the Arabic, then its Bengali) and then the hadith's own
  // number, "৬৭২৪. আবূ হুরাইরাহ…": the card starts after that number (5 Oct, Bukhari 6724; 5 of the
  // live pages' 26 hadith have a heading).
  hadith: { edition: 'ben', end: /\s*(?:\[\d+\]|\[[০-৯]+\]|\((?:[০-৯]|আধুনিক|ইসলামিক|তাওহীদ|হাদীস একাডেমি|মুসলিম|বুখারী|আহমাদ)|(?:সহীহ|হাসান|যঈফ|দুর্বল|জাল)(?:\s*সহীহ)?\s*[ঃ:।,]|আবূ ঈসা বলেন)/u },
  hadithText: (t, number) => {
    const own = `${String(number).replace(/\d/g, d => '০১২৩৪৫৬৭৮৯'[+d])}. `;
    const at = number != null ? t.indexOf(own) : -1;
    if (at >= 0 && t.length - at > 40) t = t.slice(at + own.length);
    return t.replace(/^[\s।]+/, '').replace(/ৰ/g, 'র');
  },
  surahNames: 'model', // asked for with the summaries: quran.com's Bengali names are meanings ("বকনা-বাছুর")

  voice: {
    name: 'Orus',
    style: 'calm, clear and reverent, like a scholar reading the Bengali translation of a Friday sermon in standard Bangladeshi Bengali; Arabic names and Quranic terms pronounced the Arabic way',
    base: 'The Bengali translation of a Friday khutbah, read from the minbar in standard Bangladeshi Bengali; Arabic words and Quranic terms pronounced the Arabic way',
    intro: 'আল্লাহ তাআলা বলেন:',
    spoken: { 'ﷺ': ' সাল্লাল্লাহু আলাইহি ওয়াসাল্লাম ' },
    // Whisper hears Bengali poorly (about 30% of letters wrong, zero-shot): the word check would
    // voice every passage three times. Off until a Bengali threshold is measured.
    iso: 'ben', whisper: 'bn', hear: false,
  },

  translate: {
    system: `You translate an Arabic Friday khutbah (sermon) into Bengali for Bengali-speaking worshippers from Bangladesh, at home and abroad (many work in Saudi Arabia), who do not understand Arabic. The text comes in numbered chunks, cut at pauses, so a chunk can start or end in the middle of a sentence.

- Translate every chunk completely and faithfully: every command, phrase, name and condition the imam says ("اتقوا الله" must appear as its Bengali). Do not summarise, explain or add.
- Translate exactly the words of each chunk, so that the chunks read on from one another; never move words into a neighbouring chunk.
- Write the standard colloquial Bengali of Bangladesh (চলিত ভাষা) that a good khateeb in Bangladesh speaks from the minbar: respectful and religious, but in the words ordinary worshippers use at home and in the market, so that someone with no schooling in Arabic follows every sentence when it is read aloud. Never the old literary forms (সাধু ভাষা: করিয়াছেন, তাহাদের, আমাদিগকে). Never a word of another religion for an Islamic thing: আল্লাহ (never ঈশ্বর or ভগবান), জান্নাত (never স্বর্গ), জাহান্নাম (never নরক), নামাজ for salah (never প্রার্থনা, which is any prayer), মুত্তাকি (never ধর্মভীরু). Keep the Islamic words Bangladeshi Muslims know: ঈমান, তাকওয়া, জান্নাত, জাহান্নাম, আখিরাত, রাসূল, সাহাবি, সুন্নাহ, হাদিস, নামাজ, রোজা, জাকাত, হজ, দোয়া, তাওবা. For everything else choose the everyday word over the bookish Sanskrit-derived one. It stays a khutbah: dignified, never slang, and no English word where a Bengali one is common.
- Spell Arabic loanwords as the Bangla Academy does, with জ (নামাজ, রোজা, জাকাত, অজু), and keep one spelling for a word or a name throughout: তাআলা (never তায়ালা); মুসলমান for Muslims, the people (মুসলিম only in the names Imam Muslim and Sahih Muslim).
- Put a Quran verse or a hadith that the imam quotes in quotation marks “…”, translated faithfully.
- «متفق عليه» after a hadith is always «বুখারী ও মুসলিম বর্ণনা করেছেন».
- Write numbers in Bengali digits (০–৯), and end a sentence with the dari (।).
- The transcript may have speech-recognition slips; translate the evident meaning.

Chunks are cut at the imam's pauses, so one sentence often runs across two chunks. You are shown the chunks before and after as context: read them to see where each sentence really ends, and make the Bengali of neighbouring chunks join into one grammatical sentence when read in order. Never end a chunk with a dari (।) or begin it as a new sentence when the Arabic sentence carries on into the next chunk; a question that spans chunks keeps its question mark at its true end. Keep natural Bengali word order across the join, with the verb at the end of its clause: never move a verb early or invert a clause to fit the cut.

Register and wording, as in a published Bengali khutbah:
- Allah, the Prophet ﷺ, the Companions and scholars take the honorific pronouns and verbs (তিনি, তাঁর, তাঁরা, তাঁদের, বলেছেন), never সে, তার, বলল. Allah's favours are "অনুগ্রহ করেছেন". In a du'a Allah is addressed with আপনি, as the published translation on the ayah cards does: "হে আল্লাহ! আপনি আমাদের ক্ষমা করুন" (not "তুমি … করো").
- As Bengali Muslim readers expect, write সাল্লাল্লাহু আলাইহি ওয়াসাল্লাম after the Prophet's name even where the imam does not say it there, and রাদিয়াল্লাহু আনহু / আনহা / আনহুম after a Companion or the Companions, আনহুমা for two (আবু বকর ও উমর রাদিয়াল্লাহু আনহুমা); always in full, never abbreviated as (সা.) or (রা.); once per mention, never twice in a row; and not where a du'a already asks Allah to be pleased with them.
- Prefer words an ordinary Bengali reader knows: আমাদের নেতা for سيدنا before the Prophet's name (never সর্দার, which a Bangladeshi reader hears as a village headman); শাসক for ولاة الأمر, and for الأئمة in a du'a for those in authority ("أصلح الأئمة وولاة الأمور"), where ইমাম would be heard as a prayer leader; উমরা পালনকারী for المعتمرون; পবিত্র স্থানসমূহ for المقدسات.
- When the imam repeats a phrase while speaking (a restart, "ليأمن الناس في بيوتهم ليأمن الناس في بيوتهم"), translate it once.
Return one Bengali translation per chunk number given, and nothing for the context chunks.`,
    extras: {
      system: 'You prepare the Bengali edition of a khutbah reader for Bengali-speaking worshippers from Bangladesh. Reply with JSON only.',
      ask: (shareSummary, summary) => `Translate into the everyday, respectful standard Bengali of Bangladesh a khateeb speaks (চলিত, never সাধু; the Islamic words Bangladeshi Muslims know: আল্লাহ, ঈমান, তাকওয়া, জান্নাত, নামাজ; সাল্লাল্লাহু আলাইহি ওয়াসাল্লাম and রাদিয়াল্লাহু আনহু in full; তাআলা and মুসলমান, one spelling throughout; Bengali digits), otherwise the words ordinary worshippers use, not bookish Bengali:\n"share_summary" (a two-sentence WhatsApp message): ${shareSummary}\n"summary": ${summary}`,
      hadith: `For each hadith below, give "narrator": the Companion's name as Bengali readers in Bangladesh know it, with রাদিয়াল্লাহু আনহু / আনহা (for a family chain such as "Amr ibn Shu'ayb from his father from his grandfather", write that chain in Bengali). And give "from_companion": copied character for character from its Bengali text, the part that starts where the Companion (or the Prophet ﷺ, if the Companion is not named) is first mentioned, leaving out any chain of narrators or chapter heading before; the whole text if it already starts there, "" if it has no Bengali text.`,
      surahs: `And give "surahs": for each surah number below, its name as Bengali readers in Bangladesh write it, without the word সূরা (আল-বাকারা, আত-তালাক).`,
    },
  },

  review: {
    system: `You are the editor of the Bengali reading of an Arabic Friday khutbah (sermon), checking it before it is published for Bengali-speaking worshippers from Bangladesh who do not read Arabic. The Bengali was translated from the imam's Arabic chunk by chunk; the chunks are cut at the imam's pauses, so one sentence can run across two chunks. For each chunk you have the imam's Arabic, the English translation (a second, reviewed reference; when it and the Arabic differ, the Arabic wins) and the Bengali.

Correct what a careful bilingual scholar-editor would:
- omission: meaning in the Arabic that the Bengali leaves out (a word such as "their honour", a phrase, a command, a name).
- addition: meaning in the Bengali that the Arabic does not have. সাল্লাল্লাহু আলাইহি ওয়াসাল্লাম after the Prophet's name and রাদিয়াল্লাহু আনহু / আনহা / আনহুমা / আনহুম after the Companions (আনহুমা for two) are Bengali convention, not additions: keep them, and add them in full where the Bengali names the Prophet ﷺ or a Companion without them or abbreviates them as (সা.), (রা.).
- mistranslation: Bengali that says something different from the Arabic.
- boundary: read in order, the Bengali of neighbouring chunks does not join into one grammatical sentence with natural word order where the Arabic sentence runs on (a dari too early, a sentence left without its verb, a question split so that it loses its question mark).
- register: the wrong pronoun or verb for Allah, the Prophet ﷺ, the Companions or scholars (তিনি, তাঁর, বলেছেন; never সে, তার, বলল); Allah addressed with তুমি in a du'a (this reading uses আপনি: দিন, করুন); an honorific doubled; the old literary forms (সাধু: করিয়াছেন, তাহাদের) mixed into the colloquial (চলিত).
- unnatural: wording an educated Bangladeshi reader would find odd, obscure or misleading (সর্দার for سيدنا before the Prophet's name, which is heard as a village headman: it is আমাদের নেতা).
- inconsistent: one word or name spelled or rendered two ways in the khutbah. This reading writes তাআলা (never তায়ালা); মুসলমান for Muslims, the people (মুসলিম only in the names Imam Muslim and Sahih Muslim); Arabic loanwords with জ as the Bangla Academy does (নামাজ, not নামায).
- bookish: a literary Sanskrit-derived word where a khateeb in Bangladesh uses an everyday or Islamic one, or a word of another religion for an Islamic thing (ঈশ্বর, ভগবান, স্বর্গ, নরক, প্রার্থনা for salah, ধর্মভীরু). The Islamic words Bangladeshi Muslims know (আল্লাহ, ঈমান, তাকওয়া, জান্নাত, নামাজ, দোয়া, সাল্লাল্লাহু আলাইহি ওয়াসাল্লাম) stay. Do not make it casual: a khutbah stays dignified, never slang, and no English word where a Bengali one is common.
Leave the translator's wording alone where it is correct and natural: change only what is wrong. The transcript can contain speech-recognition slips; do not flag them unless the Bengali follows a slip into a wrong meaning. When the imam repeats a phrase while speaking, rendering it once is correct. Keep quoted verses and hadith in “…”, and numbers in Bengali digits.

Severity: high, the meaning is wrong or missing; medium, a broken sentence, the wrong register, wording a reader would stumble on, a bookish word a listener would not use, or a word or name spelled two ways in the khutbah (correct every chunk that has the other form); low, a matter of taste.

For each chunk that needs a change, return the chunk number, its issues, and "corrected_bengali": the whole corrected Bengali of that chunk. A correction stays within its chunk, except that it may move the few words needed to make a sentence that runs across two chunks read correctly (then correct both chunks). Most chunks need no change: return only those that do.`,
    types: ['omission', 'addition', 'mistranslation', 'boundary', 'register', 'unnatural', 'bookish', 'inconsistent', 'other'],
    whole: 'The whole Bengali reading, for consistency of terms and spelling:',
  },
};
