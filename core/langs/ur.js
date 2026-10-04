// core/langs/ur.js — Urdu (اردو): what the translation, its review, the voice and the page do
// differently for Urdu. Moved here unchanged on 5 Oct 2026 from urdu/translate_urdu.js,
// urdu/review_urdu.js, voice/tts.js, voice/recite.js and public/reader.html, so that a language is
// one file (core/languages.js lists them).

export default {
  code: 'ur', name: 'Urdu', native: 'اردو', field: 'urdu', dir: 'rtl',
  // The page: its font and sizes (Nastaliq needs the tall line), and its words.
  font: { family: "'Noto Nastaliq Urdu', serif", google: 'Noto+Nastaliq+Urdu:wght@400;500', size: '16px', lineHeight: 2.5,
    shareLineHeight: 2.4, citeLineHeight: 2, inlineSize: '14px', switchSize: '12px', phoneSwitchSize: '14px' },
  digits: '٠١٢٣٤٥٦٧٨٩', // a passage's ayah numbers on its card
  sentenceEnd: '۔!؟?',
  comma: '، ',
  // Urdu translations (Junagarhi) use little punctuation, so a clause also starts at "اور"; a piece
  // under 3 words ("زمین اور آسمان") joins the next.
  clause: '(?<=[،۔؛:!?,.])\\s+|\\s+(?=اور\\s)', clauseMinWords: 3,
  untranslated: '(ترجمہ دستیاب نہیں)',
  ui: {
    'In Short': 'مختصر', 'Summary': 'خلاصہ', 'Full Translation': 'مکمل ترجمہ',
    'Copy for WhatsApp': 'واٹس ایپ کے لیے کاپی کریں', 'Copied': '✓ کاپی ہو گیا',
    'Show full ayah': 'مکمل آیت دیکھیں', 'Show recited part': 'صرف تلاوت شدہ حصہ',
  },
  // Collection names as Urdu readers know them; both Sahihs for «متفق عليه».
  collections: {
    'Sahih al-Bukhari': 'صحیح بخاری', 'Sahih Muslim': 'صحیح مسلم', 'Jami` at-Tirmidhi': 'جامع ترمذی',
    'Sunan Abu Dawud': 'سنن ابو داؤد', "Sunan an-Nasa'i": 'سنن نسائی', 'Sunan Ibn Majah': 'سنن ابن ماجہ',
    'ahmad': 'مسند احمد', 'Musnad Ahmad': 'مسند احمد', 'Muwatta Malik': 'موطا امام مالک',
  },
  bothSahihs: 'صحیح بخاری و صحیح مسلم',
  // Shown as the short sign (ﷺ ﵁ …) on the page, as the Arabic forms are.
  honorifics: {
    '\uFDFA': 'صلی اللہ علیہ وسلم', '\uFD4A': 'علیہ الصلاۃ والسلام', '\uFD47': 'علیہ السلام', '\uFD48': 'علیہم السلام',
    '\uFD44': 'رضی اللہ عنہما', '\uFD43': 'رضی اللہ عنہم', '\uFD42': 'رضی اللہ عنہا', '\uFD41': 'رضی اللہ عنہ',
    '\uFD4F': 'رحمہم اللہ', '\uFD40': 'رحمہ اللہ', '\uFDFE': 'سبحانہ وتعالیٰ|سبحانہ و تعالیٰ', '\uFDFB': 'جل جلالہ', '\uFD4E': 'تبارک وتعالیٰ',
  },

  // Ayah cards: a published Urdu translation. Which one is Meer's decision; until then Muhammad
  // Junagarhi's (tanzil.net, via fawazahmed0/quran-api), marked as a placeholder.
  quran: {
    edition: 'urd-muhammadjunagar', // editions.json lists it as urd_muhammadjunagar; paths use '-'
    name: 'Muhammad Junagarhi',
    placeholder: true, // not chosen yet: Junagarhi, Jalandhry or Maududi is Meer's call
  },
  // NFKC: the tanzil text carries Arabic presentation forms (ﻻ, ﻇ) that Nastaliq fonts do not join
  // like ordinary letters.
  verseText: t => t.normalize('NFKC'),
  // Hadith cards: fawazahmed0/hadith-api's urd-* editions. Jami' at-Tirmidhi's follows each hadith
  // with the Imam's grading and notes ("۱؎ … امام ترمذی کہتے ہیں: یہ حدیث حسن غریب ہے"); the card
  // shows the hadith only.
  hadith: { edition: 'urd', end: /\s*۱؎|\s*امام ترمذی کہتے ہیں/ },
  hadithText: t => t.normalize('NFKC'),
  surahNames: 'arabic', // the Arabic names Urdu readers use (quran-json)

  voice: {
    name: 'Orus',
    style: 'calm, clear and reverent, like a scholar reading the Urdu translation of a Friday sermon in standard Pakistani Urdu; Arabic names and Quranic terms pronounced the Arabic way',
    base: 'The Urdu translation of a Friday khutbah, read from the minbar in standard Pakistani Urdu; Arabic words and Quranic terms pronounced the Arabic way',
    // A verse the imam did not introduce gets this lead-in.
    intro: 'ارشادِ باری تعالیٰ ہے:',
    // Urdu keeps the Arabic honorifics as Urdu speakers say them; only the symbol is spelled out.
    spoken: { 'ﷺ': ' صلی اللہ علیہ وسلم ' },
    iso: 'urd', whisper: 'ur', hear: true,
  },

  translate: {
    system: `You translate an Arabic Friday khutbah (sermon) into Urdu for worshippers in Pakistan and India who do not understand Arabic. The text comes in numbered chunks, cut at pauses, so a chunk can start or end in the middle of a sentence.

- Translate every chunk completely and faithfully: every command, phrase, name and condition the imam says ("اتقوا الله" must appear as its Urdu). Do not summarise, explain or add.
- Translate exactly the words of each chunk, so that the chunks read on from one another; never move words into a neighbouring chunk.
- Write the Urdu a good khateeb in Pakistan speaks from the minbar: respectful and religious, but in the words ordinary worshippers use at home and in the bazaar, so that someone with no schooling in Arabic or Persian follows every sentence when it is read aloud. Keep the religious terms and honorifics everyone knows (اللہ تعالیٰ، نبی کریم صلی اللہ علیہ وسلم، رضی اللہ عنہ، تقویٰ، نماز، زکوٰۃ). For everything else choose the everyday word over the bookish Arabic or Persian one: ایمان والے بھائیو (not ایمانی بھائیو) for إخوة الإيمان, جائیداد (not املاک) for property, دین و دنیا کے کام (not مصلحتیں) for مصالح الدين والدنيا. It stays a khutbah: dignified, never slang, and no English word where an Urdu one is common.
- Put a Quran verse or a hadith that the imam quotes in quotation marks “…”, translated faithfully.
- «متفق عليه» after a hadith is always «اسے بخاری اور مسلم نے روایت کیا ہے».
- The transcript may have speech-recognition slips; translate the evident meaning.

Chunks are cut at the imam's pauses, so one sentence often runs across two chunks. You are shown the chunks before and after as context: read them to see where each sentence really ends, and make the Urdu of neighbouring chunks join into one grammatical sentence when read in order. Never end a chunk with a full stop (۔) or begin it as a new sentence when the Arabic sentence carries on into the next chunk; a question that spans chunks keeps its question mark at its true end. Keep natural Urdu word order across the join: never invert a clause to fit the cut ("اور چونکہ یہ / نعمت بہت عظیم ہے", not "اور چونکہ بہت بڑی ہے / یہ عظیم نعمت").

Register and wording, as in a published Urdu khutbah:
- Allah is spoken of in the singular: "جو بادشاہ ہے، احسان فرمانے والا ہے" (not "ہیں"). His favours are "احسان فرمایا" (never "احسان جتلایا", which sounds like taunting).
- The Prophet ﷺ, Companions and scholars in the respectful plural, with the honorific once: do not add رضی اللہ عنہم where a du'a already asks Allah to be pleased with them ("…سے راضی ہو جا").
- As Urdu readers expect, write صلی اللہ علیہ وسلم after the Prophet's name even where the imam does not say it there (the shahada: "محمد صلی اللہ علیہ وسلم اللہ کے بندے اور رسول ہیں"), and رضی اللہ عنہ / عنہا / عنہم after a Companion or the Companions, the dual عنہما for two (ابوبکر و عمر رضی اللہ عنہما); once per mention, never twice in a row.
- Prefer words an ordinary Urdu reader knows over rare Arabic loans: حکمران for ولاة الأمر, and for الأئمة in a du'a for those in authority ("أصلح الأئمة وولاة الأمور"), where امام would be heard as a prayer leader, عمرہ کرنے والے for المعتمرون, جسارت for an audacious crime (جرأت is courage), مقدس مقامات for المقدسات.
- Keep one spelling for a word throughout (e.g. سیکیورٹی).
- When the imam repeats a phrase while speaking (a restart, "ليأمن الناس في بيوتهم ليأمن الناس في بيوتهم"), translate it once.
Return one Urdu translation per chunk number given, and nothing for the context chunks.`,
    extras: {
      system: 'You prepare the Urdu edition of a khutbah reader for worshippers in Pakistan and India. Reply with JSON only.',
      ask: (shareSummary, summary) => `Translate into the everyday, respectful Urdu a khateeb in Pakistan speaks: the religious terms and honorifics everyone knows (اللہ تعالیٰ، نبی کریم صلی اللہ علیہ وسلم، رضی اللہ عنہ), otherwise the words ordinary worshippers use, not bookish Urdu:\n"share_summary" (a two-sentence WhatsApp message): ${shareSummary}\n"summary": ${summary}`,
      hadith: `For each hadith below, give "narrator": the Companion's name as Urdu readers know it, with رضی اللہ عنہ / عنہا (for a family chain such as "Amr ibn Shu'ayb from his father from his grandfather", write that chain in Urdu). And give "from_companion": copied character for character from its Urdu text, the part that starts where the Companion (or the Prophet ﷺ, if the Companion is not named) is first mentioned, leaving out the chain of narrators before; the whole text if it already starts there, "" if it has no Urdu text.`,
    },
  },

  review: {
    system: `You are the editor of the Urdu reading of an Arabic Friday khutbah (sermon), checking it before it is published for Urdu-speaking worshippers in Pakistan and India who do not read Arabic. The Urdu was translated from the imam's Arabic chunk by chunk; the chunks are cut at the imam's pauses, so one sentence can run across two chunks. For each chunk you have the imam's Arabic, the English translation (a second, reviewed reference; when it and the Arabic differ, the Arabic wins) and the Urdu.

Correct what a careful bilingual scholar-editor would:
- omission: meaning in the Arabic that the Urdu leaves out (a word such as "their honour", a phrase, a command, a name).
- addition: meaning in the Urdu that the Arabic does not have. صلی اللہ علیہ وسلم after the Prophet's name and رضی اللہ عنہ / عنہما / عنہم after the Companions (عنہما for two) are Urdu convention, not additions: keep them, and add them where the Urdu names the Prophet ﷺ or a Companion without them.
- mistranslation: Urdu that says something different from the Arabic.
- boundary: read in order, the Urdu of neighbouring chunks does not join into one grammatical sentence with natural word order where the Arabic sentence runs on (a full stop too early, a lost "جس نے", a question split so that it loses its question mark, a sentence left without its verb).
- register: the wrong tone for Allah (He is spoken of in the singular: "جو بادشاہ ہے"; His favour is "احسان فرمایا", never "احسان جتلایا"), for the Prophet ﷺ or the Companions, an honorific doubled, or عنہم for two Companions (the dual is عنہما).
- unnatural: wording an educated Urdu reader would find odd, obscure or misleading (a rare Arabic loan where an everyday word exists; جرأت, courage, for an audacious crime, which is جسارت).
- inconsistent: one word or name spelled or rendered two ways in the khutbah.
- bookish: a literary Arabic or Persian word or construction where a khateeb speaking to ordinary worshippers in Pakistan would use an everyday one (ایمانی بھائیو where people say ایمان والے بھائیو; املاک for جائیداد; مصلحتیں where people say دین و دنیا کے کام). The religious terms and honorifics everyone knows (اللہ تعالیٰ، تقویٰ، نماز، صلی اللہ علیہ وسلم) stay. Do not make it casual: a khutbah stays dignified, never slang, and no English word where an Urdu one is common.
Leave the translator's wording alone where it is correct and natural: change only what is wrong. The transcript can contain speech-recognition slips; do not flag them unless the Urdu follows a slip into a wrong meaning. When the imam repeats a phrase while speaking, rendering it once is correct. Keep quoted verses and hadith in “…”.

Severity: high, the meaning is wrong or missing; medium, a broken sentence, the wrong register, wording a reader would stumble on, or a bookish word a listener would not use; low, a matter of taste.

For each chunk that needs a change, return the chunk number, its issues, and "corrected_urdu": the whole corrected Urdu of that chunk. A correction stays within its chunk, except that it may move the few words needed to make a sentence that runs across two chunks read correctly (then correct both chunks). Most chunks need no change: return only those that do.`,
    types: ['omission', 'addition', 'mistranslation', 'boundary', 'register', 'unnatural', 'bookish', 'inconsistent', 'other'],
    whole: 'The whole Urdu reading, for consistency of terms and spelling:',
  },
};
