// og_image.js — The picture a shared link shows (WhatsApp, iMessage, Telegram…), in the site's look (12 Oct 2026):
// the khutbah's title, its date (with the Hijri date) and masjid, its languages in gold, beside the gold minbar.
// Most visitors arrive through a link shared on WhatsApp, so this card is the first thing they see.
// Drawn by the Mac's Chrome (headless screenshot) and saved as a JPEG of 1200 × 630.
//
//   node scripts/og_image.js --home                               public/img/og.jpg, the site's own card
//   node scripts/og_image.js outputs/<folder> --title "…" --date "9 October 2026" --masjid "…" [--langs en,ur,bn]
//   node scripts/og_image.js --all [--site https://khutbah.dev] [--upload]   every published khutbah (outputs/<folder>/og.jpg)
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { pathToFileURL } from 'url';
import { MINBAR } from '../design/home/minbar.svg.js';

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const NATIVE = { ar: ['العربية', 'ar'], en: ['English', ''], ur: ['اردو', 'ur'], bn: ['বাংলা', 'bn'] };
const LOGO = readFileSync(new URL('../public/img/logo.svg', import.meta.url), 'utf8');

function cardHtml({ title, date = '', masjid = '', langs = ['en', 'ur', 'bn'], home = false }) {
  const t = Date.parse(`${date} 12:00 UTC`);
  let hijri = '';
  if (Number.isFinite(t)) { try { hijri = new Intl.DateTimeFormat('ar-SA-u-ca-islamic-umalqura-nu-arab', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(t)).replace(/\s*هـ$/, ''); } catch {} }
  const tongues = ['ar', ...langs].map(c => `<span lang="${NATIVE[c][1]}">${NATIVE[c][0]}</span>`).join('<i>·</i>');
  return `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Kufam:wght@500;600&family=Readex+Pro:wght@300;400&family=Amiri&family=Noto+Nastaliq+Urdu&family=Noto+Serif+Bengali&display=block" rel="stylesheet">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 1200px; height: 630px; overflow: hidden; }
  body { position: relative; background: #0B1712; color: #ECE6D6; font: 300 26px/1.4 "Readex Pro", sans-serif; }
  .glow { position: absolute; inset: 0; background: radial-gradient(48% 70% at 78% 48%, rgba(248,233,188,.08), transparent 70%), radial-gradient(60% 60% at 0% 0%, rgba(40,84,63,.6), transparent 70%); }
  .lattice { position: absolute; inset: 0; opacity: .05;
    background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='64' height='64'%3E%3Cg fill='none' stroke='%23D8B86C' stroke-width='1'%3E%3Cpath d='M32 4 L60 32 L32 60 L4 32 Z'/%3E%3Cpath d='M14 14 H50 V50 H14 Z'/%3E%3C/g%3E%3C/svg%3E") 0 0 / 64px 64px; }
  .minbar-box { position: absolute; right: 36px; top: 46px; width: 470px; }
  .minbar { width: 100%; height: auto; overflow: visible; }
  .minbar .ln { fill: none; stroke: #D8B86C; stroke-width: 2.2; stroke-linecap: round; stroke-linejoin: round; }
  .minbar .thin { stroke-width: 1.4; opacity: .7; } .minbar .b { stroke-width: 1.5; opacity: .75; } .minbar .win { stroke-width: 1.7; opacity: .8; }
  .minbar .floor { opacity: .45; } .minbar .lattice { color: #D8B86C; opacity: .38; }
  .text { position: absolute; left: 72px; top: 56px; width: 640px; height: 520px; display: flex; flex-direction: column; }
  .brand { display: flex; align-items: center; gap: 14px; font: 500 30px/1 Kufam, sans-serif; color: #ECE6D6; }
  .brand svg { width: 52px; height: 52px; }
  h1 { margin-top: 46px; font: 600 64px/1.1 Kufam, sans-serif; letter-spacing: -.01em; text-wrap: balance; color: #F4EEDD; }
  .meta { margin-top: 22px; font-size: 27px; color: #A6B3AA; }
  .meta .hijri { font-family: Amiri, serif; font-size: 30px; }
  .meta b { display: block; font-weight: 400; color: #ECE6D6; }
  .tongues { margin-top: auto; display: flex; flex-wrap: wrap; align-items: baseline; gap: 0 16px; font: 400 34px/1.5 "Readex Pro", sans-serif; color: #D8B86C; }
  .tongues i { font-style: normal; color: rgba(216,184,108,.45); }
  .tongues [lang="ar"] { font-family: Amiri, serif; font-size: 1.1em; }
  .tongues [lang="ur"] { font-family: "Noto Nastaliq Urdu", serif; font-size: .9em; line-height: 1.3; }
  .tongues [lang="bn"] { font-family: "Noto Serif Bengali", serif; font-size: .92em; }
</style></head><body>
<div class="glow"></div><div class="lattice"></div>
<div class="minbar-box">${MINBAR.replace(/ role="img" aria-label="[^"]*"/, '').replaceAll('stop-color="var(--light)"', 'stop-color="#F8E9BC"')}</div>
<div class="text">
  <div class="brand">${LOGO.replace(/<\?xml[^>]*>/, '')}Khutbah.dev</div>
  <h1 id="t">${esc(title)}</h1>
  ${home ? '<p class="meta"><b>Every ayah and hadith cited.</b>Read and listen in your language.</p>'
    : `<p class="meta">${esc(date)}${hijri ? ` · <span class="hijri">${hijri}</span>` : ''}${masjid ? `<b>${esc(masjid)}</b>` : ''}</p>`}
  <p class="tongues">${tongues}</p>
</div>
<script>
  // a long title steps down until it fits in three lines
  document.fonts.ready.then(() => { const h = document.getElementById('t'); let s = 64; while (h.scrollHeight > h.clientHeight + 2 && s > 36) { s -= 2; h.style.fontSize = s + 'px'; } if (h.getBoundingClientRect().height > 3 * s * 1.1 + 4) { h.style.fontSize = (s = Math.max(36, s - 6)) + 'px'; } document.title = 'ready'; });
</script>
</body></html>`;
}

// One card, drawn by Chrome and saved as a JPEG.
export function drawCard(opts, outFile) {
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME} (set CHROME_PATH)`);
  const dir = mkdtempSync(join(tmpdir(), 'og-'));
  try {
    const html = join(dir, 'card.html'), png = join(dir, 'card.png');
    writeFileSync(html, cardHtml(opts));
    const r = spawnSync(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=1200,630',
      '--virtual-time-budget=8000', `--screenshot=${png}`, pathToFileURL(html).href], { stdio: 'pipe', timeout: 60_000 });
    if (!existsSync(png)) throw new Error('Chrome made no picture: ' + String(r.stderr || '').slice(0, 200));
    const j = spawnSync('ffmpeg', ['-v', 'error', '-y', '-i', png, '-q:v', '3', outFile], { stdio: 'pipe' });
    if (j.status !== 0) throw new Error('ffmpeg: ' + String(j.stderr).slice(0, 200));
  } finally { rmSync(dir, { recursive: true, force: true }); }
  return outFile;
}

// CLI
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const opt = (f, d = null) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
  const CODES = { English: 'en', Urdu: 'ur', Bengali: 'bn' };
  if (args.includes('--home')) {
    console.log(drawCard({ title: 'Understand the Friday khutbah, even if you don\'t speak Arabic.', home: true }, resolve('public/img/og.jpg')));
  } else if (args.includes('--all')) {
    const site = opt('--site', 'https://khutbah.dev');
    const items = (await (await fetch(`${site}/api/results`)).json()).items;
    for (const it of items) {
      const out = join('outputs', it.folder, 'og.jpg');
      if (!args.includes('--upload')) {
        drawCard({ title: it.title, date: it.date, masjid: it.masjid, langs: (it.languages || []).map(n => CODES[n]).filter(Boolean) }, out);
        console.log(`${it.slug}: ${out}`);
      } else {
        const r = await fetch(`${site}/admin/api/files/${encodeURIComponent(it.folder)}/og.jpg`,
          { method: 'PUT', body: readFileSync(out), headers: { 'x-admin-key': process.env.ADMIN_TOKEN || '', 'content-type': 'application/octet-stream' } });
        console.log(`${it.slug}: ${r.ok ? 'uploaded' : `upload failed ${r.status}`}`);
      }
    }
  } else {
    const folder = args.find(a => !a.startsWith('--') && !['--title', '--date', '--masjid', '--langs'].includes(args[args.indexOf(a) - 1]));
    if (!folder || !opt('--title')) { console.error('usage: node scripts/og_image.js outputs/<folder> --title "…" [--date …] [--masjid …] [--langs en,ur,bn] | --home | --all'); process.exit(1); }
    console.log(drawCard({ title: opt('--title'), date: opt('--date', ''), masjid: opt('--masjid', ''), langs: (opt('--langs', 'en,ur,bn')).split(',').filter(Boolean) }, join(folder, 'og.jpg')));
  }
}
