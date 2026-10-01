# KhutbahTranscribe

Turns a recording of an Arabic Friday khutbah into a page people can read and listen to:
the imam's Arabic word by word, an English and an Urdu translation, every Quran verse and
hadith he cites as a card with its source (quran.com, sunnah.com), and voice tracks that read
the translation aloud with the imam's own recitation before each verse.

Live site: **https://khutbah-live.onrender.com**

## How it works

```
recording
  → transcribe            Gemini 2.5 Flash for the text + Groq Whisper for word timings
  → Quran zones           4-gram index over the Quran finds recited passages, even partial ones
  → prose chunks          the rest, cut at the imam's pauses
  → Claude                translates each chunk, names the verses and hadith it hears
  → references            Claude's verses checked against the Quran corpus; scans find the ones
                          it missed; hadith matched to a local corpus, then to sunnah.com
  → reader                outputs/<run>/reader.txt + result.json: Arabic block, English, cards
  → Urdu, voices          translation and review (Claude), Gemini voices, offline word alignment
  → site                  published through the site's API: live at once, no commit, no deploy;
                          the audio goes to Cloudflare R2 when it is set up
```

From the masjid, the whole chain is one upload: the upload page stores the recording on the
site, a worker on a Mac picks it up and runs `worker/autopublish.js`, and the page goes live.

## Repository layout

```
pipeline.js            the command line: a recording (or a transcript) → outputs/<time>_<name>/
core/                  the pipeline library
  arabic.js              Arabic normalisation, Quran corpus and n-gram index, zones, verse matching
  hadith.js              hadith corpus and matching, sunnah.com links and narrators
  analyze.js             the Claude analysis prompt, the second-khutbah split
  transcribe.js          audio preprocessing, Gemini + Groq transcription, word timing
  reader.js              reader.txt and readable.txt
  reader_chunks.js       the reader's blocks, as the site serves them
  quote_swaps.js         published translations for quoted verses and hadith
  verse_excerpts.js      the recited part of a partly recited verse
  verify_reader.js       the publish gate: checks what the reader really renders
  check_english.js       English checks used by the gate
  review_blocks.js       a second model reviews every block and flags problems
urdu/                  the Urdu translation and its review
voice/                 voice tracks (Gemini, ElevenLabs), word alignment, the imam's recitation,
                       echo removal (Node + Python)
worker/                publish.js (one khutbah to publishable), autopublish.js (recording to
                       live page), upload_worker.js (runs autopublish for each upload)
server/                the website: Express routes, viewer counts, admin, upload and publish
                       API; the published khutbahs are in SQLite (db.js) on Render's disk
public/                the pages (home, reader)
scripts/               maintenance: reanalyze an old run, set up the hadith corpus, evaluations
tests/                 npm test: reader checks per khutbah, server, pipeline end to end
requirements/          the Python environments
docs/                  architecture proposal, fix history, deployment, recordings
outputs/, audio_files/ pipeline runs and recordings (in git only those published before the
                       publish API; new ones go to the site's disk, their audio to R2; the
                       site plays all seven older ones' audio from R2 too)
```

## Setup

Needs Node 22.13+ (the site uses Node's built-in SQLite), ffmpeg, and for the voice steps Python 3.12 and [uv](https://docs.astral.sh/uv/).

```bash
npm install
cp .env.example .env              # add the API keys (see the file)
node scripts/setup_hadith.js      # the hadith collections, into hadith_data/ (~35 MB)
```

Python environments, only for the voice and audio steps (each file has its setup line):

| Environment | For | Requirements |
|---|---|---|
| `.venv-align` | word timings (`voice/align_words.py`, `voice/align_imam.js`), the imam's delivery | `requirements/align.txt` + the MMS model in `models/mms_fa/` |
| `.venv-clean` | echo removal (`voice/clean_audio.py`) | `requirements/clean.txt` |
| `.venv` | the ElevenLabs engine, the quran-detector evaluation | `requirements/base.txt` |

Run every command from the repo root: scripts read `.env` and `outputs/…` from there.

## Usage

```bash
# One khutbah, step by step
node pipeline.js audio_files/khutbah.m4a              # Gemini text + Groq timing (best)
node pipeline.js audio_files/khutbah.m4a --groq       # Groq only (free, rougher text)
node pipeline.js audio_files/eid.m4a --type eid       # also: --type arafah, --single
node core/verify_reader.js outputs/<run>              # the publish gate
node urdu/translate_urdu.js outputs/<run>             # then urdu/review_urdu.js
node voice/tts.js outputs/<run> --lang ur --direct    # a voice track (Gemini)

# Publishing
node worker/publish.js <recording> --slug 2026-10-02 --title "…" --date "2 October 2026"   # to your local site
node worker/autopublish.js <recording> [--masjid "Name"] [--no-push]   # everything, then the live site
caffeinate -is node worker/upload_worker.js           # on the Mac: picks up uploads

# The site
npm start                                             # http://localhost:3000
```

Each script prints its options when run without arguments. Publishing goes through the site's
admin API (`worker/site.js`, needs `ADMIN_TOKEN`; with the `R2_*` settings in `.env`, the
recording and voice tracks go to Cloudflare R2 instead of the site's disk): `publish.js` publishes to `--site` (your local
server by default, so you check it there first), `autopublish.js` to the live site. Nothing is
committed and nothing is deployed; the page is live at once.

## Tests

```bash
npm test
```

- `tests/test_khutbahs.js`: every published khutbah's reader against its expected verse and
  hadith cards (`tests/khutbahs.json`), as on disk and rebuilt with the current code.
- `tests/server.test.js`: the site's pages, API, viewer socket, feedback, upload API and
  publishing a khutbah, on a real server with an empty data folder and a fresh database.
- `tests/pipeline.test.js`: `pipeline.js` end to end on a published transcript with Claude
  stubbed out; the reader it writes must pass the publish gate.

All free and offline (no API key needed). GitHub Actions runs them on every push.

## Deployment

Render (`render.yaml`, Starter plan, Node 22) deploys `main` and runs `node server/server.js`.
A persistent disk at `data/` holds the database (`site.db`: the published khutbahs), the files of
khutbahs published through the API, viewer counts, feedback and uploads. Code changes deploy;
publishing a khutbah does not. Admin
pages: `/admin/traffic`, `/admin/feedback` and `/admin/upload`, each with `?key=<ADMIN_TOKEN>`.
See [docs/DEPLOY.md](docs/DEPLOY.md).

## Cost

About $2.25 per khutbah through `autopublish.js` (Claude about $1.60, Gemini about $0.65);
Groq timing is on the free tier. The site itself has no per-visit cost.

## More

- [CLAUDE.md](CLAUDE.md): working notes on every part of the pipeline and the fixes behind it
- [docs/FIXES.md](docs/FIXES.md): root causes of each fix
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): the scalability proposal (content out of git,
  multi-language data model)
