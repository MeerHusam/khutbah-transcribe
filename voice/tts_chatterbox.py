#!/usr/bin/env python3
# tts_chatterbox.py — Speak a khutbah's English blocks with Chatterbox (Resemble AI, MIT
# licence, runs locally) in the voice of a reference clip. The clip carries the accent: a
# speaker who says Allah and Muhammad the Arabic way gives the voice that way of saying them.
# Called by tts.js --engine chatterbox.
#
# Job (tts_common.py) plus: { ref, exaggeration, cfg_weight, device }
#   ref: a clean clip of the speaker, 10-12 s (only the first 10 s is used).
#   exaggeration: 0.5 is neutral, higher is more intense. cfg_weight: lower is slower, calmer.
# Chatterbox marks its audio with an inaudible watermark (Perth), so it can be shown to be AI.
#
# Needs its own environment (torch; kept apart from .venv):
#   python3.12 -m venv .venv-tts && ./.venv-tts/bin/pip install "setuptools<81" wheel chatterbox-tts
#   (setuptools 81+ has no pkg_resources, which its watermarker needs)
# The model (~3 GB) downloads from Hugging Face on first use.

import sys

import torch
from chatterbox.tts import ChatterboxTTS

from tts_common import read_job, run


def main():
    job = read_job()
    device = job.get('device') or ('mps' if torch.backends.mps.is_available() else 'cpu')
    print(f'  loading Chatterbox on {device}...', file=sys.stderr, flush=True)
    model = ChatterboxTTS.from_pretrained(device=device)
    model.prepare_conditionals(job['ref'], exaggeration=job.get('exaggeration', 0.5))

    def speak(piece):
        wav = model.generate(piece, exaggeration=job.get('exaggeration', 0.5),
                             cfg_weight=job.get('cfg_weight', 0.5))
        return wav.squeeze(0).numpy()

    run(job, speak, model.sr)


if __name__ == '__main__':
    main()
