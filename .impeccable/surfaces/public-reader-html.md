---
version: 1
slug: "public-reader-html"
primary_target: "public/reader.html"
related_targets: ["design/reader/reader.html"]
---

## Scope

The khutbah reader (`/<slug>`, public/reader.html; working copy design/reader/reader.html until Meer approves). Mode: Read, with an Operate player. Audience: non-Arabic speakers at Askan AlMaather (Urdu, Bengali, English), mostly on phones at home after Jumu'ah, arriving from a WhatsApp link to one khutbah; many not tech-savvy. Phone first; the laptop follows later (Meer: the home's laptop layout is "perfect", keep the reader's laptop in the same spirit).

## Direction contract

THESIS: The same world as the home page, now a page you stay in: the khutbah read and heard in your language, the imam's words lighting as they are said, every ayah and hadith set apart in gold with its source. The interface recedes to one gold language line and one slim gold player.

OWN-WORLD: The minbar at night, as the home page now ships it: green-black ground, the star lattice faint, gold for everything tapped and for the Quran (mushaf script, between ﴿ ﴾), cream for the imam's words and their translation. Kufam headings, Readex Pro text, Amiri Arabic, Amiri Quran for ayaat, Nastaliq Urdu, Noto Serif Bengali. No boxes around passages, no coloured side borders, no uppercase labels, no green.

STORY: A visitor opens a WhatsApp link, sees the khutbah's title and its In Short in their language, taps their language once and hears it read while the words light, follows the imam passage by passage, and sees where each ayah and hadith comes from.

FIRST VIEWPORT (phone): the header; the title, date (with Hijri), masjid and khateeb; the gold language line (العربية · English · اردو · বাংলা, Arabic = the imam's voice); In Short in the chosen language; the first passage starting. The slim player along the bottom.

FORM: Redesign that preserves the home's committed world (seed 67519760 direction, refined by Meer through rounds 1–25). Code-led, built on the reader's own code (rendering, word timing, follow, recitation) with its presentation replaced.

TASTE READ: Redesign (preserve) of a khutbah reading and listening page for non-tech-savvy phone readers, with a calm, trust-first editorial language, leaning toward native CSS + anime.js. Dials: VARIANCE 4, MOTION 4, DENSITY 4.

PHASE 1 (mockup, Meer 12 Oct): ideas 1 (one language line: read = hear, Arabic = imam, "Hear the imam instead" in the player), 2 (slim gold player), 3 (follow the imam: current passage in view, gold word light, "Back to the imam"), 5 (ayah and hadith in the home's style). Later: 4 (the khutbah's shape along the side), 7 (laptop: Arabic and translation side by side), 8 (text size, previous/next Friday).

FINISH: unreviewed and undocumented is unfinished; mockup approved by Meer before the real reader changes.
