// The published khutbahs and what the site serves for each.
//
// server/khutbahs.json is the curated public list (worker/publish.js adds to it). This is a
// READ-ONLY listening site, so instead of exposing every folder in outputs/ (many dev/test runs)
// it publishes a hand-picked allowlist with friendly titles; the featured entry (or the first)
// is the home view. An entry's audio is audio_files/<audio>, or audio_files/<basename>.<ext>
// where basename is its folder name after the timestamp. old_slugs and old_folders keep earlier
// links working.
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { loadResult } from '../core/reader_chunks.js';
import { ROOT } from './config.js';

export const PUBLIC_KHUTBAHS = JSON.parse(readFileSync(join(ROOT, 'server', 'khutbahs.json'), 'utf8'));
export const FEATURED_FOLDER = (PUBLIC_KHUTBAHS.find(k => k.featured) || PUBLIC_KHUTBAHS[0]).folder;
export const ALLOWED_FOLDERS = new Set(PUBLIC_KHUTBAHS.map(k => k.folder));
// An entry by its folder, or by a folder it used to have (an old ?folder= link still opens it).
export const entryForFolder = f => PUBLIC_KHUTBAHS.find(k => k.folder === f || k.old_folders?.includes(f));
// Short share links: /2026-09-25 instead of /index.html?folder=<run folder>.
export const SLUG_TO_FOLDER = new Map(PUBLIC_KHUTBAHS.filter(k => k.slug).map(k => [k.slug, k.folder]));
export const FOLDER_TO_SLUG = new Map(PUBLIC_KHUTBAHS.filter(k => k.slug).map(k => [k.folder, k.slug]));

function findAudioUrl(folder) {
  // An entry whose folder name does not match its recording names the file itself.
  const named = PUBLIC_KHUTBAHS.find(k => k.folder === folder)?.audio;
  if (named && existsSync(join(ROOT, 'audio_files', named))) return `/audio_files/${named}`;
  const exts = ['mp3', 'm4a', 'wav', 'mp4', 'ogg', 'flac'];
  // CLI run: basename after timestamp prefix matches audio_files/ filename
  const baseMatch = folder.match(/^\d{4}-\d{2}-\d{2}T[\d-]+_(.+)$/);
  if (baseMatch) {
    const basename = baseMatch[1];
    for (const ext of exts) {
      if (existsSync(join(ROOT, 'audio_files', `${basename}.${ext}`))) {
        return `/audio_files/${basename}.${ext}`;
      }
    }
  }
  return null;
}

// The voice tracks (tts.js): English (tts_en) and Urdu (tts_ur), each with every block's place
// in it. A track is attached only while its manifest still names the reader's blocks, so a
// rebuilt reader never plays stale times. Folders without a tts_*.json are untouched.
export const TTS_LANGS = ['en', 'ur'];
function attachTts(folder, result) {
  const dir = join(ROOT, 'outputs', folder);
  const chunks = result.reader_chunks || [];
  const head = c => c.arabic.split(/\s+/).filter(Boolean).slice(0, 6).join(' ');
  for (const lang of TTS_LANGS) {
    try {
      const m = JSON.parse(readFileSync(join(dir, `tts_${lang}.json`), 'utf8'));
      if (!existsSync(join(dir, m.audio))) continue;
      if (!m.blocks.every(b => chunks[b.i] && head(chunks[b.i]) === b.arabic_head)) continue;
      for (const b of m.blocks) chunks[b.i][lang === 'en' ? 'tts_start' : `tts_${lang}_start`] = b.start;
      result[`tts_${lang}`] = { url: `/tts/${encodeURIComponent(folder)}/${lang}.mp3`, voice: m.voice, engine: m.engine };
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
  const result = loadResult(`outputs/${k.folder}`);
  result.audio_url = findAudioUrl(k.folder);
  attachTts(k.folder, result);
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
  };
}

// Parsed results are immutable at runtime (files never change), so cache indefinitely.
const resultCache = new Map();
let listCache = null;

// A published folder's result (throws if its files cannot be read).
export function getResult(folder) {
  if (!resultCache.has(folder)) resultCache.set(folder, buildResult(PUBLIC_KHUTBAHS.find(k => k.folder === folder)));
  return resultCache.get(folder);
}

// The home page's list of published khutbahs (with friendly titles + summary stats).
export function getList() {
  if (listCache) return listCache;
  const items = PUBLIC_KHUTBAHS.map(k => {
    try {
      return listItem(k, JSON.parse(readFileSync(join(ROOT, 'outputs', k.folder, 'result.json'), 'utf8')));
    } catch { return null; }
  }).filter(Boolean);
  listCache = { featured: FEATURED_FOLDER, items };
  return listCache;
}

// Pre-warm the cache at startup so the very first visitor never waits on file I/O.
export function warmCache() {
  for (const k of PUBLIC_KHUTBAHS) {
    try {
      resultCache.set(k.folder, buildResult(k));
    } catch (e) {
      console.warn(`Cache warm failed for ${k.folder}:`, e.message);
    }
  }
  listCache = {
    featured: FEATURED_FOLDER,
    items: PUBLIC_KHUTBAHS.map(k => {
      const r = resultCache.get(k.folder);
      return r ? listItem(k, r) : null;
    }).filter(Boolean),
  };
  console.log(`Cached ${resultCache.size}/${PUBLIC_KHUTBAHS.length} khutbahs.`);
}

// A khutbah's "In Short" for link previews, read once.
const shareSummaries = new Map();
export function shareSummary(folder) {
  if (!shareSummaries.has(folder)) {
    let text = '';
    try {
      const r = JSON.parse(readFileSync(join(ROOT, 'outputs', folder, 'result.json'), 'utf8'));
      text = r.share_summary || r.summary || '';
    } catch {}
    shareSummaries.set(folder, text);
  }
  return shareSummaries.get(folder);
}
