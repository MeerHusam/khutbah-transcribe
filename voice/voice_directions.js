// voice_directions.js — How each sentence of a voice track should be said (1 Oct 2026), for
// tts.js --direct. Gemini TTS takes a style note per piece of text; one note per sentence lets
// the voice rise where the imam is stirred and soften where he is tender, instead of reading the
// whole khutbah in one calm tone (Meer: Orus with these notes "has actual emotion").
//
// One call for the whole khutbah, so the notes follow its arc: each block's sentences, the
// imam's Arabic, and how he delivered it (delivery_imam.json from imam_delivery.py, when
// there). Since 10 Oct 2026 the call covers every language the khutbah is voiced in (`others`):
// the Arabic and his delivery go once, with each language's sentences beside them, so the voices
// also follow the same arc (one call per language before, ~$0.24 a khutbah for three). A language
// the answer leaves out is asked for alone. Kept per language in tts_<lang>_directions.json; a
// block whose text is unchanged keeps its notes, so a re-voice pays only for blocks that changed.
// Claude Sonnet 5.5.

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { langOf } from '../core/languages.js';

const MODEL = 'claude-sonnet-5-5';
const PRICE_IN = 2 / 1e6, PRICE_OUT = 10 / 1e6; // USD per token, claude-sonnet-5-5
const FALLBACK = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
const LANGUAGE = lang => (lang === 'en' ? 'English' : langOf(lang).name);

// A block's sentences, each with its end mark (and a closing quote), in order. Text that would
// not split back into itself exactly stays one piece.
export function sentences(text, lang) {
  const ends = lang === 'en' ? '.!?' : langOf(lang).sentenceEnd;
  const re = new RegExp(`[^${ends}]+[${ends}]*["”’)]?`, 'gu');
  const parts = (text.match(re) ?? []).map(s => s.trim()).filter(Boolean);
  const same = (a, b) => a.replace(/\s+/g, '') === b.replace(/\s+/g, '');
  return parts.length && same(parts.join(''), text) ? parts : [text];
}

const names = langs => {
  const n = langs.map(LANGUAGE);
  return n.length > 1 ? `${n.slice(0, -1).join(', ')} and ${n.at(-1)}` : n[0];
};
const system = langs => `You direct ${langs.length > 1 ? 'the voice actors' : 'a voice actor'} reading the ${names(langs)} translation${langs.length > 1 ? 's' : ''} of an Arabic Friday khutbah (sermon) aloud, sentence by sentence, so the listener feels what the congregation felt. You get the whole khutbah in order: for each block its ${names(langs)} sentences, the imam's Arabic, and, where measured, how the imam delivered it, from his recording against his own average in this khutbah (z-scores: 0 his average; +1 clearly louder, higher, wider in pitch movement, faster).

For every sentence write one short English direction for a text-to-speech model (its style note): how loud and how high, how urgent or how tender, the pace, which words to lean on, where to slow or pause. Follow the imam and the meaning, and match his intensity rather than holding back:
- Where he is raised and stirred (a warning, a condemnation, an exclamation, a rhetorical question), the voice is clearly raised, urgent and earnest, not calm or measured; let it land with force.
- Where the meaning is warm or tender (a blessing, Allah's mercy, gratitude, a du'a), the voice is genuinely warm, gentle or pleading, the emotion audible; in a du'a humble, earnest and hopeful, asking with trust that Allah answers, with longing on the call to Allah: never mournful, tearful or grieving (Meer, 1 Oct: the du'a for the distressed and the indebted sounded too sad).
- A Quran verse's meaning is read with gravity and awe; the Prophet's ﷺ words with reverence.
- Plain teaching is earnest and clear, never flat.
It stays a sermon from the minbar: never flat or newsreader-like, never theatrical, mocking, sing-song, whispery or shouting. One sentence of direction per sentence of text, and nothing of the text itself.${langs.length > 1 ? ' Each language follows the same arc: a moment that is raised or tender in one is raised or tender in all.' : ''}`;

const schema = langs => ({
  type: 'object', additionalProperties: false, required: ['blocks'],
  properties: { blocks: { type: 'array', items: {
    type: 'object', additionalProperties: false, required: ['i', 'lang', 'styles'],
    properties: { i: { type: 'integer' }, lang: { type: 'string', enum: langs }, styles: { type: 'array', items: { type: 'string' } } },
  } } },
});

// One request for the languages in `need` ([{ lang, blocks, todo }]): their changed blocks are
// directed, the rest of the khutbah is shown as context. Returns lang -> i -> styles, and the usage.
async function ask(anthropic, need, arabic, delivery, effort) {
  const langs = need.map(s => s.lang);
  const todo = new Map(need.map(s => [s.lang, new Map(s.todo.map(b => [b.i, b.text]))]));
  const any = new Map(need.flatMap(s => s.blocks.map(b => [b.i, b.text])).reverse()); // first language's text wins
  const order = [...new Set(need.flatMap(s => s.blocks.map(b => b.i)))].sort((a, b) => a - b);
  const content = order.map(i => {
    const asked = langs.filter(l => todo.get(l).has(i));
    if (!asked.length) return `Block ${i} (already directed, context only): ${any.get(i)}`;
    const d = delivery.get(i);
    const how = d ? ` (imam: loudness ${d.loud_z}, pitch ${d.pitch_z}, pitch movement ${d.range_z}, pace ${d.pace_z})` : '';
    return `Block ${i}${how}\nArabic: ${arabic.get(i) ?? ''}\n` + asked.map(l => `${LANGUAGE(l)} (${l}):\n` +
      sentences(todo.get(l).get(i), l).map((s, k) => `  sentence ${k + 1}: ${s}`).join('\n')).join('\n');
  }).join('\n\n') + `\n\nFor every block that lists sentences, give one entry per language listed in it (i, lang, styles), with exactly one style per sentence, in order.`;
  const r = await anthropic.beta.messages.stream({
    model: MODEL, max_tokens: 64000, system: system(langs), ...FALLBACK,
    output_config: { effort, format: { type: 'json_schema', schema: schema(langs) } },
    messages: [{ role: 'user', content }],
  }).finalMessage();
  let out = [];
  try { out = JSON.parse(r.content.find(c => c.type === 'text')?.text ?? '').blocks ?? []; } catch { /* below */ }
  const got = new Map(langs.map(l => [l, new Map()]));
  for (const o of out) got.get(o.lang)?.set(o.i, o.styles);
  const sent = need.map(s => s.todo.reduce((n, b) => n + sentences(b.text, s.lang).length, 0));
  return { got, usage: r.usage, stop: r.stop_reason, langs, share: sent.map(n => n / Math.max(sent.reduce((a, b) => a + b, 0), 1)) };
}

// One folder's directions at a time. Voices made side by side (autopublish, 13 Oct 2026) each ask for the notes
// of both languages: the first takes this lock and directs both, the other waits and then finds its notes in its
// file (9 Oct 2026 Makkah: the Urdu and Bengali voices both made the shared call, $0.20 paid twice). A lock
// whose process has ended is taken over.
async function oneAtATime(folder, fn) {
  const lock = join(folder, '.directions.lock');
  for (;;) {
    try { mkdirSync(lock); writeFileSync(join(lock, 'pid'), String(process.pid)); break; } catch {
      let owner = null;
      try { owner = Number(readFileSync(join(lock, 'pid'), 'utf8')); } catch { /* being made, or gone */ }
      if (owner) { try { process.kill(owner, 0); } catch (e) { if (e.code === 'ESRCH') { rmSync(lock, { recursive: true, force: true }); continue; } } }
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  try { return await fn(); } finally { rmSync(lock, { recursive: true, force: true }); }
}

// blocks: [{ i, text }] as tts.js speaks them in `lang`; arabic: i -> the imam's Arabic for the block;
// others: [{ lang, blocks }] for the other languages voiced from this folder, directed in the same call
// and written to their own files, where their tts.js run finds them. Returns i -> [{ text, style }] for
// `lang`, one per sentence.
export function directions(args) {
  return oneAtATime(args.folder, () => direct(args));
}

async function direct({ folder, lang, blocks, arabic, effort = 'high', others = [], client }) {
  const delivery = existsSync(join(folder, 'delivery_imam.json'))
    ? new Map(JSON.parse(readFileSync(join(folder, 'delivery_imam.json'), 'utf8')).blocks.map(d => [d.i, d])) : new Map();
  const all = [{ lang, blocks }, ...others].map(({ lang: l, blocks: bs }) => {
    const path = join(folder, `tts_${l}_directions.json`);
    const kept = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { blocks: [] };
    const old = new Map(kept.blocks.map(b => [b.i, b]));
    return { lang: l, blocks: bs, path, kept, old, todo: bs.filter(b => old.get(b.i)?.text !== b.text) };
  });
  const need = all.filter(s => s.todo.length);
  if (!need.length) {
    console.log(`  directions: all ${blocks.length} blocks unchanged, kept from ${all[0].path}`);
    return new Map(blocks.map(b => [b.i, all[0].old.get(b.i).parts]));
  }
  const anthropic = client ?? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 600_000, maxRetries: 3 });
  const answers = [await ask(anthropic, need, arabic, delivery, effort)];
  // A language the answer left out (a refusal, an answer cut short, a language skipped) is asked alone.
  if (need.length > 1) for (const s of need.filter(s => !answers[0].got.get(s.lang).size)) {
    console.error(`  directions: no ${LANGUAGE(s.lang)} in the answer (${answers[0].stop}); asking for it alone`);
    answers.push(await ask(anthropic, [s], arabic, delivery, effort));
  }
  for (const a of answers) {
    const spent = a.usage.input_tokens * PRICE_IN + a.usage.output_tokens * PRICE_OUT;
    console.log(`  directions for ${a.langs.join(', ')} with ${MODEL} (${effort}): ${a.usage.input_tokens} in ($${(a.usage.input_tokens * PRICE_IN).toFixed(3)}) / ${a.usage.output_tokens} out ($${(a.usage.output_tokens * PRICE_OUT).toFixed(3)}), $${spent.toFixed(3)}`);
  }
  for (const s of need) {
    const a = answers.findLast(a => a.got.get(s.lang)?.size) ?? answers[0];
    const got = a.got.get(s.lang);
    if (!got.size) console.error(`  directions: no usable ${LANGUAGE(s.lang)} answer (${a.stop}); its blocks keep the base style`);
    let short = 0;
    for (const b of s.todo) {
      const ss = sentences(b.text, s.lang), st = got.get(b.i) ?? [];
      if (st.length !== ss.length) short++;
      s.old.set(b.i, { i: b.i, text: b.text, parts: ss.map((x, j) => ({ text: x, style: st[j] ?? st.at(-1) ?? null })) });
    }
    if (short) console.log(`  directions, ${LANGUAGE(s.lang)}: ${short} block(s) had a different number of notes than sentences (nearest note used)`);
    // Each language's file records the call that made its notes; a shared call's cost is split by sentences.
    const cost = (s.kept.cost_usd ?? 0) + answers.filter(x => x.langs.includes(s.lang))
      .reduce((n, x) => n + (x.usage.input_tokens * PRICE_IN + x.usage.output_tokens * PRICE_OUT) * x.share[x.langs.indexOf(s.lang)], 0);
    const lines = s.blocks.map(b => JSON.stringify(s.old.get(b.i)));
    writeFileSync(s.path, `{\n "model": ${JSON.stringify(MODEL)},\n "effort": ${JSON.stringify(effort)},\n` +
      (a.langs.length > 1 ? ` "call": ${JSON.stringify(a.langs)},\n` : '') +
      ` "input_tokens": ${a.usage.input_tokens},\n "output_tokens": ${a.usage.output_tokens},\n "cost_usd": ${cost.toFixed(4)},\n "blocks": [\n  ${lines.join(',\n  ')}\n ]\n}\n`);
  }
  return new Map(blocks.map(b => [b.i, all[0].old.get(b.i).parts]));
}
