// Where the site's files are, and its settings from the environment.
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PORT = process.env.PORT || 3000;
// Secret for the admin pages (/admin/…?key=…), set in env on deploy.
export const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';

// Viewer counts, visits, feedback and uploads, persisted so they survive restarts and
// redeploys (Render's disk is mounted at <root>/data). DATA_DIR is for tests: a fresh folder
// per run.
export const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
export const VIEWS_FILE = join(DATA_DIR, 'views.json');
export const FEEDBACK_FILE = join(DATA_DIR, 'feedback.jsonl');
export const GEO_FILE = join(DATA_DIR, 'geo_views.jsonl');
export const VISITS_FILE = join(DATA_DIR, 'visits.jsonl');
// Reader-page engagement snapshots (time on screen, audio played), posted by the page.
export const ENGAGE_FILE = join(DATA_DIR, 'engage.jsonl');
// Recordings sent from the upload page, each with a small job file.
export const UPLOAD_DIR = join(DATA_DIR, 'uploads');
mkdirSync(UPLOAD_DIR, { recursive: true });
