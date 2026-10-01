#!/usr/bin/env python3
# clean_audio.py — Take the hall out of a khutbah recording: the room's background, the
# reverberation, and the distinct echo from the far loudspeakers. No model, nothing rebuilt:
# each frequency is only turned down where the room's measured sound says it is background
# or tail, so the imam's voice itself is left as it was (a neural cleaner, VoiceFixer, took the
# reverb out too but left him muffled).
#
#   .venv-clean/bin/python voice/clean_audio.py <recording> outputs/<folder> <out.wav>
#
# 1. The room, measured in the recording itself: the background (fans, sound system,
#    congregation) as a spectrum from the longest silence (between the two khutbahs, where the
#    imam sits), and the hall's decay per frequency band from where he stops before it.
# 2. Late reverberation taken off by spectral subtraction (Lebart 2001, Habets 2007): the tail
#    still sounding at each moment is predicted from the sound a moment earlier, decayed at the
#    hall's rate, and subtracted with the background.
# 3. The distinct echo (a delayed copy 130-190 ms later on 25 Sep) taken off by long-delay
#    linear prediction: what can be predicted from the sound that long before is the echo
#    (speech does not repeat itself at that delay), so the fitted prediction is subtracted.
# 25 Sep: speech stands 18 dB above the gaps between words instead of 10, the echo at 130-190
# ms falls from 0.24 to 0.02, and Whisper hears the words as well as before; 12 s for 16 min.
#
# Setup: uv venv --python 3.12 .venv-clean && VIRTUAL_ENV=.venv-clean uv pip install -r requirements/clean.txt

import json, subprocess, sys
from pathlib import Path
import numpy as np, soundfile as sf
from scipy.linalg import solve_toeplitz
from scipy.signal import fftconvolve, istft, stft

SR, NFFT, HOP = 44100, 2048, 512
NOISE_WEIGHT, REVERB_WEIGHT, FLOOR_DB = 1.5, 2.0, -20  # "medium", as chosen on 30 Sep
ECHO_FROM, ECHO_TO, ECHO_STRENGTH = 0.13, 0.19, 1.0     # "full"


def load(path, a=None, b=None):
    cut = (['-ss', str(a)] if a is not None else []) + (['-to', str(b)] if b is not None else [])
    raw = subprocess.run(['ffmpeg', '-loglevel', 'error', *cut, '-i', str(path), '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'],
                         capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).copy()


def spec(x):
    return stft(x, SR, nperseg=NFFT, noverlap=NFFT - HOP)


def longest_silence(folder):
    """(last word's end, next word's start) around the longest gap in the imam's speech."""
    words = json.loads((Path(folder) / 'result.json').read_text())['transcript_words']
    gaps = [(words[k]['start'] - words[k - 1]['start'], k) for k in range(1, len(words))]
    _, k = max(gaps)
    imam = Path(folder) / 'words_imam.json'
    if imam.exists():  # the aligned word ends are exact
        flat = sorted((w for b in json.loads(imam.read_text())['blocks'] for w in b['words']), key=lambda w: w[1])
        before = [w for w in flat if w[1] < words[k]['start'] - 0.5]
        return before[-1][2], words[k]['start']
    return words[k - 1]['start'] + 0.6, words[k]['start']


def room(recording, stop, resume):
    """The background spectrum, and the decay time per frequency bin."""
    f, _, Xn = spec(load(recording, stop + 0.9, resume - 0.5))
    noise = np.mean(np.abs(Xn) ** 2, axis=1)
    _, _, Xd = spec(load(recording, stop - 0.1, stop + 1.2))
    Pd = np.abs(Xd) ** 2
    rt = np.full(len(f), 1.2)
    edges = [60, 250, 500, 1000, 2000, 4000, 8000, 16000]
    for lo, hi in zip(edges[:-1], edges[1:]):
        band = (f >= lo) & (f < hi)
        lvl = 10 * np.log10(Pd[band].sum(0) + 1e-12)
        floor = 10 * np.log10(noise[band].sum() + 1e-12)
        tail = lvl[int(np.argmax(lvl[:12])):]
        above = np.where(tail - floor > 3)[0]  # the decay while still above the background
        n = int(above[-1]) if len(above) else 0
        if n >= 4:
            slope = np.polyfit(np.arange(n + 1) * HOP / SR, tail[:n + 1], 1)[0]
            rt[band] = float(np.clip(-60 / slope, 0.3, 3.0)) if slope < 0 else 1.2
    return noise, rt


def dereverb(x, noise, rt):
    _, _, X = spec(x)
    P = np.abs(X) ** 2
    Ps = P.copy()
    for k in range(1, P.shape[1]):
        Ps[:, k] = 0.6 * Ps[:, k - 1] + 0.4 * P[:, k]
    nd = max(1, round(0.05 * SR / HOP))
    decay = np.exp(-2 * (3 * np.log(10) / rt) * nd * HOP / SR)[:, None]
    late = np.zeros_like(P)
    late[:, nd:] = decay * Ps[:, :-nd]
    g = np.maximum(1 - NOISE_WEIGHT * noise[:, None] / (P + 1e-12) - REVERB_WEIGHT * late / (P + 1e-12), 10 ** (FLOOR_DB / 10))
    for k in range(1, g.shape[1]):
        g[:, k] = 0.7 * g[:, k] + 0.3 * g[:, k - 1]
    _, y = istft(X * np.sqrt(g), SR, nperseg=NFFT, noverlap=NFFT - HOP)
    return y[:len(x)]


def deecho(x):
    D, T = int(ECHO_FROM * SR), int((ECHO_TO - ECHO_FROM) * SR)
    n = 1 << (2 * len(x) - 1).bit_length()
    ac = np.fft.irfft(np.abs(np.fft.rfft(x, n)) ** 2)[: D + T]
    col = ac[:T].copy()
    col[0] *= 1 + 1e-3
    h = solve_toeplitz(col, ac[D:D + T])  # predict x[n] from x[n - D - k]
    echo = fftconvolve(x, h)[: len(x)]
    return x - ECHO_STRENGTH * np.concatenate([np.zeros(D), echo[: len(x) - D]])


def main():
    if len(sys.argv) != 4:
        sys.exit('usage: clean_audio.py <recording> outputs/<folder> <out.wav>')
    recording, folder, out = sys.argv[1:]
    stop, resume = longest_silence(folder)
    noise, rt = room(recording, stop, resume)
    print(f'room measured in the silence {stop:.1f}-{resume:.1f} s')
    x = load(recording)
    seg, ov, parts, k = 60 * SR, 2 * SR, [], 0  # a minute at a time, 2 s overlap
    while k < len(x):
        a, b = max(0, k - ov), min(len(x), k + seg + ov)
        parts.append(dereverb(x[a:b], noise, rt)[k - a: k - a + min(seg, len(x) - k)])
        k += seg
    y = deecho(np.concatenate(parts))
    sf.write(out, (y / max(1e-9, np.abs(y).max()) * 0.9).astype(np.float32), SR)
    print(f'wrote {out}: {len(y) / SR / 60:.1f} min, same timeline as the recording')


if __name__ == '__main__':
    main()
