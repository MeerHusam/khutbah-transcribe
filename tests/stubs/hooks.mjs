// Module hooks: '@anthropic-ai/sdk' and '@google/genai' resolve to the stubs next to this file.
const stubs = {
  '@anthropic-ai/sdk': new URL('./anthropic.mjs', import.meta.url).href,
  '@google/genai': new URL('./genai.mjs', import.meta.url).href,
};

export async function resolve(specifier, context, next) {
  return stubs[specifier] ? { url: stubs[specifier], shortCircuit: true } : next(specifier, context);
}
