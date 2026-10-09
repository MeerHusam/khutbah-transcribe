// tests/highlight.test.js — voice/check_highlight.js without the network: word times that no longer
// match the page's blocks fail before anything is sent to Groq (the server would drop them and the
// page light no word). The heard check itself was calibrated on 11 Sep 2026 Makkah (8 Oct): as made,
// 18/19 heard words on time (median 0.08 s); every time moved 1 s, 1/14; moved 2 s, 1/3.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, cpSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('word times that no longer match the page\'s blocks fail, with no request made', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kt-hl-'));
  try {
    cpSync('tests/fixture', dir, { recursive: true });
    const w = JSON.parse(readFileSync(join(dir, 'words_imam.json'), 'utf8'));
    w.blocks[3].arabic_head = 'كلمات لا تطابق الصفحة';
    writeFileSync(join(dir, 'words_imam.json'), JSON.stringify(w));
    const r = spawnSync('node', ['voice/check_highlight.js', dir, join(dir, 'result.json')], { encoding: 'utf8', env: { ...process.env, GROQ_API_KEY: '' } });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /no longer match/);
    assert.equal(JSON.parse(readFileSync(join(dir, 'highlight_check.json'), 'utf8')).verdict, 'fail');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// 9 Oct 2026: a block's first word timed before the block before it ended (align_imam.js aligned each
// block alone); the voice tracks' recitation of 9:40 lost "معنا". Such word times fail before any request.
test('a block whose first word is timed before the block before it ends fails, with no request made', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kt-hl-'));
  try {
    cpSync('tests/fixture', dir, { recursive: true });
    const w = JSON.parse(readFileSync(join(dir, 'words_imam.json'), 'utf8'));
    const timed = w.blocks.filter(b => b.words?.length);
    // The fixture (2 Oct, aligned before the fix) overlaps at 14 boundaries: first make it clean.
    timed.slice(1).forEach((b, k) => { const end = timed[k].words.at(-1)[2]; if (b.words[0][1] < end) b.words[0][1] = end; });
    const check = () => {
      writeFileSync(join(dir, 'words_imam.json'), JSON.stringify(w));
      return spawnSync('node', ['voice/check_highlight.js', dir, join(dir, 'result.json')], { encoding: 'utf8', env: { ...process.env, GROQ_API_KEY: '' } });
    };
    const clean = check();
    assert.equal(clean.status, 0, clean.stdout + clean.stderr); // no Groq key: skipped, not failed
    timed[4].words[0][1] = timed[3].words.at(-1)[2] - 0.5;
    const r = check();
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /1 block\(s\) of words_imam.json start before the block before them ends/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
