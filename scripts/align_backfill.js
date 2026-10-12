// align_backfill.js — The phrase matching (core/align_phrases.js) for khutbahs published before it (12 Oct 2026).
// Each khutbah is matched against the live site's own text (/api/results/<folder>, read only), so the matching fits
// what the site serves; it is written to outputs/<folder>/align.json and, with --upload, put on the site (the publish
// API's file upload; the site reads it when it next builds the khutbah, e.g. after a deploy).
//
//   node --env-file=.env scripts/align_backfill.js --count                 sizes and projected cost (free)
//   node --env-file=.env scripts/align_backfill.js --run --cap 1.50        match each khutbah without align.json
//   node --env-file=.env scripts/align_backfill.js --upload                send each align.json to the site
// --site https://khutbah.dev (the default); --only <folder> for one khutbah.
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { alignChunks, passagesFor } from '../core/align_phrases.js';

const args = process.argv.slice(2);
const opt = (f, d = null) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
const SITE = opt('--site', 'https://khutbah.dev');
const CAP = +opt('--cap', '1.50');
const only = opt('--only');

const items = (await (await fetch(`${SITE}/api/results`)).json()).items.filter(i => !only || i.folder === only);
let spent = 0, projected = 0;
for (const it of items) {
  const file = join('outputs', it.folder, 'align.json');
  if (args.includes('--upload')) {
    if (!existsSync(file)) { console.log(`${it.slug}: no align.json`); continue; }
    const r = await fetch(`${SITE}/admin/api/files/${encodeURIComponent(it.folder)}/align.json`,
      { method: 'PUT', body: readFileSync(file), headers: { 'x-admin-key': process.env.ADMIN_TOKEN || '', 'content-type': 'application/octet-stream' } });
    console.log(`${it.slug}: ${r.ok ? 'uploaded' : `upload failed ${r.status} ${(await r.text()).slice(0, 120)}`}`);
    continue;
  }
  const live = await (await fetch(`${SITE}/api/results/${encodeURIComponent(it.folder)}`)).json();
  const chunks = live.reader_chunks || [];
  if (args.includes('--count')) {
    const out = await alignChunks(chunks, { count: true, log: () => {} });
    projected += out.projected_usd;
    console.log(`${it.slug}: ${chunks.length} passages (${passagesFor(chunks, 'en').length} to match), projected $${out.projected_usd}`);
    continue;
  }
  if (!args.includes('--run')) continue;
  if (existsSync(file)) { console.log(`${it.slug}: kept (align.json is there)`); continue; }
  const left = CAP - spent;
  if (left < 0.05) { console.log(`${it.slug}: not run, the $${CAP} cap is nearly reached ($${spent.toFixed(4)} spent)`); continue; }
  const out = await alignChunks(chunks, { cap: Math.min(0.40, left), log: m => console.log(`  ${it.slug} ${m}`) });
  spent += out.cost_usd;
  if (Object.keys(out.langs).length) writeFileSync(file, JSON.stringify(out));
  console.log(`${it.slug}: $${out.cost_usd} (${spent.toFixed(4)} so far)${out.notes.length ? ' — ' + out.notes.join('; ') : ''}`);
}
if (args.includes('--count')) console.log(`projected $${projected.toFixed(4)} for ${items.length} khutbahs`);
if (args.includes('--run')) console.log(`spent $${spent.toFixed(4)} (cap $${CAP})`);
