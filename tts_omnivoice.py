#!/usr/bin/env python3
# tts_omnivoice.py — Speak a khutbah's blocks with OmniVoice (k2-fsa, Apache-2.0, runs
# locally) in the voice of a reference clip. Called by tts.js --engine omnivoice.
# Unlike Chatterbox it takes pronunciation overrides inline, as CMU codes in brackets
# ("[AA0 L AA1 HH]"), so the lexicon's Arabic names apply; and it speaks Urdu.
#
# Job (tts_common.py) plus: { ref, ref_text, language, lexicon?, device? }
#   ref_text: what is said in the reference clip, word for word.
#
# Needs its own environment:
#   python3.12 -m venv .venv-omni && ./.venv-omni/bin/pip install "setuptools<81" wheel omnivoice soundfile
# The model downloads from Hugging Face on first use.

import sys

import torch
from omnivoice import OmniVoice

from tts_common import WORD, ipa_to_arpabet, load_lexicon, lookup, read_job, run


def with_arpabet(text, lex):
    def tag(m):
        ipa = lookup(lex, m.group())
        return m.group() if ipa is None else f'[{ipa_to_arpabet(ipa)}]'
    return WORD.sub(tag, text)


def main():
    job = read_job()
    device = job.get('device') or ('mps' if torch.backends.mps.is_available() else 'cpu')
    print(f'  loading OmniVoice on {device}...', file=sys.stderr, flush=True)
    model = OmniVoice.from_pretrained('k2-fsa/OmniVoice', device_map=device)
    prompt = model.create_voice_clone_prompt(ref_audio=job['ref'], ref_text=job['ref_text'])
    lex = load_lexicon(job['lexicon']) if job.get('lexicon') else {}

    def speak(text):
        return model.generate(text=with_arpabet(text, lex) if lex else text,
                              language=job['language'], voice_clone_prompt=prompt)[0]

    run(job, speak, model.sampling_rate)


if __name__ == '__main__':
    main()
