// Builds the reader mockup (design/reader/reader.html) from the live reader (public/reader.html): the same
// code for rendering, word timing, recitation and following, with the home page's look (reader.css.part),
// one language line, a slim player and a calmer top. Run from the repo root: node design/reader/build.mjs
import { readFileSync, writeFileSync } from 'fs';
const here = new URL('.', import.meta.url).pathname;
let s = readFileSync(here + '../../public/reader.html', 'utf8');
const css = readFileSync(here + 'reader.css.part', 'utf8');
const rep = (a, b) => { const n = s.split(a).length - 1; if (n !== 1) throw new Error(`expected 1 match, got ${n}: ${a.slice(0, 90)}`); s = s.replace(a, b); };
const cut = (from, to, by) => { const a = s.indexOf(from), b = s.indexOf(to, a); if (a < 0 || b < 0) throw new Error('cut: ' + from.slice(0, 60)); s = s.slice(0, a) + by + s.slice(b); };

// fonts: the home page's
s = s.replace(/  <link href="https:\/\/fonts\.googleapis\.com\/css2\?family=Inter[^\n]*\n/, '  <link href="https://fonts.googleapis.com/css2?family=Kufam:wght@500;600&family=Readex+Pro:wght@300;400;500&family=Amiri:wght@400;700&family=Amiri+Quran&family=Noto+Naskh+Arabic&family=Noto+Nastaliq+Urdu:wght@400;500&family=Noto+Serif+Bengali:wght@400;500&display=swap" rel="stylesheet">\n');
cut('  <style>\n    *, *::before', '</head>', css + '\n');

// header: the brand and the live count, as on the home page
cut('<header>', '  <div class="audio-player"', `<header>
  <a class="brand" href="/"><img src="/img/logo.svg" alt="" width="34" height="34">Khutbah.dev</a>
  <span class="viewers" id="viewers" title="People reading now">
    <span class="live-dot" aria-hidden="true"></span>
    <span><b id="liveCount">–</b> reading now</span>
    <span class="total-views">· <b id="uniqueCount">–</b> unique · <b id="totalCount">–</b> visits</span>
  </span>
  <select class="khutbah-select" id="khutbahSelect" onchange="switchKhutbah(this.value)" aria-label="Choose a khutbah" tabindex="-1"></select>
</header>

`);

// the player: play, the time, speed, and the voice (the language's own, or the imam); a thin gold line to seek
cut('  <div class="audio-player" id="audioPlayer">', '<div id="app">', `  <div class="audio-player" id="audioPlayer">
    <button type="button" class="back-to-active" id="backToActive" hidden><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"/></svg>Show what's playing</button>
    <input class="audio-scrubber" id="scrubber" type="range" min="0" max="100" value="0" step="0.1" aria-label="Position in the recording">
    <div class="ap-transport">
      <button class="skip-btn skip-back" onclick="skip(-10)" title="Back 10 seconds" aria-label="Back 10 seconds">−10s</button>
      <button class="play-btn" id="playBtn" onclick="togglePlay()" aria-label="Play or pause">
        <svg id="playIcon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>
        <svg id="pauseIcon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" style="display:none"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>
      </button>
      <button class="skip-btn skip-fwd" onclick="skip(10)" title="Forward 10 seconds" aria-label="Forward 10 seconds">+10s</button>
    </div>
    <span class="audio-time" id="audioTime">0:00 / 0:00</span>
    <span id="apCur" hidden></span><span id="apDur" hidden></span>
    <button class="speed-btn" id="speedBtn" onclick="cycleSpeed()" title="Playback speed" aria-label="Playback speed">1×</button>
    <div class="ap-group" id="hearGroup" role="group" aria-label="Voice" hidden>
      <span class="seg" id="voiceSwitch"><button type="button" data-voice="imam" class="on" aria-pressed="true" onclick="pickVoice('imam')" title="The imam's recording, in Arabic">Imam</button><button type="button" data-voice="en" aria-pressed="false" onclick="pickVoice('en')" title="The English translation, read aloud" hidden>English</button></span>
    </div>
  </div>

`);

// footer
cut('<footer class="site-footer">', '<!-- Feedback modal -->', `<footer class="site-footer">
  Made by <strong>Meer Husamuddin</strong> in Riyadh.<a href="https://www.linkedin.com/in/meerhusam" target="_blank" rel="noopener">LinkedIn</a><a href="https://github.com/MeerHusam/khutbah-transcribe" target="_blank" rel="noopener">GitHub</a>
  <div><button class="footer-feedback" onclick="openFeedback()">Tell us what to fix</button></div>
</footer>

`);

// the language buttons now live in the language line, not in the player
rep(`document.getElementById('readSwitch').insertAdjacentHTML(`, `document.getElementById('readSwitch')?.insertAdjacentHTML(`);

// the top of the page: title, date (and Hijri), masjid, khateeb; the language line; In Short; the summary on a tap
cut('    return `\n    <div class="layout">', '  async function enhanceQuranRefs', `    const hijri = (() => { const t = Date.parse((r.date || '') + ' 12:00 UTC'); if (!Number.isFinite(t)) return ''; try { return new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura-nu-arab', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(t)).replace(/\\s*هـ$/, ''); } catch { return ''; } })();
    const masjid = r.masjid ? (r.maps_url ? \`<a href="\${escAttr(r.maps_url)}" target="_blank" rel="noopener">\${escHtml(r.masjid)}</a>\` : escHtml(r.masjid)) : '';
    const khateeb = r.speaker && !/^friday khutbah$/i.test(r.speaker) ? escHtml(r.speaker) : '';
    const tongues = [['ar', 'العربية', 'ar'], ['en', 'English', ''], ...TR.map(L => [L.code, L.native, L.code])];
    return \`
    <div class="layout">
      <div class="main-col">
        <a class="back-home" href="/#khutbahs">← All khutbahs</a>
        <div class="khutbah-heading">
          <h2>\${escHtml(r.title || 'Friday Khutbah')}</h2>
          <p class="meta-row">\${r.date ? \`<span>\${escHtml(r.date)}</span>\` : ''}\${hijri ? \`<span class="hijri" lang="ar">\${hijri}</span>\` : ''}\${masjid ? \`<span>\${masjid}</span>\` : ''}\${khateeb ? \`<span>\${khateeb}</span>\` : ''}</p>
        </div>

        <p class="tongue-help">\${bi('Read and listen in')}</p>
        <p class="tongue-line" id="tongues" role="group" aria-label="Language">\${tongues.map(([c, name, lang], i) => (i ? '<span class="sep" aria-hidden="true">·</span>' : '') + \`<button type="button" data-l="\${c}"\${lang ? \` lang="\${lang}"\` : ''} aria-pressed="false" onclick="chooseLang('\${c}')"\${c === 'ar' ? ' title="The imam\\'s own words, in his voice"' : ''}>\${name}</button>\`).join('')}</p>

        <div class="lede">
          <p class="share-text\${TR.length ? ' chunk-en' : ''}">\${escHtml(r.share_summary || r.summary || '')}</p>
          \${trShare('share_summary')}
          <button class="copy-btn" onclick="copyShare()">\${bi('Copy for WhatsApp')}</button>
        </div>
        <details class="summary-more">
          <summary>\${bi('Read the summary')}</summary>
          <p class="share-text\${TR.length ? ' chunk-en' : ''}">\${escHtml(r.summary || '')}</p>
          \${trShare('summary')}
        </details>

        <h2 class="khutbah-h">\${bi('The khutbah')}</h2>
        <div class="khutbah-text">\${renderTranslation(r)}</div>

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

        <details class="checked">
          <summary>How this was checked</summary>
          <p>Every ayah is matched against the mushaf twice, by an AI model and by a matching algorithm; every hadith is matched against the collections and linked to sunnah.com.</p>
          <div class="stat-row"><span>Words written down</span><span class="stat-value">\${wordCount.toLocaleString()}</span></div>
          <div class="stat-row"><span>Ayaat matched</span><span class="stat-value">\${matched} of \${qRefs.length}</span></div>
          <div class="stat-row"><span>Hadith found</span><span class="stat-value">\${hadithRefs.length}</span></div>
        </details>
      </div>
    </div>\`;
  }

`);

// words the language files do not have yet (they move to core/langs/ when this is built)
rep(`    TR = result.languages || [];\n`, `    TR = result.languages || [];
    const MORE_UI = { ur: { 'Read and listen in': 'پڑھیں اور سنیں', 'Read the summary': 'خلاصہ پڑھیں', 'The khutbah': 'خطبہ' },
                      bn: { 'Read and listen in': 'পড়ুন ও শুনুন', 'Read the summary': 'সারাংশ পড়ুন', 'The khutbah': 'খুতবা' } };
    for (const L of TR) L.ui = { ...(MORE_UI[L.code] || {}), ...L.ui };
`);
rep(`    document.getElementById('readGroup').hidden = !TR.length;\n`, ``);

// the language line shows the language on screen; العربية is the imam alone (not kept as a reading language)
rep(`    for (const b of document.querySelectorAll('#readSwitch button')) {
      const on = b.dataset.lang === lang;
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on);
    }`, `    markTongues();`);
rep(`  // Marks a quote whose English above is a direct translation`, `  function markTongues() {
    const ar = document.body.classList.contains('ar-only');
    for (const b of document.querySelectorAll('#tongues button')) b.setAttribute('aria-pressed', String(ar ? b.dataset.l === 'ar' : b.dataset.l === pageLang));
  }
  // One tap reads and hears a language: its translation on screen and its voice (the imam where it has none);
  // العربية is the imam's words alone, in his voice.
  function chooseLang(l) {
    const ar = l === 'ar';
    document.body.classList.toggle('ar-only', ar);
    if (!ar) setLang(l); else markTongues();
    if (audio) {
      const want = ar ? 'imam' : result['tts_' + l] ? l : 'imam';
      if (want !== voice) switchTrack(want); else updateVoiceBtn();
    }
    wordMaps.clear(); litKey = null; paintWord();
  }

  // Marks a quote whose English above is a direct translation`);

rep(`    pageLang = lang;
    paintWord();`, `    pageLang = lang;
    document.body.classList.toggle('rtl', TR.some(L => L.code === lang && L.dir === 'rtl'));
    markTongues();
    paintWord();`);
s = s.replace(`    markTongues();
    if (remember)`, `    if (remember)`);

// the voice switch: the language on screen's own voice, or the imam
cut('  function updateVoiceBtn() {', '  // ── Word by word ──', `  function updateVoiceBtn() {
    const group = document.getElementById('hearGroup');
    if (!group || !audio) return;
    const own = !document.body.classList.contains('ar-only') && result['tts_' + pageLang] ? pageLang : null;
    for (const b of document.querySelectorAll('#voiceSwitch button')) {
      const v = b.dataset.voice, on = v === voice;
      b.hidden = !(v === 'imam' || v === own);
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on);
    }
    group.hidden = !own;
  }

`);
cut('  function togglePlayerSize(mini) {', '  // Hear is the audio only', `  function togglePlayerSize() {}

`);

// the player: no sheet to shrink; the progress line fills in gold; the page knows when it plays
cut('    togglePlayerSize(false);\n', '    // The time shows as', `    updateVoiceBtn();
    audio.addEventListener('play', () => document.body.classList.add('playing'));
    audio.addEventListener('pause', () => document.body.classList.remove('playing'));
    audio.addEventListener('ended', () => document.body.classList.remove('playing'));

`);
rep(`      scrubber.value = (audio.currentTime / audio.duration) * 100;\n`, `      scrubber.value = (audio.currentTime / audio.duration) * 100;
      scrubber.style.setProperty('--p', scrubber.value + '%');
`);
rep(`      if (away) backBtn.classList.toggle('up', r.bottom < 90);`, `      if (away) backBtn.classList.toggle('up', r.bottom < 90);`);
writeFileSync(here + 'reader.html', s);
console.log('design/reader/reader.html', s.length, 'bytes');

// motion turned off: the page jumps back to the passage instead of gliding
s = s.replace(`activeChunk?.scrollIntoView({ behavior: 'smooth', block: 'center' })`, `activeChunk?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' })`);
writeFileSync(here + 'reader.html', s);

// the page follows only while a voice plays: a language chosen while paused leaves the page where it is,
// and play brings the passage into view
s = s.replace(`        if (following) toActive(); else showBack();`, `        if (!audio.paused) { if (following) toActive(); else showBack(); }`);
s = s.replace(`    audio.addEventListener('play', () => document.body.classList.add('playing'));`, `    audio.addEventListener('play', () => { document.body.classList.add('playing'); if (following) toActive(); });`);
writeFileSync(here + 'reader.html', s);

// Scroll in place (Meer, 12 Oct): while a voice plays, the page follows the LINE being read, not just the passage.
// When the lit word leaves a band in the upper middle of the screen, the page glides it back to about a third of
// the way down, so a long passage scrolls line by line and the words being read never sink below the screen.
rep(`  let litKey = null, followEl = null, wordRaf = 0;`, `  let litKey = null, followEl = null, wordRaf = 0;
  let onWord = null, litRange = null;   // the line follower (initAudio) and the word lit now`);
rep(`    CSS.highlights.set('kt-word', now);`, `    CSS.highlights.set('kt-word', now);
    litRange = words[k].range;
    onWord?.(litRange);`);
rep(`    const toActive = () => { follow(); byHand = false; activeChunk?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' }); };`,
`    const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
    // the screen above the player: the line being read sits about a third of the way down it
    const view = () => innerHeight - (document.getElementById('audioPlayer').offsetHeight || 0);
    let glidedAt = 0;   // one glide at a time: while the page moves, the line is not yet where it will be
    const toLine = range => { const r = range.getBoundingClientRect(); if (!r.height) return false; glidedAt = performance.now(); scrollTo({ top: scrollY + r.top - view() * 0.34, behavior: still() ? 'auto' : 'smooth' }); return true; };
    onWord = range => {
      if (!following || audio.paused || performance.now() - glidedAt < 900) return;
      const r = range.getBoundingClientRect(), v = view();
      if (r.height && (r.top < v * 0.16 || r.bottom > v * 0.6)) toLine(range);
    };
    // a passage taller than the screen starts near the top; a short one is centred, as before
    const toActive = () => {
      follow(); byHand = false;
      if (!activeChunk) return;
      if (litRange && activeChunk.contains(litRange.startContainer.parentElement || litRange.startContainer) && toLine(litRange)) return;
      const r = activeChunk.getBoundingClientRect(), v = view();
      if (r.height > v * 0.7) scrollTo({ top: scrollY + r.top - v * 0.12, behavior: still() ? 'auto' : 'smooth' });
      else activeChunk.scrollIntoView({ behavior: still() ? 'auto' : 'smooth', block: 'center' });
    };`);
writeFileSync(here + 'reader.html', s);
