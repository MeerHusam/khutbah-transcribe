// Publishing to the site through its API (server/routes/admin.js): the files the reader needs,
// the recording, then the entry. The khutbah is live at once; nothing is committed or deployed.
// Used by publish.js (and so by autopublish.js).
import { readFileSync, existsSync } from 'fs';
import { join, basename } from 'path';

// The files of a pipeline run that the site reads (server/khutbahs.js); the rest stay on the Mac.
export const SITE_FILES = ['result.json', 'reader.txt', 'reader_ur.txt', 'tts_en.json', 'tts_en.mp3', 'tts_ur.json', 'tts_ur.mp3', 'words_imam.json'];

async function call(site, key, method, path, body, type) {
  const r = await fetch(site + path, { method, body, headers: { 'x-admin-key': key, 'content-type': type } });
  if (!r.ok) throw new Error(`${method} ${path}: ${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

// The short links already in use on the site.
export async function siteSlugs(site) {
  const r = await fetch(`${site}/api/results`);
  if (!r.ok) throw new Error(`${site}/api/results: ${r.status}`);
  return (await r.json()).items.map(i => i.slug);
}

// folderPath: the run's folder (outputs/<folder>); recording: the audio file the page plays (its
// name is the entry's `audio`, or the folder's name after the timestamp); entry: slug, title, …
// Returns the page's address.
export async function publishToSite({ site, key, folderPath, recording, entry }) {
  if (!key) throw new Error('ADMIN_TOKEN is not set (put the site\'s admin key in .env)');
  const folder = basename(folderPath);
  for (const file of SITE_FILES) {
    const path = join(folderPath, file);
    if (existsSync(path)) await call(site, key, 'PUT', `/admin/api/files/${encodeURIComponent(folder)}/${file}`, readFileSync(path), 'application/octet-stream');
  }
  if (recording) await call(site, key, 'PUT', `/admin/api/audio/${encodeURIComponent(basename(recording))}`, readFileSync(recording), 'application/octet-stream');
  const { link } = await call(site, key, 'POST', '/admin/api/khutbahs', JSON.stringify({ ...entry, folder }), 'application/json');
  return site + link;
}
