#!/usr/bin/env python3
"""
Local transcription helper for the Khutbah pipeline.
Called by pipeline.js when --local is passed.

Usage:
    python3 transcribe_local.py <audio_path> [model_name]

Install dependencies:
    pip install mlx-whisper          # Apple Silicon (fast, recommended on Mac)
    pip install faster-whisper       # fallback (CPU only, slow on large models)

The transcript is written to stdout only.
All progress/status messages go to stderr so Node.js can capture them separately.
"""

import sys
import os


MLX_MODEL = "mlx-community/whisper-large-v3-mlx"   # ~3 GB, fast on Apple Silicon
FW_MODEL  = "Systran/faster-whisper-large-v3"       # ~3 GB, CPU-only fallback


def seg_text(seg):
    return seg["text"].strip() if isinstance(seg, dict) else seg.text.strip()


def remove_hallucinations(segments):
    """Drop segments that look like Whisper hallucinations (repeated tokens)."""
    import re
    cleaned = []
    for seg in segments:
        text = seg_text(seg)
        # Detect token repetition: any token repeated 4+ times consecutively
        if re.search(r'(\S+)(\s+\1){3,}', text):
            continue
        # Detect character soup (many repeated 2-char substrings like ائائائ)
        if re.search(r'(.{1,3})\1{5,}', text):
            continue
        cleaned.append(seg)
    return cleaned


def transcribe_mlx(audio_path, model_name):
    import mlx_whisper

    print(f"Loading MLX model: {model_name}", file=sys.stderr)
    print("(First run downloads weights to ~/.cache/huggingface)", file=sys.stderr)
    print("Running transcription...", file=sys.stderr)

    result = mlx_whisper.transcribe(
        audio_path,
        path_or_hf_repo=model_name,
        language="ar",
        word_timestamps=False,
        verbose=False,
        no_speech_threshold=0.1,
        initial_prompt="بسم الله الرحمن الرحيم. خطبة الجمعة.",
    )

    segments = remove_hallucinations(result.get("segments", []))
    duration  = segments[-1]["end"] if segments else 1
    parts = []
    seg_data = []
    for seg in segments:
        text = seg_text(seg)
        parts.append(text)
        seg_data.append({"start": seg["start"], "end": seg["end"], "text": text})
        pct = min(100, int((seg["end"] / duration) * 100)) if duration else 0
        bar = ("█" * (pct // 5)).ljust(20)
        print(f"\r  [{bar}] {pct}%  {seg['end']:.0f}s / {duration:.0f}s",
              end="", flush=True, file=sys.stderr)

    print(file=sys.stderr)
    return {"text": " ".join(parts), "segments": seg_data}


def transcribe_faster_whisper(audio_path, model_name):
    from faster_whisper import WhisperModel

    print(f"Loading model: {model_name}", file=sys.stderr)
    print("(First run downloads weights to ~/.cache/huggingface -- ~3 GB for large-v3)", file=sys.stderr)

    # device="auto" -> CUDA if available, else CPU (MPS not supported by CTranslate2)
    model = WhisperModel(model_name, device="auto", compute_type="int8")

    print("Running transcription...", file=sys.stderr)

    segments, info = model.transcribe(
        audio_path,
        language="ar",
        beam_size=5,
        vad_filter=True,
        vad_parameters={
            "min_silence_duration_ms": 500,
            "threshold": 0.3,
        },
        no_speech_threshold=0.1,
        condition_on_previous_text=False,
        initial_prompt="بسم الله الرحمن الرحيم. خطبة الجمعة.",
    )

    print(
        f"Detected language: {info.language} "
        f"(probability {info.language_probability:.2f})",
        file=sys.stderr,
    )

    segments_list = remove_hallucinations(list(segments))
    audio_duration = info.duration
    parts = []
    seg_data = []
    for seg in segments_list:
        text = seg_text(seg)
        parts.append(text)
        seg_data.append({"start": seg.start, "end": seg.end, "text": text})
        pct = min(100, int((seg.end / audio_duration) * 100)) if audio_duration else 0
        bar = ("█" * (pct // 5)).ljust(20)
        print(f"\r  [{bar}] {pct}%  {seg.end:.0f}s / {audio_duration:.0f}s",
              end="", flush=True, file=sys.stderr)

    print(file=sys.stderr)
    return {"text": " ".join(parts), "segments": seg_data}


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 transcribe_local.py <audio_path> [model_name]", file=sys.stderr)
        sys.exit(1)

    audio_path = sys.argv[1]

    if not os.path.exists(audio_path):
        print(f"Error: audio file not found: {audio_path}", file=sys.stderr)
        sys.exit(1)

    import json
    try:
        import mlx_whisper  # noqa: F401
        passed = sys.argv[2] if len(sys.argv) > 2 else ""
        model_name = passed if passed and "mlx" in passed.lower() else MLX_MODEL
        result = transcribe_mlx(audio_path, model_name)
    except ImportError:
        try:
            import faster_whisper  # noqa: F401
            model_name = sys.argv[2] if len(sys.argv) > 2 else FW_MODEL
            result = transcribe_faster_whisper(audio_path, model_name)
        except ImportError:
            print(
                "No transcription backend found.\n"
                "Fix (Apple Silicon): pip install mlx-whisper\n"
                "Fix (other):         pip install faster-whisper",
                file=sys.stderr,
            )
            sys.exit(1)

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
