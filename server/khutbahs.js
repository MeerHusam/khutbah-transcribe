// The published khutbahs and what the site serves for each.
//
// The list is in the database (server/db.js), seeded on a fresh database from
// server/khutbahs.seed.json and added to by the publish API (worker/publish.js). This is a
// READ-ONLY listening site: only listed khutbahs are served; the featured entry (or the first)
// is the home view. old_slugs and old_folders keep earlier links working.
//
// A khutbah's files are in DATA_DIR/outputs/<folder>/ and DATA_DIR/audio_files/ (Render's disk,
// written by the publish API) or, for the khutbahs published before the database, in the repo
// (outputs/, audio_files/). Its recording is audio_files/<audio>, or audio_files/<basename>.<ext>
// where basename is its folder name after the timestamp. A khutbah with a media_url has its
// recording (<media_url><audio>) and voice tracks (<media_url>tts_<lang>.mp3) there instead (R2).
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { loadResult } from '../core/reader_chunks.js';
import { ROOT, DATA_DIR } from './config.js';
import { listKhutbahs, publishKhutbah, seedIfEmpty } from './db.js';
import { LANGS, langOf, forPage } from '../core/languages.js';
import { quranEnglish } from '../core/quran_en.js';

seedIfEmpty(JSON.parse(readFileSync(join(ROOT, 'server', 'khutbahs.seed.json'), 'utf8')));

// The list and its lookups, rebuilt after each publish.
let snapshot = null;
export function catalog() {
  if (!snapshot) {
    const list = listKhutbahs();
    snapshot = {
      list,
      featured: (list.find(k => k.featured) || list[0])?.folder,
      allowed: new Set(list.map(k => k.folder)),
      // Short share links: /2026-09-25 instead of /index.html?folder=<run folder>.
      slugToFolder: new Map(list.filter(k => k.slug).map(k => [k.slug, k.folder])),
      folderToSlug: new Map(list.filter(k => k.slug).map(k => [k.folder, k.slug])),
    };
  }
  return snapshot;
}
// An entry by its folder, or by a folder it used to have (an old ?folder= link still opens it).
export const entryForFolder = f => catalog().list.find(k => k.folder === f || k.old_folders?.includes(f));

// Where a khutbah's files are: on the disk if it was published through the API, else in the repo.
const contentDir = folder => [DATA_DIR, ROOT].map(r => join(r, 'outputs', folder)).find(existsSync) ?? join(ROOT, 'outputs', folder);
export const audioRoots = [join(DATA_DIR, 'audio_files'), join(ROOT, 'audio_files')];
const audioExists = name => audioRoots.some(r => existsSync(join(r, name)));

function findAudioUrl(folder) {
  const k = catalog().list.find(x => x.folder === folder);
  if (k?.media_url) return k.audio ? k.media_url + k.audio : null;
  // An entry whose folder name does not match its recording names the file itself.
  const named = k?.audio;
  if (named && audioExists(named)) return `/audio_files/${named}`;
  const exts = ['mp3', 'm4a', 'wav', 'mp4', 'ogg', 'flac'];
  // CLI run: basename after timestamp prefix matches audio_files/ filename
  const baseMatch = folder.match(/^\d{4}-\d{2}-\d{2}T[\d-]+_(.+)$/);
  if (baseMatch) {
    const basename = baseMatch[1];
    for (const ext of exts) {
      if (audioExists(`${basename}.${ext}`)) {
        return `/audio_files/${basename}.${ext}`;
      }
    }
  }
  return null;
}

// The voice tracks (tts.js): English (tts_en) and each other language's (tts_ur, tts_bn …), each with
// every block's place in it. A track is attached only while its manifest still names the reader's blocks, so a
// rebuilt reader never plays stale times. Folders without a tts_*.json are untouched.
export const TTS_LANGS = ['en', ...LANGS.map(L => L.code)];
function attachTts(k, result) {
  const { folder, media_url } = k;
  const dir = contentDir(folder);
  const chunks = result.reader_chunks || [];
  const head = c => c.arabic.split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
  for (const lang of TTS_LANGS) {
    try {
      const m = JSON.parse(readFileSync(join(dir, `tts_${lang}.json`), 'utf8'));
      if (!media_url && !existsSync(join(dir, m.audio))) continue;
      if (!m.blocks.every(b => chunks[b.i] && head(chunks[b.i]) === b.arabic_head)) continue;
      for (const b of m.blocks) chunks[b.i][lang === 'en' ? 'tts_start' : `tts_${lang}_start`] = b.start;
      const url = media_url ? media_url + m.audio : `/tts/${encodeURIComponent(folder)}/${lang}.mp3`;
      result[`tts_${lang}`] = { url, voice: m.voice, engine: m.engine };
      // When each word is spoken (align_words.py), fetched by the page only when it plays this voice.
      if (m.blocks.every(b => Array.isArray(b.words))) result[`tts_${lang}`].words_url = `/tts/${encodeURIComponent(folder)}/${lang}.words.json`;
    } catch {}
  }
  // When each word of the imam's recording is spoken (align_imam.js), for the Arabic.
  try {
    const w = JSON.parse(readFileSync(join(dir, 'words_imam.json'), 'utf8'));
    if (w.blocks.every(b => chunks[b.i] && head(chunks[b.i]) === b.arabic_head)) result.imam_words_url = `/words/${encodeURIComponent(folder)}/imam.json`;
  } catch {}
}

// One khutbah as the reader page loads it: the reader's chunks and refs, its audio, voice
// tracks and word times, and the entry's title and place.
function buildResult(k) {
  const result = loadResult(contentDir(k.folder));
  result.audio_url = findAudioUrl(k.folder);
  attachTts(k, result);
  // The languages the page can show besides English (core/languages.js), with what it needs for each.
  result.languages = LANGS.filter(L => (result.reader_chunks || []).some(c => c[L.field])).map(forPage);
  result.quran_en_name = quranEnglish(result).name; // the label under the ayah cards' English
  result.title = k.title || '';
  result.speaker = k.speaker || '';
  result.masjid = k.masjid || '';
  result.masjid_ar = k.masjid_ar || '';
  result.maps_url = k.maps_url || '';
  result.date = k.date || '';
  return result;
}

// One home-page card. Shared by the route and the startup cache warm-up: they were two
// copies, and the warm-up one lost masjid and date, so the cards never showed them.
function listItem(k, r) {
  return {
    folder: k.folder,
    slug: k.slug || '',
    id: k.id || '',
    masjid_id: k.masjid_id ?? null,
    title: k.title,
    speaker: k.speaker || '',
    masjid: k.masjid || '',
    maps_url: k.maps_url || '',
    date: k.date || '',
    featured: !!k.featured,
    summary: (r.share_summary || r.summary || '').slice(0, 200),
    words: r.metadata?.transcript_word_count || 0,
    quran: r.metadata?.quran_references_matched || 0,
    hadith: r.metadata?.hadith_references_found || 0,
    mode: r.metadata?.transcription_mode || '',
    // What the page offers: the languages it reads in and the voices it can play (tts.js).
    languages: ['Arabic', 'English', ...LANGS.filter(L => r[L.field]).map(L => L.name)],
    voices: TTS_LANGS.filter(l => existsSync(join(contentDir(k.folder), `tts_${l}.json`))).map(l => (l === 'en' ? 'English' : langOf(l).name)),
  };
}

// Parsed results only change when a khutbah is published (publish() clears them).
const resultCache = new Map();
let listCache = null;
const shareSummaries = new Map();
const wordsCache = new Map();

// A published folder's result (throws if its files cannot be read).
export function getResult(folder) {
  if (!resultCache.has(folder)) resultCache.set(folder, buildResult(catalog().list.find(k => k.folder === folder)));
  return resultCache.get(folder);
}

// The home page's list of published khutbahs (with friendly titles + summary stats).
export function getList() {
  if (listCache) return listCache;
  const { list, featured } = catalog();
  const items = list.map(k => {
    try {
      return listItem(k, JSON.parse(readFileSync(join(contentDir(k.folder), 'result.json'), 'utf8')));
    } catch { return null; }
  }).filter(Boolean);
  listCache = { featured, items };
  return listCache;
}

// Pre-warm the cache at startup so the very first visitor never waits on file I/O.
export function warmCache() {
  const { list, featured } = catalog();
  for (const k of list) {
    try {
      resultCache.set(k.folder, buildResult(k));
    } catch (e) {
      console.warn(`Cache warm failed for ${k.folder}:`, e.message);
    }
  }
  listCache = {
    featured,
    items: list.map(k => {
      const r = resultCache.get(k.folder);
      return r ? listItem(k, r) : null;
    }).filter(Boolean),
  };
  console.log(`Cached ${resultCache.size}/${list.length} khutbahs.`);
}

// A khutbah's "In Short" for link previews, read once.
export function shareSummary(folder) {
  if (!shareSummaries.has(folder)) {
    let text = '';
    try {
      const r = JSON.parse(readFileSync(join(contentDir(folder), 'result.json'), 'utf8'));
      text = r.share_summary || r.summary || '';
    } catch {}
    shareSummaries.set(folder, text);
  }
  return shareSummaries.get(folder);
}

// A voice track's word times, block by block, as the JSON the page fetches:
// { blocks: { <block>: [[word, start, end], ...] }, arabic: {...} }. Null if the file is missing.
export function getWords(folder, file) {
  const key = `${folder}/${file}`;
  if (!wordsCache.has(key)) {
    try {
      const m = JSON.parse(readFileSync(join(contentDir(folder), file), 'utf8'));
      wordsCache.set(key, JSON.stringify({
        blocks: Object.fromEntries(m.blocks.filter(b => b.words).map(b => [b.i, b.words])),
        // A voice track with the imam's recitation in it (recite.js): his words, for the Arabic.
        arabic: Object.fromEntries(m.blocks.filter(b => b.arabic_words).map(b => [b.i, b.arabic_words])),
      }));
    } catch { return null; }
  }
  return wordsCache.get(key);
}

// A voice track's audio file.
export const ttsPath = (folder, lang) => join(contentDir(folder), `tts_${lang}.mp3`);

// Whether a folder has what the reader is built from (on the disk or in the repo).
export const hasReader = folder => ['result.json', 'reader.txt'].every(f => existsSync(join(contentDir(folder), f)));

// Where the publish API writes a khutbah's files.
export const uploadDir = folder => join(DATA_DIR, 'outputs', folder);
export const audioUploadDir = join(DATA_DIR, 'audio_files');

// Publish (or update) a khutbah whose files are already uploaded; it is live at once.
export function publish(entry) {
  publishKhutbah(entry);
  snapshot = null;
  listCache = null;
  resultCache.delete(entry.folder);
  shareSummaries.delete(entry.folder);
  for (const key of wordsCache.keys()) if (key.startsWith(`${entry.folder}/`)) wordsCache.delete(key);
}
