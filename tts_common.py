# tts_common.py — The part of the English voice that does not depend on the model: split each
# block into sentence-sized pieces, speak them in order, and write one WAV with each block's
# start and end. tts_kokoro.py and tts_chatterbox.py each supply only `speak(piece)`; they run
# in different environments (.venv and .venv-tts), so this file imports nothing heavy.
#
# Job (JSON on stdin, written by tts.js): { block_pause, sentence_pause, out,
#   blocks: [{ i, text }], ...engine options }
# Prints [{ i, start, end }] (seconds into the WAV) as JSON, the last line on stdout; progress
# on stderr.

import json
import re
import sys
import time

import numpy as np
import soundfile as sf

# Models speak one short piece at a time (Kokoro ~510 phonemes, Chatterbox ~40 s of audio);
# cutting at sentence ends keeps the intonation natural instead of breaking mid-clause.
MAX_CHARS = 280


def pieces(text):
    sentences = re.split(r'(?<=[.!?;:])\s+', text.strip())
    out = []
    for s in sentences:
        while len(s) > MAX_CHARS:
            cut = s.rfind(', ', 0, MAX_CHARS)
            if cut < MAX_CHARS // 3:
                cut = s.rfind(' ', 0, MAX_CHARS)
            out.append(s[:cut + 1].strip())
            s = s[cut + 1:].strip()
        if s:
            out.append(s)
    return out


def read_job():
    return json.load(sys.stdin)


def run(job, speak, sr):
    """speak(piece) -> float32 samples at `sr`."""
    block_gap = np.zeros(int(sr * job.get('block_pause', 0.7)), dtype=np.float32)
    sentence_gap = np.zeros(int(sr * job.get('sentence_pause', 0.2)), dtype=np.float32)
    parts, times, t = [], [], 0.0
    blocks = job['blocks']
    began = time.time()
    for n, block in enumerate(blocks):
        start = t
        for k, piece in enumerate(pieces(block['text'])):
            samples = np.asarray(speak(piece), dtype=np.float32).reshape(-1)
            if k:
                parts.append(sentence_gap)
                t += len(sentence_gap) / sr
            parts.append(samples)
            t += len(samples) / sr
        times.append({'i': block['i'], 'start': round(start, 2), 'end': round(t, 2)})
        parts.append(block_gap)
        t += len(block_gap) / sr
        print(f'  block {n + 1}/{len(blocks)}  {t / 60:.1f} min of audio in {(time.time() - began) / 60:.1f} min',
              file=sys.stderr, flush=True)
    sf.write(job['out'], np.concatenate(parts) if parts else np.zeros(1, dtype=np.float32), sr)
    print('\n' + json.dumps(times), flush=True)
