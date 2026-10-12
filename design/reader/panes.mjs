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
    setupPanes();`);
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
    #app { flex: 1; min-height: 0; width: 100%; max-width: 720px; margin: 0 auto; padding: 0 0 calc(58px + env(safe-area-inset-bottom)); display: flex; flex-direction: column; }
    .site-footer { display: none; }
    .r-top { flex: none; padding: 0 20px; }
    .r-head { max-height: 220px; overflow: hidden; transition: max-height .4s cubic-bezier(.16, 1, .3, 1), opacity .25s; }
    body.reading .r-head { max-height: 0; opacity: 0; }
    .r-title { margin-top: 2px; font: 600 21px/1.2 var(--display); letter-spacing: -.005em; text-wrap: balance; color: var(--cream); }
    .r-tools { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0 14px; padding-bottom: 2px; }
    .r-tools .tongue-line { margin-top: 4px; }
    .r-short > summary {
      display: inline-flex; align-items: center; gap: 6px; min-height: 40px; cursor: pointer; list-style: none;
      color: var(--gold); font-size: 14.5px; text-decoration: underline; text-decoration-color: var(--gold-dim); text-underline-offset: 4px;
    }
    .r-short > summary::-webkit-details-marker { display: none; }
    .r-short > summary::after { content: ''; width: 7px; height: 7px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: translateY(-2px) rotate(45deg); }
    .r-short[open] { flex-basis: 100%; }
    .r-short[open] > summary::after { transform: translateY(2px) rotate(-135deg); }
    .r-short-body { max-height: 34vh; overflow-y: auto; padding-bottom: 8px; }
    .r-short-body .share-text { font-size: 16px; line-height: 1.6; font-weight: 400; color: #DCDED5; }
    body.rtl .r-short-body { text-align: right; }
    body[class] .r-short > summary .tr-inline[lang] { font-size: 15px; }

    /* the imam's Arabic above in parchment, the translation below in cream, the three gold stars between them (Meer picked E) */
    .panes { flex: 1; min-height: 0; display: grid; grid-template-rows: 2fr auto 3fr; }
    .stars-seam { display: flex; justify-content: center; align-items: center; gap: 18px; padding: 8px 0 6px; color: var(--gold); }
    .stars-seam svg { width: 16px; height: 16px; }
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
    .pane .chunk-arabic { margin: 0; font-size: 26px; line-height: 1.95; }
    .pane .chunk-arabic-quran { font-size: 26px; text-align: right; padding: 0; }
    .pane-tr .chunk-english { font-size: 19px; line-height: 1.6; }
    .pane-tr .chunk-hadith-trans { font-size: 17.5px; }
    .pane-tr :is(.chunk-en, .chunk-tr) { text-align: start; }
    .pane-tr .chunk-quran-translation { text-align: start; margin: 0; font-size: 18px; }
    .pane .khutbah-divider { margin: 16px 0 14px; }
    body.playing .pane :is(.reader-chunk, .tr-chunk):not(.chunk-active) { opacity: .42; }
    .tr-chunk[data-follow="en"] :is(.chunk-en .chunk-english, .chunk-en .chunk-hadith-trans, .chunk-quran-translation:not(.chunk-tr)),
    .tr-chunk[data-follow="en"] :is(.chunk-en .chunk-english, .chunk-en .chunk-hadith-trans, .chunk-quran-translation:not(.chunk-tr)) *,
    .tr-chunk[data-follow]:not([data-follow="ar"], [data-follow="en"]) :is(.chunk-tr .chunk-english, .chunk-tr .chunk-hadith-trans, .chunk-quran-translation.chunk-tr),
    .tr-chunk[data-follow]:not([data-follow="ar"], [data-follow="en"]) :is(.chunk-tr .chunk-english, .chunk-tr .chunk-hadith-trans, .chunk-quran-translation.chunk-tr) * {
      color: rgba(236, 230, 214, .4);
    }
    .pane-tr .sources { margin-top: 40px; }
    .pane-feedback { margin: 24px 0 0; }
    /* العربية alone: the upper pane takes the whole space */
    body.ar-only :is(.pane-tr, .stars-seam) { display: none; }
    body.ar-only .panes { grid-template-rows: 1fr; }
    @media (min-width: 901px) {
      #app { max-width: 1180px; }
      .panes { grid-template-rows: none; grid-template-columns: 1fr auto 1fr; }
      .pane-tr { order: 1; } .stars-seam { order: 2; flex-direction: column; padding: 0 6px; } .pane-ar { order: 3; }
      .pane { padding: 18px 28px 0; }
      .pane .chunk-arabic, .pane .chunk-arabic-quran { font-size: 28px; }
      body.ar-only .panes { grid-template-columns: 1fr; }
      header { padding-left: max(28px, calc(50vw - 590px)); padding-right: max(28px, calc(50vw - 590px)); }
      .audio-player { padding-left: max(28px, calc(50vw - 590px)); padding-right: max(28px, calc(50vw - 590px)); }
    }
  </style>

</head>`);
writeFileSync(here + 'reader-panes.html', s);
console.log('design/reader/reader-panes.html', s.length, 'bytes');
