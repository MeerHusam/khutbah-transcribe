#!/usr/bin/env python3
# tts_kokoro.py — Speak a khutbah's English blocks with Kokoro-82M (free, open weights,
# runs locally). Called by tts.js, like transcribe_local.py is called by pipeline.js.
#
# Reads JSON from stdin: { model, voices, voice, speed, lang, block_pause, sentence_pause,
#   lexicon, out, blocks: [{ i, text }] }
# Arabic words listed in the lexicon (tts_lexicon.txt) are given their listed sounds; the rest
# of the text goes through Kokoro's own English phonemizer.
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


SUN_LETTERS = ('th', 'dh', 'sh', 't', 'd', 'r', 'z', 's', 'n', 'l')
WORD = re.compile(r"[A-Za-z][A-Za-z'’]*(?:-[A-Za-z][A-Za-z'’]*)*")


def load_lexicon(path, vocab):
    lex = {}
    for n, line in enumerate(open(path, encoding='utf-8'), 1):
        line = line.split('#', 1)[0].strip()
        if not line:
            continue
        word, sounds = line.split(None, 1)
        bad = [c for c in sounds.strip() if c not in vocab]
        if bad:
            print(f'  tts_lexicon.txt:{n} {word}: the voice has no sound {"".join(bad)!r}', file=sys.stderr)
        lex[word.lower()] = sounds.strip()
    return lex


def lookup(lex, word):
    w = word.replace('’', "'").lower()
    if w in lex:
        return lex[w]
    if w.endswith("'s") and w[:-2] in lex:
        return lex[w[:-2]] + 'z'
    if w.startswith('al-'):
        rest = lookup(lex, w[3:])
        if rest is None:
            return None
        # al- before a sun letter is said as a doubled letter: al-Tirmidhi → at-Tirmidhi.
        body = rest.lstrip('ˈˌ')
        sun = next((c for c in SUN_LETTERS if w[3:].startswith(c)), None)
        return ('ɑ' + body[0] if sun else 'ɑl') + rest
    if '-' in w:
        parts = [lookup(lex, p) for p in w.split('-')]
        return ''.join(parts) if all(parts) else None
    return None


def phonemes(kokoro, lex, text, lang):
    out, at = [], 0
    def flush(upto):
        seg = text[at:upto]
        if seg.strip():
            out.append(kokoro.tokenizer.phonemize(seg, lang))
    for m in WORD.finditer(text):
        sounds = lookup(lex, m.group())
        if sounds is None:
            continue
        flush(m.start())
        out.append(sounds)
        at = m.end()
    flush(len(text))
    # Punctuation stays attached to its word.
    joined = ''
    for p in out:
        joined += p if (not joined or p[0] in ',.;:!?”)' or joined[-1] in '“(') else ' ' + p
    return joined


def main():
    job = json.load(sys.stdin)
    kokoro = Kokoro(job['model'], job['voices'])
    lex = load_lexicon(job['lexicon'], kokoro.tokenizer.vocab) if job.get('lexicon') else {}
    lang = job.get('lang', 'en-us')
    sr = 24000
    block_gap = np.zeros(int(sr * job.get('block_pause', 0.7)), dtype=np.float32)
    sentence_gap = np.zeros(int(sr * job.get('sentence_pause', 0.2)), dtype=np.float32)

    parts, times, t = [], [], 0.0
    blocks = job['blocks']
    for n, block in enumerate(blocks):
        start = t
        for k, piece in enumerate(pieces(block['text'])):
            samples, sr = kokoro.create(phonemes(kokoro, lex, piece, lang), voice=job['voice'],
                                        speed=job.get('speed', 1.0), lang=lang, is_phonemes=True)
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
