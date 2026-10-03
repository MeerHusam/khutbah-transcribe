// Publishing to the site through its API (server/routes/admin.js): the files the reader needs,
// the recording, then the entry. The khutbah is live at once; nothing is deployed.
// Used by publish.js (and so by autopublish.js).
//
// Audio goes to Cloudflare R2 when the R2_* settings are in .env (the recording and the voice
// tracks under <folder>/ in the bucket, served from R2_PUBLIC_URL); otherwise it goes to the site
// with the rest. The R2 keys stay on this machine: the site only stores the public address.
import { readFileSync, existsSync } from 'fs';
import { join, basename, extname } from 'path';
import { createHash, createHmac } from 'crypto';

// The files of a pipeline run that the site reads (server/khutbahs.js); the rest stay on the Mac.
export const SITE_FILES = ['result.json', 'reader.txt', 'reader_ur.txt', 'tts_en.json', 'tts_en.mp3', 'tts_ur.json', 'tts_ur.mp3', 'words_imam.json'];
const AUDIO_TYPES = { '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.flac': 'audio/flac' };

const R2_SETTINGS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_URL'];
export const r2Configured = () => R2_SETTINGS.every(k => process.env[k]);

// PUT or DELETE an object in the R2 bucket, signed with AWS Signature V4 (R2 speaks the S3 API).
const sha256 = b => createHash('sha256').update(b).digest('hex');
const hmac = (key, s) => createHmac('sha256', key).update(s).digest();
export async function r2(method, key, body = '', type = null) {
  const { R2_ACCOUNT_ID: account, R2_ACCESS_KEY_ID: keyId, R2_SECRET_ACCESS_KEY: secret, R2_BUCKET: bucket } = process.env;
  const host = `${account}.r2.cloudflarestorage.com`;
  const path = `/${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`;
  const amzDate = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
  const scope = `${amzDate.slice(0, 8)}/auto/s3/aws4_request`;
  const headers = { host, 'x-amz-content-sha256': sha256(body), 'x-amz-date': amzDate, ...(type ? { 'content-type': type } : {}) };
  const names = Object.keys(headers).sort();
  const canonical = [method, path, '', ...names.map(h => `${h}:${headers[h]}`), '', names.join(';'), headers['x-amz-content-sha256']].join('\n');
  let signingKey = hmac(`AWS4${secret}`, amzDate.slice(0, 8));
  for (const part of ['auto', 's3', 'aws4_request']) signingKey = hmac(signingKey, part);
  const signature = createHmac('sha256', signingKey).update(['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n')).digest('hex');
  const { host: _, ...sent } = headers; // fetch sets Host itself
  const r = await fetch(`https://${host}${path}`, {
    method, body: method === 'PUT' ? body : undefined,
    headers: { ...sent, authorization: `AWS4-HMAC-SHA256 Credential=${keyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` },
  });
  if (!r.ok) throw new Error(`R2 ${method} ${key}: ${r.status} ${(await r.text()).slice(0, 200)}`);
}

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
// Returns the page's address and the entry as the site stored it.
export async function publishToSite({ site, key, folderPath, recording, entry }) {
  if (!key) throw new Error('ADMIN_TOKEN is not set (put the site\'s admin key in .env)');
  const folder = basename(folderPath);
  const toR2 = r2Configured();
  const isAudio = file => extname(file) in AUDIO_TYPES;
  for (const file of SITE_FILES) {
    const path = join(folderPath, file);
    if (!existsSync(path)) continue;
    if (toR2 && isAudio(file)) await r2('PUT', `${folder}/${file}`, readFileSync(path), AUDIO_TYPES[extname(file)]);
    else await call(site, key, 'PUT', `/admin/api/files/${encodeURIComponent(folder)}/${file}`, readFileSync(path), 'application/octet-stream');
  }
  if (recording) {
    const name = basename(recording);
    if (toR2) await r2('PUT', `${folder}/${name}`, readFileSync(recording), AUDIO_TYPES[extname(name)] ?? 'application/octet-stream');
    else await call(site, key, 'PUT', `/admin/api/audio/${encodeURIComponent(name)}`, readFileSync(recording), 'application/octet-stream');
    if (toR2) entry = { ...entry, audio: name };
  }
  if (toR2) entry = { ...entry, media_url: `${process.env.R2_PUBLIC_URL.replace(/\/+$/, '')}/${folder}/` };
  entry = { folder, ...entry };
  const { link } = await call(site, key, 'POST', '/admin/api/khutbahs', JSON.stringify(entry), 'application/json');
  return { url: site + link, entry };
}
