# KhutbahTranscribe

A Node.js pipeline that takes an Arabic Khutbah (Friday sermon) audio file and produces:

- A full Arabic transcript
- An English translation
- A topic summary
- Identified Quranic Ayahs with matched Surah/Ayah numbers and quran.com links
- Identified Hadith references with narrator and collection notes

## How it works

```
Audio file → Whisper (transcription) → Claude Sonnet (analysis) → quran-json (Ayah matching) → output files
```

1. **OpenAI Whisper** transcribes the Arabic audio to text
2. **Claude Sonnet** translates the transcript, summarises the Khutbah, and detects signal phrases that introduce Quranic Ayahs and Hadith
3. **quran-json** (local corpus — no extra API call) matches the extracted Arabic snippets to specific Ayahs using diacritic-normalised containment and word-overlap scoring

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Add your API keys

Edit `.env` and fill in both keys:

```
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```

- Get an OpenAI key at https://platform.openai.com/api-keys
- Get an Anthropic key at https://console.anthropic.com/settings/keys

### 3. Run the pipeline

**API mode** (OpenAI Whisper — easy, costs ~$0.25/run, 25 MB file limit):
```bash
node pipeline.js path/to/khutbah.mp3
```

**Local mode** (faster-whisper — free after download, no size limit, better Arabic accuracy):
```bash
# Install faster-whisper once
pip install faster-whisper

# Run with default model (Byne/whisper-large-v3-arabic, ~3 GB download on first run)
node pipeline.js path/to/khutbah.mp3 --local

# Or specify a different HuggingFace model
node pipeline.js path/to/khutbah.mp3 --local --model mboushaba/whisper-large-v3-turbo-arabic
```

The 25 MB limit only applies to API mode. Local mode handles any file size.

If you're in API mode and your file is over 25 MB, compress it first:
```bash
ffmpeg -i khutbah.mp3 -ac 1 -b:a 32k khutbah_compressed.mp3
```

**Getting a test Khutbah** (Internet Archive — free, public domain):
```bash
# Install yt-dlp if needed: brew install yt-dlp
yt-dlp -x --audio-format mp3 "https://archive.org/details/MadinahFridayKhutbah_100"
```

Supported formats: `mp3`, `m4a`, `ogg`, `wav`, `webm`, `mp4`, `mpeg`, `mpga`

## Output files

| File | Contents |
|------|----------|
| `output_transcript.txt` | Raw Arabic transcript from Whisper |
| `output_result.json` | Full structured result (summary, translation, references, metadata) |
| `output_readable.txt` | Human-readable formatted version of the result |
| `output_claude_raw.txt` | Only written on error — Claude's raw response if JSON parsing fails |

## Approximate cost per run

**API mode** — 30-minute Khutbah:

| Step | Model | Cost |
|------|-------|------|
| Transcription | OpenAI `whisper-1` | ~$0.18 ($0.006/min) |
| Analysis | Claude Sonnet 4 | ~$0.06 (~9k tokens in/out) |
| Quran matching | Local `quran-json` | Free |
| **Total** | | **~$0.25** |

**Local mode** — after the one-time model download (~3 GB):

| Step | Cost |
|------|------|
| Transcription | Free (runs on your CPU/GPU) |
| Analysis | ~$0.06 (Claude API still used) |
| **Total** | **~$0.06** |

Local mode also tends to produce **better Arabic transcripts** for Khutbahs — the `Byne/whisper-large-v3-arabic` model is fine-tuned on MSA data and handles Quranic vocabulary and classical signal phrases more reliably than the generic `whisper-1` API endpoint.

## Example console output

```
Transcribing khutbah.mp3 (7.2 MB)…
✓ Transcription complete — 3847 words
Analysing with Claude…
✓ Translation complete
✓ 6 Quranic references detected, 5 matched
✓ 3 Hadith references detected
✓ Results saved to output_result.json and output_readable.txt
```

## Notes

- Hadith matching is detection only — the pipeline identifies signal phrases but **does not verify the Hadith chain or text** against a corpus. Each entry includes a `"note": "Manual verification recommended"` field.
- Quran matching uses a similarity threshold of 0.4. Recited Ayahs often have slight pronunciation variations captured by Whisper; the diacritic-normalised word-overlap approach handles most of these gracefully.
- API keys are never logged or written to any output file.
