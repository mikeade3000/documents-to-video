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

// Voice engine. Two ways to run the model:
//  - GPU (WebGPU): fastest on good graphics cards, but on some laptops it is very slow or hangs.
//  - CPU (WebAssembly): reliable everywhere; several workers run in parallel, one per ~2 cores.
// In "auto" mode the GPU is tested first and the app falls back to CPU if it fails or is slow.

const workers = []; // workers with the model loaded and ready
let nextId = 1;
const pending = new Map();
const cache = new Map();
let progressHandler = null;
let statusHandler = null;
let device = null; // 'webgpu' | 'wasm' once loaded
let loading = null;
let rr = 0;
let preference = 'auto'; // 'auto' | 'cpu' | 'gpu'
let generation = 0; // bumps on stop, so stale background loads are discarded

const GPU_TEST_TIMEOUT = 60_000; // first GPU sentence (includes shader compilation)
const GPU_SENTENCE_TIMEOUT = 45_000; // any later GPU sentence
const GPU_MAX_SLOWDOWN = 1.0; // GPU must generate at least as fast as real time, or we use CPU

export function setEnginePreference(p) {
  if (p !== preference) {
    preference = p;
    stopVoiceEngine();
  }
}

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

function call(w, payload, timeoutMs = 0) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    let timer = null;
    const done = (fn) => (v) => { clearTimeout(timer); fn(v); };
    pending.set(id, { resolve: done(resolve), reject: done(reject), worker: w });
    if (timeoutMs) {
      timer = setTimeout(() => {
        pending.delete(id);
        const err = new Error('timeout');
        err.timeout = true;
        reject(err);
      }, timeoutMs);
    }
    w.postMessage({ id, ...payload });
  });
}

export function pickDevice() {
  return 'gpu' in navigator ? 'webgpu' : 'wasm';
}

// Ask the browser for a graphics adapter before downloading the (larger) GPU model.
async function hasUsableGpu() {
  if (!('gpu' in navigator)) return false;
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return false;
    // Software/fallback adapters are slower than the CPU engine.
    if (adapter.isFallbackAdapter || adapter.info?.isFallbackAdapter) return false;
    return true;
  } catch {
    return false;
  }
}

export function engineLabel() {
  if (device === 'webgpu') return 'GPU';
  return `CPU × ${Math.max(1, workers.length)}`;
}

function cpuWorkerCount() {
  const cores = navigator.hardwareConcurrency || 2;
  const mem = navigator.deviceMemory || 8; // GB, Chrome only
  return Math.max(1, Math.min(4, Math.floor(cores / 2), Math.floor(mem / 2)));
}

// Stop everything immediately (used by Cancel). The model stays in the browser cache.
export function stopVoiceEngine() {
  generation++;
  for (const w of workers) w.terminate();
  workers.length = 0;
  for (const p of pending.values()) {
    p.worker?.terminate();
    p.reject(new Error('Cancelled.'));
  }
  pending.clear();
  device = null;
  loading = null;
}

async function startCpu(gen) {
  statusHandler?.('Starting the voice engine on the CPU…');
  const first = createWorker();
  try {
    await call(first, { type: 'load', device: 'wasm' });
  } catch (err) {
    first.terminate();
    throw err;
  }
  if (gen !== generation) { first.terminate(); throw new Error('Cancelled.'); }
  device = 'wasm';
  workers.push(first);
  // Extra CPU workers load the (now cached) model in the background and join when ready.
  for (let i = 1; i < cpuWorkerCount(); i++) {
    const w = createWorker();
    call(w, { type: 'load', device: 'wasm' })
      .then(() => (gen === generation && device === 'wasm' ? workers.push(w) : w.terminate()))
      .catch(() => w.terminate());
  }
}

// Load the model on the GPU and check that it really works and is fast enough.
async function tryGpu(gen) {
  statusHandler?.('Starting the voice engine on the graphics card (GPU)…');
  const w = createWorker();
  try {
    await call(w, { type: 'load', device: 'webgpu' });
    statusHandler?.('Testing the graphics card (the first sentence can take up to a minute)…');
    await call(w, { type: 'speak', text: 'Testing the voice.', voice: 'af_heart', speed: 1, device: 'webgpu' }, GPU_TEST_TIMEOUT);
    const text = 'This short sentence checks how quickly the graphics card can speak.';
    const t0 = performance.now();
    const res = await call(w, { type: 'speak', text, voice: 'af_heart', speed: 1, device: 'webgpu' }, GPU_SENTENCE_TIMEOUT);
    const took = (performance.now() - t0) / 1000;
    const audioSeconds = res.samples.length / res.sampleRate;
    const quiet = !res.samples.some((v) => Math.abs(v) > 0.01);
    if (quiet) throw new Error('GPU produced silent audio');
    if (took > audioSeconds * GPU_MAX_SLOWDOWN) throw new Error(`GPU too slow (${took.toFixed(1)}s for ${audioSeconds.toFixed(1)}s of speech)`);
    if (gen !== generation) throw new Error('Cancelled.');
    device = 'webgpu';
    workers.push(w);
    return true;
  } catch (err) {
    w.terminate();
    if (err.message === 'Cancelled.') throw err;
    console.warn('GPU voice engine not used:', err.message);
    return false;
  }
}

export async function loadVoiceEngine(onProgress, onStatus) {
  if (onProgress) progressHandler = onProgress;
  if (onStatus) statusHandler = onStatus;
  if (workers.length) return device;
  if (!loading) {
    const gen = generation;
    loading = (async () => {
      const wantGpu = preference !== 'cpu' && (await hasUsableGpu());
      if (wantGpu && (await tryGpu(gen))) return device;
      if (wantGpu) statusHandler?.('The graphics card was too slow or failed — switching to the CPU…');
      await startCpu(gen);
      return device;
    })().finally(() => { loading = null; });
  }
  return loading;
}

// If the GPU stalls in the middle of a job, drop it and continue on the CPU.
async function switchToCpu() {
  if (device === 'wasm') return;
  const gen = generation;
  for (const w of workers) w.terminate();
  workers.length = 0;
  device = null;
  statusHandler?.('The graphics card stopped responding — continuing on the CPU…');
  if (!loading) loading = startCpu(gen).then(() => device).finally(() => { loading = null; });
  await loading;
}

// Returns { samples: Float32Array, sampleRate } for one short piece of text (one or two sentences).
export async function speak(text, voice, speed = 1) {
  const key = `${voice}|${speed}|${text}`;
  if (cache.has(key)) return cache.get(key);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!workers.length) await loadVoiceEngine();
    const w = workers[rr++ % workers.length];
    try {
      const res = await call(w, { type: 'speak', text, voice, speed, device }, device === 'webgpu' ? GPU_SENTENCE_TIMEOUT : 0);
      const out = { samples: res.samples, sampleRate: res.sampleRate };
      cache.set(key, out);
      return out;
    } catch (err) {
      if (device === 'webgpu' && attempt === 0) { await switchToCpu(); continue; }
      throw err;
    }
  }
  throw new Error('Voice engine failed.');
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
      onEach?.(++done);
    }
  };
  // One runner per ready worker; more join as extra CPU workers finish loading.
  const runners = [];
  const target = () => Math.max(1, workers.length);
  const add = () => {
    const r = runner();
    r.catch(() => {}); // the error is reported once through Promise.all below
    runners.push(r);
  };
  while (runners.length < target()) add();
  const grow = setInterval(() => { while (runners.length < target() && next < texts.length) add(); }, 1000);
  try {
    // Wait until no new runners were added while waiting.
    let n;
    do { n = runners.length; await Promise.all(runners); } while (runners.length !== n);
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
