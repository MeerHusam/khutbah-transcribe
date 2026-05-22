#!/usr/bin/env python3
"""
Quran detection helper — shells out from pipeline.js (like transcribe_local.py).

Runs the `quran-detector` library (github.com/SElBeltagy/Quran_Detector) over a
transcript and prints detected verse fragments as JSON to stdout.

Usage:
    python quran_detect.py <transcript.txt>
    echo "<arabic text>" | python quran_detect.py -

Output (stdout): JSON array of
    {
      "surah_name_ar": "البقرة",
      "aya_start": 185, "aya_end": 185,
      "start_word": 511, "end_word": 515,   # word indices into the library's tokenization
      "verses": ["..."],                      # matched verse fragment(s)
      "errors": [[["transcribed","expected",pos], ...]]  # typo/missing-word notes
    }

This is a PROTOTYPE for comparison against the existing n-gram/Jaccard pipeline.
It does not modify the production pipeline.
"""
import sys
import json


def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: quran_detect.py <transcript.txt|->\n")
        sys.exit(1)

    src = sys.argv[1]
    text = sys.stdin.read() if src == "-" else open(src, encoding="utf-8").read()

    try:
        import quran_detector as qd
    except ImportError:
        sys.stderr.write("quran_detector not installed (pip install quran-detector, needs Python >=3.12)\n")
        sys.exit(2)

    matches = qd.detect(text)

    out = []
    for m in matches:
        out.append({
            "surah_name_ar": m.get("surah_name"),
            "aya_start": m.get("aya_start"),
            "aya_end": m.get("aya_end"),
            "start_word": m.get("start_in_text"),
            "end_word": m.get("end_in_text"),
            "verses": m.get("verses", []),
            "errors": m.get("errors", []),
        })

    json.dump(out, sys.stdout, ensure_ascii=False)


if __name__ == "__main__":
    main()
