#!/usr/bin/env python3
# tts_kokoro.py — Speak a khutbah's English blocks with Kokoro-82M (free, open weights,
# runs locally). Called by tts.js, like transcribe_local.py is called by pipeline.js.
#
# Reads JSON from stdin: { model, voices, voice, speed, lang, block_pause, sentence_pause,
#   out, blocks: [{ i, text }] }
# Writes one WAV (out) with every block in order, separated by block_pause seconds, and
# prints [{ i, start, end }] (seconds into the WAV) as JSON on stdout. Progress goes to stderr.
#
# Needs the project .venv:  ./.venv/bin/pip install kokoro-onnx soundfile
# and the model files in models/kokoro/ (see tts.js).

import json
import re
import sys

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

# Kokoro reads one piece of at most ~510 phonemes at a time; cutting at sentence ends keeps
# its intonation natural instead of breaking mid-clause where the model's limit falls.
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


def main():
    job = json.load(sys.stdin)
    kokoro = Kokoro(job['model'], job['voices'])
    sr = 24000
    block_gap = np.zeros(int(sr * job.get('block_pause', 0.7)), dtype=np.float32)
    sentence_gap = np.zeros(int(sr * job.get('sentence_pause', 0.2)), dtype=np.float32)

    parts, times, t = [], [], 0.0
    blocks = job['blocks']
    for n, block in enumerate(blocks):
        start = t
        for k, piece in enumerate(pieces(block['text'])):
            samples, sr = kokoro.create(piece, voice=job['voice'], speed=job.get('speed', 1.0),
                                        lang=job.get('lang', 'en-us'))
            if k:
                parts.append(sentence_gap)
                t += len(sentence_gap) / sr
            parts.append(samples.astype(np.float32))
            t += len(samples) / sr
        times.append({'i': block['i'], 'start': round(start, 2), 'end': round(t, 2)})
        parts.append(block_gap)
        t += len(block_gap) / sr
        print(f'  block {n + 1}/{len(blocks)}  {t / 60:.1f} min', file=sys.stderr, flush=True)

    sf.write(job['out'], np.concatenate(parts) if parts else np.zeros(1, dtype=np.float32), sr)
    json.dump(times, sys.stdout)


if __name__ == '__main__':
    main()
