# tts_common.py — The part of the English voice that does not depend on the model: split each
# block into sentence-sized pieces, speak them in order, and write one WAV with each block's
# start and end. tts_kokoro.py and tts_chatterbox.py each supply only `speak(piece)`; they run
# in different environments (.venv and .venv-tts), so this file imports nothing heavy.
#
# Job (JSON on stdin, written by tts.js): { block_pause, sentence_pause, out,
#   blocks: [{ i, text, pause_before? }], whole_blocks?, ...engine options }
# pause_before (seconds): silence before a block, e.g. between the two khutbahs.
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


# ── Pronunciation list (tts_lexicon.txt): Arabic words and their sounds in espeak-style IPA.

SUN_LETTERS = ('th', 'dh', 'sh', 't', 'd', 'r', 'z', 's', 'n', 'l')
WORD = re.compile(r"[A-Za-z][A-Za-z'’]*(?:-[A-Za-z][A-Za-z'’]*)*")


def load_lexicon(path, vocab=None):
    lex = {}
    for n, line in enumerate(open(path, encoding='utf-8'), 1):
        line = line.split('#', 1)[0].strip()
        if not line:
            continue
        word, sounds = line.split(None, 1)
        bad = [c for c in sounds.strip() if vocab is not None and c not in vocab]
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



# The same sounds in CMU (ARPAbet) codes, for engines that take English phonemes only
# (OmniVoice: "[AA0 L AA1 HH]"). ARPAbet has no q, kh or doubled letters, so those become
# their nearest English sound; the stress and full vowels, which carry most of it, stay.
_ARPA = [('ddʒ', 'JH'), ('dʒ', 'JH'), ('ttʃ', 'CH'), ('tʃ', 'CH'), ('eɪ', 'EY'), ('oʊ', 'OW'),
         ('aɪ', 'AY'), ('aʊ', 'AW'), ('ɑj', 'AY'), ('ɑw', 'AW'),
         ('ɑː', 'AA'), ('iː', 'IY'), ('uː', 'UW'), ('ɑ', 'AA'), ('a', 'AA'), ('æ', 'AE'),
         ('ɪ', 'IH'), ('i', 'IY'), ('ʊ', 'UH'), ('u', 'UW'), ('ə', 'AH'), ('ʌ', 'AH'),
         ('ɛ', 'EH'), ('ɔ', 'AO'), ('ð', 'DH'), ('θ', 'TH'), ('ʃ', 'SH'), ('ʒ', 'ZH'), ('ŋ', 'NG'),
         ('ɾ', 'R'), ('ɹ', 'R'), ('r', 'R'), ('j', 'Y'), ('h', 'HH'), ('q', 'K'), ('χ', 'HH'),
         ('x', 'HH'), ('ɣ', 'G'), ('ɡ', 'G'), ('b', 'B'), ('d', 'D'), ('f', 'F'), ('g', 'G'),
         ('k', 'K'), ('l', 'L'), ('m', 'M'), ('n', 'N'), ('p', 'P'), ('s', 'S'), ('t', 'T'),
         ('v', 'V'), ('w', 'W'), ('z', 'Z')]
_VOWELS = {'AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW'}


def ipa_to_arpabet(ipa):
    out, stress, i = [], '0', 0
    while i < len(ipa):
        ch = ipa[i]
        if ch in 'ˈˌ':
            stress = '1' if ch == 'ˈ' else '2'
            i += 1
            continue
        if ch in 'ʔː ':
            i += 1
            continue
        for sym, code in _ARPA:
            if ipa.startswith(sym, i):
                if code in _VOWELS:
                    code, stress = code + stress, '0'
                if not out or out[-1] != code:  # no doubled letters in ARPAbet
                    out.append(code)
                i += len(sym)
                break
        else:
            i += 1  # a sound ARPAbet cannot write
    return ' '.join(out)


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
        if block.get('pause_before'):
            gap = np.zeros(int(sr * block['pause_before']), dtype=np.float32)
            parts.append(gap)
            t += len(gap) / sr
        start = t
        # An engine that reads whole paragraphs well (whole_blocks: its character limit) gets
        # each block in one piece; the rest get sentences.
        whole = job.get('whole_blocks', 0)
        parts_of_block = [block['text']] if whole and len(block['text']) <= whole else pieces(block['text'])
        for k, piece in enumerate(parts_of_block):
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
