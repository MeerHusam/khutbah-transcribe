// The admin pages, all behind ADMIN_TOKEN (?key=… or the x-admin-key header): feedback,
// traffic, the upload page with the job API the Mac's upload worker uses, and the publish API.
import express from 'express';
import { readFileSync, writeFileSync, existsSync, createWriteStream, readdirSync, unlinkSync, mkdirSync, renameSync } from 'fs';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { ROOT, ADMIN_TOKEN, FEEDBACK_FILE, GEO_FILE, VISITS_FILE, ENGAGE_FILE, UPLOAD_DIR } from '../config.js';
import { catalog, publish, hasReader, uploadDir, audioUploadDir } from '../khutbahs.js';
import { viewerTotals } from '../viewers.js';
import { buildTrafficPage, readJsonl } from '../admin/traffic.js';

const router = express.Router();

router.get('/admin/feedback', (req, res) => {
  if (!ADMIN_TOKEN) return res.status(503).send('Set the ADMIN_TOKEN env var to view feedback.');
  if (req.query.key !== ADMIN_TOKEN) return res.status(401).send('Unauthorized');
  let entries = [];
  try {
    entries = readFileSync(FEEDBACK_FILE, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean).reverse();
  } catch {}
  const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const cards = entries.length
    ? entries.map(e => `<div class="f"><div class="msg">${esc(e.message)}</div>
        <div class="meta">${esc(e.ts)}${e.contact ? ' · ' + esc(e.contact) : ''}${e.khutbah ? ' · ' + esc(e.khutbah) : ''}</div></div>`).join('')
    : '<p>No feedback yet.</p>';
  res.send(`<!doctype html><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Feedback (${entries.length})</title>
    <style>body{font-family:system-ui,-apple-system,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#1a1a1a}
    h1{font-size:18px;margin-bottom:16px}.f{border:1px solid #e5e7eb;border-radius:10px;padding:14px 16px;margin-bottom:12px}
    .msg{white-space:pre-wrap;line-height:1.55}.meta{font-size:12px;color:#6b7280;margin-top:8px}</style>
    <h1>Feedback (${entries.length})</h1>${cards}`);
});

// Traffic: views over time, places, khutbahs, sources, devices, time of day, engagement.
// Built by admin/traffic.js from data/visits.jsonl, geo_views.jsonl and engage.jsonl.
router.get('/admin/traffic', (req, res) => {
  if (!ADMIN_TOKEN) return res.status(503).send('Set the ADMIN_TOKEN env var to view traffic data.');
  if (req.query.key !== ADMIN_TOKEN) return res.status(401).send('Unauthorized');
  res.send(buildTrafficPage({
    visits: readJsonl(VISITS_FILE, readFileSync),
    geo: readJsonl(GEO_FILE, readFileSync),
    engage: readJsonl(ENGAGE_FILE, readFileSync),
    totals: viewerTotals(),
    khutbahs: catalog().list,
  }));
});

// ── Uploads: a khutbah recording sent from the masjid (2 Oct 2026) ──────────────
// The upload page (/admin/upload?key=…) streams the file here; it is kept on the persistent
// disk with a small job file. Meer's Mac (worker/upload_worker.js) asks for new jobs, downloads
// the recording, runs worker/autopublish.js, and reports each stage back, which the page shows
// live. The Mac only calls out to the site: nothing on it is reachable from the internet.
const MAX_UPLOAD = 400 * 1024 * 1024;
const AUDIO_EXT = /\.(m4a|mp3|wav|aac|ogg|opus|webm|mp4|caf|3gp|amr|flac)$/i;
const isAdmin = req => !!ADMIN_TOKEN && (req.query.key === ADMIN_TOKEN || req.get('x-admin-key') === ADMIN_TOKEN);
const jobFile = id => join(UPLOAD_DIR, `${id}.json`);
const readJob = id => { try { return /^[\w-]+$/.test(id) ? JSON.parse(readFileSync(jobFile(id), 'utf8')) : null; } catch { return null; } };
const saveJob = job => writeFileSync(jobFile(job.id), JSON.stringify(job, null, 1));
const allJobs = () => readdirSync(UPLOAD_DIR).filter(f => f.endsWith('.json')).map(f => readJob(f.slice(0, -5))).filter(Boolean)
  .sort((a, b) => (b.uploaded_at || '').localeCompare(a.uploaded_at || ''));
const publicJob = ({ file, ...job }) => job;

router.get('/admin/upload', (req, res) => {
  if (!ADMIN_TOKEN) return res.status(503).send('Set the ADMIN_TOKEN env var to use uploads.');
  if (!isAdmin(req)) return res.status(401).send('Unauthorized');
  res.sendFile(join(ROOT, 'server', 'admin', 'upload.html'));
});

// Stream a request body (not a form) to `path`, up to `max` bytes. On a problem the file is
// removed and the error sent; otherwise onDone(bytes, fail) runs once the file is written.
function streamToFile(req, res, path, max, onDone) {
  const out = createWriteStream(path);
  let bytes = 0, failed = false;
  const fail = (code, msg) => {
    if (failed) return; failed = true;
    out.destroy(); try { unlinkSync(path); } catch {}
    if (!res.headersSent) res.status(code).json({ error: msg });
  };
  req.on('data', c => { bytes += c.length; if (bytes > max) { fail(413, 'File too large'); req.destroy(); } });
  req.on('aborted', () => fail(400, 'Upload interrupted'));
  out.on('error', () => fail(500, 'Could not save the file'));
  out.on('finish', () => { if (!failed) onDone(bytes, fail); });
  req.pipe(out);
}

// The recording as the request body (not a form): any size up to MAX_UPLOAD, streamed to disk.
router.post('/admin/upload', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const name = decodeURIComponent(req.get('x-file-name') || 'recording.m4a').slice(0, 200);
  const ext = (name.match(AUDIO_EXT)?.[1] || 'm4a').toLowerCase();
  const id = `${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${randomBytes(3).toString('hex')}`;
  const file = `${id}.${ext}`;
  streamToFile(req, res, join(UPLOAD_DIR, file), MAX_UPLOAD, (bytes, fail) => {
    if (bytes < 100 * 1024) { fail(400, 'That file is too small to be a khutbah recording'); return; }
    const now = new Date().toISOString();
    const job = {
      id, file, name, bytes, uploaded_at: now, status: 'uploaded',
      masjid: decodeURIComponent(req.get('x-masjid') || '').trim().slice(0, 120),
      single: req.get('x-single') === '1',
      log: [{ at: now, status: 'uploaded', message: `${(bytes / 1048576).toFixed(1)} MB received` }],
    };
    saveJob(job);
    res.json(publicJob(job));
  });
});

router.get('/admin/uploads', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const jobs = allJobs().filter(j => !req.query.status || j.status === req.query.status);
  res.json(jobs.slice(0, 30).map(publicJob));
});
router.get('/admin/uploads/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const job = readJob(req.params.id);
  return job ? res.json(publicJob(job)) : res.status(404).json({ error: 'Not found' });
});
router.get('/admin/uploads/:id/file', (req, res) => {
  if (!isAdmin(req)) return res.status(401).end();
  const job = readJob(req.params.id);
  if (!job || !existsSync(join(UPLOAD_DIR, job.file))) return res.status(404).end();
  res.sendFile(join(UPLOAD_DIR, job.file));
});
// The worker's progress. Claiming is first come: only an 'uploaded' job can be claimed.
router.post('/admin/uploads/:id/status', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const job = readJob(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  const { status, message = '', link = null, slug = null, title = null } = req.body || {};
  if (typeof status !== 'string' || !/^[a-z_]{2,30}$/.test(status)) return res.status(400).json({ error: 'Bad status' });
  if (status === 'claimed' && job.status !== 'uploaded') return res.status(409).json({ error: `Already ${job.status}` });
  job.status = status;
  if (link) job.link = String(link).slice(0, 300);
  if (slug) job.slug = String(slug).slice(0, 80);
  if (title) job.title = String(title).slice(0, 120);
  job.log.push({ at: new Date().toISOString(), status, message: String(message).slice(0, 500) });
  saveJob(job);
  // The recording can go once the Mac has it: the site keeps only the job's history.
  if (status === 'downloaded') try { unlinkSync(join(UPLOAD_DIR, job.file)); } catch {}
  res.json(publicJob(job));
});

// ── Publishing: a khutbah goes live without a commit or a deploy ────────────────────
// worker/site.js uploads each file the reader needs, then the entry. Files land on the disk
// (DATA_DIR/outputs/<folder>/, DATA_DIR/audio_files/); the entry goes into the database and
// the khutbah is served at once. Publishing a folder again updates it in place.
const SAFE_NAME = /^[\w-][\w.-]{0,199}$/;   // a file or folder name: no slashes, no leading dot
const MAX_FILE = 200 * 1024 * 1024;

// A file as the request body (application/octet-stream), written under its name once complete.
function receiveFile(req, res, dir, name) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  if (!SAFE_NAME.test(name)) return res.status(400).json({ error: 'Bad file name' });
  mkdirSync(dir, { recursive: true });
  const part = join(dir, `.${name}.part`);
  streamToFile(req, res, part, MAX_FILE, bytes => {
    renameSync(part, join(dir, name));
    res.json({ ok: true, bytes });
  });
}
router.put('/admin/api/files/:folder/:name', (req, res) => {
  if (!SAFE_NAME.test(req.params.folder)) return res.status(400).json({ error: 'Bad folder name' });
  receiveFile(req, res, uploadDir(req.params.folder), req.params.name);
});
router.put('/admin/api/audio/:name', (req, res) => receiveFile(req, res, audioUploadDir, req.params.name));

const ENTRY_TEXT = ['title', 'speaker', 'masjid', 'masjid_ar', 'maps_url', 'date', 'audio', 'page', 'note'];
router.post('/admin/api/khutbahs', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const b = req.body || {};
  if (!SAFE_NAME.test(b.folder || '') || !/^[a-z0-9-]{1,80}$/.test(b.slug || '') || typeof b.title !== 'string' || !b.title) {
    return res.status(400).json({ error: 'folder, slug (a-z, 0-9, -) and title are required' });
  }
  if (!hasReader(b.folder)) return res.status(400).json({ error: `upload ${b.folder}/result.json and reader.txt first` });
  const entry = { folder: b.folder, slug: b.slug, featured: b.featured === true };
  for (const f of ENTRY_TEXT) if (typeof b[f] === 'string' && b[f]) entry[f] = b[f].slice(0, 2000);
  for (const f of ['old_slugs', 'old_folders']) if (Array.isArray(b[f])) entry[f] = b[f].filter(x => typeof x === 'string').slice(0, 50);
  // Where its audio is when not uploaded here (R2): an https URL ending in '/'.
  if (b.media_url != null) {
    if (typeof b.media_url !== 'string' || !/^https:\/\/[^\s"'<>]+\/$/.test(b.media_url)) return res.status(400).json({ error: 'media_url must be an https URL ending in /' });
    entry.media_url = b.media_url;
  }
  try {
    publish(entry);
  } catch (e) {
    return res.status(e.status || 500).json({ error: e.message });
  }
  res.json({ ok: true, link: `/${entry.slug}` });
});

export default router;
