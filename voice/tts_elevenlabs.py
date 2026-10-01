#!/usr/bin/env python3
# tts_elevenlabs.py — Speak a khutbah's blocks with ElevenLabs (paid API; the free tier has
# 10k credits a month). Called by tts.js --engine elevenlabs. The key comes from the
# environment (ELEVEN_LABS_API_KEY in .env, loaded by tts.js); it needs only text-to-speech
# permission.
#
# Job (tts_common.py) plus: { model, voice (voice id), language_code, lexicon? }
#   eleven_v3: most expressive, speaks Urdu; says Arabic names its own way.
#   eleven_flash_v2: English only, half the price, and the only model that honours inline
#     <phoneme> tags, so with the lexicon Allah and Muhammad get their listed sounds.
# Cost: v3 1 credit per character, Flash 0.5. Every block's audio is kept in .tts_cache/, so a
# block is paid for once: re-runs (another tempo, one block's text fixed) cost only what
# changed. Before sending anything the run adds up what it would cost and stops if that is
# over max_credits (tts.js --max-credits, 2000 by default).

import hashlib
import json
import os
import sys
import time
import urllib.error
import urllib.request

import numpy as np

from tts_common import WORD, load_lexicon, lookup, read_job, run

URL = 'https://api.elevenlabs.io/v1/text-to-speech/{voice}?output_format=pcm_24000'
CACHE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.tts_cache', 'elevenlabs')


def with_phonemes(text, lex):
    def tag(m):
        ipa = lookup(lex, m.group())
        return m.group() if ipa is None else f'<phoneme alphabet="ipa" ph="{ipa}">{m.group()}</phoneme>'
    return WORD.sub(tag, text)


def main():
    job = read_job()
    key = os.environ.get('ELEVEN_LABS_API_KEY') or os.environ.get('ELEVENLABS_API_KEY')
    lex = load_lexicon(job['lexicon']) if job.get('lexicon') else {}
    rate = 0.5 if 'flash' in job['model'] else 1.0
    sent = cached = 0

    def request(text):
        body = {'text': with_phonemes(text, lex) if lex else text, 'model_id': job['model']}
        if job.get('language_code') and job['model'] != 'eleven_flash_v2':
            body['language_code'] = job['language_code']
        path = os.path.join(CACHE, hashlib.sha1(json.dumps([job['voice'], body], ensure_ascii=False).encode()).hexdigest() + '.pcm')
        return body, path

    # What this run would cost, before any of it is spent.
    whole = job.get('whole_blocks', 0)
    todo = [b['text'] for b in job['blocks']]
    new_chars = sum(len(t) for t in todo if not os.path.exists(request(t)[1]))
    cost = round(new_chars * rate)
    print(f'  ElevenLabs cost of this run: {cost} credits ({new_chars} new characters; the rest cached)',
          file=sys.stderr, flush=True)
    if any(len(t) > whole for t in todo):
        sys.exit('  a block is longer than whole_blocks; the cost check assumes whole blocks')
    if cost > job.get('max_credits', 2000):
        sys.exit(f'  stopped: {cost} credits is over the cap of {job.get("max_credits", 2000)}; '
                 f'run again with --max-credits {cost} to spend them')
    os.makedirs(CACHE, exist_ok=True)

    def speak(text):
        nonlocal sent, cached
        body, path = request(text)
        if os.path.exists(path):
            cached += len(text)
            with open(path, 'rb') as f:
                return np.frombuffer(f.read(), dtype='<i2').astype(np.float32) / 32768
        req = urllib.request.Request(URL.format(voice=job['voice']), data=json.dumps(body).encode(),
                                     headers={'xi-api-key': key, 'Content-Type': 'application/json'})
        for attempt in range(3):
            try:
                with urllib.request.urlopen(req, timeout=180) as r:
                    pcm = r.read()
                break
            except urllib.error.HTTPError as e:
                detail = e.read().decode(errors='replace')[:400]
                if e.code in (429, 500, 502, 503) and attempt < 2:
                    time.sleep(5 * (attempt + 1))
                    continue
                sys.exit(f'ElevenLabs {e.code}: {detail}')
        with open(path, 'wb') as f:
            f.write(pcm)
        sent += len(text)
        return np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768

    run(job, speak, 24000)
    print(f'  spent about {round(sent * rate)} credits ({sent} characters sent, {cached} from cache)', file=sys.stderr)


if __name__ == '__main__':
    main()
