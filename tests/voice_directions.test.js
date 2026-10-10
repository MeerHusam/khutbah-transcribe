// tests/voice_directions.test.js — The voice directions for every language in one call (10 Oct 2026; one
// call per language before): the imam's Arabic goes once, each language gets its own notes in its own
// file, the next voice's run finds its notes ready, and a language the answer leaves out is asked
// alone. A fake client; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { directions } from '../voice/voice_directions.js';

const BLOCKS = {
  ur: [{ i: 0, text: 'تمام تعریفیں اللہ کے لیے ہیں۔ اے لوگو! اللہ سے ڈرو۔' }, { i: 2, text: 'اے اللہ، ہمیں معاف فرما۔' }],
  bn: [{ i: 0, text: 'সমস্ত প্রশংসা আল্লাহর। হে লোকসকল! আল্লাহকে ভয় করো।' }, { i: 2, text: 'হে আল্লাহ, আমাদের ক্ষমা করুন।' }],
  en: [{ i: 0, text: 'All praise is for Allah. O people! Fear Allah.' }, { i: 2, text: 'O Allah, forgive us.' }],
};
const ARABIC = new Map([[0, 'الحمد لله. أيها الناس! اتقوا الله.'], [1, '(a verse)'], [2, 'اللهم اغفر لنا.']]);

// Answers every language and block the request lists, one style per sentence ("ur 0.1"), except the
// languages in `skip`.
function fakeClient(skip = []) {
  const asked = [];
  const answer = params => {
    const out = [];
    for (const section of params.messages[0].content.split('\n\n')) {
      const i = section.match(/^Block (\d+)[^\n]*\nArabic: /)?.[1];
      if (i === undefined) continue;
      let lang = null;
      for (const line of section.split('\n').slice(2)) {
        const head = line.match(/^\S+ \((\w+)\):$/);
        if (head) { lang = head[1]; if (!skip.includes(lang)) out.push({ i: +i, lang, styles: [] }); }
        else if (lang && !skip.includes(lang)) out.at(-1).styles.push(`${lang} ${i}.${out.at(-1).styles.length + 1}`);
      }
    }
    return { content: [{ type: 'text', text: JSON.stringify({ blocks: out }) }], usage: { input_tokens: 3000, output_tokens: 600 }, stop_reason: 'end_turn' };
  };
  return { asked, beta: { messages: { stream: params => { asked.push(params); return { finalMessage: async () => answer(params) }; } } } };
}
const others = (...langs) => langs.map(lang => ({ lang, blocks: BLOCKS[lang] }));

test('one call directs every voice; each language keeps its notes in its own file', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'directions-test-'));
  try {
    const client = fakeClient();
    const ur = await directions({ folder, lang: 'ur', blocks: BLOCKS.ur, arabic: ARABIC, others: others('bn', 'en'), client });
    assert.equal(client.asked.length, 1);
    const { content, system } = { content: client.asked[0].messages[0].content, system: client.asked[0].system };
    assert.equal(content.match(/^Arabic: /gm).length, 2, "each block's Arabic once, not once a language");
    assert.match(system, /Urdu, Bengali and English translations/);
    assert.deepEqual(ur.get(0).map(p => p.style), ['ur 0.1', 'ur 0.2', 'ur 0.3']);
    for (const lang of ['ur', 'bn', 'en']) {
      const file = JSON.parse(readFileSync(join(folder, `tts_${lang}_directions.json`), 'utf8'));
      assert.deepEqual(file.call, ['ur', 'bn', 'en']);
      assert.equal(file.blocks.find(b => b.i === 2).parts[0].style, `${lang} 2.1`);
      assert.ok(file.cost_usd > 0 && file.cost_usd < 0.012, 'a share of the call, not all of it');
    }
    // The next voices' runs: nothing to ask.
    const bn = await directions({ folder, lang: 'bn', blocks: BLOCKS.bn, arabic: ARABIC, others: others('ur', 'en'), client });
    await directions({ folder, lang: 'en', blocks: BLOCKS.en, arabic: ARABIC, others: [], client });
    assert.equal(client.asked.length, 1);
    assert.deepEqual(bn.get(2).map(p => p.style), ['bn 2.1']);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test('a language the answer leaves out is asked alone; a changed block is directed again', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'directions-test-'));
  try {
    // The shared answer leaves Bengali out; asked on its own, it is answered.
    const shared = fakeClient(['bn']), alone = fakeClient();
    let calls = 0;
    const client = { beta: { messages: { stream: params => (calls++ === 0 ? shared : alone).beta.messages.stream(params) } } };
    await directions({ folder, lang: 'ur', blocks: BLOCKS.ur, arabic: ARABIC, others: others('bn', 'en'), client });
    assert.equal(calls, 2);
    assert.match(alone.asked[0].system, /reading the Bengali translation of/);
    const bn = JSON.parse(readFileSync(join(folder, 'tts_bn_directions.json'), 'utf8'));
    assert.equal(bn.blocks[0].parts[0].style, 'bn 0.1');
    assert.equal(bn.call, undefined, 'made by a call of its own');

    // English block 2 changed: only it is directed again; block 0 is context.
    const again = fakeClient();
    await directions({ folder, lang: 'en', blocks: [BLOCKS.en[0], { i: 2, text: 'O Allah, forgive us and have mercy on us.' }], arabic: ARABIC, others: [], client: again });
    const asked = again.asked[0].messages[0].content;
    assert.match(asked, /^Block 0 \(already directed, context only\)/m);
    assert.match(asked, /^Block 2\nArabic: /m);
    assert.match(again.asked[0].system, /reading the English translation of/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
