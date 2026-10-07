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
     page         TEXT,                  -- unused since 4 Oct 2026: every khutbah opens public/reader.html
     old_slugs    TEXT,                  -- JSON array: earlier short links that redirect here
     old_folders  TEXT,                  -- JSON array: earlier folders whose ?folder= links open this
     note         TEXT,
     published_at TEXT NOT NULL
   )`,
  // Where a khutbah's audio is when it is not on this server (R2), ending in '/'.
  'ALTER TABLE khutbahs ADD COLUMN media_url TEXT',
  // Masjid and khutbah ids (5 Oct 2026). A masjid's id is its number in the order it was first
  // published (1 Makkah, 2 Madinah, 3 ours, as Meer numbered them); a khutbah's is its masjid's
  // id and its date as YYMMDD, year first as ISO 8601 (it sorts by date and reads the same in every
  // country): Makkah on 2 Oct 2026 is 1261002. Links stay the slugs.
  `CREATE TABLE masjids (
     id       INTEGER PRIMARY KEY,
     name     TEXT NOT NULL UNIQUE,
     name_ar  TEXT,
     maps_url TEXT
   );
   INSERT INTO masjids (id, name, name_ar, maps_url) VALUES
     (1, 'Masjid al-Haram, Makkah', 'المسجد الحرام', NULL),
     (2, 'Masjid an-Nabawi, Madinah', 'المسجد النبوي', NULL),
     (3, 'Askan AlMaather Mosque', 'جامع إسكان المعذر', 'https://maps.app.goo.gl/J8ghwSqr3yUyrTQA6');
   ALTER TABLE khutbahs ADD COLUMN masjid_id INTEGER REFERENCES masjids (id);
   ALTER TABLE khutbahs ADD COLUMN id TEXT;
   CREATE UNIQUE INDEX khutbahs_id ON khutbahs (id);`,
];
const version = db.prepare('PRAGMA user_version').get().user_version;
for (let v = version; v < MIGRATIONS.length; v++) {
  db.exec('BEGIN');
  db.exec(MIGRATIONS[v]);
  db.exec(`PRAGMA user_version = ${v + 1}`);
  db.exec('COMMIT');
}

const FIELDS = ['folder', 'slug', 'title', 'speaker', 'masjid', 'masjid_ar', 'maps_url', 'date', 'audio', 'page', 'old_slugs', 'old_folders', 'note', 'media_url', 'masjid_id', 'id'];
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

// The masjid's id, found by its name or Arabic name; a masjid not seen before gets the next number.
function masjidId(k) {
  if (!k.masjid) return null;
  const row = db.prepare('SELECT id, maps_url FROM masjids WHERE lower(name) = lower(?) OR name_ar = ?').get(k.masjid, k.masjid_ar ?? null);
  if (!row) return Number(db.prepare('INSERT INTO masjids (name, name_ar, maps_url) VALUES (?, ?, ?)').run(k.masjid, k.masjid_ar ?? null, k.maps_url ?? null).lastInsertRowid);
  if (!row.maps_url && k.maps_url) db.prepare('UPDATE masjids SET maps_url = ? WHERE id = ?').run(k.maps_url, row.id);
  return row.id;
}

// A khutbah's masjid id and id (see MIGRATIONS). An id once given stays; a second khutbah of the
// same masjid and day gets "-2". No masjid or no date: no id.
function withIds(k) {
  const masjid_id = masjidId(k);
  const kept = db.prepare('SELECT id FROM khutbahs WHERE folder = ?').get(k.folder)?.id;
  const day = dayOf(k);
  if (kept || masjid_id == null || !day) return { ...k, masjid_id, id: kept ?? null };
  const d = new Date(day), two = n => String(n).padStart(2, '0');
  const base = `${masjid_id}${two(d.getUTCFullYear() % 100)}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}`;
  let id = base;
  for (let n = 2; db.prepare('SELECT 1 FROM khutbahs WHERE id = ? AND folder != ?').get(id, k.folder); n++) id = `${base}-${n}`;
  return { ...k, masjid_id, id };
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
    upsert.run({ ...toColumns(withIds(entry)), position: top == null ? 0 : top - 1, featured: entry.featured ? 1 : 0, published_at: new Date().toISOString() });
  });
}

// On a fresh database, the khutbahs published before it existed (server/khutbahs.seed.json).
export function seedIfEmpty(entries) {
  if (db.prepare('SELECT COUNT(*) AS n FROM khutbahs').get().n) return;
  transaction(() => entries.forEach((k, i) => upsert.run({
    ...toColumns(withIds(k)), position: i, featured: k.featured ? 1 : 0, published_at: new Date().toISOString(),
  })));
}

// Khutbahs published before the ids (the live database on 5 Oct 2026) get theirs once, oldest first.
transaction(() => {
  for (const row of db.prepare('SELECT * FROM khutbahs WHERE id IS NULL AND masjid IS NOT NULL ORDER BY position DESC').all()) {
    const k = withIds(toEntry(row));
    db.prepare('UPDATE khutbahs SET masjid_id = ?, id = ? WHERE folder = ?').run(k.masjid_id, k.id, k.folder);
  }
});
