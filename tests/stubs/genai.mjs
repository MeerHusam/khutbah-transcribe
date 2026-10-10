// Stand-in for @google/genai in tests (loaded by register.mjs). A block translation request
// (core/translate.js) is answered from STUB_GEMINI_ANSWERS, a JSON file whose translations[i] is
// chunk i's text (reports/blindtest-2026-10-10/out/*.json), or with "gemini <i>" without one; a chunk
// the file has no text for is left out of the answer. A request that includes a chunk listed in
// STUB_GEMINI_FAIL ("13" or "13,30") comes back blocked; one with a chunk in STUB_GEMINI_CUT, asked at
// HIGH thinking, is cut at the token limit with its reasoning as unflagged text (Gemini 3 Flash's
// thinking loop). Anything else gets no text. Each answer starts with a thought part, which is not
// the answer. Nothing is sent anywhere.
import { readFileSync } from 'fs';

const answers = process.env.STUB_GEMINI_ANSWERS ? JSON.parse(readFileSync(process.env.STUB_GEMINI_ANSWERS, 'utf8')).translations : null;
const fail = new Set((process.env.STUB_GEMINI_FAIL ?? '').split(',').filter(Boolean).map(Number));
const cut = new Set((process.env.STUB_GEMINI_CUT ?? '').split(',').filter(Boolean).map(Number));
const usageMetadata = { promptTokenCount: 1000, candidatesTokenCount: 500, thoughtsTokenCount: 1500 };

export class GoogleGenAI {
  constructor() {
    this.models = {
      generateContent: async ({ contents, config }) => {
        const asked = String(contents).match(/^Translate chunks ([\d, ]+):/m)?.[1].split(', ').map(Number) ?? [];
        if (asked.some(i => fail.has(i))) return { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' }, usageMetadata: { promptTokenCount: 1000 } };
        if (asked.some(i => cut.has(i)) && config?.thinkingConfig?.thinkingLevel === 'HIGH') {
          return { candidates: [{ content: { parts: [{ text: 'Wait, let me check that chunk again. Wait,' }] }, finishReason: 'MAX_TOKENS' }],
            usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 10, thoughtsTokenCount: (config.maxOutputTokens ?? 0) - 10 } };
        }
        const field = config?.responseJsonSchema?.properties?.translations?.items?.required?.[1];
        const text = field ? JSON.stringify({ translations: asked.filter(i => !answers || answers[i]).map(i => ({ i, [field]: answers ? answers[i] : `gemini ${i}` })) }) : '';
        return { candidates: [{ content: { parts: [{ text: 'Thinking about it.', thought: true }, { text }] }, finishReason: 'STOP' }], usageMetadata };
      },
    };
  }
}
