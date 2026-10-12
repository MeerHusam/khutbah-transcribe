# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: the non-Arabic speakers at Askan AlMaather Mosque in Riyadh (Urdu, Bengali and English speakers, many of them expatriate workers) who sit through a Friday khutbah delivered in Arabic that they cannot follow. Most of them open the site on a phone at home after Jumu'ah, often from a link shared on WhatsApp by a friend or the masjid group. A large share are not tech-savvy: they need obvious controls, plain words and nothing hidden behind gestures or icons alone.

Secondary: anyone who wants the Friday khutbah of the two Haramain (Masjid al-Haram, Makkah; Masjid an-Nabawi, Madinah) in their language.

Direction: built for one masjid first, with the intent to add other masjids later (masjid ids already exist in the database).

## Product Purpose

Every Friday's khutbah, from the imam's own Arabic, made understandable to people who don't speak Arabic: translated into English, Urdu and Bengali, with the imam's recording to follow word by word, a voice reading each translation, and every ayah and hadith he quotes shown with its source. Success: a worshipper who could not follow the khutbah in the masjid understands it in full that same day, including the ayaat and hadith it is built on.

## Positioning

Not a Quran app and not a lecture library: it is this Friday's actual khutbah, from a real masjid, in the imam's own words and voice. The Arabic sits beside the translation, the imam's recording lights each word as he says it, and the Quran and hadith references are checked against the mushaf and sunnah.com. Made by a hafidh of the Qur'an who prays at that masjid.

## Operating Context

- Weekly rhythm: a khutbah is recorded at Jumu'ah, uploaded from the masjid, and published the same day (Haramain khutbahs follow).
- Reached mostly by WhatsApp links to a specific khutbah (`/<date>`), then the home page for others.
- Read and listened to on phones at home; less often on a computer.
- Each khutbah has two parts (the first khutbah, the imam sits, the second khutbah) and a closing du'a.

## Capabilities and Constraints

- Languages: Arabic (the imam's), English, Urdu, Bengali; more languages possible later. Each khutbah lists the languages it has.
- Audio: the imam's recording; a voice reading the English, Urdu and Bengali where made. Word-by-word highlighting for the imam and the voices.
- References: every Quran ayah (with the part the imam recited) and every hadith (collection, number, narrator, sunnah.com link).
- Hijri and Gregorian dates; masjid and khateeb (the speaker) per khutbah.
- Static HTML/CSS/JS pages served by Express (`public/home.html`, `public/reader.html`); no build step; Render hosting; fonts from Google Fonts.
- Terminology: "ayah / ayaat" (never "verse"), "khateeb" for the speaker, "khutbah", "masjid".
- Undecided: how other masjids join (sign-up flow, naming).

## Brand Commitments

- Name: Khutbah.dev. Logo: a minbar line drawing in a circle (`public/img/logo.svg`).
- Keep the three rub el hizb stars (۞) and the eight-pointed star lattice from the current site (Meer, 8 Oct 2026).
- Voice: plain, warm, respectful; no marketing language; Islamic terms kept (Taqwa, Iman …), glossed the first time.
- Honorifics shown as signs in the imam's text (ﷺ ﵁), never inside Quran text.

## Evidence on Hand

- 12+ published khutbahs (Askan AlMaather, Masjid al-Haram, Masjid an-Nabawi, Arafah), each with Arabic text, translations, imam recording (R2), word timings, references.
- Meer's own "Why I made this" text (home page) and the imam's approval of the translation quality (Oct 2026).
- Live viewer counts (WebSocket). No testimonials, user numbers or press beyond these: do not invent them.

## Product Principles

1. Clarity before beauty: a first-time, non-technical visitor must see within seconds that they can switch to their language and press play.
2. The imam's words are the content: the Arabic, his voice and its translation lead; the interface recedes.
3. Trust is shown, not claimed: sources sit beside every ayah and hadith.
4. One masjid, real and named, built so others can join.

## Accessibility & Inclusion

Many users are not tech-savvy and read on phones: large tap targets, visible text labels (not icon-only), plain language, readable sizes in Arabic, Urdu (Nastaliq) and Bengali scripts, right-to-left text handled correctly, reduced motion respected, works on older phones and slow connections.
