// retake.js — Whether a voiced passage is voiced again (tts_gemini.mjs). Whisper hears each passage
// back (Groq, free); one it hears less than 85% of, or 25% more words than were written, is voiced
// again, up to three takes, the best kept. Since 11 Oct 2026 not when the passage is short (under 40
// words the share is too coarse: on 9 Oct a 5-second passage was voiced three times at 82%), and not
// after a retake that heard no more than the take before it (the shortfall is then Whisper's, a name
// it spells its own way, not the voice's). In the logs to 11 Oct retakes were 6% of the audio.
export const SHORT_WORDS = 40;

// take: the take just made (1-3); words: the passage's words; share: what Whisper heard ({ said, extra })
// or null when it was not checked; score: this take's score; before: the previous take's score, or null.
export function retake({ take, words, share, score, before = null }) {
  if (take >= 3 || !share) return false;
  if (share.said >= 0.85 && share.extra <= 1.25) return false;
  if (words < SHORT_WORDS) return false;
  if (before != null && score <= before + 0.02) return false;
  return true;
}
