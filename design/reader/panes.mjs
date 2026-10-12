// The reader as two teleprompters tied together (Meer, 12 Oct 2026): the imam's Arabic in a pane above, the language
// chosen in a pane below, each one continuous text; scrolling either scrolls both to the same place, and while a voice
// plays its pane glides line by line and the other keeps pace. On a computer the panes stand side by side.
// Built from the stacked mockup: node design/reader/build.mjs && node design/reader/panes.mjs
import { readFileSync, writeFileSync } from 'fs';
const here = new URL('.', import.meta.url).pathname;
let s = readFileSync(here + 'reader.html', 'utf8');
const rep = (a, b) => { const n = s.split(a).length - 1; if (n !== 1) throw new Error(`expected 1 match, got ${n}: ${a.slice(0, 90)}`); s = s.replace(a, b); };
const cut = (from, to, by) => { const a = s.indexOf(from), b = s.indexOf(to, a); if (a < 0 || b < 0) throw new Error('cut: ' + from.slice(0, 60)); s = s.slice(0, a) + by + s.slice(b); };

// ── markup: a short top (title, date, the language line, In short on a tap), then the two panes ──
cut('    return `\n    <div class="layout">', '  async function enhanceQuranRefs', `    const khutbah = renderTranslation(r);
    return \`
    <div class="r-top" id="rTop">
      <div class="r-head">
        <a class="back-home" href="/#khutbahs">← All khutbahs</a>
        <h2 class="r-title">\${escHtml(r.title || 'Friday Khutbah')}</h2>
        <p class="meta-row">\${r.date ? \`<span>\${escHtml(r.date)}</span>\` : ''}\${hijri ? \`<span class="hijri" lang="ar">\${hijri}</span>\` : ''}\${masjid ? \`<span>\${masjid}</span>\` : ''}\${khateeb ? \`<span>\${khateeb}</span>\` : ''}</p>
      </div>
      <div class="r-tools">
        <p class="tongue-line" id="tongues" role="group" aria-label="Language">\${tongues.map(([c, name, lang], i) => (i ? '<span class="sep" aria-hidden="true">·</span>' : '') + \`<button type="button" data-l="\${c}"\${lang ? \` lang="\${lang}"\` : ''} aria-pressed="false" onclick="chooseLang('\${c}')"\${c === 'ar' ? ' title="The imam\\'s own words, in his voice"' : ''}>\${name}</button>\`).join('')}</p>
        <details class="r-short">
          <summary>\${bi('In Short')}</summary>
          <div class="r-short-body">
            <p class="share-text\${TR.length ? ' chunk-en' : ''}">\${escHtml(r.share_summary || r.summary || '')}</p>
            \${trShare('share_summary')}
            <button class="copy-btn" onclick="copyShare()">\${bi('Copy for WhatsApp')}</button>
          </div>
        </details>
        <div class="r-size" id="textSize" role="group" aria-label="Text size"><button type="button" data-ts="0.86" aria-label="Smaller text" aria-pressed="false">A</button><button type="button" data-ts="1" aria-label="Normal text" aria-pressed="true">A</button><button type="button" data-ts="1.16" aria-label="Larger text" aria-pressed="false">A</button></div>
      </div>
    </div>
    <div class="panes" id="panes">
      <div class="pane pane-ar" id="paneAr" aria-label="The imam's Arabic">\${khutbah}</div>
      <div class="stars-seam" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5.2" y="5.2" width="13.6" height="13.6"/><rect x="5.2" y="5.2" width="13.6" height="13.6" transform="rotate(45 12 12)"/><circle cx="12" cy="12" r="2.3"/></svg><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5.2" y="5.2" width="13.6" height="13.6"/><rect x="5.2" y="5.2" width="13.6" height="13.6" transform="rotate(45 12 12)"/><circle cx="12" cy="12" r="2.3"/></svg><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5.2" y="5.2" width="13.6" height="13.6"/><rect x="5.2" y="5.2" width="13.6" height="13.6" transform="rotate(45 12 12)"/><circle cx="12" cy="12" r="2.3"/></svg></div>
      <div class="pane pane-tr" id="paneTr" aria-label="The translation">\${khutbah.replace(/class="reader-chunk"/g, 'class="tr-chunk"')}
        <div class="sources">
          <div class="section">
            <div class="section-header"><h2>Every ayah <span class="count-badge">\${qRefs.length}</span></h2></div>
            <div class="section-body">\${qRefs.map((q, i) => [q, i])
              .sort(([a, ia], [b, ib]) => (a.surah_number || 999) - (b.surah_number || 999) || (a.ayah_number || 0) - (b.ayah_number || 0) || ia - ib)
              .map(([q, i]) => renderQuranRef(q, i)).join('')}</div>
          </div>
          \${hadithRefs.length ? \`<div class="section">
            <div class="section-header"><h2>Every hadith <span class="count-badge">\${hadithRefs.length}</span></h2></div>
            <div class="section-body">\${hadithRefs.map(renderHadithRef).join('')}</div>
          </div>\` : ''}
        </div>
        <p class="pane-feedback"><button class="footer-feedback" onclick="openFeedback()">Tell us what to fix</button></p>
      </div>
    </div>\`;
  }

`);

// ── the twin: each passage's translation is in the lower pane, its Arabic in the upper one ──
rep(`  let onWord = null, litRange = null;`, `  let onWord = null, litRange = null;
  // A passage's translation lives in the lower pane (.tr-chunk), its Arabic in the upper one (.reader-chunk).
  const twinOf = el => (el && document.querySelector(\`#paneTr .tr-chunk[data-i="\${el.dataset.i}"]\`)) || el;
  // Scrolling either pane scrolls the other to the same passage and the same point in it, on a reading line a third
  // of the way down. driveBy(pane) marks a pane the page itself is moving, so the other follows it and not back.
  let driveBy = () => {};
  function setupPanes() {
    const A = document.getElementById('paneAr'), B = document.getElementById('paneTr');
    if (!A || !B) return;
    let driver = null, at = 0;
    driveBy = p => { driver = p; at = performance.now(); };
    const items = p => [...p.querySelectorAll(':scope > [data-i]')];
    const sync = (src, dst) => {
      const a = items(src), b = items(dst);
      if (!a.length || !b.length || dst.offsetParent === null) return;
      const line = src.scrollTop + src.clientHeight * 0.34;
      let i = a.findIndex(el => el.offsetTop + el.offsetHeight > line);
      if (i < 0) i = a.length - 1;
      const el = a[i], tw = b[Math.min(i, b.length - 1)];
      const f = Math.min(1, Math.max(0, (line - el.offsetTop) / Math.max(1, el.offsetHeight)));
      dst.scrollTop = tw.offsetTop + f * tw.offsetHeight - dst.clientHeight * 0.34;
    };
    for (const [src, dst] of [[A, B], [B, A]]) src.addEventListener('scroll', () => {
      const now = performance.now();
      if (driver !== src && now - at < 160) return;   // being moved by the other pane
      driver = src; at = now;
      sync(src, dst);
      document.body.classList.toggle('reading', src.scrollTop > 30 || document.body.classList.contains('playing'));
    }, { passive: true });
  }`);
rep(`      if (!wordMaps.has(key)) wordMaps.set(key, matchWords(shownWords(el, lang), spoken, lang));`,
    `      if (!wordMaps.has(key)) wordMaps.set(key, matchWords(shownWords(lang === 'ar' ? el : twinOf(el), lang), spoken, lang));`);
rep(`    if (followEl && followEl !== el) delete followEl.dataset.follow;
    followEl = el;
    if (!el) { CSS.highlights.delete('kt-said'); CSS.highlights.delete('kt-word'); return; }
    el.dataset.follow = f.lang;`, `    const host = el && (f.lang === 'ar' ? el : twinOf(el));
    if (followEl && followEl !== host) delete followEl.dataset.follow;
    followEl = host;
    if (!el) { CSS.highlights.delete('kt-said'); CSS.highlights.delete('kt-word'); return; }
    host.dataset.follow = f.lang;`);
rep(`    document.getElementById('app').innerHTML = renderResults(result);`, `    document.getElementById('app').innerHTML = renderResults(result);
    setupPanes();
    setupSize();`);
rep(`  function setupPanes() {`, `  // Text size (Meer, 12 Oct): three steps for both panes, kept for the next visit (localStorage 'kt-size')
  function setupSize() {
    const box = document.getElementById('textSize');
    if (!box) return;
    const set = v => {
      document.documentElement.style.setProperty('--ts', v);
      box.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.ts === String(v))));
    };
    let saved = null;
    try { saved = localStorage.getItem('kt-size'); } catch {}
    if (saved && box.querySelector(\`[data-ts="\${saved}"]\`)) set(saved);
    box.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      set(b.dataset.ts);
      try { localStorage.setItem('kt-size', b.dataset.ts); } catch {}
    });
  }
  function setupPanes() {`);
rep(`        btn.onclick = ev => { ev.stopPropagation(); btn.closest('.reader-chunk').classList.toggle('show-full-verse'); };`,
    `        btn.onclick = ev => { ev.stopPropagation(); const i = btn.closest('[data-i]').dataset.i; document.querySelectorAll(\`[data-i="\${i}"]\`).forEach(c => c.classList.toggle('show-full-verse')); };`);
rep(`        if (activeChunk) activeChunk.classList.remove('chunk-active');
        best.classList.add('chunk-active');`, `        if (activeChunk) { activeChunk.classList.remove('chunk-active'); twinOf(activeChunk).classList.remove('chunk-active'); }
        best.classList.add('chunk-active'); twinOf(best).classList.add('chunk-active');`);
rep(`    audio.addEventListener('play', () => { document.body.classList.add('playing'); if (following) toActive(); });`,
    `    audio.addEventListener('play', () => { document.body.classList.add('playing', 'reading'); if (following) toActive(); });`);

// ── following inside the panes: the voice's pane glides line by line; the other follows by the sync ──
cut(`    const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;`, `    const showBack = () => {`, `    const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
    const paneAr = document.getElementById('paneAr');
    const paneOf = node => (node.nodeType === 1 ? node : node.parentElement).closest('.pane') || paneAr;
    let glidedAt = 0;   // one glide at a time: while a pane moves, the line is not yet where it will be
    const toLine = range => {
      const r = range.getBoundingClientRect();
      if (!r.height) return false;
      const pane = paneOf(range.startContainer), p = pane.getBoundingClientRect();
      glidedAt = performance.now(); driveBy(pane);
      pane.scrollTo({ top: pane.scrollTop + (r.top - p.top) - pane.clientHeight * 0.34, behavior: still() ? 'auto' : 'smooth' });
      return true;
    };
    onWord = range => {
      if (!following || audio.paused || performance.now() - glidedAt < 900) return;
      const r = range.getBoundingClientRect();
      if (!r.height) return;
      const pane = paneOf(range.startContainer), p = pane.getBoundingClientRect(), h = pane.clientHeight;
      if (r.top - p.top < h * 0.16 || r.bottom - p.top > h * 0.6) toLine(range);
    };
    const toActive = () => {
      follow(); byHand = false;
      if (!activeChunk) return;
      if (litRange && [activeChunk, twinOf(activeChunk)].some(x => x.contains(litRange.startContainer)) && toLine(litRange)) return;
      const p = paneAr.getBoundingClientRect(), r = activeChunk.getBoundingClientRect();
      driveBy(paneAr);
      paneAr.scrollTo({ top: paneAr.scrollTop + (r.top - p.top) - paneAr.clientHeight * 0.12, behavior: still() ? 'auto' : 'smooth' });
    };
`);
rep(`      const away = !!r && (r.bottom < 90 || r.top > innerHeight - 140);`, `      const pr = document.getElementById('paneAr').getBoundingClientRect();
      const away = !!r && (r.bottom < pr.top + 8 || r.top > pr.bottom - 8);`);
rep(`      if (away) backBtn.classList.toggle('up', r.bottom < 90);`, `      if (away) backBtn.classList.toggle('up', r.bottom < pr.top + 8);`);
rep(`    addEventListener('scroll', () => { if (byHand) showBack(); }, { passive: true });`,
    `    document.querySelectorAll('.pane').forEach(p => p.addEventListener('scroll', () => { if (byHand) showBack(); }, { passive: true }));`);
// a tap on the translation plays from that word, as a tap on the Arabic does
rep(`    scrubber.addEventListener('input', () => {`, `    document.querySelectorAll('#paneTr .tr-chunk').forEach(tw => tw.addEventListener('click', e => {
      if (e.target.closest('a, button')) return;
      const a = document.querySelector(\`#paneAr .reader-chunk[data-i="\${tw.dataset.i}"]\`);
      if (!a) return;
      follow();
      const w = wordTimeAt(a, e.clientX, e.clientY), t = w ?? chunkTime(a);
      if (t == null) return;
      audio.currentTime = t; audio.play(); setPlayIcon(false);
    }));

    scrubber.addEventListener('input', () => {`);

// ── styles ──
rep(`  </style>

</head>`, `
    /* ── Two teleprompters (the panes layout) ── */
    html, body { height: 100%; }
    body { height: 100dvh; display: flex; flex-direction: column; overflow: hidden; }
    body::before { display: none; }
    header { position: relative; flex: none; }
    #app { order: 1; flex: 1; min-height: 0; width: 100%; max-width: 720px; margin: 0 auto; padding: 0; display: flex; flex-direction: column; }
    .site-footer { display: none; }
    .r-top { flex: none; padding: 0 20px; }
    .r-head { max-height: 220px; overflow: hidden; transition: max-height .4s cubic-bezier(.16, 1, .3, 1), opacity .25s; }
    body.reading .r-head { max-height: 0; opacity: 0; }
    .r-title { margin-top: 2px; font: 600 24px/1.2 var(--display); letter-spacing: -.005em; text-wrap: balance; color: var(--cream); }
    .r-tools { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0 14px; padding-bottom: 2px; }
    .r-tools .tongue-line { margin-top: 4px; font-size: 20px; }
    .r-short > summary {
      display: inline-flex; align-items: center; gap: 6px; min-height: 40px; cursor: pointer; list-style: none;
      color: var(--gold); font-size: 16px; text-decoration: underline; text-decoration-color: var(--gold-dim); text-underline-offset: 4px;
    }
    .r-short > summary::-webkit-details-marker { display: none; }
    .r-short > summary::after { content: ''; width: 7px; height: 7px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: translateY(-2px) rotate(45deg); }
    .r-short[open] { flex-basis: 100%; }
    .r-short[open] > summary::after { transform: translateY(2px) rotate(-135deg); }
    .r-short-body { max-height: 34vh; overflow-y: auto; padding-bottom: 8px; }
    .r-short-body .share-text { font-size: 18px; line-height: 1.6; font-weight: 400; color: #DCDED5; }
    body.rtl .r-short-body { text-align: right; }
    body[class] .r-short > summary .tr-inline[lang] { font-size: 17px; }

    /* the imam's Arabic above in parchment, the translation below in cream, the three gold stars between them (Meer picked E) */
    .panes { flex: 1; min-height: 0; display: grid; grid-template-rows: 1fr auto 1fr; }
    /* the seam: the three stars with a gold line either side, fading out towards the edges (Meer picked it, 12 Oct) */
    .stars-seam { display: flex; justify-content: center; align-items: center; gap: 14px; padding: 8px 20px 6px; color: var(--gold); }
    .stars-seam svg { width: 16px; height: 16px; flex: none; }
    .stars-seam::before, .stars-seam::after { content: ''; flex: 1; height: 1px; }
    .stars-seam::before { margin-right: 4px; background: linear-gradient(to right, transparent, var(--gold)); }
    .stars-seam::after { margin-left: 4px; background: linear-gradient(to left, transparent, var(--gold)); }
    .pane {
      position: relative; overflow-y: auto; overscroll-behavior: contain; padding: 14px 20px 0; scrollbar-width: none;
      -webkit-mask-image: linear-gradient(transparent, #000 7%, #000 90%, transparent); mask-image: linear-gradient(transparent, #000 7%, #000 90%, transparent);
    }
    .pane::-webkit-scrollbar { display: none; }
    .pane::after { content: ''; display: block; height: 66%; }
    .pane-ar .chunk-arabic:not(.chunk-arabic-quran) { color: #EADFBF; }
    /* the upper pane is the imam's words alone, the lower one the translation alone: continuous text, no rules between passages */
    .pane-ar :is(.chunk-en, .chunk-tr, .chunk-quran-translation, .verse-toggle, .trans-ours) { display: none !important; }
    .pane-tr .chunk-arabic { display: none; }
    .pane :is(.reader-chunk, .tr-chunk) { position: relative; padding: 0 0 12px; border: 0; transition: opacity .35s; cursor: pointer; }
    .pane .chunk-arabic { margin: 0; font-size: calc(30px * var(--ts, 1)); line-height: 1.85; }
    .pane .chunk-arabic-quran { font-size: calc(30px * var(--ts, 1)); text-align: right; padding: 0; }
    .pane-tr .chunk-english { font-size: calc(22px * var(--ts, 1)); line-height: 1.55; }
    .pane-tr .chunk-hadith-trans { font-size: calc(20px * var(--ts, 1)); }
    /* Urdu and Bengali as large as English (the language files size them for running text beside the Arabic) */
    .pane-tr .chunk-tr[lang] :is(.chunk-english, .chunk-hadith-trans), .pane-tr .chunk-quran-translation.chunk-tr[lang] { font-size: calc(22px * var(--ts, 1)); }
    .pane-tr .chunk-tr[lang="ur"] :is(.chunk-english, .chunk-hadith-trans), .pane-tr .chunk-quran-translation.chunk-tr[lang="ur"] { line-height: 2.25; }
    .pane-tr .chunk-tr[lang="bn"] :is(.chunk-english, .chunk-hadith-trans), .pane-tr .chunk-quran-translation.chunk-tr[lang="bn"] { line-height: 1.75; }
    .pane-tr :is(.chunk-en, .chunk-tr) { text-align: start; }
    .pane-tr .chunk-quran-translation { text-align: start; margin: 0; font-size: calc(21px * var(--ts, 1)); }
    /* text size: three A's, small to large */
    .r-size { display: inline-flex; align-items: baseline; gap: 2px; margin-left: auto; }
    .r-size button { min-width: 40px; min-height: 40px; padding: 0 4px; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--gold); cursor: pointer; font-family: var(--text); line-height: 1; }
    .r-size button:nth-child(1) { font-size: 14px; } .r-size button:nth-child(2) { font-size: 18px; } .r-size button:nth-child(3) { font-size: 23px; }
    .r-size button[aria-pressed="true"] { color: #F3DFA6; border-bottom-color: var(--gold); }
    .pane :is(.chunk-quran-cite, .chunk-hadith-cite) { font-size: 16px; }

    /* the player: part of the page (below the panes), the progress line with the time at both ends, then
       speed · −10s · play · +10s · voice, play in the centre */
    .audio-player { order: 2; flex: none; position: relative; left: auto; right: auto; bottom: auto; padding: 8px 16px calc(14px + env(safe-area-inset-bottom)); }
    .audio-player.ready { display: grid; grid-template-columns: 1fr auto auto auto 1fr; grid-template-areas: "bar bar bar bar bar" "speed back play fwd voice"; align-items: center; column-gap: 6px; row-gap: 2px; }
    .ap-bar { grid-area: bar; display: flex; align-items: center; gap: 10px; }
    .ap-bar .audio-scrubber { flex: 1; width: auto; margin: 0; height: 28px; }
    .ap-cur, .ap-dur { font-size: 14px; color: var(--mist); font-variant-numeric: tabular-nums; }
    .audio-time { display: none; }
    .ap-transport { display: contents; }
    .skip-back { grid-area: back; } .skip-fwd { grid-area: fwd; }
    .audio-player .skip-btn { display: inline-flex; align-items: center; justify-content: center; min-width: 52px; min-height: 52px; font-size: 16px; color: var(--gold); }
    .audio-player .play-btn { grid-area: play; width: 60px; height: 60px; margin: 0 6px; }
    .audio-player .play-btn svg { width: 22px; height: 22px; }
    .audio-player .speed-btn { grid-area: speed; justify-self: start; }
    .audio-player .ap-group { grid-area: voice; justify-self: end; }
    .audio-player .seg { display: none; }
    .side-btn {
      display: inline-flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; min-width: 76px; min-height: 52px; padding: 4px 12px;
      border: 1px solid var(--line); border-radius: 14px; background: none; color: var(--gold); cursor: pointer; line-height: 1.15;
    }
    .side-btn small { font-size: 12px; color: var(--mist); }
    .side-btn b { font-size: 16px; font-weight: 500; }
    .side-btn b[lang="ur"] { font-family: 'Noto Nastaliq Urdu', serif; font-size: 15px; line-height: 1.5; }
    .side-btn b[lang="bn"] { font-family: 'Noto Serif Bengali', serif; }
    .audio-player .skip-btn { min-width: 46px; }
    .audio-player .back-to-active { font-size: 15px; }
    .pane .khutbah-divider { margin: 16px 0 14px; }
    body.playing .pane :is(.reader-chunk, .tr-chunk):not(.chunk-active) { opacity: .42; }
    .tr-chunk[data-follow="en"] :is(.chunk-en .chunk-english, .chunk-en .chunk-hadith-trans, .chunk-quran-translation:not(.chunk-tr)),
    .tr-chunk[data-follow="en"] :is(.chunk-en .chunk-english, .chunk-en .chunk-hadith-trans, .chunk-quran-translation:not(.chunk-tr)) *,
    .tr-chunk[data-follow]:not([data-follow="ar"], [data-follow="en"]) :is(.chunk-tr .chunk-english, .chunk-tr .chunk-hadith-trans, .chunk-quran-translation.chunk-tr),
    .tr-chunk[data-follow]:not([data-follow="ar"], [data-follow="en"]) :is(.chunk-tr .chunk-english, .chunk-tr .chunk-hadith-trans, .chunk-quran-translation.chunk-tr) * {
      color: rgba(236, 230, 214, .32);
    }
    .pane-tr .sources { margin-top: 40px; }
    .pane-feedback { margin: 24px 0 0; }
    /* العربية alone: the upper pane takes the whole space */
    body.ar-only :is(.pane-tr, .stars-seam) { display: none; }
    body.ar-only .panes { grid-template-rows: 1fr; }
    @media (min-width: 901px) {
      #app { max-width: 1180px; }
      .panes { grid-template-rows: none; grid-template-columns: 1fr auto 1fr; }
      .pane-tr { order: 1; } .stars-seam { order: 2; flex-direction: column; padding: 18px 6px; } .pane-ar { order: 3; }
      .stars-seam::before, .stars-seam::after { width: 1px; height: auto; }
      .stars-seam::before { margin: 0 0 4px; background: linear-gradient(to bottom, transparent, var(--gold)); }
      .stars-seam::after { margin: 4px 0 0; background: linear-gradient(to top, transparent, var(--gold)); }
      .pane { padding: 18px 28px 0; }
      .pane .chunk-arabic, .pane .chunk-arabic-quran { font-size: calc(32px * var(--ts, 1)); }
      .pane-tr .chunk-english { font-size: calc(22px * var(--ts, 1)); }
      .audio-player { padding-left: max(28px, calc(50vw - 590px)); padding-right: max(28px, calc(50vw - 590px)); }
      body.ar-only .panes { grid-template-columns: 1fr; }
      header { padding-left: max(28px, calc(50vw - 590px)); padding-right: max(28px, calc(50vw - 590px)); }
      .audio-player { padding-left: max(28px, calc(50vw - 590px)); padding-right: max(28px, calc(50vw - 590px)); }
    }
  </style>

</head>`);
// While a voice reads the translation, the Arabic it is translating lights too (Meer, 12 Oct): a group of four of the
// imam's words at the same point in his passage as the voice is in its translation. By position, not an exact
// word-for-word match, which is enough to cross-check that the translation follows the Arabic.
rep(`    litRange = words[k].range;
    onWord?.(litRange);`, `    litRange = words[k].range;
    onWord?.(litRange);
    nearArabic(el, f.lang, k, words.length);`);
rep(`    if (!el) { CSS.highlights.delete('kt-said'); CSS.highlights.delete('kt-word'); return; }`,
    `    if (!el) { CSS.highlights.delete('kt-said'); CSS.highlights.delete('kt-word'); clearNear(); return; }`);
rep(`    if (k < 0) { CSS.highlights.delete('kt-word'); return; }`, `    if (k < 0) { CSS.highlights.delete('kt-word'); clearNear(); return; }`);
rep(`  // Every frame while playing: timeupdate comes only about four times a second.`, `  // The part of the imam's sentence the voice is translating, matched by meaning (Meer, 12 Oct): each passage's
  // Arabic and translation split into matching phrases when the khutbah is made (design/reader/align/), and the
  // Arabic phrase whose translation the voice is reading is bright, the rest of his passage dimmed. A passage with
  // no matching (or one that does not check out) lights no part: nothing is guessed.
  // The translation does the same (Meer, 12 Oct): the phrase being read bright, the rest of its passage dimmed,
  // the word being said still gold.
  let nearEl = null, nearKey = null, nearTr = null;
  const alignCache = new Map();
  function clearNear() { if (nearEl) delete nearEl.dataset.near; nearEl = null; nearKey = null; nearTr = null; CSS.highlights.delete('kt-near'); }
  const rawWords = t => t.split(/\\s+/).filter(Boolean);
  const rawTr = t => (t || '').split(/\\n\\n+/).map(p => p.trim()).filter(p => p && !/^(📖|📑|📚)/u.test(p)).map(p => p.replace(/^❝\\s*/, '')).join(' ');
  function alignOf(el, lang) {
    const i = el.dataset.i, key = lang + ':' + i;
    if (alignCache.has(key)) return alignCache.get(key);
    let out = null;
    const pairs = (result.align || window.__ALIGN || {})[lang]?.[i];
    const c = result.reader_chunks?.[i];
    if (pairs && c) {
      const L = TR.find(x => x.code === lang);
      const ar = rawWords(c.arabic), tr = rawWords(rawTr(lang === 'en' ? c.english : c[L?.field]));
      let pa = -1, pt = -1, good = true;
      for (const [a, t] of pairs) { if (!(a > pa && t > pt)) good = false; pa = a; pt = t; }
      if (good && pa === ar.length - 1 && pt === tr.length - 1) {
        // the words on screen, each with its place in the passage's text
        const arShown = matchWords(shownWords(el, 'ar'), ar.map((w, j) => [w, j, j]), 'ar');
        const trShown = matchWords(shownWords(twinOf(el), lang), tr.map((w, j) => [w, j, j]), lang);
        out = { pairs, arShown, trShown };
      }
    }
    alignCache.set(key, out);
    return out;
  }
  function nearArabic(el, lang, k, n) {
    if (lang === 'ar' || !el || !litRange) return clearNear();
    const A = alignOf(el, lang);
    if (!A) return clearNear();
    const at = A.trShown.find(w => w.range.startContainer === litRange.startContainer && w.range.startOffset === litRange.startOffset);
    if (!at) { if (nearTr) CSS.highlights.set('kt-said', nearTr); return; }   // a lead-in the voice adds: keep the phrase lit
    const j = at.start;
    let s0 = 0, a0 = 0, a1 = -1, prevT = -1, t0 = 0, t1 = -1;
    for (const [a, t] of A.pairs) { if (j <= t && j > prevT) { a0 = s0; a1 = a; t0 = prevT + 1; t1 = t; break; } prevT = t; s0 = a + 1; }
    if (a1 < 0) return clearNear();
    const k2 = el.dataset.i + ':' + a0 + ':' + a1;
    if (k2 !== nearKey) {
      const trLit = A.trShown.filter(w => w.start >= t0 && w.start <= t1).map(w => w.range);
      nearTr = trLit.length ? new Highlight(...trLit) : null;
    }
    // the translation phrase bright in place of the words said so far (paintWord sets those on every word)
    if (nearTr) CSS.highlights.set('kt-said', nearTr);
    if (k2 === nearKey) return;
    const lit = A.arShown.filter(w => w.start >= a0 && w.start <= a1).map(w => w.range);
    if (!lit.length) return clearNear();
    if (nearEl && nearEl !== el) delete nearEl.dataset.near;
    nearEl = el; nearKey = k2; el.dataset.near = '';
    CSS.highlights.set('kt-near', new Highlight(...lit));
  }

  // Every frame while playing: timeupdate comes only about four times a second.`);
rep(`    ::highlight(kt-word) {`, `    ::highlight(kt-near) { color: #FBF3DC; }
    .pane-ar .reader-chunk[data-near] .chunk-arabic, .pane-ar .reader-chunk[data-near] .chunk-arabic * { color: rgba(234, 223, 191, .3); transition: color .3s; }
    ::highlight(kt-word) {`);

// the player (Meer, 12 Oct): the progress line with the time at both ends; below it speed on the left, −10s,
// play/pause in the centre, +10s, and the voice (the imam or the language chosen) on the right
rep(`    <input class="audio-scrubber" id="scrubber" type="range" min="0" max="100" value="0" step="0.1" aria-label="Position in the recording">`,
    `    <div class="ap-bar"><span class="ap-cur" id="apCur">0:00</span><input class="audio-scrubber" id="scrubber" type="range" min="0" max="100" value="0" step="0.1" aria-label="Position in the recording"><span class="ap-dur" id="apDur">0:00</span></div>`);
rep(`    <span id="apCur" hidden></span><span id="apDur" hidden></span>
`, '');
// the two side controls say what they are: Speed (1×) on the left, Voice (the imam or the language) on the right;
// a tap on Voice switches between the language's own voice and the imam
rep(`    <button class="speed-btn" id="speedBtn" onclick="cycleSpeed()" title="Playback speed" aria-label="Playback speed">1×</button>`,
    `    <button class="speed-btn side-btn" id="speedBtn" onclick="cycleSpeed()" aria-label="Playback speed"><small>Speed</small><b id="speedVal">1×</b></button>`);
rep(`    document.getElementById('speedBtn').textContent = SPEEDS[speedIdx] + '×';`, `    document.getElementById('speedVal').textContent = SPEEDS[speedIdx] + '×';`);
rep(`<span class="seg" id="voiceSwitch">`, `<button type="button" class="side-btn" id="voiceToggle" onclick="toggleVoice()" aria-label="Voice: switch between the imam and the translation"><small>Voice</small><b id="voiceVal">Imam</b></button><span class="seg" id="voiceSwitch">`);
rep(`    group.hidden = !own;
  }`, `    group.hidden = !own;
    const L = TR.find(x => x.code === voice), val = document.getElementById('voiceVal');
    if (val) { val.textContent = voice === 'imam' ? 'Imam' : voice === 'en' ? 'English' : (L ? L.native : voice); val.lang = L ? L.code : ''; }
  }
  function toggleVoice() {
    const own = !document.body.classList.contains('ar-only') && result['tts_' + pageLang] ? pageLang : null;
    if (own) pickVoice(voice === 'imam' ? own : 'imam');
  }`);
{
  const A = JSON.parse(readFileSync(here + 'align/align-2026-10-09.json', 'utf8'));
  const data = Object.fromEntries(Object.entries(A.langs).map(([l, v]) => [l, Object.fromEntries((v.passages || []).map(p => [p.i, p.pairs]))]));
  rep(`<script src="/recited.js"></script>`, `<script>window.__ALIGN = ${JSON.stringify(data)};</script>\n<script src="/recited.js"></script>`);
}
// Highlights by kind (Meer, 12 Oct: hadith green): a lit or dimmed word keeps its colour, a hadith's green,
// the Quran's gold, the imam's own words cream. Each highlight is split into name, name-q and name-h.
rep(`  let onWord = null, litRange = null;`, `  let onWord = null, litRange = null;
  const HADITH = '.inline-hadith, .inline-hadith-en, .chunk-hadith-trans, .hadith-arabic';
  const QURAN = '.inline-ayah, .inline-ayah-en, .chunk-arabic-quran, .chunk-quran-translation';
  const kindOf = range => { const n = range.startContainer, el = n.nodeType === 1 ? n : n.parentElement; return el.closest(HADITH) ? 'h' : el.closest(QURAN) ? 'q' : ''; };
  function setHL(name, ranges) {
    const by = { '': [], q: [], h: [] };
    for (const x of ranges || []) by[kindOf(x)].push(x);
    for (const [k, list] of Object.entries(by)) { const nm = k ? name + '-' + k : name; if (list.length) CSS.highlights.set(nm, new Highlight(...list)); else CSS.highlights.delete(nm); }
  }
  function delHL(name) { for (const nm of [name, name + '-q', name + '-h']) CSS.highlights.delete(nm); }`);
s = s.replace(`CSS.highlights.set('kt-said', new Highlight(...words.slice(0, k + 1).map(w => w.range)));`, `setHL('kt-said', words.slice(0, k + 1).map(w => w.range));`);
s = s.split(`CSS.highlights.delete('kt-said')`).join(`delHL('kt-said')`);
s = s.split(`CSS.highlights.delete('kt-near')`).join(`delHL('kt-near')`);
s = s.replace(`CSS.highlights.set('kt-near', new Highlight(...lit));`, `setHL('kt-near', lit);`);
s = s.replace(`nearTr = trLit.length ? new Highlight(...trLit) : null;`, `nearTr = trLit.length ? trLit : null;`);
s = s.split(`CSS.highlights.set('kt-said', nearTr)`).join(`setHL('kt-said', nearTr)`);
rep(`    ::highlight(kt-near) { color: #FBF3DC; }`, `    ::highlight(kt-near) { color: #FBF3DC; }
    ::highlight(kt-near-h), ::highlight(kt-said-h) { color: #B8F2D3; }
    ::highlight(kt-near-q), ::highlight(kt-said-q) { color: var(--gold-bright); }`);
// dimmed, a hadith stays a dim green and the Quran a dim gold
rep(`  </style>\n\n</head>`, `    .pane :is(.reader-chunk[data-near], .tr-chunk[data-follow]) :is(.inline-hadith, .inline-hadith-en, .chunk-hadith-trans),
    .pane :is(.reader-chunk[data-near], .tr-chunk[data-follow]) :is(.inline-hadith, .inline-hadith-en, .chunk-hadith-trans) * { color: rgba(147, 221, 183, .38) !important; }
    .pane :is(.reader-chunk[data-near], .tr-chunk[data-follow]) :is(.inline-ayah, .inline-ayah-en, .chunk-quran-translation, .chunk-arabic-quran),
    .pane :is(.reader-chunk[data-near], .tr-chunk[data-follow]) :is(.inline-ayah, .inline-ayah-en, .chunk-quran-translation, .chunk-arabic-quran) * { color: rgba(216, 184, 108, .4) !important; }
  </style>\n\n</head>`);
writeFileSync(here + 'reader-panes.html', s);
console.log('design/reader/reader-panes.html', s.length, 'bytes');
