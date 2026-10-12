// fix_summaries.js — "In short" of the khutbahs published before 12 Oct 2026 that open with "This Friday khutbah…"
// (Meer: the page already says it is a khutbah), rewritten to begin with the takeaway itself, in English and in each
// translation, keeping the meaning. Only khutbahs whose local result.json is the one the site serves are touched.
// Gemini 3.8 Flash, one request per khutbah, capped (--cap, default $0.10).
//   node --env-file=.env scripts/fix_summaries.js            which would change (free: no request)
//   node --env-file=.env scripts/fix_summaries.js --run       rewrite, into outputs/<folder>/result.json
//   node --env-file=.env scripts/fix_summaries.js --upload    send each changed result.json to the site
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { GoogleGenAI } from '@google/genai';
import { loadResult } from '../core/reader_chunks.js';
import { LANGS } from '../core/languages.js';

const args = process.argv.slice(2);
const opt = (f, d = null) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
const SITE = opt('--site', 'https://khutbah.dev'), CAP = +opt('--cap', '0.10');
export const OPENS = /^(this|today'?s|the)\s+(friday\s+|week'?s\s+|ramadan\s+|eid al-adha\s+|jumu'?ah\s+|jummah\s+)*khutbah\b/i;
// what the site builds from a folder, to be sure the local copy is the one it serves
const fingerprint = r => JSON.stringify([r.share_summary, r.summary, (r.reader_chunks || []).map(c => [c.arabic, c.english, ...LANGS.map(L => c[L.field] || '')]),
  (r.quran_references || []).length, (r.hadith_references || []).length, ...LANGS.map(L => r[L.field]?.share_summary || '')]);
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || 'not-set' });
const items = (await (await fetch(`${SITE}/api/results`)).json()).items;
let spent = 0;
for (const it of items) {
  const dir = join('outputs', it.folder), file = join(dir, 'result.json');
  if (args.includes('--upload')) {
    if (!existsSync(join(dir, '.summary_fixed'))) continue;
    const r = await fetch(`${SITE}/admin/api/files/${encodeURIComponent(it.folder)}/result.json`,
      { method: 'PUT', body: readFileSync(file), headers: { 'x-admin-key': process.env.ADMIN_TOKEN || '', 'content-type': 'application/octet-stream' } });
    console.log(`${it.slug}: ${r.ok ? 'uploaded' : 'upload failed ' + r.status}`);
    continue;
  }
  const live = await (await fetch(`${SITE}/api/results/${encodeURIComponent(it.folder)}`)).json();
  if (!OPENS.test(live.share_summary || '')) continue;
  let local; try { local = loadResult(dir); } catch { console.log(`${it.slug}: no local copy, left`); continue; }
  if (fingerprint(local) !== fingerprint(live)) { console.log(`${it.slug}: the local copy differs from the site's, left`); continue; }
  const langs = LANGS.filter(L => live[L.field]?.share_summary);
  console.log(`${it.slug}: "${live.share_summary.slice(0, 70)}…" (${['en', ...langs.map(L => L.code)].join(', ')})`);
  if (!args.includes('--run')) continue;
  if (spent > CAP - 0.01) { console.log('  not run: the cap'); continue; }
  const ask = `Rewrite this khutbah's one-line summary in each language so that it begins with the takeaway itself, not with "This khutbah", "This Friday khutbah", "Today's khutbah" or the like (the page already says it is a khutbah). Keep the meaning, the length and the tone; change only what the new opening needs. Answer as JSON with the same keys.
${JSON.stringify({ en: live.share_summary, ...Object.fromEntries(langs.map(L => [L.code, live[L.field].share_summary])) }, null, 1)}`;
  const res = await ai.models.generateContent({ model: 'gemini-3.8-flash', contents: ask,
    config: { responseMimeType: 'application/json', thinkingConfig: { thinkingLevel: 'LOW' }, maxOutputTokens: 4000 } });
  const u = res.usageMetadata ?? {};
  spent += ((u.promptTokenCount ?? 0) * 0.75 + ((u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)) * 3.75) / 1e6;
  let out; try { out = JSON.parse(res.text); } catch { console.log('  not JSON, left'); continue; }
  if (!out.en || OPENS.test(out.en) || langs.some(L => !out[L.code])) { console.log('  answer not usable, left'); continue; }
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  raw.share_summary_before_12oct = raw.share_summary;
  raw.share_summary = out.en;
  for (const L of langs) raw[L.field].share_summary = out[L.code];
  writeFileSync(file, JSON.stringify(raw, null, 2));
  writeFileSync(join(dir, '.summary_fixed'), new Date().toISOString());
  console.log(`  → ${out.en}`);
}
if (args.includes('--run')) console.log(`spent $${spent.toFixed(4)} (cap $${CAP})`);
