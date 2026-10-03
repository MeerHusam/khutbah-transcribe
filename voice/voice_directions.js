// voice_directions.js — How each sentence of a voice track should be said (1 Oct 2026), for
// tts.js --direct. Gemini TTS takes a style note per piece of text; one note per sentence lets
// the voice rise where the imam is stirred and soften where he is tender, instead of reading the
// whole khutbah in one calm tone (Meer: Orus with these notes "has actual emotion").
//
// One call for the whole khutbah, so the notes follow its arc: each block's sentences, the
// imam's Arabic, and how he delivered it (delivery_imam.json from imam_delivery.py, when
// there). Kept in tts_<lang>_directions.json; a block whose text is unchanged keeps its notes,
// so a re-voice pays only for blocks that changed. Claude Sonnet 5.5, ~$0.15 for 25 Sep.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const MODEL = 'claude-sonnet-5-5';
const PRICE_IN = 2 / 1e6, PRICE_OUT = 10 / 1e6; // USD per token, claude-sonnet-5-5
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
const LANGUAGE = { ur: 'Urdu', en: 'English' };

// A block's sentences, each with its end mark (and a closing quote), in order. Text that would
// not split back into itself exactly stays one piece.
export function sentences(text, lang) {
  const re = lang === 'ur' ? /[^۔!؟?]+[۔!؟?]*["”’)]?/gu : /[^.!?]+[.!?]*["”’)]?/gu;
  const parts = (text.match(re) ?? []).map(s => s.trim()).filter(Boolean);
  const same = (a, b) => a.replace(/\s+/g, '') === b.replace(/\s+/g, '');
  return parts.length && same(parts.join(''), text) ? parts : [text];
}

const system = lang => `You direct a voice actor reading the ${LANGUAGE[lang]} translation of an Arabic Friday khutbah (sermon) aloud, sentence by sentence, so the listener feels what the congregation felt. You get the whole khutbah in order: for each block its ${LANGUAGE[lang]} sentences, the imam's Arabic, and, where measured, how the imam delivered it, from his recording against his own average in this khutbah (z-scores: 0 his average; +1 clearly louder, higher, wider in pitch movement, faster).

For every sentence write one short English direction for a text-to-speech model (its style note): how loud and how high, how urgent or how tender, the pace, which words to lean on, where to slow or pause. Follow the imam and the meaning, and match his intensity rather than holding back:
- Where he is raised and stirred (a warning, a condemnation, an exclamation, a rhetorical question), the voice is clearly raised, urgent and earnest, not calm or measured; let it land with force.
- Where the meaning is warm or tender (a blessing, Allah's mercy, gratitude, a du'a), the voice is genuinely warm, gentle or pleading, the emotion audible; in a du'a humble, earnest and hopeful, asking with trust that Allah answers, with longing on the call to Allah: never mournful, tearful or grieving (Meer, 1 Oct: the du'a for the distressed and the indebted sounded too sad).
- A Quran verse's meaning is read with gravity and awe; the Prophet's ﷺ words with reverence.
- Plain teaching is earnest and clear, never flat.
It stays a sermon from the minbar: never flat or newsreader-like, never theatrical, mocking, sing-song, whispery or shouting. One sentence of direction per sentence of text, and nothing of the text itself.`;

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['blocks'],
  properties: { blocks: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['i', 'styles'],
    properties: { i: { type: 'integer' }, styles: { type: 'array', items: { type: 'string' } } },
  } } },
};

// blocks: [{ i, text }] as tts.js speaks them; arabic: i -> the imam's Arabic for the block.
// Returns i -> [{ text, style }], one per sentence.
export async function directions({ folder, lang, blocks, arabic, effort = 'high' }) {
  const path = join(folder, `tts_${lang}_directions.json`);
  const kept = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { blocks: [] };
  const old = new Map(kept.blocks.map(b => [b.i, b]));
  const todo = blocks.filter(b => old.get(b.i)?.text !== b.text);
  const delivery = existsSync(join(folder, 'delivery_imam.json'))
    ? new Map(JSON.parse(readFileSync(join(folder, 'delivery_imam.json'), 'utf8')).blocks.map(d => [d.i, d])) : new Map();
  let cost = kept.cost_usd ?? 0;
  if (todo.length) {
    const todoSet = new Set(todo.map(b => b.i));
    const describe = b => {
      const d = delivery.get(b.i);
      const how = d ? ` (imam: loudness ${d.loud_z}, pitch ${d.pitch_z}, pitch movement ${d.range_z}, pace ${d.pace_z})` : '';
      return `Block ${b.i}${how}\nArabic: ${arabic.get(b.i) ?? ''}\n` + sentences(b.text, lang).map((s, k) => `  sentence ${k + 1}: ${s}`).join('\n');
    };
    // The whole khutbah is shown for its arc; directions are asked only for blocks that changed.
    const content = blocks.map(b => todoSet.has(b.i) ? describe(b) : `Block ${b.i} (already directed, context only): ${b.text}`).join('\n\n')
      + `\n\nGive exactly one style per sentence, in order, for blocks ${todo.map(b => b.i).join(', ')}.`;
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 600_000, maxRetries: 3 });
    const r = await anthropic.beta.messages.create({
      model: MODEL, max_tokens: 32000, system: system(lang), ...FALLBACK,
      output_config: { effort, format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content }],
    });
    const spent = r.usage.input_tokens * PRICE_IN + r.usage.output_tokens * PRICE_OUT;
    cost += spent;
    let out = [];
    try { out = JSON.parse(r.content.find(c => c.type === 'text')?.text ?? '').blocks; } catch { /* below */ }
    if (!out.length) console.error(`  directions: no usable answer (${r.stop_reason}); blocks keep the base style`);
    const got = new Map(out.map(o => [o.i, o.styles]));
    let short = 0;
    for (const b of todo) {
      const ss = sentences(b.text, lang), st = got.get(b.i) ?? [];
      if (st.length !== ss.length) short++;
      old.set(b.i, { i: b.i, text: b.text, parts: ss.map((s, k) => ({ text: s, style: st[k] ?? st.at(-1) ?? null })) });
    }
    console.log(`  directions for ${todo.length} block(s) with ${MODEL} (${effort}): ${r.usage.input_tokens} in ($${(r.usage.input_tokens * PRICE_IN).toFixed(3)}) / ${r.usage.output_tokens} out ($${(r.usage.output_tokens * PRICE_OUT).toFixed(3)}), $${spent.toFixed(3)}` +
      (short ? `; ${short} block(s) had a different number of notes than sentences (nearest note used)` : ''));
    const lines = blocks.map(b => JSON.stringify(old.get(b.i)));
    writeFileSync(path, `{\n "model": ${JSON.stringify(MODEL)},\n "effort": ${JSON.stringify(effort)},\n "input_tokens": ${r.usage.input_tokens},\n "output_tokens": ${r.usage.output_tokens},\n "cost_usd": ${cost.toFixed(4)},\n "blocks": [\n  ${lines.join(',\n  ')}\n ]\n}\n`);
  } else console.log(`  directions: all ${blocks.length} blocks unchanged, kept from ${path}`);
  return new Map(blocks.map(b => [b.i, old.get(b.i).parts]));
}
