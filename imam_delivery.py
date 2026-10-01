#!/usr/bin/env python3
# imam_delivery.py — How the imam delivered each block, measured from his recording, so the voice
# can follow him: where he is raised and stirred, and where he is soft (tts.js --direct).
#
#   .venv-align/bin/python imam_delivery.py outputs/<folder> <recording>
#
# Reads words_imam.json (align_imam.js) and writes delivery_imam.json: for each block its
# loudness (speech frames only), pitch height and pitch movement (semitones) and pace (words a
# second), each also as a z-score against his own average in this khutbah (0 his average, +1
# clearly louder, higher, wider, faster). A block is measured from its first word to its last,
# so the pause where he sits between the khutbahs does not count as slow speech.
# 25 Sep: the condemnation before Surat al-Fil stands out (pitch +1.8), as one hears it.
# Local, no API; about 20 s for 16 min. Needs librosa (in .venv-align).

import json, subprocess, sys
from pathlib import Path
import numpy as np, librosa

SR, HOP = 16000, 160  # 10 ms frames


def main():
    if len(sys.argv) != 3:
        sys.exit('usage: imam_delivery.py outputs/<folder> <recording>')
    folder, recording = Path(sys.argv[1]), sys.argv[2]
    blocks = json.loads((folder / 'words_imam.json').read_text())['blocks']
    raw = subprocess.run(['ffmpeg', '-loglevel', 'error', '-i', recording, '-ac', '1', '-ar', str(SR), '-f', 's16le', '-'],
                         capture_output=True, check=True).stdout
    x = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768
    db = 20 * np.log10(librosa.feature.rms(y=x, frame_length=640, hop_length=HOP)[0] + 1e-6)
    f0 = librosa.yin(x, fmin=70, fmax=400, sr=SR, frame_length=1024, hop_length=HOP)
    speech = db > np.percentile(db, 40)
    rows = []
    for b in blocks:
        words = b.get('words') or []
        if not words:
            continue
        a, z = int(words[0][1] * 100), int(words[-1][2] * 100) + 1
        sp = speech[a:z]
        if sp.sum() < 50:  # under half a second of speech: too little to measure
            continue
        p = f0[a:z][sp[:len(f0[a:z])]]
        p = p[(p > 75) & (p < 380)]
        if len(p) < 20:
            continue
        semis = 12 * np.log2(p / 100)
        rows.append({'i': b['i'], 'loud': float(np.mean(db[a:z][sp])), 'pitch': float(np.median(semis)),
                     'range': float(np.percentile(semis, 90) - np.percentile(semis, 10)),
                     'pace': len(words) / max(0.5, (z - a) / 100)})
    for k in ['loud', 'pitch', 'range', 'pace']:
        v = np.array([r[k] for r in rows])
        m, s = v.mean(), v.std() + 1e-9
        for r in rows:
            r[k + '_z'] = round(float((r[k] - m) / s), 2)
            r[k] = round(r[k], 2)
    out = folder / 'delivery_imam.json'
    out.write_text('{\n "blocks": [\n  ' + ',\n  '.join(json.dumps(r) for r in rows) + '\n ]\n}\n')
    print(f'Wrote {out}: {len(rows)} blocks measured')


if __name__ == '__main__':
    main()
