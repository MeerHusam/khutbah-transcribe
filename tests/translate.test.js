// tests/translate.test.js — The Urdu and Bengali blocks on Gemini 3.8 Flash, a batch it does not answer
// on Opus (10 Oct 2026). core/gemini_text.js against a fake client, then core/translate.js end to end
// on a copy of tests/fixture/ with both SDKs stubbed (tests/stubs/). No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, copyFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { geminiJSON, geminiPrice } from '../core/gemini_text.js';
import { langOf } from '../core/languages.js';

// Each call takes the next answer: an Error is thrown, anything else is the response.
function fakeClient(answers) {
  const asked = [];
  return { asked, models: { generateContent: async req => { asked.push(req); const a = answers.shift(); if (a instanceof Error) throw a; return a; } } };
}
const answer = (text, finishReason = 'STOP') => ({
  candidates: [{ content: { parts: [{ text: 'Let me think.', thought: true }, { text }] }, finishReason }],
  usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200, thoughtsTokenCount: 800 },
});
const ask = client => geminiJSON({ model: 'gemini-3.8-flash', system: 'sys', content: 'c', schema: { type: 'object' }, client, waitMs: 1, gapMs: 0 });

test('the answer is the JSON of the non-thought parts; thinking is billed as output', async () => {
  const client = fakeClient([answer('{"translations":[]}')]);
  const r = await ask(client);
  assert.equal(r.ok, true);
  assert.deepEqual(r.json, { translations: [] });
  assert.deepEqual(r.usage, { calls: 1, input_tokens: 1000, output_tokens: 1000, thoughts_tokens: 800 });
  const [pin, pout] = geminiPrice('gemini-3.8-flash');
  assert.equal(r.cost_usd, (1000 * pin + 1000 * pout) / 1e6);
  const { model, config } = client.asked[0];
  assert.equal(model, 'gemini-3.8-flash');
  assert.equal(config.systemInstruction, 'sys');
  assert.equal(config.responseMimeType, 'application/json');
  assert.deepEqual(config.thinkingConfig, { thinkingLevel: 'HIGH' });
});

test('blocked, cut short, no text, not JSON: no answer, the reason, and the tokens still counted', async () => {
  const cases = [
    [{ promptFeedback: { blockReason: 'PROHIBITED_CONTENT' }, usageMetadata: { promptTokenCount: 900 } }, /blocked \(PROHIBITED_CONTENT\)/],
    [answer('{"translations":[{"i":0,', 'MAX_TOKENS'), /MAX_TOKENS/],
    [answer('', 'STOP'), /no text/],
    [answer('Here are the translations:'), /not JSON/],
  ];
  for (const [response, why] of cases) {
    const r = await ask(fakeClient([response]));
    assert.equal(r.ok, false);
    assert.match(r.why, why);
    assert.equal(r.usage.calls, 1);
    assert.ok(r.cost_usd > 0, 'the tokens of a failed answer are paid for too');
  }
});

test('a busy model is asked once more; a bad request is not repeated', async () => {
  const busy = () => new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand."}}');
  let client = fakeClient([busy(), answer('{"ok":1}')]);
  assert.equal((await ask(client)).ok, true);
  assert.equal(client.asked.length, 2);

  client = fakeClient([busy(), busy()]);
  const r = await ask(client);
  assert.equal(r.ok, false);
  assert.match(r.why, /error 503/);
  assert.equal(client.asked.length, 2);
  assert.equal(r.cost_usd, 0);

  client = fakeClient([Object.assign(new Error('bad request'), { status: 400 })]);
  assert.match((await ask(client)).why, /error 400/);
  assert.equal(client.asked.length, 1);
});

test('Gemini 3.8 Flash costs twice as much from 1 Jan 2027', () => {
  assert.deepEqual(geminiPrice('gemini-3.8-flash', new Date('2026-12-31T23:59:00Z')), [0.75, 3.75]);
  assert.deepEqual(geminiPrice('gemini-3.8-flash', new Date('2027-01-01T00:00:00Z')), [1.5, 7.5]);
  assert.equal(geminiPrice('gemini-9-ultra'), null);
});

// translate.js reads the language's Quran and hadith editions from hadith_data/ (not on GitHub's runners).
const UR = langOf('ur');
const editions = existsSync(join('hadith_data', `quran-${UR.quran.edition}.json`));

test('translate.js: Gemini makes the blocks, a blocked batch goes to Opus, and both are recorded', { skip: !editions && 'no hadith_data/' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'translate-test-'));
  for (const f of ['result.json', 'transcript.txt', 'reader.txt']) copyFileSync(join('tests/fixture', f), join(dir, f));
  const run = spawnSync(process.execPath, ['--import', './tests/stubs/register.mjs', 'core/translate.js', dir, '--lang', 'ur', '--retranslate'], {
    encoding: 'utf8',
    env: { ...process.env, ANTHROPIC_API_KEY: 'stub', GEMINI_API_KEY: 'stub', STUB_TRANSLATE: '1', STUB_GEMINI_FAIL: '13',
      KT_TRANSLATE_MODEL: '', KT_TRANSLATE_CAP: '', KT_GEMINI_GAP_MS: '0' },
  });
  try {
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const ur = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'))[UR.field];
    const n = ur.chunk_translations.length;
    // Batches of 12: chunk 13 is in 12–23, which Gemini blocks, so Opus translates all twelve.
    const byOpus = i => i >= 12 && i <= 23;
    const want = [...Array(n).keys()];
    assert.deepEqual(ur.chunk_translations, want.map(i => (byOpus(i) ? `opus ${i}` : `gemini ${i}`)));
    assert.deepEqual(ur.block_models, want.map(i => (byOpus(i) ? 'claude-opus-5-5' : 'gemini-3.8-flash')));
    assert.equal(ur.model, 'gemini-3.8-flash + claude-opus-5-5');
    const g = ur.usage.by_model['gemini-3.8-flash'], o = ur.usage.by_model['claude-opus-5-5'];
    assert.equal(g.calls, Math.ceil(n / 12), 'one call a batch, the blocked one included');
    assert.equal(g.thoughts_tokens, 1500 * (Math.ceil(n / 12) - 1));
    assert.equal(o.calls, 2, 'the blocked batch and the extras');
    assert.equal(ur.usage.cost_usd, Math.round((g.cost_usd + o.cost_usd) * 10000) / 10000);
    assert.match(run.stdout, /gemini-3\.8-flash, chunks 12-23: blocked \(PROHIBITED_CONTENT\); asking claude-opus-5-5/);
    assert.match(run.stdout, new RegExp(`✓ ${n} blocks \\(${n - 12} gemini-3\\.8-flash, 12 claude-opus-5-5\\)`));
    assert.match(readFileSync(join(dir, `reader_${UR.code}.txt`), 'utf8'), /gemini 0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('KT_TRANSLATE_MODEL=claude-opus-5-5: the blocks on Opus, as before', { skip: !editions && 'no hadith_data/' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'translate-test-'));
  for (const f of ['result.json', 'transcript.txt', 'reader.txt']) copyFileSync(join('tests/fixture', f), join(dir, f));
  const run = spawnSync(process.execPath, ['--import', './tests/stubs/register.mjs', 'core/translate.js', dir, '--lang', 'ur', '--retranslate'], {
    encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: 'stub', STUB_TRANSLATE: '1', KT_TRANSLATE_MODEL: 'claude-opus-5-5', KT_TRANSLATE_CAP: '' },
  });
  try {
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const ur = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'))[UR.field];
    assert.ok(ur.chunk_translations.every((t, i) => t === `opus ${i}`));
    assert.equal(ur.model, 'claude-opus-5-5');
    assert.deepEqual(Object.keys(ur.usage.by_model), ['claude-opus-5-5']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the cap: a call that could take the run past it is refused, and nothing is written', { skip: !editions && 'no hadith_data/' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'translate-test-'));
  for (const f of ['result.json', 'transcript.txt', 'reader.txt']) copyFileSync(join('tests/fixture', f), join(dir, f));
  const before = readFileSync(join(dir, 'result.json'), 'utf8');
  const run = spawnSync(process.execPath, ['--import', './tests/stubs/register.mjs', 'core/translate.js', dir, '--lang', 'ur', '--retranslate'], {
    encoding: 'utf8', env: { ...process.env, ANTHROPIC_API_KEY: 'stub', GEMINI_API_KEY: 'stub', STUB_TRANSLATE: '1', KT_TRANSLATE_MODEL: '', KT_TRANSLATE_CAP: '0.01', KT_GEMINI_GAP_MS: '0' },
  });
  try {
    assert.equal(run.status, 1);
    assert.match(run.stderr, /call refused/);
    assert.equal(readFileSync(join(dir, 'result.json'), 'utf8'), before);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
