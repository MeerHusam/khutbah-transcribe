// tests/transcribe_fallback.test.js — The Arabic text survives a closed or busy Gemini model
// (3 Oct 2026: gemini-2.5-flash answered 404 to the new key and the run stopped at once). A fake
// client: the first model is closed, the second stays busy, the third answers. No network.
// An answer that is not a transcript (9 Oct 2026: Gemini's working notes) is asked for once
// more, then the next model; the publish gate fails one that got through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { geminiTranscript } from '../core/transcribe.js';
import { transcriptProblem } from '../core/arabic.js';
import { verifyReader } from '../core/verify_reader.js';

function fakeClient(answers) {
  const asked = [];
  let deleted = 0;
  return {
    asked, deletedCount: () => deleted,
    files: {
      upload: async () => ({ name: 'files/x', uri: 'gs://x', state: 'ACTIVE' }),
      get: async () => ({ name: 'files/x', uri: 'gs://x', state: 'ACTIVE' }),
      delete: async () => { deleted++; },
    },
    models: {
      // An answer: an Error (thrown), a text, { parts } as they come, or a list of these, one per ask.
      generateContent: async ({ model }) => {
        asked.push(model);
        let a = answers[model];
        if (Array.isArray(a)) a = a.length > 1 ? a.shift() : a[0];
        if (a instanceof Error) throw a;
        return { candidates: [{ content: { parts: typeof a === 'string' ? [{ text: a }] : a.parts } }] };
      },
    },
  };
}

test('a closed model is skipped, a busy one is asked three times, then the next answers', async () => {
  const closed = new Error('{"error":{"code":404,"message":"This model models/gemini-3.6-flash is no longer available to new users."}}');
  const busy = new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand."}}');
  let client = fakeClient({ 'gemini-3.6-flash': closed, 'gemini-3.1-pro-preview': 'الحمد لله' });
  assert.deepEqual(await geminiTranscript('x.mp3', 'audio/mpeg', 'prompt', { client, waitMs: 1 }), { text: 'الحمد لله', model: 'gemini-3.1-pro-preview' });
  assert.deepEqual(client.asked, ['gemini-3.6-flash', 'gemini-3.1-pro-preview']);
  assert.equal(client.deletedCount(), 1, 'the uploaded recording is deleted');

  client = fakeClient({ 'gemini-3.6-flash': busy, 'gemini-3.1-pro-preview': 'الحمد لله' });
  assert.equal((await geminiTranscript('x.mp3', 'audio/mpeg', 'prompt', { client, waitMs: 1 })).model, 'gemini-3.1-pro-preview');
  assert.deepEqual(client.asked, ['gemini-3.6-flash', 'gemini-3.6-flash', 'gemini-3.6-flash', 'gemini-3.1-pro-preview']);
});

test('when no model answers, null (the caller then uses Groq\'s own text)', async () => {
  const closed = new Error('404 no longer available');
  const client = fakeClient({ 'gemini-3.6-flash': closed, 'gemini-3.1-pro-preview': '' });
  assert.equal(await geminiTranscript('x.mp3', 'audio/mpeg', 'prompt', { client, waitMs: 1 }), null);
  assert.equal(client.deletedCount(), 1);
});

// 9 Oct 2026's first answer began like this.
const NOTES = 'Ah, "اللهم مزق شملهم" is indeed "اللهم مزق شملهم" (Allahumma mazziq shamlahum). Let\'s write "اللهم مزق شملهم". The transcription is highly accurate and follows all formatting rules.';

test('a thought part is not the transcript', async () => {
  const client = fakeClient({ 'gemini-3.6-flash': { parts: [{ text: NOTES, thought: true }, { text: 'الحمد لله رب العالمين' }] } });
  const r = await geminiTranscript('x.mp3', 'audio/mpeg', 'prompt', { client, waitMs: 1 });
  assert.deepEqual(r, { text: 'الحمد لله رب العالمين', model: 'gemini-3.6-flash' });
});

test('an answer that is not a transcript is asked for once more, then the next model', async () => {
  const client = fakeClient({ 'gemini-3.6-flash': NOTES, 'gemini-3.1-pro-preview': 'الحمد لله رب العالمين' });
  const r = await geminiTranscript('x.mp3', 'audio/mpeg', 'prompt', { client, waitMs: 1 });
  assert.equal(r.model, 'gemini-3.1-pro-preview');
  assert.deepEqual(client.asked, ['gemini-3.6-flash', 'gemini-3.6-flash', 'gemini-3.1-pro-preview']);

  // Asked again, it answered: kept.
  const again = fakeClient({ 'gemini-3.6-flash': [NOTES, 'الحمد لله رب العالمين'] });
  assert.equal((await geminiTranscript('x.mp3', 'audio/mpeg', 'prompt', { client: again, waitMs: 1 })).model, 'gemini-3.6-flash');
  assert.equal(again.asked.length, 2);
});

test('far fewer words than Groq heard is not a transcript either', async () => {
  const groq = 'الحمد لله رب العالمين والصلاة والسلام على أشرف الأنبياء والمرسلين';
  const check = text => transcriptProblem(text, groq);
  const client = fakeClient({ 'gemini-3.6-flash': 'الحمد لله', 'gemini-3.1-pro-preview': groq });
  const r = await geminiTranscript('x.mp3', 'audio/mpeg', 'prompt', { client, waitMs: 1, check });
  assert.equal(r.model, 'gemini-3.1-pro-preview');
});

test('transcriptProblem: notes, another language, too few words; a good transcript passes', () => {
  assert.match(transcriptProblem(NOTES), /% of its letters are Arabic/);
  assert.match(transcriptProblem("And we'll haem'dhamed tohine him by Allah"), /^0% of its letters are Arabic/);
  assert.equal(transcriptProblem('الحمد لله. رب العالمين!', 'الحمد لله رب العالمين'), null);
  assert.equal(transcriptProblem('الحمد لله', 'الحمد لله رب العالمين'), "2 words against Groq's 4");
  assert.equal(transcriptProblem('الحمد لله رب العالمين وبعد', 'الحمد لله رب العالمين'), null, 'more words than Groq is normal');
});

test('the publish gate fails a transcript far shorter than Groq\'s', () => {
  const dir = mkdtempSync(join(tmpdir(), 'transcript-gate-'));
  try {
    cpSync('tests/fixture', dir, { recursive: true });
    const transcript = readFileSync(join(dir, 'transcript.txt'), 'utf8');
    assert.ok(!verifyReader(dir).failures.some(f => /transcript is not usable/.test(f)));
    writeFileSync(join(dir, 'transcript_groq.txt'), `${transcript} ${transcript}`);
    assert.ok(verifyReader(dir).failures.some(f => /the transcript is not usable: \d+ words against Groq's \d+/.test(f)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
