// pcm-worklet.js — AudioWorklet processor: captures mic audio, downsamples to 16kHz,
// converts to 16-bit LE PCM, and posts it to the main thread in ~64ms frames.
//
// This replaces MediaRecorder entirely. MediaRecorder produces encoded webm/mp4 *blobs*
// that must be cut into standalone files — the root cause of the chunk-boundary problem.
// A worklet gives us a continuous raw sample stream, which is what streaming ASR wants.

class PCMProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = options?.processorOptions?.targetRate || 16000;
    this.ratio = sampleRate / this.targetRate;   // sampleRate is the context rate (global)
    this.acc = [];        // accumulated downsampled float samples
    this.pos = 0;         // fractional read position for resampling
    this.FRAME = 1024;    // samples per posted frame (~64ms at 16kHz)
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];

    // Linear-interpolation downsample from the context rate to 16kHz.
    while (this.pos < ch.length) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = ch[i] ?? 0;
      const b = ch[i + 1] ?? a;
      this.acc.push(a + (b - a) * frac);
      this.pos += this.ratio;
    }
    this.pos -= ch.length;

    while (this.acc.length >= this.FRAME) {
      const slice = this.acc.splice(0, this.FRAME);
      const pcm = new Int16Array(slice.length);
      let peak = 0;
      for (let i = 0; i < slice.length; i++) {
        const s = Math.max(-1, Math.min(1, slice[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        const abs = Math.abs(s);
        if (abs > peak) peak = abs;
      }
      // Transfer the buffer (zero-copy) plus a peak level for the UI meter.
      this.port.postMessage({ pcm: pcm.buffer, peak }, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
