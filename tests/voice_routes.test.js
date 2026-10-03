// tests/voice_routes.test.js — The voice survives Gemini's daily limit (3 Oct 2026: the limit ended
// the Madinah run's voices). A stand-in for Google answers the first key "100 per day" at once, lets
// the second voice one block before it runs out too, and then the Agent Platform voices the rest.
// A second run, every key known to be spent and no Agent Platform key, stops at once without
// sending anything. Nothing leaves this Mac and no real key is used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SR = 24000;
const wav = () => {
  const pcm = Buffer.alloc(SR); // half a second of silence
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]).toString('base64');
};
const perDay = JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED',
  message: 'Rate limit exceeded for model gemini-3.8-flash-tts (limit: 100 requests per day on Tier 1). Please retry in 19h44m12s.' } });

function fakeGoogle() {
  const seen = { 'key-a': 0, 'key-b': 0, vertex: 0 };
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      const key = req.headers['x-goog-api-key'];
      if (req.url.includes(':generateContent')) {
        seen.vertex++;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: wav() } }] } }] }));
      }
      seen[key]++;
      if (key === 'key-a' || (key === 'key-b' && seen[key] > 1)) {
        res.writeHead(429, { 'content-type': 'application/json' });
        return res.end(perDay);
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'x', outputs: [{ type: 'audio', data: wav() }] }));
    });
  });
  return new Promise(resolve => server.listen(0, () => resolve({ server, seen, url: `http://localhost:${server.address().port}` })));
}

function voice(env, blocks, out) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, ['voice/tts_gemini.mjs'], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', d => { stdout += d; });
    p.stderr.on('data', d => { stderr += d; });
    p.on('exit', code => resolve({ code, stdout, stderr }));
    p.stdin.end(JSON.stringify({ model: 'gemini-3.8-flash-tts', voice: 'Orus', style: 'test', concurrency: 1, out, blocks }));
  });
}

test('a spent key moves to the next key, then to the Agent Platform, and is remembered', async () => {
  const { server, seen, url } = await fakeGoogle();
  const dir = mkdtempSync(join(tmpdir(), 'voice-routes-'));
  const keys = { GEMINI_API_KEY: 'key-a', GEMINI_API_KEY2: 'key-b', GEMINI_BASE_URL: url, TTS_CACHE_DIR: dir, GROQ_API_KEY: '' };
  try {
    const blocks = [0, 1, 2].map(i => ({ i, text: `block ${i} ${Date.now()}` }));
    const run = await voice({ ...keys, VERTEX_API_KEY: 'key-v', VERTEX_BASE_URL: url }, blocks, join(dir, 'out.wav'));
    assert.equal(run.code, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout.trim().split('\n').at(-1)).length, 3);
    assert.ok(existsSync(join(dir, 'out.wav')));
    assert.deepEqual(seen, { 'key-a': 1, 'key-b': 2, vertex: 2 }, 'each spent key is asked once, then skipped');
    assert.equal(Object.keys(JSON.parse(readFileSync(join(dir, 'limits.json'), 'utf8'))).length, 2);

    // Both keys are now known to be spent until tomorrow; without the Agent Platform the run
    // stops with the daily-limit message (autopublish waits for the reset on it), asking nothing.
    const again = await voice({ ...keys, VERTEX_API_KEY: '' }, [{ i: 0, text: `new ${Date.now()}` }], join(dir, 'out2.wav'));
    assert.equal(again.code, 3, again.stderr);
    assert.match(again.stderr, /daily voice limit reached on every key/);
    assert.deepEqual(seen, { 'key-a': 1, 'key-b': 2, vertex: 2 });
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
