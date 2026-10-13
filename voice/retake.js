// retake.js — Whether a voiced passage is voiced again (tts_gemini.mjs). Whisper hears each passage
// back (Groq, free); one it hears less than 85% of, or 25% more words than were written, is voiced
// again, up to three takes, the best kept. Since 11 Oct 2026 not when the passage is short (under 40
// words the share is too coarse: on 9 Oct a 5-second passage was voiced three times at 82%), and not
// after a retake that heard no more than the take before it (the shortfall is then Whisper's, a name
// it spells its own way, not the voice's). In the logs to 11 Oct retakes were 6% of the audio.
// Since 13 Oct 2026 also when the voice says something the text does not have: Whisper hears at least
// ADDED_WORDS more words in one place than were written there (2 Oct, English, 2:40: the voice said an
// Arabic sentence that is in neither the khutbah nor the text sent, 8 words in a passage of 5 minutes,
// about 1% more words, which the share above lets through), however long or short the passage.
export const SHORT_WORDS = 40;
export const ADDED_WORDS = 5;

// Words compared loosely: Whisper writes Urdu its own way (مسلمانوں for مسلمانو, ي for ی).
export const looseWords = t => t.normalize('NFC').replace(/[ً-ٰٟٔں]/g, '')
  .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[ةه]/g, 'ہ')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ').toLowerCase().split(/\s+/).filter(Boolean);

// What Whisper heard of a passage's text: said, the share of the written words it heard (in order);
// extra, how many words it heard for each written one; added, the most words it heard in one place
// beyond what was written there (between two words heard as written, the words heard there less the
// words written there), and addedText, those words. A word heard another way (a name spelled its own
// way) stands in for the written one and adds nothing.
export function heardShare(text, heard) {
  const a = looseWords(text), b = looseWords(heard), n = a.length, m = b.length;
  const T = new Int32Array((n + 1) * (m + 1)), at = (i, j) => i * (m + 1) + j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) T[at(i, j)] = a[i - 1] === b[j - 1] ? T[at(i - 1, j - 1)] + 1 : Math.max(T[at(i - 1, j)], T[at(i, j - 1)]);
  }
  const pairs = [[n, m]];
  for (let i = n, j = m; i > 0 && j > 0;) {
    if (a[i - 1] === b[j - 1]) { pairs.push([i - 1, j - 1]); i--; j--; }
    else if (T[at(i - 1, j)] >= T[at(i, j - 1)]) i--;
    else j--;
  }
  pairs.push([-1, -1]);
  pairs.reverse();
  let added = 0, addedText = '';
  for (let k = 1; k < pairs.length; k++) {
    const [i1, j1] = pairs[k - 1], [i2, j2] = pairs[k];
    const more = (j2 - j1 - 1) - (i2 - i1 - 1);
    if (more > added) { added = more; addedText = b.slice(j1 + 1, j2).join(' '); }
  }
  return { said: T[at(n, m)] / Math.max(1, n), extra: m / Math.max(1, n), added, addedText };
}

// A take's score, to keep the best of the takes: the share heard, less what was heard beyond the text.
export const scoreOf = share => (share ? share.said - Math.max(0, share.extra - 1.15) - ((share.added ?? 0) >= ADDED_WORDS ? 0.1 : 0) : 1);

// take: the take just made (1-3); words: the passage's words; share: what Whisper heard (heardShare)
// or null when it was not checked; score: this take's score; before: the previous take's score, or null.
export function retake({ take, words, share, score, before = null }) {
  if (take >= 3 || !share) return false;
  const added = (share.added ?? 0) >= ADDED_WORDS;
  if (!added && share.said >= 0.85 && share.extra <= 1.25) return false;
  if (!added && words < SHORT_WORDS) return false;
  if (before != null && score <= before + 0.02) return false;
  return true;
}
