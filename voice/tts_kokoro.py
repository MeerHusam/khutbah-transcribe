#!/usr/bin/env python3
# tts_kokoro.py — Speak a khutbah's English blocks with Kokoro-82M (free, open weights,
# runs locally). Called by tts.js, like transcribe_local.py is called by pipeline.js.
#
# Job (tts_common.py) plus: { model, voices, voice, speed, lang, lexicon }
# Arabic words listed in the lexicon (tts_lexicon.txt) are given their listed sounds; the rest
# of the text goes through Kokoro's own English phonemizer.
#
# Needs the project .venv:  ./.venv/bin/pip install kokoro-onnx soundfile
# and the model files in models/kokoro/ (see tts.js).

import re
import sys

from kokoro_onnx import Kokoro

from tts_common import WORD, load_lexicon, lookup, read_job, run


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
    job = read_job()
    kokoro = Kokoro(job['model'], job['voices'])
    lex = load_lexicon(job['lexicon'], kokoro.tokenizer.vocab) if job.get('lexicon') else {}
    lang = job.get('lang', 'en-us')

    def speak(piece):
        samples, _ = kokoro.create(phonemes(kokoro, lex, piece, lang), voice=job['voice'],
                                   speed=job.get('speed', 1.0), lang=lang, is_phonemes=True)
        return samples

    run(job, speak, 24000)


if __name__ == '__main__':
    main()
