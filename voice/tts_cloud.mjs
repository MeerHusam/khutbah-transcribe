// tts_cloud.mjs — The same Gemini voices through Google Cloud Text-to-Speech (2 Oct 2026), for
// tts_gemini.mjs with TTS_BACKEND=cloud and GOOGLE_TTS_API_KEY in .env. Cloud TTS has a per-minute
// quota (150 requests) and no daily cap, where the Gemini API stops at 100 requests a day per
// project, which two voiced khutbahs in a day used up on 2 Oct.
//
// Cloud takes one style prompt per request, not one per sentence, so each sentence's direction
// goes into the prompt as a numbered note. Limits: text and prompt at most 4,000 bytes each and
// ~655 s of audio per request. Model: CLOUD_TTS_MODEL (default gemini-2.5-flash-tts; the Gemini
// API's gemini-3.8-flash-tts is not listed on Cloud). Not tried against the API yet: the first
// run is a one-sentence test.

const ENDPOINT = 'https://texttospeech.googleapis.com/v1/text:synthesize';
export const CLOUD_MODEL = process.env.CLOUD_TTS_MODEL || 'gemini-2.5-flash-tts';
const LANGUAGE = { ur: 'ur-PK', en: 'en-US' };
const bytes = s => Buffer.byteLength(s, 'utf8');

// content: [{ text, annotations: [{ style }] }], as tts_gemini.mjs builds for the Gemini API.
export function cloudBody(content, { lang = 'en', voice, sampleRate = 24000 } = {}) {
  const text = content.map(c => c.text).join('');
  const styles = content.map(c => c.annotations?.[0]?.style ?? '');
  const prompt = new Set(styles).size <= 1 ? styles[0]
    : 'Read the text aloud. Delivery, sentence by sentence:\n'
      + content.map((c, k) => `${k + 1}. "${c.text.trim().split(/\s+/).slice(0, 6).join(' ')}…": ${styles[k]}`).join('\n');
  if (bytes(text) > 4000 || bytes(prompt) > 4000) {
    throw new Error(`passage too long for Cloud TTS (text ${bytes(text)} bytes, prompt ${bytes(prompt)}; 4,000 each): voice fewer blocks per passage`);
  }
  return {
    input: { text, prompt },
    voice: { languageCode: LANGUAGE[lang] ?? 'en-US', name: voice, model_name: CLOUD_MODEL },
    audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: sampleRate },
  };
}

// One request -> the WAV bytes (LINEAR16 comes with a RIFF header). Errors carry .status, so the
// caller's retry rules (429 and 5xx again, other 4xx not) apply as for the Gemini API.
export async function askCloud(content, opts) {
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GOOGLE_TTS_API_KEY ?? '' },
    body: JSON.stringify(cloudBody(content, opts)),
  });
  if (!r.ok) throw Object.assign(new Error(`Cloud TTS ${r.status}: ${(await r.text()).slice(0, 300)}`), { status: r.status });
  const { audioContent } = await r.json();
  if (!audioContent) throw new Error('Cloud TTS: no audio in the answer');
  return Buffer.from(audioContent, 'base64');
}
