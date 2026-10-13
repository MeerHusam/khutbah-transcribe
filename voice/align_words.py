#!/usr/bin/env python3
# align_words.py — When each word of a voice track is spoken, for word-by-word follow-along.
#
#   .venv-align/bin/python voice/align_words.py outputs/<folder> ur      (or en)
#   .venv-align/bin/python voice/align_words.py -  < job.json               (align_imam.js: the imam)
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
# Job mode (stdin): { audio, lang, pad?, blocks: [{ i, start, end, text }] } -> prints
# [{ i, words }] as the last stdout line. The imam's block times are rougher than a voice
# track's, so his blocks get more padding and a spare slot at the end as well as the start,
# where words of the neighbouring blocks can fall without being taken for this block's.
#
# Setup (once):
#   uv venv --python 3.12 .venv-align && VIRTUAL_ENV=.venv-align uv pip install -r requirements/align.txt
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

ROOT = Path(__file__).resolve().parent.parent
MODEL = ROOT / 'models' / 'mms_fa' / 'model.onnx'
# The same model with its matrix weights in 8 bits (13 Oct 2026), for the voice tracks: 1.8x faster, and on the 28 Aug
# Makkah voices every word start the same as the full model's within one 20 ms step (English 310 words, Urdu 380,
# Bengali 285). Not for the imam's hall recording: there 12 of 737 words moved by 2 to 3 s. Made once, locally:
#   .venv-align/bin/python -c "from onnxruntime.quantization import quantize_dynamic, QuantType; quantize_dynamic('models/mms_fa/model.onnx', 'models/mms_fa/model.int8.onnx', weight_type=QuantType.QInt8, op_types_to_quantize=['MatMul'])"
# Without it, the full model is used.
MODEL_INT8 = ROOT / 'models' / 'mms_fa' / 'model.int8.onnx'
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


def align_block(session, tokenizer, wave, start, end, text, iso, pad=PAD):
    """[[word, start, end], ...] for the words of `text`, spoken in wave[start:end] (seconds)."""
    words = text.split()
    a = max(0, int((start - pad) * SR))
    b = min(len(wave), int((end + pad) * SR))
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
    if pad > PAD:
        tokens.append('<star>')  # the start of the next block, heard in the padding
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


def performance_cores():
    """How many fast cores this Mac has (hw.perflevel0), or None elsewhere."""
    try:
        return int(subprocess.run(['sysctl', '-n', 'hw.perflevel0.physicalcpu'], capture_output=True, text=True, check=True).stdout)
    except (OSError, ValueError, subprocess.CalledProcessError):
        return None


def open_model(voice=False):
    """The aligner model. On an Apple chip it runs on the performance cores only: by default
    onnxruntime also hands work to the slow efficiency cores and waits for them (1 Oct: 150 s ->
    117 s for a 16-min khutbah on an M1 Pro, same results)."""
    opts = onnxruntime.SessionOptions()
    cores = performance_cores()
    if cores:
        opts.intra_op_num_threads = cores
    model = MODEL_INT8 if voice and MODEL_INT8.exists() else MODEL
    return onnxruntime.InferenceSession(str(model), sess_options=opts, providers=['CPUExecutionProvider'])


def dump(manifest):
    """The manifest as JSON with one block per line, so it stays small and diffs block by block."""
    head = {k: v for k, v in manifest.items() if k != 'blocks'}
    blocks = ',\n  '.join(json.dumps(b, ensure_ascii=False) for b in manifest['blocks'])
    return json.dumps(head, ensure_ascii=False, indent=1)[:-2] + f',\n "blocks": [\n  {blocks}\n ]\n}}\n'


def run_job():
    job = json.load(sys.stdin)
    wave = load_audio(job['audio'])
    session = open_model(voice=bool(job.get('voice')))
    tokenizer = Tokenizer()
    iso, pad, blocks, out = job.get('iso') or ISO[job['lang']], job.get('pad', PAD), job['blocks'], []
    began = time.time()
    for n, b in enumerate(blocks):
        out.append({'i': b['i'], 'words': align_block(session, tokenizer, wave, b['start'], b['end'], b['text'], iso, pad)})
        print(f'  block {n + 1}/{len(blocks)}  {time.time() - began:.0f} s', file=sys.stderr, flush=True)
    print('\n' + json.dumps(out, ensure_ascii=False), flush=True)


def main():
    if sys.argv[1:] == ['-']:
        return run_job()
    # A language not in ISO gives its code (from core/langs/<code>.js): align_words.py <folder> bn ben
    if len(sys.argv) not in (3, 4) or (len(sys.argv) == 3 and sys.argv[2] not in ISO):
        sys.exit('usage: align_words.py outputs/<folder> en|ur [<ISO 639-3>]')
    folder, lang = Path(sys.argv[1]), sys.argv[2]
    iso = sys.argv[3] if len(sys.argv) == 4 else ISO[lang]
    manifest_path = folder / f'tts_{lang}.json'
    manifest = json.loads(manifest_path.read_text())
    wave = load_audio(folder / manifest.get('audio', f'tts_{lang}.mp3'))
    session = open_model(voice=True)
    tokenizer = Tokenizer()
    began = time.time()
    blocks = manifest['blocks']
    for n, block in enumerate(blocks):
        block['words'] = align_block(session, tokenizer, wave, block['start'], block['end'], block['text'], iso)
        print(f'  block {n + 1}/{len(blocks)}  {time.time() - began:.0f} s', file=sys.stderr, flush=True)
    manifest['words_by'] = 'mms_fa'
    manifest_path.write_text(dump(manifest))
    print(f'Wrote words for {len(blocks)} blocks to {manifest_path} in {time.time() - began:.0f} s')


def one_at_a_time():
    """One aligner at a time on this Mac (13 Oct 2026). Each uses all the performance cores; since the voices of a
    khutbah are made side by side, three ran at once and each took 9.6 min instead of about 2 (18 threads on 6 cores).
    The lock is let go when the process ends, however it ends."""
    import fcntl
    lock_dir = ROOT / '.tts_cache'
    lock_dir.mkdir(exist_ok=True)
    f = open(lock_dir / 'aligner.lock', 'w')
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print('  waiting for the aligner (another voice is using it)', file=sys.stderr, flush=True)
        fcntl.flock(f, fcntl.LOCK_EX)
    return f


if __name__ == '__main__':
    _lock = one_at_a_time()
    main()
