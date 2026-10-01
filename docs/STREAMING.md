# Streaming Live Mode — Progress & Handoff

Real-time khutbah transcription + translation with **sub-2s latency**, built on Speechmatics
realtime ASR. This is the third mode, kept **fully separate** from the two existing ones:

| Mode | Route | Engine | Latency | Status |
|------|-------|--------|---------|--------|
| Upload pipeline (original) | `/` reader | `pipeline.js` (Whisper batch) | offline | unchanged, untouched |
| Chunk live (v1) | `/live` | `live.js` (Groq, 4s chunks) | ~4s | working |
| **Streaming live (v2)** | **`/stream`** | **`live/` (Speechmatics)** | **~1s** | **built, needs API key to test live** |

---

## Why streaming (the core insight)

Whisper is an offline encoder-decoder trained on fixed 30s windows — it **cannot emit a word
until a whole audio block is ingested**. Every live-Whisper setup is a chunk-and-stitch hack
with hard, wrong-looking boundaries (you saw orphan fragments like `والسيئات قال`).

Google/YouTube/Zoom use **streaming transducers**: raw PCM goes up continuously in tiny frames,
words come back as recognised (~0.3–1s), with **partials that self-correct**. Speechmatics is
the same class of model, has the strongest Arabic (MSA + Gulf/Levantine/Egyptian dialects,
~96% accuracy), and ships **built-in AR→EN realtime translation** so English no longer waits
on a Claude round-trip. Free tier = 40 hrs/month (covers a weekly khutbah forever).

---

## What was built

### `live/speechmatics.js` — transport
Owns the Speechmatics WebSocket. `StartRecognition` (raw 16kHz PCM, `enhanced` operating point,
partials on, `translation_config` for EN) → streams binary audio up → normalises
`AddPartialTranscript`/`AddTranscript`/`AddTranslation` into callbacks. Buffers audio captured
before the handshake completes so no opening words are lost. `end()` sends `EndOfStream` to
flush finals gracefully.

### `live/engine.js` — session logic
Driven by **finalised words**, not chunks:
- `onFinal` appends words → `emitPass()` runs the **same `prescanForQuranZones` n-gram scan**
  from `pipeline.js` (the whole differentiator — reused, not reimplemented).
- Quran zones → gold cards (canonical Arabic from quran.json + English from quran_en.json).
- Prose blocks get English from **Speechmatics MT** (`onTranslation`), patched in live.
- **Claude demoted to enrichment only**: a cheap regex prefilter (`قال رسول الله` etc.) gates a
  detached Claude call that flags quoted hadiths → teal card → `findMatchingHadith` against the
  local 29k corpus → `resolveSunnahLinksForRefs` patches the authoritative sunnah.com permalink.
  Claude **never gates the feed** — a failure just leaves prose untouched.
- `HOLDBACK=3` words + zones touching the transcript end held back (n-gram needs 4 words).
- On stop: saves to `outputs/stream_<ts>/` (same shape as `live.js`) so `reanalyze.js` can
  post-process.

### `live/index.js` — WS handler (`/ws/stream`)
Wires browser PCM → Speechmatics → engine → broadcast to all clients (host + passive listeners
share one feed). Only the socket that sent `start` (`hostWs`) may push audio or `stop`. Missing
key → single `{type:'error', fatal:true}` with setup instructions, no crash. Does **not**
broadcast `ended` when replacing a stale session (that bug killed the host loop in v1).

### `public/pcm-worklet.js` — AudioWorklet
Replaces MediaRecorder entirely. Captures mic, linear-downsamples to 16kHz, converts to 16-bit
LE PCM, posts ~64ms frames. Continuous raw stream = no encoded blobs, no chunk boundaries.

### `public/stream.html` — UI at `/stream`
Same visual language as `/live` (gold Quran / teal Hadith cards, RECORDING bar with pulse +
live mic meter + timer + word counter). Adds a bottom **live bar** showing the self-revising
interim Arabic + interim English — the "wobble" line that makes it feel instant. Shows an
inline setup card if the API key is missing.

### `server.js` — additive only
`/ws/stream` routed alongside `/ws/live`; `GET /stream`; `GET /api/stream/status`. Nothing
existing changed. `.env.example` documents `SPEECHMATICS_API_KEY` + `SPEECHMATICS_MAX_DELAY`.

---

## Verification done (2026-07-29)

- **All routes 200**: `/`, `/live`, `/stream`, `/api/results`, `/api/live/status`, `/api/stream/status`.
- **Offline pipeline intact**: `pipeline.js` imports (22 exports), `reanalyze.js` on the Arafah
  khutbah reproduces identical `reader.txt`/`result.json` (no regression).
- **Full chain tested against a mock Speechmatics server** (replays the real Arafah transcript
  as streaming partials/finals — see `scratchpad/mock_sm.js`): prose:28 all with English,
  **9 Quran cards**, 8 of which **exactly match the offline pipeline's prescan** on the same
  words (Al-Hajj 22:1, 22:2, 22:6, 22:7, 22:12, 22:13, 22:31, 22:34). The one extra (Al-Anfal
  8:2) was at the truncation boundary — incremental vs batch resolving differently, expected.
- `configured:false` correctly detected when no key is set; stream socket fails gracefully.

**Not yet tested with a real Speechmatics key** — the mock proves the wiring, engine, Quran/
Hadith layers, and event feed. The only unproven piece is the live Speechmatics protocol
handshake + real Arabic ASR quality, which needs the key.

---

## To go live (next session)

1. Sign up at https://portal.speechmatics.com → create an API key (free tier, 40 hrs/month).
2. Add to `.env`:
   ```
   SPEECHMATICS_API_KEY=your_key
   SPEECHMATICS_MAX_DELAY=1.0
   ```
3. `node server.js` → open `http://localhost:3000/stream` → Start Listening.
4. If the real message shapes differ from the docs (field names in `results[]`, translation
   result structure), adjust `extractWords` / `joinTranslation` in `live/speechmatics.js` —
   that's the only place the wire format is parsed. Everything downstream is format-agnostic.

## Known / deferred

- **Endpointing**: currently emits on Speechmatics finals + holdback. Could add explicit VAD
  segmentation for cleaner prose blocks.
- **True-matn-span** (shared with offline fix #15 edge case): a Quranic phrase *inside* hadith
  text can still get its own Quran card.
- **QR-code join** + separate host/listener pages: `qrcode` dep installed, not wired.
- `SPEECHMATICS_URL` env var overrides the endpoint (used for the mock; also lets you pick the
  US region `wss://us.rt.speechmatics.com/v2` if latency is better from your location).

## Test harness (scratchpad, not committed)

`scratchpad/mock_sm.js` — mock Speechmatics server on :9999 replaying a real transcript.
Run it, then start the app server with `SPEECHMATICS_URL=ws://localhost:9999
SPEECHMATICS_API_KEY=mock-key` and drive `/ws/stream` with `scratchpad/test_stream.js`.
