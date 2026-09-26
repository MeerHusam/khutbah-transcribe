// Reader-chunk assembly — shared by server.js (what the site serves) and
// verify_reader.js (the gate). Both must see identical chunks and identical timings, so
// this lives in one module rather than being duplicated.

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Maps each transcript word to the start time of the Whisper segment it belongs to.
export function buildWordTimeMap(segments) {
  const wordTimes = [];
  for (const seg of segments) {
    const words = seg.text.trim().split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) wordTimes.push(seg.start);
  }
  return wordTimes;
}

// `readerRawOverride` lets the test runner check a reader rebuilt in memory with the
// current code instead of the reader.txt on disk.
export function loadResult(folder, readerRawOverride = null) {
  const result = JSON.parse(readFileSync(join(__dirname, folder, 'result.json'), 'utf8'));
  try {
    const readerRaw = readerRawOverride ?? readFileSync(join(__dirname, folder, 'reader.txt'), 'utf8');
    // A paragraph is Arabic-dominant if >40% of its word chars are Arabic Unicode
    const isArabicDominant = s => {
      const total = s.replace(/\s/g, '').length;
      if (!total) return false;
      const arChars = (s.match(/[؀-ۿ]/g) || []).length;
      return arChars / total > 0.4;
    };
    const chunks = readerRaw
      .split(/─{20,}/)
      .map(block => {
        return block.replace(/^ANNOTATED READER VIEW\s*=+\s*/i, '').trim();
      })
      .filter(Boolean)
      .map(block => {
        const paras = block.split(/\n\n+/).map(p => p.trim()).filter(Boolean);
        const arabicParas = paras.filter(p => isArabicDominant(p));
        const englishParas = paras.filter(p => !isArabicDominant(p));
        return {
          arabic: arabicParas.join(' '),
          english: englishParas.join('\n\n')
        };
      })
      .filter(c => c.arabic && c.english);

    // Attach start_time by searching for each chunk's leading Arabic words in the transcript.
    // This is more robust than a sequential pcm counter: Hadith overlap and zone-boundary
    // edge cases caused the counter to drift 3-4 entries off, producing timestamps 30-40s late.
    // Prefer word-level timestamps (transcript_words) — each word carries its own real audio
    // time. Fall back to segment start times for older runs that lack word-level data.
    let tWords, wordTimes;
    if (result.transcript_words && result.transcript_words.length) {
      tWords = result.transcript_words.map(w => w.word);
      wordTimes = result.transcript_words.map(w => w.start);
    } else if (result.transcript_segments && result.transcript_segments.length) {
      const segments = result.transcript_segments;
      wordTimes = buildWordTimeMap(segments);
      tWords = [];
      for (const seg of segments) tWords.push(...seg.text.trim().split(/\s+/).filter(Boolean));
    }
    // Word times must never go backwards. In --gemini mode the times come from aligning
    // Gemini's words onto Groq's word-level timestamps, and around an alignment gap a later
    // word can be handed an earlier time than the one before it. A chunk starting on such a
    // word then gets a start_time before the previous chunk's, so following the audio jumps
    // backwards mid-khutbah and a block looks skipped. Clamp to a running maximum: the
    // affected words are a fraction of a second out, so this costs nothing in accuracy.
    if (wordTimes && wordTimes.length) {
      let maxSoFar = -Infinity;
      wordTimes = wordTimes.map(t => {
        if (typeof t !== 'number' || Number.isNaN(t)) return maxSoFar === -Infinity ? 0 : maxSoFar;
        maxSoFar = Math.max(maxSoFar, t);
        return maxSoFar;
      });
    }
    if (tWords && tWords.length) {
      // Normalize to bare Arabic letters so punctuation/parens/diacritics in Quran cards
      // (e.g. "(خير") don't block the match against plain transcript tokens.
      const stripPunct = w => w.replace(/[ً-ْٰـ]/g, '').replace(/[^ء-ي]/g, '');
      const ntWords = tWords.map(stripPunct);

      // First index >= fromWord where `needleWords` (a prefix/suffix slice) matches.
      function findSeq(needleWords, fromWord, maxWord) {
        const n = needleWords.length;
        if (!n) return -1;
        const hi = Math.min(maxWord ?? ntWords.length - n, ntWords.length - n);
        for (let i = fromWord; i <= hi; i++) {
          if (needleWords.every((w, j) => ntWords[i + j] === w)) return i;
        }
        return -1;
      }

      // Match each chunk to its real span in the transcript. start = first occurrence of the
      // leading words (>= cursor). The cursor then advances to where the chunk actually ENDS
      // (located via its trailing words), not by its display word count — Hadith text is
      // duplicated across reader chunks (signal-phrase chunk + Hadith card), so counting its
      // words would push the cursor past the real position and the forward search could never
      // recover. End-anchoring keeps the cursor on the true transcript position.
      let cursor = 0;
      for (const chunk of chunks) {
        const cw = chunk.arabic.split(/\s+/).map(stripPunct).filter(Boolean);
        let ws = -1;
        for (const len of [6, 4, 3]) {
          if (cw.length < len) continue;
          ws = findSeq(cw.slice(0, len), cursor);
          if (ws >= 0) break;
        }
        if (ws < 0) ws = cursor; // safe fallback
        chunk.start_time = Math.round(wordTimes[Math.min(ws, wordTimes.length - 1)] * 10) / 10;

        // Advance cursor to the chunk's trailing words (its end), searched in a bounded window
        // so duplicated text shrinks the span instead of inflating it.
        let we = ws + 1;
        const tail = cw.slice(-3);
        if (tail.length === 3) {
          const te = findSeq(tail, ws, ws + cw.length + 15);
          if (te >= 0) we = te + 3;
        }
        // Advance past most of this chunk, not merely one word. When the trailing-word
        // search fails the cursor barely moved, so the NEXT chunk's prefix could match a
        // repeated phrase inside this chunk and be handed a start time from the middle of
        // it — two chunks then resolve to nearly the same moment and the earlier one flashes
        // past unread. 60% of the chunk's length is a floor that guarantees real progress
        // while still tolerating the duplication that made end-anchoring necessary here.
        cursor = Math.max(ws + 1, we, ws + Math.floor(cw.length * 0.6));
      }

      // Chunk start times must be STRICTLY increasing, not merely non-decreasing. The
      // player highlights the last chunk whose start_time is <= the current time, so two
      // chunks sharing a time make the earlier one unreachable — it is never highlighted
      // and the reader appears to skip it. Clamping the word times to a running maximum
      // (above) removes backward jumps but can leave two chunks on the same value, so
      // separate them here by a tenth of a second.
      // Where a chunk's time is not greater than the previous chunk's, its anchor word sits
      // in a stretch the aligner filled in backwards, so the value itself is wrong rather
      // than merely out of order — nudging it a tenth of a second past its neighbour makes
      // it reachable but leaves it tens of seconds early, so the block still flashes past.
      // Interpolate the bad run between the last trustworthy time and the next one instead,
      // weighted by how many words each block holds.
      for (let i = 1; i < chunks.length; i++) {
        if (typeof chunks[i].start_time !== 'number') continue;
        if (chunks[i].start_time > chunks[i - 1].start_time) continue;
        let j = i;
        while (j < chunks.length && chunks[j].start_time <= chunks[i - 1].start_time) j++;
        const t0 = chunks[i - 1].start_time;
        const t1 = j < chunks.length ? chunks[j].start_time : t0 + (j - i + 1);
        const lens = [];
        for (let k = i - 1; k < j; k++) lens.push(Math.max(1, chunks[k].arabic.split(/\s+/).filter(Boolean).length));
        const total = lens.reduce((a, b) => a + b, 0);
        let acc = 0;
        for (let k = i; k < j; k++) {
          acc += lens[k - i];
          chunks[k].start_time = Math.round((t0 + (t1 - t0) * (acc / total)) * 10) / 10;
        }
        i = j - 1;
      }
    }

    // Flag the chunk that begins the second khutbah (so the UI can render a divider before it).
    if (result.second_khutbah && chunks.length) {
      const sk = result.second_khutbah;
      const sp = w => w.replace(/[ً-ْٰـ]/g, '').replace(/[^ء-ي]/g, '');
      let target = -1;

      // 1) Prefer the chunk whose Arabic STARTS with the marker phrase. After the straddling
      //    chunk has been split (clean case) the second-khutbah chunk begins exactly with it.
      //    `startsWith` (not `includes`) avoids matching Khutbah 1's chunk that merely contains it.
      if (sk.marker_text) {
        const needle = sp(sk.marker_text.split(/\s+/).slice(0, 6).join('')).slice(0, 14);
        if (needle) target = chunks.findIndex(c => sp(c.arabic.split(/\s+/).slice(0, 8).join('')).startsWith(needle));
      }
      // 2) Fall back to the chunk whose start_time is NEAREST the split time (mid-chunk boundary
      //    when the split didn't happen, or older data). Nearest — not first ≥ — so a chunk that
      //    starts a hair before the boundary isn't picked over the real one.
      if (target < 0 && typeof sk.time === 'number' && chunks.some(c => typeof c.start_time === 'number')) {
        let bestD = Infinity;
        chunks.forEach((c, i) => {
          if (typeof c.start_time === 'number') {
            const d = Math.abs(c.start_time - sk.time);
            if (d < bestD) { bestD = d; target = i; }
          }
        });
      }
      if (target >= 0) chunks[target].second_khutbah_start = true;
    }

    result.reader_chunks = chunks;
  } catch (_) {}
  return result;
}
