// Stand-in for @anthropic-ai/sdk in tests (loaded by register.mjs). The analysis call (a stream)
// answers with the JSON in STUB_ANALYSIS; every other call answers "null", which callers treat
// as no answer and do not cache. With STUB_TRANSLATE set, core/translate.js's requests are answered
// too: the blocks asked for ("opus <i>") and its extras (summaries, no hadith). Nothing is sent anywhere.
import { readFileSync } from 'fs';

const reply = (text, usage = { input_tokens: 0, output_tokens: 0 }) => ({ content: [{ type: 'text', text }], usage, stop_reason: 'end_turn' });
const noAnswer = async () => reply('null');

async function beta(params) {
  const props = params.output_config?.format?.schema?.properties ?? {};
  if (!process.env.STUB_TRANSLATE || !(props.translations || props.share_summary)) return reply('null');
  const usage = { input_tokens: 1000, output_tokens: 500 };
  if (props.share_summary) return reply(JSON.stringify({ share_summary: 'stub', summary: 'stub', hadith: [], ...(props.surahs ? { surahs: [] } : {}) }), usage);
  const field = props.translations.items.required[1];
  const asked = String(params.messages[0].content).match(/^Translate chunks ([\d, ]+):/m)?.[1].split(', ').map(Number) ?? [];
  return reply(JSON.stringify({ translations: asked.map(i => ({ i, [field]: `opus ${i}` })) }), usage);
}

export default class Anthropic {
  constructor() {
    this.messages = {
      stream: () => ({ on() { return this; }, finalMessage: async () => reply(readFileSync(process.env.STUB_ANALYSIS, 'utf8')) }),
      create: noAnswer,
    };
    this.beta = { messages: { create: beta } };
  }
}
