#!/usr/bin/env python3
"""
Compare our pipeline's transcript against a YouTube reference transcript.
Usage:
    python3 compare_transcripts.py <our_transcript.txt> <yt_reference.txt>
    python3 compare_transcripts.py outputs/<folder>/transcript.txt references/sudais_ashura_muharram_yt.txt
"""

import sys
import re
from difflib import SequenceMatcher


def normalize(text):
    """Strip diacritics and punctuation, normalise alifs/hamzas for fair comparison."""
    # Remove tashkeel (diacritics)
    text = re.sub(r'[ً-ٰٟ]', '', text)
    # Remove tatweel
    text = text.replace('ـ', '')
    # Normalise alif variants → bare alif
    text = re.sub(r'[آأإٱ]', 'ا', text)
    # Remove punctuation
    text = re.sub(r'[،؟!,.،؛:«»\(\)\[\]"\'\.]+', ' ', text)
    # Collapse whitespace
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def tokenize(text):
    return [w for w in normalize(text).split() if w]


def coverage(ours, reference):
    """What % of reference words appear in our transcript (order-independent)."""
    our_set = set(ours)
    ref_set = set(reference)
    matched = ref_set & our_set
    return len(matched) / max(len(ref_set), 1) * 100


def find_missing_spans(ours_words, ref_words, min_span=5):
    """Find spans of consecutive reference words missing from our transcript."""
    our_set = set(ours_words)
    missing_spans = []
    i = 0
    while i < len(ref_words):
        if ref_words[i] not in our_set:
            j = i
            while j < len(ref_words) and ref_words[j] not in our_set:
                j += 1
            if j - i >= min_span:
                missing_spans.append((i, j, ref_words[i:j]))
            i = j
        else:
            i += 1
    return missing_spans


def sequence_similarity(ours, ref):
    """SequenceMatcher ratio on word lists."""
    return SequenceMatcher(None, ref, ours).ratio() * 100


def main():
    if len(sys.argv) < 3:
        print("Usage: python3 compare_transcripts.py <our_transcript> <yt_reference>")
        sys.exit(1)

    our_path = sys.argv[1]
    ref_path = sys.argv[2]

    with open(our_path, encoding='utf-8') as f:
        our_text = f.read()
    with open(ref_path, encoding='utf-8') as f:
        ref_text = f.read()

    our_words = tokenize(our_text)
    ref_words = tokenize(ref_text)

    cov = coverage(our_words, ref_words)
    sim = sequence_similarity(our_words, ref_words)
    missing = find_missing_spans(our_words, ref_words)

    print("=" * 60)
    print("  TRANSCRIPT COMPARISON REPORT")
    print("=" * 60)
    print(f"  Our transcript : {len(our_words)} words")
    print(f"  YT reference   : {len(ref_words)} words")
    print(f"  Word coverage  : {cov:.1f}%  (reference words found in ours)")
    print(f"  Sequence match : {sim:.1f}%  (order-aware similarity)")
    print()

    if missing:
        print(f"  MISSING SPANS ({len(missing)} gap(s) of 5+ consecutive words):")
        print("-" * 60)
        for start, end, words in missing:
            snippet = ' '.join(words[:12])
            if len(words) > 12:
                snippet += ' ...'
            print(f"  [{start}–{end}]  ({end-start} words)")
            print(f"    {snippet}")
            print()
    else:
        print("  No significant gaps found.")

    print("=" * 60)


if __name__ == '__main__':
    main()
