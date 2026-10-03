# Recordings Index

| # | File | Source | Date | Duration | Masjid / Location | Notes |
|---|------|--------|------|----------|-------------------|-------|
| 1 | `madinah_khutbah_1.mp3` | [tilawatalharamain.com/m/19304](https://tilawatalharamain.com/m/19304) | 2025-11-28 | 20m 49s | Masjid an-Nabawi, Madinah | Topic: Sabr (Patience). Full khutbah. |
| 2 | `masjid_khutbah_may8.m4a` | Phone recording | 2026-05-08 | 2m 41s | Local masjid | Du'aa section only (end of khutbah). 90% transcription accuracy. |
| 4 | `masjid_khutbah_may15.m4a` | Phone recording | 2026-05-15 | 15m 01s | Local masjid | Full khutbah recording. |
| 3 | `makkah_sudais_ramadan_ummah.mp3` | tilawatalharamain.com | 1999-12-17 (9 Ramadan 1420 AH) | 25m 59s | Masjid al-Haram, Makkah | Sheikh Abdur-Rahman as-Sudais. Topic: Ramadan and the Affairs of the Ummah. |

## How to run

```bash
# Transcribe + full analysis
node pipeline.js "audio_files/<file>" --groq

# Re-run analysis on existing transcript (no Groq cost)
node pipeline.js --transcript "outputs/<folder>/transcript.txt"
```

## Setup (first time only)

```bash
npm install
node setup_hadith.js   # downloads ~35 MB Hadith corpus once
```
