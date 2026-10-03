// The site's database: SQLite (Node's built-in node:sqlite) in DATA_DIR, on Render's disk.
// Holds the published khutbahs; their files live beside it (DATA_DIR/outputs, DATA_DIR/audio_files)
// or, for the khutbahs published before the database, in the repo. The rest of the server reads
// and writes through these functions only, so a move to Postgres would change this file alone.
import { DatabaseSync } from 'node:sqlite';
import { join } from 'path';
import { DATA_DIR } from './config.js';

const db = new DatabaseSync(join(DATA_DIR, 'site.db'));
db.exec('PRAGMA journal_mode = WAL');

// Migrations, in order; PRAGMA user_version records how many have run.
const MIGRATIONS = [
  `CREATE TABLE khutbahs (
     folder       TEXT PRIMARY KEY,      -- the pipeline run: outputs/<folder>/
     slug         TEXT NOT NULL UNIQUE,  -- the short link: /<slug>
     position     INTEGER NOT NULL,      -- display order, lowest first (a new khutbah goes on top)
     featured     INTEGER NOT NULL DEFAULT 0,
     title        TEXT NOT NULL,
     speaker      TEXT,
     masjid       TEXT,
     masjid_ar    TEXT,
     maps_url     TEXT,
     date         TEXT,
     audio        TEXT,                  -- the recording in audio_files/, when not named after the folder
     page         TEXT,                  -- the reader page, when not index.html
     old_slugs    TEXT,                  -- JSON array: earlier short links that redirect here
     old_folders  TEXT,                  -- JSON array: earlier folders whose ?folder= links open this
     note         TEXT,
     published_at TEXT NOT NULL
   )`,
  // Where a khutbah's audio is when it is not on this server (R2), ending in '/'.
  'ALTER TABLE khutbahs ADD COLUMN media_url TEXT',
];
const version = db.prepare('PRAGMA user_version').get().user_version;
for (let v = version; v < MIGRATIONS.length; v++) {
  db.exec('BEGIN');
  db.exec(MIGRATIONS[v]);
  db.exec(`PRAGMA user_version = ${v + 1}`);
  db.exec('COMMIT');
}

const FIELDS = ['folder', 'slug', 'title', 'speaker', 'masjid', 'masjid_ar', 'maps_url', 'date', 'audio', 'page', 'old_slugs', 'old_folders', 'note', 'media_url'];
const LISTS = new Set(['old_slugs', 'old_folders']);
// Kept when publishing again without them (publish.js never sends the first three; media_url
// stays so a republish from a machine without R2 settings cannot orphan the audio).
const KEPT = new Set(['old_slugs', 'old_folders', 'note', 'media_url']);

// A row as the entry the server uses: only the fields that are set, lists parsed, featured as true.
function toEntry(row) {
  const k = {};
  for (const f of FIELDS) if (row[f] != null) k[f] = LISTS.has(f) ? JSON.parse(row[f]) : row[f];
  if (row.featured) k.featured = true;
  return k;
}
const toColumns = k => Object.fromEntries(FIELDS.map(f => [f, k[f] == null ? null : LISTS.has(f) ? JSON.stringify(k[f]) : String(k[f])]));

// Newest khutbah first, by its date ("2 October 2026"); one without a date goes by the date its
// folder name starts with (the run's). Khutbahs of the same day keep the order they were added.
// Until 3 Oct 2026 the list was only the order of adding, so 22 May stood above 11 Sep.
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
export function dayOf(k) {
  const [d, m, y] = (k.date ?? '').trim().toLowerCase().split(/\s+/);
  const month = MONTHS.indexOf(m);
  if (month >= 0 && +d && +y) return Date.UTC(+y, month, +d);
  return Date.parse((k.folder ?? '').slice(0, 10)) || 0;
}

export function listKhutbahs() {
  return db.prepare('SELECT * FROM khutbahs ORDER BY position').all().map(toEntry).sort((a, b) => dayOf(b) - dayOf(a));
}

const upsert = db.prepare(`
  INSERT INTO khutbahs (${FIELDS.join(', ')}, position, featured, published_at)
  VALUES (${FIELDS.map(f => '$' + f).join(', ')}, $position, $featured, $published_at)
  ON CONFLICT (folder) DO UPDATE SET ${FIELDS.filter(f => f !== 'folder')
    .map(f => (KEPT.has(f) ? `${f} = COALESCE(excluded.${f}, ${f})` : `${f} = excluded.${f}`)).join(', ')},
    featured = excluded.featured, published_at = excluded.published_at`);

function transaction(fn) {
  db.exec('BEGIN');
  try { const out = fn(); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Publish a khutbah, or update one already published (it keeps its place in the list, and a
// changed slug keeps the old one as a redirect). A new one goes on top. A featured one takes the
// home page from the one before it. Throws when the slug belongs to another folder.
export function publishKhutbah(entry) {
  return transaction(() => {
    const taken = db.prepare('SELECT folder FROM khutbahs WHERE folder != ? AND (slug = ? OR old_slugs LIKE ?)')
      .get(entry.folder, entry.slug, `%"${entry.slug}"%`);
    if (taken) throw Object.assign(new Error(`slug "${entry.slug}" is taken`), { status: 409 });
    const prev = db.prepare('SELECT slug, old_slugs FROM khutbahs WHERE folder = ?').get(entry.folder);
    if (prev && prev.slug !== entry.slug) {
      entry = { ...entry, old_slugs: [...new Set([...(entry.old_slugs ?? JSON.parse(prev.old_slugs ?? '[]')), prev.slug])].filter(s => s !== entry.slug) };
    }
    const top = db.prepare('SELECT MIN(position) AS p FROM khutbahs').get().p;
    if (entry.featured) db.exec('UPDATE khutbahs SET featured = 0');
    upsert.run({ ...toColumns(entry), position: top == null ? 0 : top - 1, featured: entry.featured ? 1 : 0, published_at: new Date().toISOString() });
  });
}

// On a fresh database, the khutbahs published before it existed (server/khutbahs.seed.json).
export function seedIfEmpty(entries) {
  if (db.prepare('SELECT COUNT(*) AS n FROM khutbahs').get().n) return;
  transaction(() => entries.forEach((k, i) => upsert.run({
    ...toColumns(k), position: i, featured: k.featured ? 1 : 0, published_at: new Date().toISOString(),
  })));
}
