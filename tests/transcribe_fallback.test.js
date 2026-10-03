// tests/transcribe_fallback.test.js — The Arabic text survives a closed or busy Gemini model
// (3 Oct 2026: gemini-2.5-flash answered 404 to the new key and the run stopped at once). A fake
// client: the first model is closed, the second stays busy, the third answers. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geminiTranscript } from '../core/transcribe.js';

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
      generateContent: async ({ model }) => {
        asked.push(model);
        const a = answers[model];
        if (a instanceof Error) throw a;
        return { candidates: [{ content: { parts: [{ text: a }] } }] };
      },
    },
  };
}

test('a closed model is skipped, a busy one is asked three times, then the next answers', async () => {
  const client = fakeClient({
    'gemini-3.5-flash': new Error('{"error":{"code":404,"message":"This model models/gemini-3.5-flash is no longer available to new users."}}'),
    'gemini-3.1-pro-preview': new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand."}}'),
    'gemini-3.6-flash': 'الحمد لله',
  });
  const r = await geminiTranscript('x.mp3', 'audio/mpeg', 'prompt', { client, waitMs: 1 });
  assert.deepEqual(r, { text: 'الحمد لله', model: 'gemini-3.6-flash' });
  assert.deepEqual(client.asked, ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-3.1-pro-preview', 'gemini-3.1-pro-preview', 'gemini-3.6-flash']);
  assert.equal(client.deletedCount(), 1, 'the uploaded recording is deleted');
});

test('when no model answers, null (the caller then uses Groq\'s own text)', async () => {
  const closed = new Error('404 no longer available');
  const client = fakeClient({ 'gemini-3.5-flash': closed, 'gemini-3.1-pro-preview': closed, 'gemini-3.6-flash': '' });
  assert.equal(await geminiTranscript('x.mp3', 'audio/mpeg', 'prompt', { client, waitMs: 1 }), null);
  assert.equal(client.deletedCount(), 1);
});
