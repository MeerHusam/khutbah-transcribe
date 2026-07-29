// live/index.js — WebSocket handler for streaming live mode (/ws/stream).
//
// Wiring:  browser (PCM frames) → this handler → Speechmatics → engine → broadcast to all
//          connected clients (host + listeners share one feed).
//
// Kept entirely separate from live.js (the Groq chunk-based mode) and from the offline
// upload pipeline. server.js mounts this additively; nothing existing changes behaviour.

import 'dotenv/config';
import { SpeechmaticsStream } from './speechmatics.js';
import { StreamSession, warmup } from './engine.js';

const listeners = new Set();
let session = null;   // current StreamSession
let sm = null;        // current Speechmatics connection
let hostWs = null;    // socket that started the session (only it may send audio)

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const ws of listeners) {
    if (ws.readyState === 1) { try { ws.send(payload); } catch {} }
  }
}

export function streamStatus() {
  return {
    mode: 'speechmatics-realtime',
    configured: !!process.env.SPEECHMATICS_API_KEY,
    active: !!session && session.status === 'live',
    title: session?.title ?? null,
    startedAt: session?.startedAt ?? null,
    listeners: listeners.size,
  };
}

function teardown() {
  try { sm?.close(); } catch {}
  sm = null;
  hostWs = null;
}

function startSession(ws, msg) {
  const apiKey = process.env.SPEECHMATICS_API_KEY;
  if (!apiKey) {
    ws.send(JSON.stringify({
      type: 'error',
      fatal: true,
      message: 'SPEECHMATICS_API_KEY is not set. Add it to .env and restart the server.',
    }));
    return;
  }
  // Broadcaster auth: enforced only when ADMIN_TOKEN is configured (open in local dev).
  const token = process.env.ADMIN_TOKEN || '';
  if (token && msg.key !== token) {
    ws.send(JSON.stringify({ type: 'error', fatal: true, message: 'unauthorized' }));
    return;
  }

  // Replace any previous session. Note this intentionally does NOT broadcast 'ended' —
  // that once killed a freshly started host loop (see live.js fix).
  if (session && session.status === 'live') { session.status = 'ended'; session.save(); }
  teardown();

  const counts = warmup();
  session = new StreamSession(msg.title, broadcast);
  hostWs = ws;

  sm = new SpeechmaticsStream({
    apiKey,
    language: 'ar',
    translateTo: ['en'],
    maxDelay: Number(process.env.SPEECHMATICS_MAX_DELAY || 1.0),
    handlers: {
      onStarted: () => {
        console.log(`[stream] Speechmatics ready — "${session.title}" (hadith corpus: ${counts.hadith})`);
        broadcast({ type: 'status', status: 'live' });
        broadcast(session.snapshot());
      },
      onPartial: p => session?.onPartial(p),
      onFinal: f => session?.onFinal(f),
      onTranslation: t => session?.onTranslation(t),
      // Partial translations revise themselves; showing them in the ticker keeps English
      // feeling instant without committing half-sentences to the feed.
      onPartialTranslation: t => broadcast({ type: 'partial_en', text: t.text }),
      onError: message => {
        console.error('[stream] Speechmatics error:', message);
        broadcast({ type: 'error', message });
      },
      onEnd: ({ reason }) => {
        console.log(`[stream] Speechmatics closed (${reason || 'no reason'})`);
        if (session?.status === 'live') session.stop();
        teardown();
      },
    },
  });

  try {
    sm.connect();
  } catch (e) {
    ws.send(JSON.stringify({ type: 'error', fatal: true, message: e.message }));
    teardown();
  }
}

export function handleStreamConnection(ws) {
  listeners.add(ws);
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(
      session ? session.snapshot() : { type: 'snapshot', active: false, events: [] }
    ));
  }

  ws.on('message', (data, isBinary) => {
    // Binary = raw 16-bit LE PCM from the host's AudioWorklet.
    if (isBinary) {
      if (ws === hostWs && sm) sm.sendAudio(data);
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.type === 'start') {
      startSession(ws, msg);
    } else if (msg.type === 'stop') {
      if (ws !== hostWs) return;          // only the broadcaster may stop the session
      console.log('[stream] session stopping');
      sm?.end();                          // flush finals; onEnd stops the session
      setTimeout(() => {                  // safety net if EndOfTranscript never arrives
        if (session?.status === 'live') session.stop();
        teardown();
      }, 4000);
    }
  });

  const drop = () => {
    listeners.delete(ws);
    // If the broadcaster's socket dies, end the session rather than leaving it hanging.
    if (ws === hostWs) {
      sm?.end();
      setTimeout(() => {
        if (session?.status === 'live') session.stop();
        teardown();
      }, 2000);
    }
  };
  ws.on('close', drop);
  ws.on('error', drop);
}
