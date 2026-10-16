// tests/blocks_json.test.js — tts.js --blocks-json, as another voice's run reads it (spawnSync, a pipe), comes back
// whole. It exited before macOS had written the pipe, so the JSON stopped at 8,192 bytes and both the Urdu and
// Bengali voices failed on 16 Oct 2026. The fixture's English is well over 8 KB.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('--blocks-json prints every block, past the 8 KB a pipe takes at once', () => {
  const r = spawnSync(process.execPath, ['voice/tts.js', 'tests/fixture', '--lang', 'en', '--blocks-json'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(r.status, 0, r.stderr);
  const line = r.stdout.trim().split('\n').at(-1);
  let blocks;
  assert.doesNotThrow(() => { blocks = JSON.parse(line); }, `cut off at ${Buffer.byteLength(line)} bytes`);
  assert.ok(Buffer.byteLength(line) > 8192, 'the fixture is under 8 KB, so it no longer tests the cut');
  assert.ok(blocks.length > 10 && blocks.every(b => typeof b.i === 'number' && b.text));
});
