// live/speechmatics.js — Speechmatics Realtime WebSocket client.
//
// Why this exists: Whisper (offline pipeline + live.js) is an encoder-decoder trained on
// fixed 30s windows — it cannot emit a word until a whole audio block is ingested, so every
// live-Whisper setup is a chunk-and-stitch hack with hard, wrong-looking boundaries.
// Speechmatics runs a streaming transducer: raw PCM goes up continuously in small frames and
// words come back as they are recognised (~0.5-1s), with partials that self-correct.
//
// Protocol (https://docs.speechmatics.com/api-ref/realtime-transcription-websocket):
//   →  StartRecognition {audio_format, transcription_config, translation_config}
//   ←  RecognitionStarted
//   →  <binary PCM frames>                      ← AudioAdded {seq_no}
//   ←  AddPartialTranscript  (interim, revised)
//   ←  AddTranscript         (final, stable)
//   ←  AddPartialTranslation / AddTranslation   (when translation_config is set)
//   →  EndOfStream {last_seq_no}                ← EndOfTranscript
//
// This module is transport only — it owns the socket and normalises messages into
// callbacks. All khutbah logic lives in engine.js.

import WebSocket from 'ws';

const SM_URL = process.env.SPEECHMATICS_URL || 'wss://eu.rt.speechmatics.com/v2';

// Speechmatics accepts 16-bit little-endian PCM; 16kHz mono is the standard ASR rate
// and what the browser AudioWorklet downsamples to.
export const SAMPLE_RATE = 16000;
export const ENCODING = 'pcm_s16le';

export class SpeechmaticsStream {
  /**
   * @param {object} opts
   * @param {string}  opts.apiKey        Speechmatics API key
   * @param {string}  opts.language      source language (default 'ar')
   * @param {string[]}opts.translateTo   target languages, e.g. ['en'] — [] disables translation
   * @param {number}  opts.maxDelay      0.7–4s. Lower = faster finals, slightly less accurate
   * @param {object}  opts.handlers      {onPartial, onFinal, onTranslation, onPartialTranslation,
   *                                      onStarted, onError, onEnd}
   */
  constructor({ apiKey, language = 'ar', translateTo = ['en'], maxDelay = 1.0, handlers = {} }) {
    this.apiKey = apiKey;
    this.language = language;
    this.translateTo = translateTo;
    this.maxDelay = maxDelay;
    this.h = handlers;

    this.ws = null;
    this.ready = false;      // RecognitionStarted received — safe to send audio
    this.closed = false;
    this.seqNo = 0;          // count of audio frames sent (EndOfStream needs the last one)
    this.pending = [];       // audio buffered while the socket is still connecting
  }

  connect() {
    if (!this.apiKey) throw new Error('SPEECHMATICS_API_KEY is not set');

    this.ws = new WebSocket(SM_URL, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    this.ws.on('open', () => {
      const msg = {
        message: 'StartRecognition',
        audio_format: { type: 'raw', encoding: ENCODING, sample_rate: SAMPLE_RATE },
        transcription_config: {
          language: this.language,
          operating_point: 'enhanced',   // best accuracy tier
          enable_partials: true,         // interim words that revise themselves
          max_delay: this.maxDelay,
          max_delay_mode: 'flexible',    // lets the model hold a moment longer mid-entity
        },
      };
      // Realtime AR→EN translation rides the same socket, so English no longer waits on Claude.
      if (this.translateTo?.length) {
        msg.translation_config = { target_languages: this.translateTo, enable_partials: true };
      }
      this.ws.send(JSON.stringify(msg));
    });

    this.ws.on('message', raw => this._onMessage(raw));

    this.ws.on('error', err => {
      this.h.onError?.(err.message || String(err));
    });

    this.ws.on('close', (code, reason) => {
      this.ready = false;
      if (!this.closed) {
        this.closed = true;
        this.h.onEnd?.({ code, reason: reason?.toString() || '' });
      }
    });
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    switch (msg.message) {
      case 'RecognitionStarted':
        this.ready = true;
        // Flush anything captured before the handshake completed.
        for (const buf of this.pending) this._rawSend(buf);
        this.pending = [];
        this.h.onStarted?.(msg);
        break;

      case 'AddPartialTranscript':
        this.h.onPartial?.({
          transcript: msg.transcript || '',
          words: extractWords(msg.results),
          start: msg.metadata?.start_time ?? 0,
          end: msg.metadata?.end_time ?? 0,
        });
        break;

      case 'AddTranscript':
        this.h.onFinal?.({
          transcript: msg.transcript || '',
          words: extractWords(msg.results),
          start: msg.metadata?.start_time ?? 0,
          end: msg.metadata?.end_time ?? 0,
        });
        break;

      case 'AddPartialTranslation':
        this.h.onPartialTranslation?.({
          language: msg.language,
          text: joinTranslation(msg.results),
        });
        break;

      case 'AddTranslation':
        this.h.onTranslation?.({
          language: msg.language,
          text: joinTranslation(msg.results),
          start: msg.results?.[0]?.start_time ?? 0,
          end: msg.results?.[msg.results.length - 1]?.end_time ?? 0,
        });
        break;

      case 'EndOfTranscript':
        this.h.onEnd?.({ code: 1000, reason: 'end_of_transcript' });
        this.closed = true;
        break;

      case 'Error':
        this.h.onError?.(`${msg.type || 'error'}: ${msg.reason || ''} (code ${msg.code ?? '?'})`);
        break;

      // AudioAdded / Info / Warning — nothing to do.
    }
  }

  /** Feed one buffer of 16-bit LE PCM. Buffers before handshake are queued, not dropped. */
  sendAudio(buffer) {
    if (this.closed) return;
    if (!this.ready) {
      // Bound the pre-handshake queue so a stalled connect can't grow memory forever.
      if (this.pending.length < 200) this.pending.push(buffer);
      return;
    }
    this._rawSend(buffer);
  }

  _rawSend(buffer) {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(buffer);
      this.seqNo++;
    } catch { /* socket died mid-send; close handler will fire */ }
  }

  /** Graceful stop: tell Speechmatics no more audio is coming so it flushes final results. */
  end() {
    if (this.closed || this.ws?.readyState !== WebSocket.OPEN) { this.close(); return; }
    try {
      this.ws.send(JSON.stringify({ message: 'EndOfStream', last_seq_no: this.seqNo }));
    } catch { this.close(); }
  }

  close() {
    this.closed = true;
    try { this.ws?.close(); } catch {}
  }
}

// Speechmatics returns each token as {alternatives:[{content}]} plus punctuation entries.
// We keep word tokens only — the Quran n-gram scan matches on bare Arabic words.
function extractWords(results) {
  if (!Array.isArray(results)) return [];
  return results
    .filter(r => r.type === 'word')
    .map(r => ({
      word: r.alternatives?.[0]?.content ?? '',
      start: r.start_time ?? 0,
      end: r.end_time ?? 0,
      confidence: r.alternatives?.[0]?.confidence ?? 0,
    }))
    .filter(w => w.word);
}

// Translation results arrive as segments; punctuation attaches without a leading space.
function joinTranslation(results) {
  if (!Array.isArray(results)) return '';
  return results.map(r => r.content ?? '').join(' ').replace(/\s+([,.!?;:])/g, '$1').trim();
}
