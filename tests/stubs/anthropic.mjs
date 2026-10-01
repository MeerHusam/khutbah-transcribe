// Stand-in for @anthropic-ai/sdk in tests (loaded by register.mjs). The analysis call (a stream)
// answers with the JSON in STUB_ANALYSIS; every other call answers "null", which callers treat
// as no answer and do not cache. Nothing is sent anywhere.
import { readFileSync } from 'fs';

const reply = text => ({ content: [{ type: 'text', text }], usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: 'end_turn' });
const noAnswer = async () => reply('null');

export default class Anthropic {
  constructor() {
    this.messages = {
      stream: () => ({ on() { return this; }, finalMessage: async () => reply(readFileSync(process.env.STUB_ANALYSIS, 'utf8')) }),
      create: noAnswer,
    };
    this.beta = { messages: { create: noAnswer } };
  }
}
