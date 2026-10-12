// Four ways to show one passage at a time on a phone, each with a long passage (9 Oct 2026, #29: 46 Arabic
// words, 74 English), while the English voice reads it. Static mockups: node design/reader/one-passage/mock.mjs
import { writeFileSync } from 'fs';
const here = new URL('.', import.meta.url).pathname;
const AR = 'الحمد لله على إحسانه، والشكر له على توفيقه وامتنانه، وأشهد أن لا إله إلا الله وحده لا شريك له، تعظيماً لشأنه، وأشهد أن محمداً عبده ورسوله، صلى الله وسلم وبارك عليه وعلى آله وأصحابه وسلم تسليماً كثيراً إلى يوم الدين، أما بعد.';
const AR1 = 'الحمد لله على إحسانه، والشكر له على توفيقه وامتنانه، وأشهد أن لا إله إلا الله وحده لا شريك له، تعظيماً لشأنه، وأشهد أن محمداً عبده ورسوله،';
const EN = [
  'All praise is for Allah for His kindness, and thanks to Him for His granting of success and His favor.',
  'I bear witness that there is no god but Allah alone, with no partner, in veneration of His majesty, and I bear witness that Muhammad is His servant and Messenger.',
  'May Allah send blessings, peace, and favor upon him, his family, and his companions, with abundant peace until the Day of Judgment.',
  'To proceed.',
];
const CUR = 1, SAID = 9;   // the voice is in the second sentence, at its tenth word ("Allah")
const lit = (s, n = SAID) => s.split(' ').map((w, i) => `<span class="${i < n ? 'said' : i === n ? 'now' : 'unsaid'}">${w}</span>`).join(' ');
const arLit = (s, n) => s.split(' ').map((w, i) => `<span class="${i < n ? 'said' : 'unsaid'}">${w}</span>`).join(' ');
const PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="14" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>';

const page = (title, body, extraCss = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link href="https://fonts.googleapis.com/css2?family=Kufam:wght@500;600&family=Readex+Pro:wght@300;400;500&family=Amiri:wght@400;700&display=swap" rel="stylesheet">
<style>
  :root { --night: #0B1712; --gold: #D8B86C; --gold-dim: rgba(216,184,108,.42); --gold-bright: #F1D58E; --gold-ink: #1A1508; --cream: #ECE6D6; --mist: #A6B3AA; --dim: #85948B; --line: rgba(216,184,108,.16); --line-soft: rgba(236,230,214,.09);
          --display: "Kufam", "Readex Pro", sans-serif; --text: "Readex Pro", sans-serif; --ar: "Amiri", serif; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body { background: var(--night); color: var(--cream); font: 300 17px/1.6 var(--text); -webkit-font-smoothing: antialiased; display: flex; flex-direction: column; overflow: hidden; }
  header { display: flex; align-items: center; gap: 10px; padding: 12px 20px; border-bottom: 1px solid var(--line-soft); font: 500 18px/1 var(--display); }
  header img { width: 30px; height: 30px; }
  header .close { margin-left: auto; font: 400 15px var(--text); color: var(--gold); text-decoration: underline; text-decoration-color: var(--gold-dim); text-underline-offset: 4px; }
  .where { display: flex; align-items: center; justify-content: space-between; padding: 14px 20px 0; font-size: 14px; color: var(--mist); }
  .where b { color: var(--gold); font-weight: 400; }
  .bar { display: flex; gap: 3px; margin: 10px 20px 0; }
  .bar i { flex: 1; height: 3px; border-radius: 2px; background: rgba(216,184,108,.18); }
  .bar i.done { background: var(--gold); } .bar i.now { background: var(--gold-bright); }
  main { flex: 1; min-height: 0; position: relative; }
  .said { color: #F4EEDD; } .unsaid { color: rgba(236,230,214,.42); }
  .now { color: var(--gold-bright); text-decoration: underline; text-decoration-color: var(--gold); text-decoration-thickness: 2px; text-underline-offset: 6px; }
  .nav { display: flex; justify-content: space-between; padding: 6px 12px; }
  .nav a { display: inline-flex; align-items: center; min-height: 44px; padding: 0 8px; color: var(--gold); font-size: 15.5px; text-decoration: none; }
  .nav a.off { color: var(--dim); }
  .player { display: grid; grid-template-columns: auto 1fr auto auto; align-items: center; gap: 10px; padding: 8px 14px 14px; border-top: 1px solid var(--line); position: relative; }
  .player::before { content: ''; position: absolute; left: 0; right: 0; top: -2px; height: 3px; background: linear-gradient(to right, var(--gold) 38%, rgba(216,184,108,.22) 38%); }
  .play { width: 46px; height: 46px; border-radius: 50%; background: var(--gold); color: var(--gold-ink); display: grid; place-items: center; }
  .play svg { width: 18px; height: 18px; }
  .time { font-size: 14px; color: var(--mist); }
  .pill { min-height: 38px; padding: 0 12px; border: 1px solid var(--line); border-radius: 999px; display: inline-flex; align-items: center; color: var(--gold); font-size: 14px; }
  .seg { display: inline-flex; padding: 3px; border: 1px solid var(--line); border-radius: 999px; font-size: 14px; }
  .seg span { padding: 7px 11px; border-radius: 999px; color: var(--mist); } .seg .on { background: var(--gold); color: var(--gold-ink); }
  ${extraCss}
</style></head><body>
<header><img src="http://localhost:3100/img/logo.svg" alt="">Khutbah.dev<a class="close" href="#">Whole page</a></header>
<div class="where"><span>Second khutbah · <b>1</b> of 21</span><span>2:41 left</span></div>
<div class="bar">${Array.from({ length: 21 }, (_, i) => `<i class="${i < 0 ? 'done' : i === 0 ? 'now' : ''}"></i>`).join('')}</div>
<main>${body}</main>
<div class="player"><span class="play">${PLAY}</span><span class="time">5:52 / 14:22</span><span class="pill">1×</span><span class="seg"><span>Imam</span><span class="on">English</span></span></div>
</body></html>`;

// A: lyrics. The sentence being read large; the rest of the passage small and dim; the view keeps it in the middle.
writeFileSync(here + 'a-lyrics.html', page('A lyrics', `
  <div class="ar">${AR}</div>
  <div class="lyric">${EN.map((s, i) => `<p class="${i === CUR ? 'cur' : i < CUR ? 'past' : 'next'}">${i === CUR ? lit(s) : s}</p>`).join('')}</div>
  <div class="nav"><a href="#">‹ Previous</a><a href="#">Next ›</a></div>`, `
  main { display: flex; flex-direction: column; }
  .ar { margin: 16px 20px 0; direction: rtl; text-align: right; font: 400 18px/1.9 var(--ar); color: rgba(216,184,108,.78); max-height: 3.8em; overflow: hidden;
        -webkit-mask-image: linear-gradient(#000 60%, transparent); mask-image: linear-gradient(#000 60%, transparent); }
  .lyric { flex: 1; min-height: 0; overflow: hidden; padding: 14px 20px 0; display: flex; flex-direction: column; justify-content: flex-start; gap: 14px;
           -webkit-mask-image: linear-gradient(#000 84%, transparent); mask-image: linear-gradient(#000 84%, transparent); }
  .lyric p { font-size: 17px; line-height: 1.5; color: rgba(236,230,214,.36); }
  .lyric p.cur { font: 400 24px/1.4 var(--text); }`));

// B: pages. A long passage splits at a sentence end into screens that fit; the voice turns the page.
writeFileSync(here + 'b-pages.html', page('B pages', `
  <div class="pg">
    <div class="ar">${AR1}</div>
    <div class="tr">${lit(EN[0], 99)} ${lit(EN[1])}</div>
  </div>
  <div class="dots"><i class="on"></i><i></i><span>Part 1 of 2</span></div>
  <div class="nav"><a href="#">‹ Previous</a><a href="#">Next ›</a></div>`, `
  main { display: flex; flex-direction: column; }
  .pg { flex: 1; min-height: 0; padding: 18px 20px 0; overflow: hidden; }
  .ar { direction: rtl; text-align: right; font: 400 21px/1.95 var(--ar); color: var(--cream); }
  .tr { margin-top: 12px; font-size: 17px; line-height: 1.6; }
  .dots { display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 13.5px; color: var(--mist); }
  .dots i { width: 7px; height: 7px; border-radius: 50%; background: rgba(216,184,108,.3); } .dots i.on { background: var(--gold); }
  .dots span { margin-left: 6px; }`));

// C: your language first. The translation large; the imam's Arabic one tap away.
writeFileSync(here + 'c-language-first.html', page('C language first', `
  <div class="pg">
    <a class="show-ar" href="#">Show the imam's Arabic <span>⌄</span></a>
    <div class="tr">${EN.map((s, i) => (i === CUR ? lit(s) : i < CUR ? lit(s, 999) : `<span class="unsaid">${s}</span>`)).join(' ')}</div>
  </div>
  <div class="nav"><a href="#">‹ Previous</a><a href="#">Next ›</a></div>`, `
  main { display: flex; flex-direction: column; }
  .pg { flex: 1; min-height: 0; padding: 14px 20px 0; overflow: hidden; }
  .show-ar { display: inline-flex; align-items: center; gap: 6px; min-height: 40px; color: var(--gold); font-size: 15px; text-decoration: underline; text-decoration-color: var(--gold-dim); text-underline-offset: 4px; }
  .show-ar span { text-decoration: none; }
  .tr { margin-top: 6px; font: 300 22px/1.55 var(--text); }`));

// D: two panes, like subtitles. The Arabic in a strip at the top, the translation below; each keeps its place.
writeFileSync(here + 'd-two-panes.html', page('D two panes', `
  <div class="ar-pane"><div>${arLit(AR, 17)}</div></div>
  <div class="tr-pane"><div>${EN.map((s, i) => (i === CUR ? lit(s) : i < CUR ? lit(s, 999) : `<span class="unsaid">${s}</span>`)).join(' ')}</div></div>
  <div class="nav"><a href="#">‹ Previous</a><a href="#">Next ›</a></div>`, `
  main { display: flex; flex-direction: column; }
  .ar-pane { margin: 16px 20px 0; height: 128px; overflow: hidden; border-bottom: 1px solid var(--line-soft);
             -webkit-mask-image: linear-gradient(transparent, #000 18%, #000 80%, transparent); mask-image: linear-gradient(transparent, #000 18%, #000 80%, transparent); }
  .ar-pane div { direction: rtl; text-align: right; font: 400 21px/2 var(--ar); transform: translateY(-38px); }
  .tr-pane { flex: 1; min-height: 0; overflow: hidden; padding: 14px 20px 0;
             -webkit-mask-image: linear-gradient(#000 82%, transparent); mask-image: linear-gradient(#000 82%, transparent); }
  .tr-pane div { font: 300 20px/1.6 var(--text); }`));
console.log('4 mockups written');
