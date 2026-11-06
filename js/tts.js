// Main-thread client for the text-to-speech worker.

export const VOICES = {
  female: [
    { id: 'af_heart', label: 'Heart — American' },
    { id: 'af_bella', label: 'Bella — American' },
    { id: 'af_nicole', label: 'Nicole — American (soft)' },
    { id: 'bf_emma', label: 'Emma — British' },
    { id: 'bf_isabella', label: 'Isabella — British' },
  ],
  male: [
    { id: 'am_michael', label: 'Michael — American' },
    { id: 'am_fenrir', label: 'Fenrir — American (deep)' },
    { id: 'am_puck', label: 'Puck — American (bright)' },
    { id: 'bm_george', label: 'George — British' },
    { id: 'bm_fable', label: 'Fable — British' },
  ],
};

// A small pool of workers: without WebGPU each worker uses one CPU core, so several run in parallel.
const workers = [];
let nextId = 1;
const pending = new Map();
const cache = new Map();
let progressHandler = null;
let device = null;
let rr = 0;

function createWorker() {
  const w = new Worker(new URL('./tts-worker.js', import.meta.url), { type: 'module' });
  w.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'progress') {
      progressHandler?.(msg);
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.type === 'error') p.reject(new Error(msg.message));
    else p.resolve(msg);
  };
  w.onerror = (e) => {
    for (const [id, p] of pending) {
      if (p.worker === w) { p.reject(new Error(e.message || 'Voice engine failed to start')); pending.delete(id); }
    }
  };
  return w;
}

function call(w, payload) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject, worker: w });
    w.postMessage({ id, ...payload });
  });
}

export function pickDevice() {
  return 'gpu' in navigator ? 'webgpu' : 'wasm';
}

function cpuWorkerCount() {
  const cores = navigator.hardwareConcurrency || 2;
  const mem = navigator.deviceMemory || 8; // GB, Chrome only
  return Math.max(1, Math.min(4, Math.floor(cores / 2), Math.floor(mem / 2)));
}

export async function loadVoiceEngine(onProgress) {
  progressHandler = onProgress;
  if (workers.length) return device;
  device = pickDevice();
  let first = createWorker();
  try {
    await call(first, { type: 'load', device });
  } catch (err) {
    if (device !== 'webgpu') { first.terminate(); throw err; }
    // WebGPU exists but failed (common on some GPUs/drivers): fall back to CPU.
    first.terminate();
    device = 'wasm';
    first = createWorker();
    await call(first, { type: 'load', device });
  }
  workers.push(first);
  if (device === 'wasm') {
    // Extra CPU workers load the (now cached) model in the background.
    for (let i = 1; i < cpuWorkerCount(); i++) {
      const w = createWorker();
      call(w, { type: 'load', device }).then(() => workers.push(w)).catch(() => w.terminate());
    }
  }
  return device;
}

// Returns { samples: Float32Array, sampleRate } for one short piece of text (one or two sentences).
export async function speak(text, voice, speed = 1) {
  const key = `${voice}|${speed}|${text}`;
  if (cache.has(key)) return cache.get(key);
  if (!workers.length) await loadVoiceEngine(progressHandler);
  const w = workers[rr++ % workers.length];
  const res = await call(w, { type: 'speak', text, voice, speed, device });
  const out = { samples: res.samples, sampleRate: res.sampleRate };
  cache.set(key, out);
  return out;
}

// Speak many pieces of text using all workers; results come back in the same order.
export async function speakAll(texts, voice, speed, onEach, shouldStop) {
  const results = new Array(texts.length);
  let next = 0;
  let done = 0;
  const runner = async () => {
    while (next < texts.length) {
      if (shouldStop?.()) throw new Error('Cancelled.');
      const i = next++;
      results[i] = await speak(texts[i], voice, speed);
      onEach?.(++done, workers.length);
    }
  };
  // Start one runner per worker; check again shortly in case more workers finished loading.
  const runners = [];
  const target = () => Math.max(1, workers.length);
  while (runners.length < target()) runners.push(runner());
  const grow = setInterval(() => { while (runners.length < target() && next < texts.length) runners.push(runner()); }, 1000);
  try {
    // Wait twice: runners added while the first batch was running are awaited by the second call.
    await Promise.all(runners);
    await Promise.all(runners);
  } finally {
    clearInterval(grow);
  }
  return results;
}

// Split narration into sentence-sized pieces the voice model handles well (and that make good captions).
export function splitSentences(text, maxLen = 220) {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const raw = normalized.match(/[^.!?;:]+(?:[.!?;:]+["')\]]*|$)/g) || [normalized];
  const out = [];
  for (let s of raw) {
    s = s.trim();
    if (!s) continue;
    while (s.length > maxLen) {
      // break long sentences at a comma or space near the limit
      let cut = s.lastIndexOf(', ', maxLen);
      if (cut < maxLen * 0.4) cut = s.lastIndexOf(' ', maxLen);
      if (cut <= 0) cut = maxLen;
      out.push(s.slice(0, cut + 1).trim());
      s = s.slice(cut + 1).trim();
    }
    if (s) {
      // merge very short fragments into the previous piece
      if (out.length && s.length < 25 && out[out.length - 1].length + s.length < maxLen) out[out.length - 1] += ' ' + s;
      else out.push(s);
    }
  }
  return out;
}
