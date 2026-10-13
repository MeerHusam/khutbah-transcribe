# The whole site in Urdu and Bengali: the plan

Written 13 Oct 2026 for Meer, before the work starts on its own branch (`i18n`). Nothing here is built yet.

## What we are building

Every page of Khutbah.dev (the home page, every khutbah, feedback, page not found, and the link previews on WhatsApp)
in English, Urdu or Bengali. A visitor picks a language once, with the same gold language line the pages already have,
and the site remembers it. Urdu turns the whole page right to left.

## How it works for a visitor

- **First visit from a shared link:** the link decides. `khutbah.dev/ur/2026-10-09` opens in Urdu, with the preview card,
  title and summary in Urdu too. A plain link (`khutbah.dev/2026-10-09`) opens in the phone's language when we have it,
  else English.
- **Picking a language:** one tap on the language line (as now). It changes the page's words, the translation and the
  voice together, and is remembered on that phone for a year (a cookie the server can read, plus `localStorage` as now).
- **Coming back:** a plain link opens in the remembered language. Picking العربية shows the imam's words alone and keeps
  the rest of the page in the last language chosen.
- **Sharing:** Share sends one line and the link: "Listen to the entire khutbah in your language: <link>" (Meer,
  13 Oct 2026), the line in the language the site is in at that moment, and the link in that language too, so the person
  receiving it opens it in that language (WhatsApp's preview card shows the title, summary and picture). Until this is
  built the line is in English (`shareKhutbah` in `public/reader.html`).

## Decisions for Meer (my recommendation first)

1. **Addresses:** `/ur/…` and `/bn/…` before every page (English stays as it is). The alternative, `?lang=ur`, is
   simpler but Google advises against it and previews are harder.
2. **First visit with a plain link:** the phone's language when we have it (what the reader does today), else English.
   Today an English phone gets the Urdu translation (the reader's first translation); with the whole site translated
   that would mean English menus around Urdu text, so English it is, unless you prefer Urdu.
3. **One choice for everything:** the language of the page's words, the translation and the voice is one choice.
4. **Urdu digits:** Western digits (9 اکتوبر، 2026), the default for Urdu in Pakistan; ۹ is possible.
   Bengali keeps Bengali digits (৯ অক্টোবর, ২০২৬), as its translations already do.
5. **Long text on the home page:** Why I made this and How each khutbah is made translated; The technical details stays
   in English (it is for engineers).
6. **Who checks the words:** you for Urdu; someone for Bengali (not family).
7. **Urdu headings:** in Nastaliq like the text (Kufam is an Arabic Kufi face; it reads as Arabic, not Urdu).
8. **The player in Urdu:** its controls and progress line stay left to right, as media players do everywhere
   (Material's rule: they follow the tape, not the reading direction); only their labels change.

## Best practices we follow

**Addresses and search** (Google Search Central)
- A separate address for each language; not cookies or browser settings alone.
- Subdirectories (`/ur/`) are easy to run on one server; URL parameters are not recommended.
- `hreflang` links between the versions (each lists all, itself included) and `x-default` for English.
- No redirect from a guess of the visitor's language: Googlebot crawls from the USA without `Accept-Language` and would
  miss the other versions. A redirect for someone who chose a language themselves is fine; it is their choice.
- Links to the other languages on every page (the language line already is that).
- One language for the content and the menus of a page.

**Direction** (W3C Internationalization)
- `<html lang="ur" dir="rtl">` on an Urdu page; never CSS `direction` for the base direction.
- Language and direction are separate: `lang` never implies `dir`.
- CSS logical properties (`margin-inline-start`, `text-align: start`, `inset-inline-end`) instead of left and right, so
  one stylesheet serves both directions. Today: reader 37 left/right rules, home 36, feedback 3, 404 2.
- `dir="auto"` on inputs (the feedback form) and on text put in at run time; `<bdi>` around names and numbers that can
  be either direction (an English title on an Urdu page, a time).

**Mirroring** (Material Design, bidirectionality)
- Mirror what points along the reading: back and forward arrows, ←/→ in links (13 arrow characters on the pages), the
  prev/next khutbah, chevrons.
- Do not mirror media: play, −10s/+10s and the progress line keep their direction (they follow the tape).
- Do not mirror icons that are not about direction (share, the minbar, the stars).

**Urdu type** (W3C Urdu layout requirements; Noto Nastaliq practice)
- Nastaliq's ascenders and descenders reach far beyond Latin: line height at least 1.8 for text, about 1.9 for
  paragraphs (the reader already uses 2.25), never the web's usual 1.5, or dots clip.
- Nastaliq looks smaller than Latin at the same size: a step larger.
- Never letter-spacing (the letters join; spacing breaks the joins), no uppercase, no italic (Urdu has neither; a
  browser's fake italic looks broken). One rule: `:lang(ur) { letter-spacing: 0; font-style: normal; text-transform: none }`.
- Urdu punctuation from the translations themselves (۔ ، ؟).

**Bengali type**
- Left to right; conjuncts need the browser's shaping and a font that has them (Noto Serif Bengali for reading as now,
  Noto Sans Bengali for buttons and labels). Line height about 1.75. Bengali runs longer than English: buttons must
  wrap or shrink, never clip.

**Numbers, dates, plurals** (the browser's own `Intl`, checked in Node 22)
- `Intl.DateTimeFormat`: "9 October 2026", "9 اکتوبر، 2026", "৯ অক্টোবর, ২০২৬".
- `Intl.NumberFormat`: Urdu (Pakistan) Western digits by default, Bengali Bengali digits.
- `Intl.PluralRules`: Urdu and Bengali both have one/other ("Show the other 10 ayaat").

**Words** (a small layer, no library)
- One file of words per language (`locales/en.json`, `ur.json`, `bn.json`), keyed (`reader.share`), merging the
  labels already in `core/langs/*.js`.
- The server puts the page's words into the HTML before sending it (it already rewrites each page for its preview tags),
  so the page never shows English first, and previews are in the right language.
- The reader's script gets only its language's words and a `t()` of about 30 lines on `Intl`; i18next would add
  ~40 kB for features we do not need.
- A test that every word exists in every language (as `languages.test.js` checks the language files now).
- Translated by Gemini 3.8 Flash with the khutbah glossary (Iman, Taqwa, ayah/ayaat, hadith…), then checked by a
  person. About 140 strings: well under $0.05.

**Fonts**
- Load only the page's language fonts (every page loads all five families today). Google Fonts already splits each
  family by `unicode-range`, so a phone downloads only the scripts on the page.

## What changes where

| Where | What |
|---|---|
| `server/routes/pages.js` | language from the address, else the cookie, else the phone; `lang`/`dir` on `<html>`; the words put in; `hreflang`, `og:locale` (ur_PK, bn_BD), canonical per language; `/ur/…`, `/bn/…` routes; sitemap with the alternates |
| `locales/*.json` (new) | every word of the site per language |
| `public/*.html`, `design/home/` | words through keys; CSS to logical properties; arrows mirrored; Urdu and Bengali type rules |
| `public/reader.html` | one language choice for words, translation and voice; Share keeps the language; the player stays LTR |
| pipeline (`worker/autopublish.js`) | each khutbah's title in Urdu and Bengali (Gemini, a fraction of a cent); a preview card per language; the 14 published khutbahs backfilled |
| `tests/` | every key in every language; pages served in each language with the right `lang`/`dir`/`hreflang` |

## Steps (each one checked on a phone and a computer, screenshots to Meer)

1. **Foundation:** addresses, cookie, words put in by the server, `lang`/`dir`. The site still reads in English; Urdu
   pages turn right to left with English words, so the layout can be checked first.
2. **Right to left:** logical properties, mirroring, Urdu and Bengali type, fonts per language.
3. **Words:** every string moved into the language files, translated, checked (you for Urdu).
4. **Content and previews:** titles per language, preview cards per language, `hreflang`, sitemap, Share.
5. **Check:** every page in three languages at 390 and 1440 px, in Safari's engine and Chrome; then merge.

## Risks

- Nastaliq is heavy: watch the first load on a slow phone (measure before and after).
- Old links (`/2026-10-09`) keep working; links shared in Urdu before this change open in the remembered language.
- A page half in English (a string missed) looks careless: the test of every key catches it.

## Sources

- Google Search Central, Managing multi-regional and multilingual sites:
  https://developers.google.com/search/docs/specialty/international/managing-multi-regional-sites
- W3C, Structural markup and right-to-left text in HTML: https://www.w3.org/International/questions/qa-html-dir
- W3C, Inline markup and bidirectional text: https://www.w3.org/International/questions/qa-bidi-unicode-controls
- W3C, Urdu Layout Requirements: https://www.w3.org/TR/2024/DNOTE-arab-ur-lreq-20240618/
- W3C ISSUE-354, letter-spacing for Arabic script: https://www.w3.org/International/track/issues/354
- Material Design, Bidirectionality: https://m2.material.io/go/design-bidirectionality
- CLDR Urdu numbering systems: https://www.unicode.org/cldr/charts/47/summary/ur.html
- Noto Nastaliq practice (line height 1.8–1.9): https://open-design.ai/plugins/design-system-urdu/
- Fontsource, Noto Sans Bengali subsets: https://fontsource.org/fonts/noto-sans-bengali/cdn
- Logical properties: https://frontendchecklist.io/rules/css/logical-properties
- hreflang, x-default: https://specification.website/spec/i18n/hreflang.md
