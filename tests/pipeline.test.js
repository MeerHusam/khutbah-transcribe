// tests/pipeline.test.js — pipeline.js end to end on a published khutbah's transcript, with Claude
// replaced by a stub (tests/stubs/) that answers with the analysis the khutbah got, rebuilt from
// its result.json. Every stage after transcription runs for real, at no cost; sunnah.com
// lookups use the local cache when there is one and are skipped quietly when offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyReader } from '../core/verify_reader.js';

const RUN = 'outputs/2026-09-25T10-04-57_khutbah-2026-09-25-masjid';

test('pipeline.js --transcript with a stub Claude: every stage runs and the reader passes the publish gate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-test-'));
  // The transcript, and the result.json beside it whose word timings pipeline.js reuses.
  for (const f of ['transcript.txt', 'result.json']) copyFileSync(join(RUN, f), join(dir, f));
  const r = JSON.parse(readFileSync(join(RUN, 'result.json'), 'utf8'));
  const fromClaude = x => x.detection_method === 'signal_phrase';
  const quran = r.quran_references.filter(fromClaude);
  writeFileSync(join(dir, 'analysis.json'), JSON.stringify({
    share_summary: r.share_summary, summary: r.summary, chunk_translations: r.chunk_translations,
    second_khutbah_start: r.second_khutbah?.marker_text ?? null,
    quran_references: quran.map(q => ({ arabic_text: q.detected_text, surah_number: q.surah_number, ayah_number: q.ayah_number, surah_name: q.surah_name })),
    hadith_references: r.hadith_references.filter(fromClaude).map(h => ({ arabic_text: h.detected_text, narrator: h.narrator, collection: h.collection })),
  }));

  const run = spawnSync(process.execPath, ['--import', './tests/stubs/register.mjs', 'pipeline.js', '--transcript', join(dir, 'transcript.txt')], {
    encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: 'stub', STUB_ANALYSIS: join(dir, 'analysis.json') },
  });
  const out = run.stdout.match(/Output folder: (outputs\/[^/]+)\//)?.[1];
  try {
    assert.equal(run.status, 0, run.stderr);
    for (const f of ['transcript.txt', 'result.json', 'reader.txt', 'readable.txt']) assert.ok(existsSync(join(out, f)), f);
    const result = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'));
    assert.equal(result.metadata.transcript_word_count, readFileSync(join(RUN, 'transcript.txt'), 'utf8').trim().split(/\s+/).length);
    assert.equal(result.chunk_translations.length, result.prose_chunk_map.length);
    assert.ok(result.quran_references.length >= quran.length, 'Quran references');
    assert.ok(result.quran_references.filter(fromClaude).every(q => q.matched), "Claude's verses all matched");
    assert.ok(result.hadith_references.length > 0, 'hadith references');
    assert.ok(result.second_khutbah, 'second khutbah located');
    const gate = verifyReader(out);
    assert.deepEqual(gate.failures, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    if (out?.startsWith('outputs/') && out.includes('_pipeline-test-')) rmSync(out, { recursive: true, force: true });
  }
});
