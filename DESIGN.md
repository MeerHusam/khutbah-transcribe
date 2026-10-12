---
name: Khutbah.dev
description: The Friday khutbah in your language, read and heard beside the imam's Arabic. The minbar at night.
colors:
  night: "#0B1712"
  night-2: "#0F1F18"
  night-3: "#15291F"
  card: "#13291F"
  gold: "#D8B86C"
  gold-bright: "#F1D58E"
  gold-dim: "rgba(216, 184, 108, .42)"
  gold-ink: "#1A1508"
  cream: "#ECE6D6"
  mist: "#A6B3AA"
  dim: "#85948B"
  parchment-arabic: "#EADFBF"
  hadith: "#93DDB7"
  hadith-lit: "#B8F2D3"
  live: "#63C79B"
  line: "rgba(216, 184, 108, .16)"
  line-soft: "rgba(236, 230, 214, .09)"
  light: "#F8E9BC"
typography:
  display:
    fontFamily: "Kufam, Readex Pro, system-ui, sans-serif"
    fontWeight: 600
    lineHeight: 1.12
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Readex Pro, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 300
    lineHeight: 1.6
  reading-translation:
    fontFamily: "Readex Pro, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 400
    lineHeight: 1.55
  reading-arabic:
    fontFamily: "Amiri, Noto Naskh Arabic, serif"
    fontSize: "30px"
    lineHeight: 1.85
  quran:
    fontFamily: "Amiri Quran, Amiri, serif"
  urdu:
    fontFamily: "Noto Nastaliq Urdu, serif"
    lineHeight: 2.25
  bengali:
    fontFamily: "Noto Serif Bengali, serif"
    lineHeight: 1.75
  label:
    fontFamily: "Readex Pro, system-ui, sans-serif"
    fontSize: "13px"
rounded:
  card: "10px"
  control: "14px"
  pill: "999px"
spacing:
  gutter-phone: "20px"
  gutter-computer: "28px"
  section: "64px"
components:
  button-primary:
    backgroundColor: "{colors.gold}"
    textColor: "{colors.gold-ink}"
    rounded: "{rounded.pill}"
    height: "48px"
  button-play:
    backgroundColor: "{colors.gold}"
    textColor: "{colors.gold-ink}"
    size: "60px"
  player-side-button:
    textColor: "{colors.gold}"
    rounded: "{rounded.control}"
    height: "52px"
  link:
    textColor: "{colors.gold}"
  language-line:
    textColor: "{colors.gold}"
  example-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.cream}"
    rounded: "{rounded.card}"
---

# Khutbah.dev design

Built with Meer, 8–12 Oct 2026 (the home page, then the reader). Source: `design/home/` (the home page is built from it:
`node design/home/fill.mjs`) and `public/reader.html`. Product context: `PRODUCT.md`.

## Overview

**The minbar at night.** A masjid after Isha: a green-black ground, gold line drawings, the imam's words in cream. The
gold minbar (`design/home/minbar.svg.js`, single-stroke paths so it can draw itself in) with light falling through its
window is the one picture; the three rub el hizb stars (۞) and the eight-pointed star lattice are the ornament. Nothing
else is decorative: no domes, crescents, lanterns or photographs.

The people it is for read on a phone at home after Jumu'ah, from a WhatsApp link, many not tech-savvy and many older.
So: one obvious action per screen, large type, visible words on every control, and the khutbah itself (the Arabic, the
voice, the translation) carrying the page.

## Colors

- **Night** (`night`, `night-2`, `night-3`) is every background. One theme only: dark.
- **Gold** is for two things: everything you can tap (links, buttons, the language line, the player) and the Quran
  (ayaat in the mushaf's script). Filled gold buttons carry `gold-ink` text.
- **Cream** is the imam's words and their translation; `mist` and `dim` are secondary text and details.
- **Green** (`hadith`, `hadith-lit`) is for a hadith's words, in both panes and in the sources list (the imam asked for
  it, 9 Oct 2026). Not for buttons or links: those are gold (Meer, 12 Oct).
- **Parchment** (`parchment-arabic`) is the imam's Arabic in the reader's upper pane, so it reads apart from the
  translation below.
- `live` is only the small "reading now" dot.
- Lines: `line` (gold, faint) for dividers that matter, `line-soft` for quiet ones.

## Typography

- **Kufam** for headings (h1, h2, the reader's title) only; its V, W and A look like typos in running text.
- **Readex Pro** for everything else in Latin script; weight 300 for prose, 400 for reading text on the dark ground
  (light text on dark needs a step more weight), 500 for emphasis.
- **Amiri** for the imam's Arabic, **Amiri Quran** for ayaat, **Noto Nastaliq Urdu** and **Noto Serif Bengali** for
  the translations, each at the same size as English with its own line height.
- Reading sizes (phone): Arabic 30px, translation 22px; a computer a step larger. Three text sizes (×0.86, ×1, ×1.16)
  from the three A's, kept per reader (`localStorage kt-size`).
- Page and labels: title 24px on a phone, details 13–15px. Nothing functional under 13px.
- No uppercase labels, no letter-spaced eyebrows, no em dashes in the copy.

## Layout

**Home** (`public/home.html`): the bar (stays at the top), the hero (the heading, the gold language line with the
pointing hand, the example card: the imam's du'a with Ghafir 40:60 inside it, playable), the khutbahs grouped by
Friday (the latest open), "Why I made this", "How each khutbah is made" (a gold line drawn while scrolling), feedback.
On a computer the hero is copy left, minbar and card right; on a phone everything stacks, the heading 95px below the
bar, the minbar faint behind it.

**Reader** (`public/reader.html`): a stage the size of the screen between the bar and the player, then the page goes on.
- The opening, above the reader: back link, title, the date and masjid on one line, the Summary (its label in Kufam,
  cream), Share (the phone's share sheet with the summary and the link; copied on a computer) and Sources (n) ↓. When
  reading starts (a scroll in a pane, or play) the page settles on the reader, which fills the screen below the bar.
- The language line (العربية · English · اردو · বাংলা) and the three A's on one row, a gold line under them.
- Two panes tied together: the imam's Arabic above and the chosen language below (side by side on a computer, the
  Arabic on the left), each one continuous text, the three gold stars with fading gold lines between them. Scrolling
  either scrolls both to the same passage.
- After the reader: the end mark ("End of the khutbah"), every ayah and every hadith across the full width (side by
  side on a computer), the khutbah before and after at the same masjid, the footer.
- The player along the bottom: the progress line with the time at both ends; Speed, −10s, play/pause in the centre,
  +10s, Voice (the language's own voice or the imam).

## Elevation & Depth

Flat. Depth comes from the night tones (`night` → `night-3`) and from light: the soft radial glow behind the minbar.
The only shadows: the home page's example card and the floating buttons (Pause, "Show what's playing"), one soft
offset shadow each. No glass: the bars (header, player) are solid night, so text never shows behind them.

## Shapes

Line, not mass: 1px gold strokes for the minbar, the lattice, dividers and the steps' line. Pills for small controls
(language buttons are text with an underline, not pills), 10px corners for the example card, 14px for the player's
side buttons. Icons from Phosphor (regular weight), never emoji.

## Components

- **Language line**: the languages in their own scripts, gold, separated by `·`; the chosen one brighter with a gold
  underline. A tap reads and hears it; العربية is the imam alone. On the home page it plays that language in the card.
- **Follow-along**: while a voice plays, the word being said is gold-bright with a 2px gold underline; the phrase being
  read is bright in both panes (matched by meaning, `core/align_phrases.js`), the rest of the passage dimmed. A hadith
  keeps its green, an ayah its gold, lit or dimmed.
- **Ayah**: mushaf script in gold (Amiri Quran), its source a gold link (quran.com). **Hadith**: green, its narrator and
  collection a gold link (sunnah.com).
- **Player**: see Layout. Labels in words ("Speed 1×", "Voice English"), 44px+ targets.
- **Link preview** (`scripts/og_image.js`): 1200×630, the khutbah's title, date, masjid and languages beside the minbar.

## Do's and Don'ts

- Do keep one action obvious per screen; do label every control in words.
- Do keep gold for what is tapped and for the Quran; green for hadith; cream for the imam's words.
- Do test on a phone first, at 390×844 and 360×740, and in Safari's engine.
- Don't add a light theme, a second accent colour, boxes around passages or coloured side borders.
- Don't use Kufam for running text, uppercase labels, emoji, or em dashes.
- Don't show visitor totals on the page; "reading now" only (totals are on /admin/traffic).
- Don't guess: a phrase without a matching that checks out lights no part of the Arabic.
