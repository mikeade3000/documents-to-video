// Runs the Kokoro text-to-speech model in a background thread so the page stays responsive.
// The model (~90 MB) is downloaded once from Hugging Face and then cached by the browser.

import { KokoroTTS } from 'https://cdn.jsdelivr.net/npm/kokoro-js@1.2.1/dist/kokoro.web.js';

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
let tts = null;
let loading = null;

async function load(device) {
  if (tts) return tts;
  if (!loading) {
    const opts = device === 'webgpu' ? { dtype: 'fp32', device: 'webgpu' } : { dtype: 'q8', device: 'wasm' };
    loading = KokoroTTS.from_pretrained(MODEL_ID, {
      ...opts,
      progress_callback: (p) => {
        if (p.status === 'progress' && p.total) {
          self.postMessage({ type: 'progress', file: p.file, loaded: p.loaded, total: p.total });
        }
      },
    }).then((m) => (tts = m))
      .catch((err) => {
        loading = null;
        throw err;
      });
  }
  return loading;
}

self.onmessage = async (e) => {
  const { id, type } = e.data;
  try {
    if (type === 'load') {
      await load(e.data.device);
      self.postMessage({ id, type: 'loaded' });
    } else if (type === 'speak') {
      const model = await load(e.data.device);
      const out = await model.generate(e.data.text, { voice: e.data.voice, speed: e.data.speed });
      const samples = out.audio;
      self.postMessage({ id, type: 'audio', samples, sampleRate: out.sampling_rate }, [samples.buffer]);
    }
  } catch (err) {
    self.postMessage({ id, type: 'error', message: String(err?.message || err) });
  }
};
