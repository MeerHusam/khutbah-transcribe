#!/usr/bin/env python3
# align_words.py — When each word of a voice track is spoken, for word-by-word follow-along.
#
#   .venv-align/bin/python align_words.py outputs/<folder> ur      (or en)
#
# Reads tts_<lang>.mp3 and tts_<lang>.json (tts.js), and adds to each block of the JSON
#   "words": [[word, start, end], ...]   seconds into the mp3, one entry per word of its text.
# The page matches these words to the text it shows (which differs a little: "Allah says:"
# lead-ins, ﷺ read out in full).
#
# How: forced alignment. Meta's MMS aligner (a wav2vec2 model for 1,130 languages, run from
# models/mms_fa/model.onnx, on this machine; no API) is given each block's audio and the exact
# text the voice read, and finds where each word falls. The text is first written in Latin
# letters with uroman, which is what the model was trained on. Each block is aligned on its
# own, so an error cannot spread past it.
#
# Setup (once):
#   uv venv --python 3.12 .venv-align && VIRTUAL_ENV=.venv-align uv pip install ctc-forced-aligner uroman unidecode
#   curl -L -o models/mms_fa/model.onnx \
#     https://huggingface.co/deskpai/ctc_forced_aligner/resolve/main/04ac86b67129634da93aea76e0147ef3.onnx

import json
import re
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime
import uroman
from ctc_forced_aligner import Tokenizer, generate_emissions, get_alignments, get_spans, text_normalize

ROOT = Path(__file__).resolve().parent
MODEL = ROOT / 'models' / 'mms_fa' / 'model.onnx'
SR = 16000
FRAME = 0.02  # seconds per model frame (wav2vec2: 320 samples at 16 kHz)
ISO = {'en': 'eng', 'ur': 'urd', 'ar': 'ara'}
PAD = 0.15  # seconds of audio kept either side of a block


def load_audio(path):
    raw = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', str(path), '-ac', '1', '-ar', str(SR),
                          '-f', 's16le', '-'], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768


romanizer = uroman.Uroman()


def spelling(word, iso):
    """The word as the model's letters (a-z and '), e.g. ارشادِ -> "a r s h a d i"; '' if nothing is left."""
    norm = text_normalize(word, iso)
    latin = romanizer.romanize_string(norm, lcode=iso).lower() if norm else ''
    latin = re.sub(r"[^a-z']", '', latin)
    return ' '.join(latin)


def align_block(session, tokenizer, wave, start, end, text, iso):
    """[[word, start, end], ...] for the words of `text`, spoken in wave[start:end] (seconds)."""
    words = text.split()
    a = max(0, int((start - PAD) * SR))
    b = min(len(wave), int((end + PAD) * SR))
    clip = wave[a:b]
    offset = a / SR
    spelled = [spelling(w, iso) for w in words]
    keep = [k for k, s in enumerate(spelled) if s]
    if not keep:
        return [[w, round(start, 2), round(end, 2)] for w in words]
    emissions, _ = generate_emissions(session, clip, batch_size=1)
    tokens = []
    for k in keep:
        tokens += ['<star>', spelled[k]]
    segments, scores, blank = get_alignments(emissions, tokens, tokenizer)
    spans = get_spans(tokens, segments, blank)
    times = {}
    for n, k in enumerate(keep):
        span = spans[2 * n + 1]  # the word itself; the <star> before it takes any extra sound
        # The first and last frames of a span are the blank padding either side; the letters
        # are inside. Take the letters' own frames, so a word ends where its sound does.
        letters = [s for s in span if s.label != blank] or span
        s = offset + letters[0].start * FRAME
        e = offset + (letters[-1].end + 1) * FRAME
        times[k] = (s, e)
    # A word with no letters the model knows (a number, a sign) takes the gap it sits in.
    out, last_end = [], start
    for k, w in enumerate(words):
        if k in times:
            s, e = times[k]
        else:
            nxt = next((times[j][0] for j in range(k + 1, len(words)) if j in times), end)
            s, e = last_end, max(last_end, nxt)
        out.append([w, round(s, 2), round(e, 2)])
        last_end = e
    return out


def dump(manifest):
    """The manifest as JSON with one block per line, so it stays small and diffs block by block."""
    head = {k: v for k, v in manifest.items() if k != 'blocks'}
    blocks = ',\n  '.join(json.dumps(b, ensure_ascii=False) for b in manifest['blocks'])
    return json.dumps(head, ensure_ascii=False, indent=1)[:-2] + f',\n "blocks": [\n  {blocks}\n ]\n}}\n'


def main():
    if len(sys.argv) != 3 or sys.argv[2] not in ISO:
        sys.exit('usage: align_words.py outputs/<folder> en|ur')
    folder, lang = Path(sys.argv[1]), sys.argv[2]
    manifest_path = folder / f'tts_{lang}.json'
    manifest = json.loads(manifest_path.read_text())
    wave = load_audio(folder / manifest.get('audio', f'tts_{lang}.mp3'))
    session = onnxruntime.InferenceSession(str(MODEL), providers=['CPUExecutionProvider'])
    tokenizer = Tokenizer()
    began = time.time()
    blocks = manifest['blocks']
    for n, block in enumerate(blocks):
        block['words'] = align_block(session, tokenizer, wave, block['start'], block['end'], block['text'], ISO[lang])
        print(f'  block {n + 1}/{len(blocks)}  {time.time() - began:.0f} s', file=sys.stderr, flush=True)
    manifest['words_by'] = 'mms_fa'
    manifest_path.write_text(dump(manifest))
    print(f'Wrote words for {len(blocks)} blocks to {manifest_path} in {time.time() - began:.0f} s')


if __name__ == '__main__':
    main()
