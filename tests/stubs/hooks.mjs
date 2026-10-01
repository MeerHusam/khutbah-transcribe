// Module hooks: '@anthropic-ai/sdk' resolves to the stub next to this file.
const stubs = { '@anthropic-ai/sdk': new URL('./anthropic.mjs', import.meta.url).href };

export async function resolve(specifier, context, next) {
  return stubs[specifier] ? { url: stubs[specifier], shortCircuit: true } : next(specifier, context);
}
