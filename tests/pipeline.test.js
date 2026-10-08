// tests/pipeline.test.js — pipeline.js end to end on a published khutbah's transcript (tests/fixture/), with Claude
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
import { completeChunkTranslations } from '../core/analyze.js';

const RUN = 'tests/fixture';

test('pipeline.js --transcript with a stub Claude: every stage runs and the reader passes the publish gate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pipeline-test-'));
  // The transcript, and the result.json beside it whose word timings pipeline.js reuses.
  for (const f of ['transcript.txt', 'result.json']) copyFileSync(join(RUN, f), join(dir, f));
  const r = JSON.parse(readFileSync(join(RUN, 'result.json'), 'utf8'));
  const fromClaude = x => x.detection_method === 'signal_phrase';
  const quran = r.quran_references.filter(fromClaude);
  writeFileSync(join(dir, 'analysis.json'), JSON.stringify({
    share_summary: r.share_summary, summary: r.summary,
    chunk_translations: Object.fromEntries(r.chunk_translations.map((t, i) => [i + 1, t])), // keyed by chunk number
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

// 18 Sep 2026 (Madinah): the analysis gave 57 translations for 58 chunks and every later block
// showed its neighbour's English. A chunk missing from the keyed answer is translated on its own.
test('a chunk the analysis left out is translated on its own; the others keep their place', async () => {
  const asked = [];
  const client = { messages: { create: async ({ messages }) => { asked.push(messages[0].content.match(/Chunk: (.*)/)[1]); return { content: [{ type: 'text', text: 'English of B' }] }; } } };
  const chunks = [{ text: 'أ' }, { text: 'ب' }, { text: 'ج' }];
  const { list, missing } = await completeChunkTranslations(client, { 1: 'English of A', 3: 'English of C' }, chunks, 'أ ب ج');
  assert.deepEqual(list, ['English of A', 'English of B', 'English of C']);
  assert.deepEqual(missing, [1]);
  assert.deepEqual(asked, ['ب']);
  // An array of the wrong length cannot be paired: every chunk is translated again.
  assert.deepEqual((await completeChunkTranslations(client, ['x', 'y'], chunks, '')).missing, [0, 1, 2]);
});

// 11 Sep 2026 Madinah: chunk 13 came back empty because its ayah and hadith were folded into
// chunk 12's English; translated alone as well, the page said them twice. The swollen neighbour is
// translated again on its own too.
test('a neighbour that swallowed the empty chunk\'s words is translated again', async () => {
  const asked = [];
  const client = { messages: { create: async ({ messages }) => { const c = messages[0].content.match(/Chunk: (.*)/)[1]; asked.push(c); return { content: [{ type: 'text', text: `English of ${c}` }] }; } } };
  const ar = n => Array.from({ length: n }, (_, k) => `كلمة${k}`).join(' ');
  const chunks = [{ text: ar(10) }, { text: ar(16) }, { text: ar(20) }, { text: ar(10) }];
  const en = n => Array.from({ length: n }, (_, k) => `word${k}`).join(' ');
  const { list, missing } = await completeChunkTranslations(client, { 1: en(17), 2: en(79), 4: en(17) }, chunks, '');
  assert.deepEqual(missing, [1, 2]);
  assert.deepEqual(asked, [ar(16), ar(20)]);
  assert.equal(list[1], `English of ${ar(16)}`);
  assert.equal(list[0], en(17));
});
