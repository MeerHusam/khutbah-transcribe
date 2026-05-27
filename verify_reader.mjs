// Verification harness for reader.txt quality. Detects:
//  1. Duplicate adjacent Quran cards (same surah:ayah back-to-back)
//  2. Spillover: a PROSE block whose Arabic actually contains a Quran ayah (>=5 matched words)
//  3. Repeated-ayah cards (same surah:ayah carded more than once anywhere)
// Usage: node verify_reader.mjs outputs/<folder>
import { readFileSync } from 'fs';
import { join } from 'path';
import { prescanForQuranZones } from './pipeline.js';

const folder = process.argv[2];
const txt = readFileSync(join(folder, 'reader.txt'), 'utf8');

const DIV = '─'.repeat(60);
const blocks = txt.split(DIV).map(b => b.trim()).filter(Boolean);

const parsed = [];
for (const b of blocks) {
  const lines = b.split('\n').map(l => l.trim());
  const badge = lines.find(l => l.startsWith('📖'));
  const hadith = lines.find(l => l.startsWith('📚'));
  // Arabic = the first contiguous non-empty lines that are not badges/English.
  // Heuristic: Arabic lines contain Arabic letters; take leading such lines.
  const arabicLines = [];
  for (const l of lines) {
    if (!l || l.startsWith('📖') || l.startsWith('📚') || l.startsWith('ANNOTATED') || l.startsWith('=')) continue;
    if (/[؀-ۿ]/.test(l)) arabicLines.push(l); else break;
  }
  const arabic = arabicLines.join(' ');
  let ref = null;
  if (badge) {
    const mm = badge.match(/(\d+):(\d+)/);
    if (mm) ref = `${mm[1]}:${mm[2]}`;
  }
  parsed.push({ arabic, ref, isQuran: !!badge, isHadith: !!hadith });
}

// 1 & 3: duplicate cards
const cardSeq = parsed.filter(p => p.isQuran).map(p => p.ref);
const adjDup = [];
for (let i = 1; i < cardSeq.length; i++) if (cardSeq[i] === cardSeq[i - 1]) adjDup.push(cardSeq[i]);
const counts = {};
cardSeq.forEach(r => counts[r] = (counts[r] || 0) + 1);
const repeated = Object.entries(counts).filter(([, c]) => c > 1);

// 2: spillover in prose blocks
const spillover = [];
for (const p of parsed) {
  if (p.isQuran || !p.arabic) continue;
  const words = p.arabic.split(/\s+/).filter(Boolean);
  if (words.length < 5) continue;
  const zones = prescanForQuranZones(words);
  for (const z of zones) {
    const span = z.end - z.start;
    if (span >= 5) {
      spillover.push({ ref: `${z.surah_id}:${z.ayah_id}`, span, snippet: words.slice(z.start, z.end).join(' ').slice(0, 60) });
    }
  }
}

console.log(`\n===== ${folder} =====`);
console.log(`Quran cards: ${cardSeq.length}  |  unique: ${Object.keys(counts).length}`);
console.log(`\n[1] Adjacent duplicate cards: ${adjDup.length ? adjDup.join(', ') : 'none ✓'}`);
console.log(`[2] Repeated cards (any position): ${repeated.length ? repeated.map(([r, c]) => `${r}×${c}`).join(', ') : 'none ✓'}`);
console.log(`[3] Spillover (ayah text in prose): ${spillover.length ? '' : 'none ✓'}`);
for (const s of spillover) console.log(`     ${s.ref} (${s.span}w): ${s.snippet}…`);
const total = adjDup.length + spillover.length;
console.log(`\nTOTAL ISSUES: ${total}`);
