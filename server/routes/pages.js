// The pages: home (/), each khutbah at its short link (/2026-09-25), and the old reader address.
import express from 'express';
import { readFileSync } from 'fs';
import { join } from 'path';
import { ROOT } from '../config.js';
import { catalog, entryForFolder, shareSummary } from '../khutbahs.js';

const router = express.Router();

// Link previews (WhatsApp, iMessage, Telegram…): their crawlers read the HTML and run no
// script, so a shared link showed only the site's name. Each page is sent with its title,
// "In Short" summary and share image in <title> and Open Graph tags.
// The site's own address, for search engines: canonical links and the sitemap.
const SITE = 'https://khutbah.dev';
const escHtml = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function withShareMeta(file, req, { title, description, path }) {
  const base = `${req.headers['x-forwarded-proto']?.split(',')[0] || req.protocol}://${req.get('host')}`;
  const tags = [
    `<title>${escHtml(title)}</title>`,
    `<meta name="description" content="${escHtml(description)}">`,
    `<meta property="og:site_name" content="Khutbah.dev">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escHtml(title)}">`,
    `<meta property="og:description" content="${escHtml(description)}">`,
    `<meta property="og:url" content="${escHtml(base + path)}">`,
    `<link rel="canonical" href="${SITE}${escHtml(path)}">`,
    `<meta property="og:image" content="${escHtml(base)}/img/og.png">`,
    `<meta property="og:image:width" content="1200">`,
    `<meta property="og:image:height" content="630">`,
    `<meta name="twitter:card" content="summary_large_image">`,
  ].join('\n  ');
  return readFileSync(join(ROOT, 'public', file), 'utf8')
    .replace(/<meta name="description"[^>]*>\s*/, '')
    .replace(/<title>[^<]*<\/title>/, tags);
}
const HOME_DESCRIPTION = 'Arabic Friday Khutbahs with English and Urdu translations, every Quran verse and Hadith cited and linked.';

router.get('/', (req, res) => res.type('html').send(withShareMeta('home.html', req, {
  title: 'Khutbah.dev · Friday Khutbahs in Arabic, English & Urdu', description: HOME_DESCRIPTION, path: '/',
})));
// For search engines: the home page and every khutbah's short link (robots.txt points here).
router.get('/sitemap.xml', (req, res) => res.type('application/xml').send(
  '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
  + ['/', ...catalog().list.filter(k => k.slug).map(k => `/${k.slug}`)].map(p => `  <url><loc>${SITE}${p}</loc></url>\n`).join('')
  + '</urlset>\n'));
// Feedback, suggestions and comments: a form, and the messages people chose to show (/api/comments).
router.get(['/feedback', '/suggestion', '/suggestions'], (req, res) => res.type('html').send(withShareMeta('feedback.html', req, {
  title: 'Feedback & suggestions · Khutbah.dev', path: '/feedback',
  description: 'Tell us how Khutbah.dev can be better: feedback, suggestions, corrections or comments. You can stay anonymous.',
})));
// Short share links: /2026-09-25 instead of /index.html?folder=<run folder>.
router.get('/:slug', (req, res, next) => {
  const { list } = catalog();
  const k = list.find(x => x.slug && x.slug === req.params.slug);
  const moved = !k && list.find(x => x.old_slugs?.includes(req.params.slug));
  if (moved) return res.redirect(301, `/${moved.slug}`);
  if (!k) return next();
  // An entry can name its own page (the Urdu edition's reader-ur.html); the rest use index.html.
  const where = [k.date, k.masjid].filter(Boolean).join(' · ');
  res.type('html').send(withShareMeta(k.page || 'index.html', req, {
    title: `${k.title} · Khutbah.dev`,
    description: [where, shareSummary(k.folder)].filter(Boolean).join(' · ') || HOME_DESCRIPTION,
    path: `/${k.slug}`,
  }));
});
// The old reader address: an entry that has moved folder or has its own page opens at its slug.
router.get('/index.html', (req, res, next) => {
  const k = req.query.folder && entryForFolder(req.query.folder);
  if (k && k.slug && (k.folder !== req.query.folder || k.page)) return res.redirect(301, `/${k.slug}`);
  next();
});

export default router;
