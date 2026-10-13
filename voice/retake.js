// retake.js — Whether a voiced passage is voiced again (tts_gemini.mjs). Whisper hears each passage
// back (Groq, free); one it hears less than 85% of, or 25% more words than were written, is voiced
// again, up to three takes, the best kept. Since 11 Oct 2026 not when the passage is short (under 40
// words the share is too coarse: on 9 Oct a 5-second passage was voiced three times at 82%), and not
// after a retake that heard no more than the take before it (the shortfall is then Whisper's, a name
// it spells its own way, not the voice's). In the logs to 11 Oct retakes were 6% of the audio.
export const SHORT_WORDS = 40;

// Words compared loosely: Whisper writes Urdu its own way (مسلمانوں for مسلمانو, ي for ی).
export const looseWords = t => t.normalize('NFC').replace(/[ً-ٰٟٔں]/g, '')
  .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[ةه]/g, 'ہ')
  .replace(/[^\p{L}\p{N}\s]/gu, ' ').toLowerCase().split(/\s+/).filter(Boolean);

// What Whisper heard of a passage's text: said, the share of the written words it heard (in order);
// extra, how many words it heard for each written one.
export function heardShare(text, heard) {
  const a = looseWords(text), b = looseWords(heard);
  let prev = new Array(b.length + 1).fill(0);
  for (const x of a) {
    const row = [0];
    for (let j = 1; j <= b.length; j++) row[j] = x === b[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], row[j - 1]);
    prev = row;
  }
  return { said: prev[b.length] / Math.max(1, a.length), extra: b.length / Math.max(1, a.length) };
}

// A take's score, to keep the best of the takes: the share heard, less what was heard beyond the text.
export const scoreOf = share => (share ? share.said - Math.max(0, share.extra - 1.15) : 1);

// take: the take just made (1-3); words: the passage's words; share: what Whisper heard (heardShare)
// or null when it was not checked; score: this take's score; before: the previous take's score, or null.
export function retake({ take, words, share, score, before = null }) {
  if (take >= 3 || !share) return false;
  if (share.said >= 0.85 && share.extra <= 1.25) return false;
  if (words < SHORT_WORDS) return false;
  if (before != null && score <= before + 0.02) return false;
  return true;
}

// ── Speech the text does not have (13 Oct 2026) ──────────────────────────────────────────────────
// On 2 Oct the English voice said an Arabic sentence at 2:40 that is in neither the khutbah nor the
// text it was sent ("وأردنا أن ننوه هنا بمنزلة الصحابة وفضلهم", 5 s). Whisper, asked for English, left
// it out of a 3-minute passage, so the check above cannot see it. The aligner can: it times every
// written word, and speech it could not give to any written word is a stretch of voice between two of
// them. In the 14 khutbahs published by 13 Oct an ordinary pause between two words held at most
// 0.42 s of voice (a breath); the made-up sentence 4.4 s. A passage with MADE_UP_SECONDS or more of
// voice between two of its words (or before its first, or after its last) is voiced again.
export const MADE_UP_SECONDS = 1.5;
export const GAP_SECONDS = 1.2;   // shorter silences between words are not looked at
const FRAME = 0.02;               // seconds

// samples: the track (16-bit mono PCM, a Buffer or Int16Array) at rate sr; words: [[word, start, end], …] in the track,
// in order; from, to: the passage's span in the track. The stretch with the most voice that no written word was given,
// if it holds MADE_UP_SECONDS or more: { seconds, from, to, after, before } (the words either side), else null.
export function madeUpSpeech(samples, sr, words, from, to) {
  const pcm = samples instanceof Int16Array ? samples
    : new Int16Array(samples.buffer.slice(samples.byteOffset, samples.byteOffset + samples.length - (samples.length % 2)));
  const step = Math.round(sr * FRAME), first = Math.max(0, Math.floor(from / FRAME)), last = Math.min(Math.floor(pcm.length / step), Math.ceil(to / FRAME));
  const rms = new Float64Array(Math.max(0, last - first));
  for (let f = first; f < last; f++) {
    let sum = 0;
    for (let i = f * step; i < (f + 1) * step; i++) sum += pcm[i] * pcm[i];
    rms[f - first] = Math.sqrt(sum / step);
  }
  // loud enough to be voice: a tenth of the passage's middle speech level (frames above a floor of 200)
  const speech = [...rms].filter(r => r > 200).sort((a, b) => a - b);
  if (!speech.length) return null;
  const level = speech[speech.length >> 1] / 10;
  const voiceIn = (a, z) => {
    let n = 0;
    for (let f = Math.max(first, Math.floor(a / FRAME)); f < Math.min(last, Math.ceil(z / FRAME)); f++) if (rms[f - first] > level) n++;
    return n * FRAME;
  };
  const gaps = [[from, words[0]?.[1] ?? to, null, words[0]?.[0] ?? null]];
  for (let k = 1; k < words.length; k++) gaps.push([words[k - 1][2], words[k][1], words[k - 1][0], words[k][0]]);
  if (words.length) gaps.push([words.at(-1)[2], to, words.at(-1)[0], null]);
  let worst = null;
  for (const [a, z, after, before] of gaps) {
    if (z - a < GAP_SECONDS) continue;
    const seconds = voiceIn(a, z);
    if (seconds >= MADE_UP_SECONDS && (!worst || seconds > worst.seconds)) worst = { seconds: Math.round(seconds * 100) / 100, from: a, to: z, after, before };
  }
  return worst;
}
