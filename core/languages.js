// languages.js — The languages a khutbah is translated into besides English (5 Oct 2026). Each is one
// file in core/langs/ holding everything that differs: names, script and font, the published Quran and
// hadith editions, the voice, the page's words and the prompts. A new language is a file there and a
// line here; the scripts, the voice, the site and the page read it from this list.
import ur from './langs/ur.js';
import bn from './langs/bn.js';

export const LANGS = [ur, bn];
export const langOf = code => LANGS.find(L => L.code === code);

// What the reader page needs to show a language (sent with the khutbah; no prompts, no functions).
export const forPage = L => ({
  code: L.code, name: L.name, native: L.native, field: L.field, dir: L.dir, font: L.font,
  digits: L.digits, localBadgeDigits: !!L.localBadgeDigits, clause: L.clause, clauseMinWords: L.clauseMinWords,
  ui: L.ui, collections: L.collections, bothSahihs: L.bothSahihs, honorifics: L.honorifics,
});

// The value of a flag (--lang ur) and the first argument that is neither a flag nor a flag's value.
export function cliArgs(args, valueFlags = ['--lang', '--batch', '--chunks', '--rounds']) {
  const opt = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const folder = args.find((a, i) => !a.startsWith('--') && !valueFlags.includes(args[i - 1]));
  return { opt, folder };
}
